/**
 * Same-tab focus handoff protocol for #175 step 4.
 * Metadata may travel on BroadcastChannel; unsaved text/title/history never does —
 * same-tab transfer uses in-memory same-origin frame calls only.
 *
 * Same-tab vs cross-tab is decided by the transport: a direct frame call is same-tab;
 * every BroadcastChannel message is cross-tab (sessionStorage tokens are not used —
 * duplicate tabs clone them).
 */

import { isDocumentId } from './route';
import { isWindowId, type WindowId } from './window-id';

export const HANDOFF_CHANNEL = 'typebridge-handoff.v1';
/** How long a requester waits for a cooperative yield before offering Edit here (no auto-steal). */
export const HANDOFF_YIELD_TIMEOUT_MS = 2_000;
/** How long a parked owner waits for takeover confirmation before recovering its text. */
export const HANDOFF_CONFIRM_TIMEOUT_MS = 5_000;

export type HandoffSnapshot = {
  text: string;
  title: string;
  history?: unknown;
  dirty: boolean;
  revision: number;
};

export type HandoffRequestMessage = {
  v: 1;
  type: 'handoff-request';
  documentId: string;
  fromWindowId: WindowId | '';
  fromInstanceId: string;
  requestId: string;
  at: number;
};

export type HandoffReleasedMessage = {
  v: 1;
  type: 'handoff-released';
  documentId: string;
  toInstanceId: string;
  requestId: string;
  at: number;
};

export type HandoffRefusedMessage = {
  v: 1;
  type: 'handoff-refused';
  documentId: string;
  toInstanceId: string;
  requestId: string;
  at: number;
  reason: HandoffRefuseReason;
};

export type HandoffCompleteMessage = {
  v: 1;
  type: 'handoff-complete';
  documentId: string;
  requestId: string;
  ok: boolean;
  at: number;
};

export type HandoffRefuseReason =
  | 'ime'
  | 'busy'
  | 'private'
  | 'saving'
  | 'save-failed'
  | 'cross-tab-private'
  | 'unresponsive';

export type HandoffMessage =
  | HandoffRequestMessage
  | HandoffReleasedMessage
  | HandoffRefusedMessage
  | HandoffCompleteMessage;

const REFUSE_REASONS = new Set<HandoffRefuseReason>([
  'ime', 'busy', 'private', 'saving', 'save-failed', 'cross-tab-private', 'unresponsive',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an unknown handoff payload; returns undefined when it must be ignored. */
export function parseHandoffMessage(value: unknown): HandoffMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.type !== 'string') return undefined;
  if (typeof record.documentId !== 'string' || !isDocumentId(record.documentId)) return undefined;
  if (typeof record.requestId !== 'string' || !record.requestId) return undefined;
  if (!isFiniteNumber(record.at)) return undefined;

  if (record.type === 'handoff-request') {
    if (typeof record.fromInstanceId !== 'string' || !record.fromInstanceId) return undefined;
    const fromWindowId = record.fromWindowId;
    if (fromWindowId !== '' && (typeof fromWindowId !== 'string' || !isWindowId(fromWindowId))) return undefined;
    return {
      v: 1,
      type: 'handoff-request',
      documentId: record.documentId,
      fromWindowId: (fromWindowId || '') as WindowId | '',
      fromInstanceId: record.fromInstanceId,
      requestId: record.requestId,
      at: record.at,
    };
  }

  if (record.type === 'handoff-released') {
    if (typeof record.toInstanceId !== 'string' || !record.toInstanceId) return undefined;
    return {
      v: 1,
      type: 'handoff-released',
      documentId: record.documentId,
      toInstanceId: record.toInstanceId,
      requestId: record.requestId,
      at: record.at,
    };
  }

  if (record.type === 'handoff-refused') {
    if (typeof record.toInstanceId !== 'string' || !record.toInstanceId) return undefined;
    if (typeof record.reason !== 'string' || !REFUSE_REASONS.has(record.reason as HandoffRefuseReason)) {
      return undefined;
    }
    return {
      v: 1,
      type: 'handoff-refused',
      documentId: record.documentId,
      toInstanceId: record.toInstanceId,
      requestId: record.requestId,
      at: record.at,
      reason: record.reason as HandoffRefuseReason,
    };
  }

  if (record.type === 'handoff-complete') {
    if (typeof record.ok !== 'boolean') return undefined;
    return {
      v: 1,
      type: 'handoff-complete',
      documentId: record.documentId,
      requestId: record.requestId,
      ok: record.ok,
      at: record.at,
    };
  }

  return undefined;
}

/** Owner-side gate. `allowPrivateTransfer` is true only for same-origin (same-tab) frame calls. */
export function ownerYieldBlock(input: {
  isOwner: boolean;
  composing: boolean;
  transitioning: boolean;
  saving: boolean;
  saveFailed: boolean;
  dirty: boolean;
  autosaveOn: boolean;
  allowPrivateTransfer: boolean;
}): HandoffRefuseReason | '' {
  if (!input.isOwner) return 'busy';
  if (input.transitioning) return 'busy';
  if (input.composing) return 'ime';
  if (input.saving) return 'saving';
  // Failed save: same-tab may still pass the dirty snapshot in memory; cross-tab must refuse.
  if (input.saveFailed && !input.allowPrivateTransfer) return 'save-failed';
  // Cross-tab must never receive private/unsaved text; refuse so requester shows Edit here.
  if (input.dirty && !input.autosaveOn && !input.allowPrivateTransfer) return 'cross-tab-private';
  return '';
}

export function handoffRefuseGuidance(reason: HandoffRefuseReason): string {
  switch (reason) {
    case 'ime':
      return 'The editing window is mid-composition. Finish the composition there, then click here again.';
    case 'busy':
      return 'The editing window is busy with another document action. Click here again in a moment.';
    case 'saving':
      return 'The editing window is still saving. Wait a moment, then click here again.';
    case 'save-failed':
      return 'The editing window could not save. Fix or export there, then try Edit here again.';
    case 'private':
    case 'cross-tab-private':
      return 'The editing window still has unsaved or private changes that cannot be sent here. Edit here takes over with the last saved text; that window keeps its unsaved text for copy or export.';
    case 'unresponsive':
      return 'The other window did not respond. Taking over may leave its unsaved changes behind for copy or export there.';
  }
}

/**
 * Buffered input while a handoff is in flight.
 * - `type`: replay via cancelable `beforeinput` insertText (transliteration).
 * - `paste` / `break`: literal insert (no transliteration pending sequence).
 * - `delete`: Backspace / Delete with the selection at the time of the key.
 * Tab is never buffered — it must leave the field for keyboard users.
 */
export type BufferedInsert =
  | { kind: 'type'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'break'; text: string }
  | { kind: 'delete'; direction: 'backward' | 'forward'; start: number; end: number };

export function bufferInsertFromKeyboard(
  event: KeyboardEvent,
  field?: Pick<HTMLTextAreaElement, 'selectionStart' | 'selectionEnd'>,
): BufferedInsert | undefined {
  if (event.isComposing || event.key === 'Process') return undefined;
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  // Never trap Tab/Shift+Tab — focus must leave a read-only editor.
  if (event.key === 'Tab') return undefined;
  if (event.key === 'Enter') return { kind: 'break', text: '\n' };
  if (event.key === 'Backspace' || event.key === 'Delete') {
    const start = field?.selectionStart ?? 0;
    const end = field?.selectionEnd ?? start;
    return {
      kind: 'delete',
      direction: event.key === 'Backspace' ? 'backward' : 'forward',
      start,
      end,
    };
  }
  if (event.key.length === 1) return { kind: 'type', text: event.key };
  return undefined;
}

/** Replay one buffered insert through the field so typing hits Editor.beforeInput. */
export function replayBufferedInsert(field: HTMLTextAreaElement, item: BufferedInsert): void {
  if (item.kind === 'delete') {
    let start = item.start;
    let end = item.end;
    if (start === end) {
      if (item.direction === 'backward') {
        if (start <= 0) return;
        start -= 1;
      } else {
        if (end >= field.value.length) return;
        end += 1;
      }
    }
    start = Math.max(0, Math.min(start, field.value.length));
    end = Math.max(start, Math.min(end, field.value.length));
    field.setSelectionRange(start, end);
    const before = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: item.direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward',
    });
    field.dispatchEvent(before);
    if (before.defaultPrevented) return;
    field.setRangeText('', start, end, 'end');
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: item.direction === 'backward' ? 'deleteContentBackward' : 'deleteContentForward',
    }));
    return;
  }
  if (item.kind === 'paste' || item.kind === 'break') {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.setRangeText(item.text, start, end, 'end');
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: item.kind === 'paste' ? 'insertFromPaste' : 'insertLineBreak',
      data: item.text,
    }));
    return;
  }
  for (const char of item.text) {
    const before = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: char,
    });
    field.dispatchEvent(before);
    if (before.defaultPrevented) continue;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.setRangeText(char, start, end, 'end');
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: char,
    }));
  }
}

export type SameOriginYieldResult =
  | { status: 'released'; snapshot?: HandoffSnapshot }
  | { status: 'refused'; reason: HandoffRefuseReason };

export type FocusHandoffHooks = {
  __typebridgeOwnsDocument?: (documentId: string) => boolean;
  __typebridgeYieldForHandoff?: (request: {
    documentId: string;
    fromInstanceId: string;
    requestId: string;
  }) => Promise<SameOriginYieldResult>;
  /** Requester confirms takeover so the parked owner can discard or recover its text. */
  __typebridgeHandoffComplete?: (requestId: string, ok: boolean) => void;
};
