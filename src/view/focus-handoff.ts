/**
 * #175 step 4: pointer into a read-only window’s text triggers cooperative
 * same-tab handoff (in-memory snapshot) or cross-tab release / Edit here.
 *
 * Two-phase yield: the owner parks (releases the lock, keeps text) until the
 * requester confirms takeover — never discard private text before success.
 * BroadcastChannel is always cross-tab; snapshots travel only on same-origin
 * frame calls. Steal requires an explicit Edit here after an unresponsive timeout.
 */
import {
  HANDOFF_CHANNEL,
  HANDOFF_CONFIRM_TIMEOUT_MS,
  HANDOFF_YIELD_TIMEOUT_MS,
  bufferInsertFromBeforeInput,
  bufferInsertFromKeyboard,
  handoffRefuseGuidance,
  ownerYieldBlock,
  parseHandoffMessage,
  replayBufferedInsert,
  type BufferedInsert,
  type FocusHandoffHooks,
  type HandoffMessage,
  type HandoffRefuseReason,
  type HandoffSnapshot,
  type SameOriginYieldResult,
} from './handoff';
import type { EditBlock } from './ownership';
import type { WindowId } from './window-id';
import { testKnob } from './embed-api';

export type FocusHandoffDeps = {
  field: HTMLTextAreaElement;
  windowId: WindowId | undefined;
  instanceId: string;
  channel?: BroadcastChannel | null;
  getDocumentId: () => string;
  isViewMode: () => boolean;
  isOwner: () => boolean;
  editBlock: () => EditBlock;
  isComposing: () => boolean;
  isTransitioning: () => boolean;
  isSaving: () => boolean;
  saveFailed: () => boolean;
  isDirty: () => boolean;
  autosaveOn: () => boolean;
  /**
   * When this window still holds unsaved text after a prior loss, ask before starting
   * a handoff that will replace it with the owner's state. Return false to abort.
   */
  confirmDiscardDirtyForHandoff: () => Promise<boolean>;
  /** Flush Autosave when on; no-op when off. */
  flushSave: () => Promise<void>;
  captureSnapshot: () => HandoffSnapshot;
  /** Synchronously freeze the editor before capturing a snapshot / awaiting lock release. */
  beginParkFreeze: () => void;
  /** Release the parked lock after the UI is already read-only. */
  finishParkRelease: () => Promise<void>;
  /** After confirmed takeover: replace parked dirty text with last saved (only if still on `documentId`). */
  discardParkedText: (documentId: string) => Promise<void>;
  /** After failed/timed-out takeover: try to re-acquire for `documentId` while keeping parked text. */
  recoverParkedOwnership: (documentId: string) => Promise<void>;
  /**
   * Become owner after a cooperative release. `snapshot` is set only for same-tab
   * unsaved/private transfer; otherwise reread IndexedDB under the new fence.
   */
  takeOver: (input: {
    documentId: string;
    snapshot: HandoffSnapshot | undefined;
    selectionStart: number;
    selectionEnd: number;
    /** Reader text the selection offsets were measured against. */
    fromText: string;
    steal: boolean;
  }) => Promise<boolean>;
  announce: (message: string) => void;
  showEditHere: (reason: HandoffRefuseReason) => void;
  hideEditHere?: () => void;
};

export type FocusHandoffController = {
  dispose: () => void;
  hooks: FocusHandoffHooks;
  pending: () => boolean;
  /** Start a handoff from user intent (pointer or Edit here). */
  requestHandoff: (options?: { steal?: boolean }) => void;
  /** Cancel an in-flight requester handoff (document switch / navigation). */
  cancel: () => void;
};

function openChannel(existing: BroadcastChannel | null | undefined): BroadcastChannel | null {
  if (existing !== undefined) return existing;
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(HANDOFF_CHANNEL) : null;
  } catch {
    return null;
  }
}

/**
 * Carry both selection endpoints so the first buffered insert/delete can replace
 * a pre-handoff range. A collapsed 0–0 caret is preserved (Home / click at start);
 * do not rewrite it to the end — that stole intentional start carets.
 */
function readHandoffSelection(field: HTMLTextAreaElement): { start: number; end: number } {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (typeof start !== 'number') {
    const len = field.value.length;
    return { start: len, end: len };
  }
  const endVal = typeof end === 'number' ? end : start;
  return { start, end: endVal };
}

function peerFrames(): Window[] {
  try {
    if (window.parent === window) return [];
    const frames: Window[] = [];
    for (let i = 0; i < window.parent.frames.length; i++) {
      try {
        const peer = window.parent.frames[i];
        if (peer && peer !== window) frames.push(peer);
      } catch {
        /* Cross-origin frame. */
      }
    }
    return frames;
  } catch {
    return [];
  }
}

async function requestSameOriginYield(
  request: {
    documentId: string;
    fromInstanceId: string;
    requestId: string;
  },
): Promise<SameOriginYieldResult | undefined> {
  for (const peer of peerFrames()) {
    try {
      const hooks = peer as Window & FocusHandoffHooks;
      if (!hooks.__typebridgeOwnsDocument?.(request.documentId)) continue;
      if (!hooks.__typebridgeYieldForHandoff) continue;
      return await hooks.__typebridgeYieldForHandoff(request);
    } catch {
      /* Peer not ready or threw. */
    }
  }
  return undefined;
}

function notifyPeersComplete(requestId: string, ok: boolean): void {
  for (const peer of peerFrames()) {
    try {
      (peer as Window & FocusHandoffHooks).__typebridgeHandoffComplete?.(requestId, ok);
    } catch {
      /* Peer gone. */
    }
  }
}

export function installFocusHandoff(deps: FocusHandoffDeps): FocusHandoffController {
  const channel = openChannel(deps.channel);
  let disposed = false;
  let pending = false;
  let pendingRequestId = '';
  let pendingDocumentId = '';
  let pendingSelection = { start: 0, end: 0 };
  /** Text the selection offsets were measured against (reader view before install). */
  let pendingReaderText = '';
  let buffer: BufferedInsert[] = [];
  /** Pending request is paused on Edit here; input stays buffered until steal or cancel. */
  let awaitingEditHere = false;
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  /** Owner-side parked yield awaiting requester confirmation. */
  let parkedRequestId = '';
  let parkedDocumentId = '';
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const ignoresHandoffRequests = (): boolean =>
    !!testKnob('__typebridgeIgnoreHandoffRequests');

  const postMeta = (message: HandoffMessage): void => {
    try { channel?.postMessage(message); } catch { /* Channel may be closed. */ }
  };

  const clearPending = (): void => {
    pending = false;
    pendingRequestId = '';
    pendingDocumentId = '';
    pendingReaderText = '';
    buffer = [];
    awaitingEditHere = false;
    clearTimeout(yieldTimer);
    yieldTimer = undefined;
  };

  const offerEditHere = (reason: HandoffRefuseReason): void => {
    // Keep pending + buffer so keys typed during the wait stay blocked and replayable.
    clearTimeout(yieldTimer);
    yieldTimer = undefined;
    awaitingEditHere = true;
    deps.showEditHere(reason);
  };

  const clearParked = (): void => {
    parkedRequestId = '';
    parkedDocumentId = '';
    clearTimeout(confirmTimer);
    confirmTimer = undefined;
  };

  const applyBuffer = (items: BufferedInsert[]): void => {
    for (const item of items) replayBufferedInsert(deps.field, item);
  };

  const confirmParked = (requestId: string, ok: boolean): void => {
    if (!parkedRequestId || parkedRequestId !== requestId) return;
    const documentId = parkedDocumentId;
    clearParked();
    void (async () => {
      if (ok) await deps.discardParkedText(documentId);
      else await deps.recoverParkedOwnership(documentId);
    })();
  };

  const finishTakeover = async (
    snapshot: HandoffSnapshot | undefined,
    steal: boolean,
    requestId: string,
    documentId: string,
    notifySameOrigin: boolean,
  ): Promise<void> => {
    await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
    if (!pending || pendingRequestId !== requestId) return;
    // Refresh from the live field, but don't let a transient read-only 0–0 wipe a
    // real selection captured when the request started (or updated on click).
    {
      const liveStart = deps.field.selectionStart;
      const liveEnd = deps.field.selectionEnd;
      if (typeof liveStart === 'number') {
        const liveEndVal = typeof liveEnd === 'number' ? liveEnd : liveStart;
        const wipedToEmpty = deps.field.readOnly
          && liveStart === 0
          && liveEndVal === 0
          && deps.field.value.length > 0
          && (pendingSelection.start !== pendingSelection.end || pendingSelection.start !== 0);
        if (!wipedToEmpty) {
          pendingSelection = readHandoffSelection(deps.field);
          pendingReaderText = deps.field.value;
        }
      }
    }
    if (deps.getDocumentId() !== documentId) {
      clearPending();
      if (notifySameOrigin) notifyPeersComplete(requestId, false);
      postMeta({
        v: 1,
        type: 'handoff-complete',
        documentId,
        requestId,
        ok: false,
        at: Date.now(),
      });
      return;
    }
    const selection = pendingSelection;
    const fromText = pendingReaderText;
    // Keep pending=true so keystrokes during acquire/reread stay buffered.
    clearTimeout(yieldTimer);
    yieldTimer = undefined;

    const ok = await deps.takeOver({
      documentId,
      snapshot,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      fromText,
      steal,
    });
    if (!pending || pendingRequestId !== requestId) {
      if (notifySameOrigin) notifyPeersComplete(requestId, false);
      postMeta({
        v: 1,
        type: 'handoff-complete',
        documentId,
        requestId,
        ok: false,
        at: Date.now(),
      });
      return;
    }
    const stillSameDoc = deps.getDocumentId() === documentId;
    const inserts = buffer.slice();
    clearPending();
    const succeeded = ok && stillSameDoc;
    if (notifySameOrigin) notifyPeersComplete(requestId, succeeded);
    postMeta({
      v: 1,
      type: 'handoff-complete',
      documentId,
      requestId,
      ok: succeeded,
      at: Date.now(),
    });
    if (succeeded) {
      applyBuffer(inserts);
      deps.hideEditHere?.();
      deps.announce('You can edit this document in this window now.');
    }
  };

  const startRequest = async (options: {
    steal?: boolean;
    initialBuffer?: BufferedInsert[];
  } = {}): Promise<void> => {
    if (disposed || deps.isViewMode()) return;
    // Edit here continues the same pending request (buffer + selection intact).
    if (pending) {
      if (
        options.steal
        && awaitingEditHere
        && pendingDocumentId === deps.getDocumentId()
      ) {
        awaitingEditHere = false;
        deps.hideEditHere?.();
        await finishTakeover(undefined, true, pendingRequestId, pendingDocumentId, false);
      }
      return;
    }
    const block = deps.editBlock();
    if (block !== 'busy' && block !== 'lost' && block !== 'error') return;
    if (deps.field.disabled) return;

    // Dirty after loseOwnership: consent before requesting so we never silently drop private text.
    if (deps.isDirty()) {
      const discard = await deps.confirmDiscardDirtyForHandoff();
      if (!discard || disposed) return;
      // Re-check after the dialog — user may have navigated or ownership may have changed.
      if (deps.editBlock() !== 'busy' && deps.editBlock() !== 'lost' && deps.editBlock() !== 'error') return;
    }

    const documentId = deps.getDocumentId();
    pending = true;
    awaitingEditHere = false;
    pendingDocumentId = documentId;
    pendingSelection = readHandoffSelection(deps.field);
    pendingReaderText = deps.field.value;
    pendingRequestId = crypto.randomUUID();
    buffer = options.initialBuffer ? options.initialBuffer.slice() : [];
    deps.hideEditHere?.();

    const request = {
      documentId,
      fromInstanceId: deps.instanceId,
      requestId: pendingRequestId,
    };

    if (options.steal) {
      await finishTakeover(undefined, true, request.requestId, documentId, false);
      return;
    }

    // Prefer same-origin in-tab yield (may carry unsaved text in memory), but
    // bound the wait so a stalled flush/park cannot swallow input forever.
    let sameOriginTimedOut = false;
    const local = await Promise.race([
      requestSameOriginYield(request).then(result => {
        if (sameOriginTimedOut) {
          // Owner answered after we already fell through — reject a late park.
          if (result?.status === 'released') {
            notifyPeersComplete(request.requestId, false);
            postMeta({
              v: 1,
              type: 'handoff-complete',
              documentId,
              requestId: request.requestId,
              ok: false,
              at: Date.now(),
            });
          }
          return undefined;
        }
        return result;
      }),
      new Promise<undefined>(resolve => {
        setTimeout(() => {
          sameOriginTimedOut = true;
          resolve(undefined);
        }, HANDOFF_YIELD_TIMEOUT_MS);
      }),
    ]);
    if (!pending || pendingRequestId !== request.requestId) return;
    if (deps.getDocumentId() !== documentId) {
      clearPending();
      return;
    }
    if (local?.status === 'released') {
      await finishTakeover(local.snapshot, false, request.requestId, documentId, true);
      return;
    }
    if (local?.status === 'refused') {
      if (local.reason === 'cross-tab-private' || local.reason === 'private') {
        offerEditHere(local.reason);
      } else {
        const dropped = buffer.length > 0;
        clearPending();
        deps.announce(handoffRefuseGuidance(local.reason));
        if (dropped) deps.announce('Your typing was not applied.');
      }
      return;
    }

    // Cross-tab / no peer owner / timed-out same-origin: metadata-only BroadcastChannel.
    postMeta({
      v: 1,
      type: 'handoff-request',
      documentId,
      fromWindowId: deps.windowId ?? '',
      fromInstanceId: deps.instanceId,
      requestId: pendingRequestId,
      at: Date.now(),
    });

    yieldTimer = setTimeout(() => {
      if (!pending || pendingRequestId !== request.requestId) return;
      if (deps.getDocumentId() !== documentId) {
        clearPending();
        return;
      }
      // Never auto-steal — ask the user; unsaved text in an old/suspended tab must not vanish silently.
      offerEditHere('unresponsive');
    }, HANDOFF_YIELD_TIMEOUT_MS);
  };

  const beginParked = (requestId: string, documentId: string): void => {
    clearParked();
    parkedRequestId = requestId;
    parkedDocumentId = documentId;
    confirmTimer = setTimeout(() => {
      if (parkedRequestId !== requestId) return;
      const documentId = parkedDocumentId;
      clearParked();
      void deps.recoverParkedOwnership(documentId);
    }, HANDOFF_CONFIRM_TIMEOUT_MS);
  };

  const yieldFor = async (
    request: {
      documentId: string;
      fromInstanceId: string;
      requestId: string;
    },
    allowPrivateTransfer: boolean,
  ): Promise<SameOriginYieldResult> => {
    const block = ownerYieldBlock({
      isOwner: deps.isOwner() && deps.getDocumentId() === request.documentId,
      composing: deps.isComposing(),
      transitioning: deps.isTransitioning(),
      saving: deps.isSaving(),
      saveFailed: deps.saveFailed(),
      dirty: deps.isDirty(),
      autosaveOn: deps.autosaveOn(),
      allowPrivateTransfer,
    });
    if (block) return { status: 'refused', reason: block };

    if (deps.autosaveOn() && deps.isDirty()) {
      await deps.flushSave();
      const afterFlush = ownerYieldBlock({
        isOwner: deps.isOwner() && deps.getDocumentId() === request.documentId,
        composing: deps.isComposing(),
        transitioning: deps.isTransitioning(),
        saving: deps.isSaving(),
        saveFailed: deps.saveFailed(),
        dirty: deps.isDirty(),
        autosaveOn: deps.autosaveOn(),
        allowPrivateTransfer,
      });
      if (afterFlush) return { status: 'refused', reason: afterFlush };
    }

    // Freeze before capture/release so mid-yield typing cannot miss the snapshot.
    deps.beginParkFreeze();
    const dirty = deps.isDirty();
    // Snapshots only on the same-origin path — never for BroadcastChannel.
    const snapshot = allowPrivateTransfer && dirty ? deps.captureSnapshot() : undefined;
    await deps.finishParkRelease();
    beginParked(request.requestId, request.documentId);

    if (!allowPrivateTransfer) {
      postMeta({
        v: 1,
        type: 'handoff-released',
        documentId: request.documentId,
        toInstanceId: request.fromInstanceId,
        requestId: request.requestId,
        at: Date.now(),
      });
    }
    return { status: 'released', snapshot };
  };

  const onChannelMessage = (event: MessageEvent): void => {
    const message = parseHandoffMessage(event.data);
    if (!message) return;

    if (message.type === 'handoff-complete') {
      if (message.documentId === parkedDocumentId) confirmParked(message.requestId, message.ok);
      return;
    }

    if (message.type === 'handoff-request') {
      if (message.fromInstanceId === deps.instanceId) return;
      // Test hook: simulate a suspended owner that never answers (forces Edit here timeout).
      if (ignoresHandoffRequests()) return;
      if (!deps.isOwner() || deps.getDocumentId() !== message.documentId) return;
      // BroadcastChannel is always cross-tab — never allow private transfer.
      void (async () => {
        const result = await yieldFor({
          documentId: message.documentId,
          fromInstanceId: message.fromInstanceId,
          requestId: message.requestId,
        }, false);
        if (result.status === 'refused') {
          postMeta({
            v: 1,
            type: 'handoff-refused',
            documentId: message.documentId,
            toInstanceId: message.fromInstanceId,
            requestId: message.requestId,
            at: Date.now(),
            reason: result.reason,
          });
        }
      })();
      return;
    }

    if (!pending) return;
    if (message.requestId !== pendingRequestId) return;
    if (message.documentId !== pendingDocumentId) return;
    if (message.type === 'handoff-released' && message.toInstanceId === deps.instanceId) {
      void finishTakeover(undefined, false, message.requestId, pendingDocumentId, false);
      return;
    }
    if (message.type === 'handoff-refused' && message.toInstanceId === deps.instanceId) {
      if (
        message.reason === 'cross-tab-private'
        || message.reason === 'private'
        || message.reason === 'unresponsive'
      ) {
        offerEditHere(message.reason);
      } else {
        const dropped = buffer.length > 0;
        clearPending();
        deps.announce(handoffRefuseGuidance(message.reason));
        if (dropped) deps.announce('Your typing was not applied.');
      }
    }
  };

  const mayStartFromField = (): boolean => {
    if (deps.isViewMode() || deps.field.disabled) return false;
    const block = deps.editBlock();
    return block === 'busy' || block === 'lost' || block === 'error';
  };

  const onPointerDown = (): void => {
    if (!mayStartFromField()) return;
    void startRequest();
  };

  const onClick = (): void => {
    if (!pending) return;
    pendingSelection = readHandoffSelection(deps.field);
    pendingReaderText = deps.field.value;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Tab must move focus out of a read-only editor — never start handoff or buffer it.
    if (event.key === 'Tab') return;
    const insert = bufferInsertFromKeyboard(event);
    if (!insert) return;
    if (pending) {
      event.preventDefault();
      buffer.push(insert);
      return;
    }
    // Keyboard path: first key in a focused read-only field starts handoff (not plain focus).
    if (!mayStartFromField()) return;
    event.preventDefault();
    void startRequest({ initialBuffer: [insert] });
  };

  const onBeforeInput = (event: InputEvent): void => {
    const insert = bufferInsertFromBeforeInput(event);
    if (pending) {
      event.preventDefault();
      if (insert) buffer.push(insert);
      return;
    }
    if (!insert || !mayStartFromField()) return;
    event.preventDefault();
    void startRequest({ initialBuffer: [insert] });
  };

  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    if (pending) {
      event.preventDefault();
      buffer.push({ kind: 'paste', text });
      return;
    }
    if (!mayStartFromField()) return;
    event.preventDefault();
    void startRequest({ initialBuffer: [{ kind: 'paste', text }] });
  };

  deps.field.addEventListener('pointerdown', onPointerDown);
  deps.field.addEventListener('click', onClick);
  deps.field.addEventListener('keydown', onKeyDown);
  deps.field.addEventListener('beforeinput', onBeforeInput);
  deps.field.addEventListener('paste', onPaste);
  channel?.addEventListener('message', onChannelMessage);

  const hooks: FocusHandoffHooks = {
    // When the ignore hook is set, hide from same-origin discovery so the requester
    // falls through to BroadcastChannel and the yield timeout (suspended-owner e2e).
    __typebridgeOwnsDocument: (documentId: string) =>
      !ignoresHandoffRequests() && deps.isOwner() && deps.getDocumentId() === documentId,
    // Direct frame call ⇒ same-tab ⇒ private transfer allowed.
    __typebridgeYieldForHandoff: request => yieldFor(request, true),
    __typebridgeHandoffComplete: confirmParked,
  };
  const win = window as Window & FocusHandoffHooks;
  win.__typebridgeOwnsDocument = hooks.__typebridgeOwnsDocument;
  win.__typebridgeYieldForHandoff = hooks.__typebridgeYieldForHandoff;
  win.__typebridgeHandoffComplete = hooks.__typebridgeHandoffComplete;

  return {
    hooks,
    pending: () => pending,
    requestHandoff: (options) => { void startRequest(options); },
    cancel: () => {
      // Requester: abort in-flight takeover and tell a parked peer to recover.
      if (pending) {
        const requestId = pendingRequestId;
        const documentId = pendingDocumentId;
        const droppedTyping = buffer.length > 0 || awaitingEditHere;
        clearPending();
        deps.hideEditHere?.();
        if (droppedTyping) deps.announce('Your typing was not applied.');
        if (requestId && documentId) {
          notifyPeersComplete(requestId, false);
          postMeta({
            v: 1,
            type: 'handoff-complete',
            documentId,
            requestId,
            ok: false,
            at: Date.now(),
          });
        }
      } else {
        deps.hideEditHere?.();
      }
      // Owner: abandon park without discard/recover — caller is navigating away;
      // dirty handling belongs to the document switch/delete path.
      clearParked();
    },
    dispose: () => {
      disposed = true;
      clearPending();
      if (parkedRequestId) {
        const documentId = parkedDocumentId;
        clearParked();
        void deps.recoverParkedOwnership(documentId);
      }
      deps.field.removeEventListener('pointerdown', onPointerDown);
      deps.field.removeEventListener('click', onClick);
      deps.field.removeEventListener('keydown', onKeyDown);
      deps.field.removeEventListener('beforeinput', onBeforeInput);
      deps.field.removeEventListener('paste', onPaste);
      channel?.removeEventListener('message', onChannelMessage);
      try { channel?.close(); } catch { /* Ignore. */ }
      if (win.__typebridgeOwnsDocument === hooks.__typebridgeOwnsDocument) {
        delete win.__typebridgeOwnsDocument;
      }
      if (win.__typebridgeYieldForHandoff === hooks.__typebridgeYieldForHandoff) {
        delete win.__typebridgeYieldForHandoff;
      }
      if (win.__typebridgeHandoffComplete === hooks.__typebridgeHandoffComplete) {
        delete win.__typebridgeHandoffComplete;
      }
    },
  };
}
