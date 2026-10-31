import { snapToCodePointBoundary } from './goto-line';

export const POSITION_PREFIX = 'typebridge.writingPosition.v1.';
export type WritingPosition = {
  start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number; scrollLeft: number;
};

/** Optional view metadata only: never store text or change a draft/history. */
export function parseWritingPosition(raw: string | null, text: string): WritingPosition | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return;
    const p = value as WritingPosition;
    if (!Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start < 0 || p.end < p.start ||
        !['forward', 'backward', 'none'].includes(p.direction) ||
        !Number.isFinite(p.scrollTop) || p.scrollTop < 0 || !Number.isFinite(p.scrollLeft) || p.scrollLeft < 0) return;
    return {
      start: snapToCodePointBoundary(text, p.start), end: snapToCodePointBoundary(text, p.end),
      direction: p.direction, scrollTop: p.scrollTop, scrollLeft: p.scrollLeft,
    };
  } catch { /* Corrupt or old optional state must not prevent loading a draft. */ }
}

export function setupWritingPosition(field: HTMLTextAreaElement, documentId: () => string | undefined) {
  let restoring = false;
  let previous = '';
  function save(): void {
    const id = documentId();
    if (!id || restoring) return;
    const value: WritingPosition = {
      start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection,
      scrollTop: Math.max(0, field.scrollTop), scrollLeft: Math.max(0, field.scrollLeft),
    };
    const raw = JSON.stringify(value);
    if (previous === id + raw) return;
    try { sessionStorage.setItem(POSITION_PREFIX + id, raw); previous = id + raw; }
    catch { /* Selection is optional, even if storage is blocked or full. */ }
  }
  function restore(id: string): void {
    restoring = true;
    previous = '';
    try {
      const position = parseWritingPosition(sessionStorage.getItem(POSITION_PREFIX + id), field.value);
      if (!position) return;
      field.setSelectionRange(position.start, position.end, position.direction);
      // Set scroll after selection; the browser clamps it to the current layout.
      field.scrollTop = position.scrollTop;
      field.scrollLeft = position.scrollLeft;
    } catch { /* Fall back to the loaded draft's default view. */ }
    finally { restoring = false; }
  }
  for (const type of ['input', 'select', 'keyup', 'click', 'scroll', 'historychange']) field.addEventListener(type, save);
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  return { save, restore };
}
