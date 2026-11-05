/**
 * #175 step 4: pointer/focus into a read-only window’s text triggers cooperative
 * same-tab handoff (in-memory snapshot) or cross-tab release / Edit here / steal.
 */
import {
  HANDOFF_CHANNEL,
  HANDOFF_YIELD_TIMEOUT_MS,
  bufferInsertFromKeyboard,
  ensureTabToken,
  handoffRefuseGuidance,
  metadataOnlyHandoff,
  ownerYieldBlock,
  parseHandoffMessage,
  sameTab,
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
  tabToken?: string;
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
  releaseOwnership: () => Promise<void>;
  /**
   * Become owner after a cooperative release. `snapshot` is set only for same-tab
   * unsaved/private transfer; otherwise reread IndexedDB under the new fence.
   */
  takeOver: (input: {
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
  /** Owner hook used by peer same-origin frames. */
  hooks: FocusHandoffHooks;
  /** True while this window is mid handoff as requester. */
  pending: () => boolean;
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
    tabToken: string;
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

export function installFocusHandoff(deps: FocusHandoffDeps): FocusHandoffController {
  const tabToken = deps.tabToken ?? ensureTabToken();
  const channel = openChannel(deps.channel);
  let disposed = false;
  let pending = false;
  let pendingRequestId = '';
  let pendingCaret = 0;
  let buffer: BufferedInsert[] = [];
  let stealTimer: ReturnType<typeof setTimeout> | undefined;

  const postMeta = (message: HandoffMessage): void => {
    try { channel?.postMessage(metadataOnlyHandoff(message)); } catch { /* Channel may be closed. */ }
  };

  const clearPending = (): void => {
    pending = false;
    pendingRequestId = '';
    buffer = [];
    clearTimeout(stealTimer);
    stealTimer = undefined;
  };

  const applyBuffer = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.map(item => item.text).join('');
    buffer = [];
    if (!text) return;
    const field = deps.field;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const before = field.value.slice(0, start);
    const after = field.value.slice(end);
    field.value = before + text + after;
    const caret = before.length + text.length;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const finishTakeover = async (
    snapshot: HandoffSnapshot | undefined,
    steal: boolean,
  ): Promise<void> => {
    // Let the click update selection when the browser will; then read a stable caret.
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        pendingCaret = readHandoffCaret(deps.field);
        resolve();
      });
    });
    const caret = pendingCaret;
    const inserts = buffer.slice();
    clearPending();
    buffer = inserts;
    const ok = await deps.takeOver({ snapshot, caret, steal });
    if (ok) {
      applyBuffer();
      deps.hideEditHere?.();
      deps.announce('You can edit this document in this window now.');
    } else {
      buffer = [];
    }
  };

  const startRequest = async (caret: number): Promise<void> => {
    if (disposed || pending || deps.isViewMode()) return;
    const block = deps.editBlock();
    if (block !== 'busy' && block !== 'lost' && block !== 'error') return;
    if (deps.field.disabled) return;

    pending = true;
    pendingCaret = caret;
    pendingRequestId = crypto.randomUUID();
    buffer = [];
    deps.hideEditHere?.();

    const documentId = deps.getDocumentId();
    const request = {
      documentId,
      fromInstanceId: deps.instanceId,
      requestId: pendingRequestId,
      tabToken,
    };

    // Prefer same-origin in-tab yield (may carry unsaved text in memory).
    const local = await requestSameOriginYield(request);
    if (!pending || pendingRequestId !== request.requestId) return;
    if (local?.status === 'released') {
      await finishTakeover(local.snapshot, false);
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

    // Cross-tab / no peer owner found: metadata-only BroadcastChannel request.
    postMeta({
      v: 1,
      type: 'handoff-request',
      tabToken,
      documentId,
      fromWindowId: deps.windowId ?? '',
      fromInstanceId: deps.instanceId,
      requestId: pendingRequestId,
      at: Date.now(),
    });

    stealTimer = setTimeout(() => {
      void (async () => {
        if (!pending || pendingRequestId !== request.requestId) return;
        await finishTakeover(undefined, true);
      })();
    }, HANDOFF_YIELD_TIMEOUT_MS);
  };

  const yieldFor = async (request: {
    documentId: string;
    fromInstanceId: string;
    requestId: string;
    tabToken: string;
  }): Promise<SameOriginYieldResult> => {
    const isSameTab = sameTab(tabToken, request.tabToken);
    const block = ownerYieldBlock({
      isOwner: deps.isOwner() && deps.getDocumentId() === request.documentId,
      composing: deps.isComposing(),
      transitioning: deps.isTransitioning(),
      saving: deps.isSaving(),
      saveFailed: deps.saveFailed(),
      dirty: deps.isDirty(),
      autosaveOn: deps.autosaveOn(),
      sameTab: isSameTab,
    });
    if (block) return { status: 'refused', reason: block };

    // Flush Autosave so IndexedDB holds the latest committed text for a clean handoff.
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
        sameTab: isSameTab,
      });
      if (afterFlush) return { status: 'refused', reason: afterFlush };
    }

    const dirty = deps.isDirty();
    // Same-tab may pass unsaved text in memory; never attach a snapshot for cross-tab.
    const snapshot = isSameTab && dirty ? deps.captureSnapshot() : undefined;
    await deps.releaseOwnership();

    if (!isSameTab) {
      postMeta({
        v: 1,
        type: 'handoff-released',
        tabToken,
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

    if (message.type === 'handoff-request') {
      if (message.fromInstanceId === deps.instanceId) return;
      if (!deps.isOwner() || deps.getDocumentId() !== message.documentId) return;
      void (async () => {
        const result = await yieldFor({
          documentId: message.documentId,
          fromInstanceId: message.fromInstanceId,
          requestId: message.requestId,
          tabToken: message.tabToken,
        });
        if (result.status === 'refused') {
          postMeta({
            v: 1,
            type: 'handoff-refused',
            tabToken,
            documentId: message.documentId,
            toInstanceId: message.fromInstanceId,
            requestId: message.requestId,
            at: Date.now(),
            reason: result.reason,
          });
        }
        // released is posted inside yieldFor for cross-tab; same-tab uses frame call.
      })();
      return;
    }

    if (!pending) return;
    if (message.requestId !== pendingRequestId) return;
    if (message.type === 'handoff-released' && message.toInstanceId === deps.instanceId) {
      // BroadcastChannel must never carry snapshot — always reread IndexedDB.
      void finishTakeover(undefined, false);
      return;
    }
    if (message.type === 'handoff-refused' && message.toInstanceId === deps.instanceId) {
      clearPending();
      if (message.reason === 'cross-tab-private' || message.reason === 'private') {
        deps.showEditHere(message.reason);
      } else {
        deps.announce(handoffRefuseGuidance(message.reason));
      }
    }
  };

  const onPointerDown = (): void => {
    if (deps.isViewMode()) return;
    const block = deps.editBlock();
    if (block !== 'busy' && block !== 'lost' && block !== 'error') return;
    void startRequest(readHandoffCaret(deps.field));
  };

  const onClick = (): void => {
    if (!pending) return;
    pendingCaret = readHandoffCaret(deps.field);
  };

  const onFocus = (): void => {
    if (deps.isViewMode()) return;
    const block = deps.editBlock();
    if (block !== 'busy' && block !== 'lost' && block !== 'error') return;
    if (pending) return;
    void startRequest(deps.field.selectionStart);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!pending) return;
    const insert = bufferInsertFromKeyboard(event);
    if (!insert) return;
    event.preventDefault();
    buffer.push(insert);
  };

  const onBeforeInput = (event: InputEvent): void => {
    if (!pending) return;
    if (event.isComposing) return;
    const data = event.data;
    if (typeof data === 'string' && data.length > 0) {
      event.preventDefault();
      buffer.push({ text: data });
    } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.preventDefault();
      buffer.push({ text: '\n' });
    } else {
      event.preventDefault();
    }
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (!pending) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) buffer.push({ text });
  };

  deps.field.addEventListener('pointerdown', onPointerDown);
  deps.field.addEventListener('click', onClick);
  deps.field.addEventListener('focus', onFocus);
  deps.field.addEventListener('keydown', onKeyDown);
  deps.field.addEventListener('beforeinput', onBeforeInput);
  deps.field.addEventListener('paste', onPaste);
  channel?.addEventListener('message', onChannelMessage);

  const hooks: FocusHandoffHooks = {
    __typebridgeOwnsDocument: (documentId: string) =>
      deps.isOwner() && deps.getDocumentId() === documentId,
    __typebridgeYieldForHandoff: yieldFor,
  };
  const win = window as Window & FocusHandoffHooks;
  win.__typebridgeOwnsDocument = hooks.__typebridgeOwnsDocument;
  win.__typebridgeYieldForHandoff = hooks.__typebridgeYieldForHandoff;

  return {
    hooks,
    pending: () => pending,
    dispose: () => {
      disposed = true;
      clearPending();
      deps.field.removeEventListener('pointerdown', onPointerDown);
      deps.field.removeEventListener('click', onClick);
      deps.field.removeEventListener('focus', onFocus);
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
    },
  };
}
