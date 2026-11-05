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
    caret: number;
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

/** Read-only textareas often keep selection at 0–0 on click; default to end so buffered keys append. */
function readHandoffCaret(field: HTMLTextAreaElement): number {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (typeof start !== 'number') return field.value.length;
  if (field.readOnly && start === 0 && end === 0 && field.value.length > 0) return field.value.length;
  return start;
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
  let pendingCaret = 0;
  let buffer: BufferedInsert[] = [];
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  /** Owner-side parked yield awaiting requester confirmation. */
  let parkedRequestId = '';
  let parkedDocumentId = '';
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const postMeta = (message: HandoffMessage): void => {
    try { channel?.postMessage(message); } catch { /* Channel may be closed. */ }
  };

  const clearPending = (): void => {
    pending = false;
    pendingRequestId = '';
    pendingDocumentId = '';
    buffer = [];
    clearTimeout(yieldTimer);
    yieldTimer = undefined;
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
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        pendingCaret = readHandoffCaret(deps.field);
        resolve();
      });
    });
    if (!pending || pendingRequestId !== requestId) return;
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
    const caret = pendingCaret;
    // Keep pending=true so keystrokes during acquire/reread stay buffered.
    clearTimeout(yieldTimer);
    yieldTimer = undefined;

    const ok = await deps.takeOver({ documentId, snapshot, caret, steal });
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
    if (disposed || pending || deps.isViewMode()) return;
    const block = deps.editBlock();
    if (block !== 'busy' && block !== 'lost' && block !== 'error') return;
    if (deps.field.disabled) return;

    const documentId = deps.getDocumentId();
    pending = true;
    pendingDocumentId = documentId;
    pendingCaret = readHandoffCaret(deps.field);
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

    // Prefer same-origin in-tab yield (may carry unsaved text in memory).
    const local = await requestSameOriginYield(request);
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
      clearPending();
      if (local.reason === 'cross-tab-private' || local.reason === 'private') {
        deps.showEditHere(local.reason);
      } else {
        deps.announce(handoffRefuseGuidance(local.reason));
      }
      return;
    }

    // Cross-tab / no peer owner: metadata-only BroadcastChannel (never same-tab).
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
      clearPending();
      // Never auto-steal — ask the user; unsaved text in an old/suspended tab must not vanish silently.
      deps.showEditHere('unresponsive');
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
      clearPending();
      if (
        message.reason === 'cross-tab-private'
        || message.reason === 'private'
        || message.reason === 'unresponsive'
      ) {
        deps.showEditHere(message.reason);
      } else {
        deps.announce(handoffRefuseGuidance(message.reason));
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
    pendingCaret = readHandoffCaret(deps.field);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
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
    if (event.isComposing) return;
    const data = event.data;
    const insert: BufferedInsert | undefined = typeof data === 'string' && data.length > 0
      ? { kind: event.inputType === 'insertFromPaste' ? 'paste' : 'type', text: data }
      : (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')
        ? { kind: 'break', text: '\n' }
        : undefined;
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
    __typebridgeOwnsDocument: (documentId: string) =>
      deps.isOwner() && deps.getDocumentId() === documentId,
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
        clearPending();
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
      }
      // Owner: abandon park without discard/recover — caller is navigating away;
      // dirty handling belongs to the document switch/delete path.
      clearParked();
      deps.hideEditHere?.();
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
