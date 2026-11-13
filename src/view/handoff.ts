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
  /** Source document's own `private` flag — not inferred from dirty or the global session (#257). */
  private: boolean;
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
  | { kind: 'delete'; direction: 'backward' | 'forward' };

export function bufferInsertFromKeyboard(event: KeyboardEvent): BufferedInsert | undefined {
  if (event.isComposing || event.key === 'Process') return undefined;
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  // Never trap Tab/Shift+Tab — focus must leave a read-only editor.
  if (event.key === 'Tab') return undefined;
  if (event.key === 'Enter') return { kind: 'break', text: '\n' };
  if (event.key === 'Backspace' || event.key === 'Delete') {
    return {
      kind: 'delete',
      direction: event.key === 'Backspace' ? 'backward' : 'forward',
    };
  }
  if (event.key.length === 1) return { kind: 'type', text: event.key };
  return undefined;
}

/**
 * Virtual keyboards often emit Backspace/Delete only as `beforeinput` without a
 * prior `keydown`. Translate those (and insert) input types into buffer items.
 */
export function bufferInsertFromBeforeInput(event: Pick<InputEvent, 'inputType' | 'data' | 'isComposing'>): BufferedInsert | undefined {
  if (event.isComposing) return undefined;
  if (event.inputType === 'deleteContentBackward') {
    return { kind: 'delete', direction: 'backward' };
  }
  if (event.inputType === 'deleteContentForward') {
    return { kind: 'delete', direction: 'forward' };
  }
  if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
    return { kind: 'break', text: '\n' };
  }
  const data = event.data;
  if (typeof data === 'string' && data.length > 0) {
    return {
      kind: event.inputType === 'insertFromPaste' ? 'paste' : 'type',
      text: data,
    };
  }
  return undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Start offset of the grapheme that ends at `offset` (Backspace target). */
export function previousGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped <= 0) return 0;
  try {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let last = 0;
      for (const { index, segment } of segmenter.segment(text)) {
        const end = index + segment.length;
        if (end === clamped) return index;
        if (index < clamped && clamped < end) return index;
        if (index >= clamped) break;
        last = index;
      }
      return last;
    }
  } catch { /* Fall through to code-point stepping. */ }
  if (
    clamped >= 2
    && isLowSurrogate(text.charCodeAt(clamped - 1))
    && isHighSurrogate(text.charCodeAt(clamped - 2))
  ) {
    return clamped - 2;
  }
  return clamped - 1;
}

/** End offset of the grapheme that starts at `offset` (Delete target). */
export function nextGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped >= text.length) return text.length;
  try {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const { index, segment } of segmenter.segment(text)) {
        const end = index + segment.length;
        if (index <= clamped && clamped < end) return end;
        if (index > clamped) return index;
      }
      return text.length;
    }
  } catch { /* Fall through to code-point stepping. */ }
  if (
    clamped + 1 < text.length
    && isHighSurrogate(text.charCodeAt(clamped))
    && isLowSurrogate(text.charCodeAt(clamped + 1))
  ) {
    return clamped + 2;
  }
  return clamped + 1;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const limit = Math.min(a.length - prefixLength, b.length - prefixLength);
  let i = 0;
  while (
    i < limit
    && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i += 1;
  }
  return i;
}

/** True when `offset` is the start of a grapheme (or the string edge). */
function isGraphemeBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const prev = previousGraphemeBoundary(text, offset);
  return nextGraphemeBoundary(text, prev) === offset;
}

/** Pull a shared UTF-16 seam back so it is a grapheme boundary in both strings. */
function snapSharedPrefixSeam(a: string, b: string, offset: number): number {
  let o = Math.max(0, Math.min(offset, a.length, b.length));
  while (o > 0 && (!isGraphemeBoundary(a, o) || !isGraphemeBoundary(b, o))) {
    const back = Math.min(previousGraphemeBoundary(a, o), previousGraphemeBoundary(b, o));
    if (back >= o) return 0;
    o = back;
  }
  return o;
}

/** Shrink a shared suffix until both suffix-start seams sit on grapheme boundaries. */
function snapSharedSuffixLength(a: string, b: string, prefix: number, suffix: number): number {
  let s = Math.max(0, suffix);
  while (s > 0) {
    const aStart = a.length - s;
    const bStart = b.length - s;
    if (aStart < prefix || bStart < prefix) {
      return Math.max(0, Math.min(a.length - prefix, b.length - prefix));
    }
    if (isGraphemeBoundary(a, aStart) && isGraphemeBoundary(b, bStart)) return s;
    const advance = Math.max(
      nextGraphemeBoundary(a, aStart) - aStart,
      nextGraphemeBoundary(b, bStart) - bStart,
    );
    if (advance <= 0) return 0;
    s -= advance;
  }
  return 0;
}

/**
 * Map a selection measured against `fromText` onto `toText` after a handoff install.
 * Shared prefix/suffix keep their relative offsets; a selection that touches the
 * changed middle collapses so the first buffered edit inserts instead of replacing
 * characters the user never selected. Prefix/suffix seams are snapped to grapheme
 * boundaries so surrogate pairs and combining sequences are never split.
 */
export function mapSelectionAcrossTextChange(
  fromText: string,
  toText: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const a = Math.max(0, Math.min(Math.min(start, end), fromText.length));
  const b = Math.max(0, Math.min(Math.max(start, end), fromText.length));
  if (fromText === toText) {
    const len = toText.length;
    return { start: Math.min(a, len), end: Math.min(b, len) };
  }

  const prefix = snapSharedPrefixSeam(fromText, toText, commonPrefixLength(fromText, toText));
  const suffix = snapSharedSuffixLength(
    fromText,
    toText,
    prefix,
    commonSuffixLength(fromText, toText, prefix),
  );
  const fromSuffixStart = fromText.length - suffix;
  const toSuffixStart = toText.length - suffix;

  const mapPoint = (offset: number): number => {
    if (offset <= prefix) return offset;
    if (offset >= fromSuffixStart) return toSuffixStart + (offset - fromSuffixStart);
    return prefix;
  };

  const entirelyInPrefix = b <= prefix;
  const entirelyInSuffix = a >= fromSuffixStart;
  if (entirelyInPrefix || entirelyInSuffix) {
    return { start: mapPoint(a), end: mapPoint(b) };
  }
  // Touches the changed middle — collapse at the seam so we never replace foreign text.
  return { start: prefix, end: prefix };
}

/**
 * Range a buffered Backspace/Delete should remove. Non-collapsed selections are
 * replaced as-is; collapsed carets expand by one grapheme (code-point fallback).
 */
export function deleteRangeForDirection(
  text: string,
  start: number,
  end: number,
  direction: 'backward' | 'forward',
): { start: number; end: number } | undefined {
  const a = Math.max(0, Math.min(Math.min(start, end), text.length));
  const b = Math.max(0, Math.min(Math.max(start, end), text.length));
  if (a !== b) return { start: a, end: b };
  if (direction === 'backward') {
    if (a <= 0) return undefined;
    return { start: previousGraphemeBoundary(text, a), end: a };
  }
  if (b >= text.length) return undefined;
  return { start: b, end: nextGraphemeBoundary(text, b) };
}

/** Replay one buffered insert through the field so typing hits Editor.beforeInput. */
export function replayBufferedInsert(field: HTMLTextAreaElement, item: BufferedInsert): void {
  if (item.kind === 'delete') {
    // Use the live caret after prior replayed ops — never stale absolute offsets.
    const range = deleteRangeForDirection(
      field.value,
      field.selectionStart,
      field.selectionEnd,
      item.direction,
    );
    if (!range) return;
    const { start, end } = range;
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
