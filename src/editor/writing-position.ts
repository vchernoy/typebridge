import { snapToCodePointBoundary } from './goto-line';

export const POSITION_SAVE_DELAY_MS = 250;
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

/** Comparison viewers use this namespace so they never overwrite an editor's saved offsets (#159). */
export const VIEWER_POSITION_NAMESPACE = 'view:';

export function setupWritingPosition(field: HTMLTextAreaElement, documentId: () => string | undefined, namespace = '') {
  const removed = new Set<string>();
  const prefix = POSITION_PREFIX + namespace;
  let restoring = false;
  let restoreGeneration = 0;
  let previous = '';
  let pending: { id: string; value: WritingPosition } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function capture(): void {
    const id = documentId();
    if (!id || restoring || removed.has(id)) return;
    const value: WritingPosition = {
      start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection,
      scrollTop: Math.max(0, field.scrollTop), scrollLeft: Math.max(0, field.scrollLeft),
    };
    pending = { id, value };
  }
  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const latest = pending;
    pending = undefined;
    if (!latest || !documentId()) return;
    const { id, value } = latest;
    if (removed.has(id)) return;
    const raw = JSON.stringify(value);
    if (previous === id + raw) return;
    try { sessionStorage.setItem(POSITION_PREFIX + namespace + id, raw); previous = id + raw; }
    catch { /* Selection is optional, even if storage is blocked or full. */ }
  }
  // Public save is a synchronous boundary flush before a caller changes documents.
  function save(): void {
    capture();
    flush();
  }
  function schedule(): void {
    capture();
    if (!pending) return;
    clearTimeout(timer);
    timer = setTimeout(flush, POSITION_SAVE_DELAY_MS);
  }
  function restore(id: string): void {
    // Only flush a different, outgoing id; a same-id capture may be a transient
    // caret/scroll from loading or Focus layout and must not replace saved offsets.
    if (pending && pending.id !== id) flush();
    else { clearTimeout(timer); timer = undefined; pending = undefined; }
    const generation = ++restoreGeneration;
    restoring = true;
    previous = '';
    let deferred = false;
    try {
      const position = parseWritingPosition(sessionStorage.getItem(POSITION_PREFIX + namespace + id), field.value);
      if (!position) return;
      field.setSelectionRange(position.start, position.end, position.direction);
      const applyScroll = (): void => {
        field.scrollTop = position.scrollTop;
        field.scrollLeft = position.scrollLeft;
      };
      applyScroll();
      deferred = true;
      // Focus sizing and its queued select/scroll events settle over rendering turns.
      // A newer restore or genuine user input cancels this deferred application.
      requestAnimationFrame(() => {
        if (generation !== restoreGeneration) return;
        if (documentId() !== id) { restoring = false; return; }
        applyScroll();
        requestAnimationFrame(() => {
          if (generation === restoreGeneration) restoring = false;
        });
      });
      return;
    } catch { /* Fall back to the loaded draft's default view. */ }
    finally {
      if (!deferred) restoring = false;
    }
  }
  /** Only call after deletion commits; later events cannot recreate the removed key. */
  function remove(id: string, suppressFutureWrites = true): void {
    if (suppressFutureWrites) removed.add(id);
    if (pending?.id === id) {
      pending = undefined;
      clearTimeout(timer);
      timer = undefined;
    }
    if (documentId() === id) { ++restoreGeneration; restoring = false; }
    previous = '';
    try { sessionStorage.removeItem(prefix + id); } catch { /* Optional metadata. */ }
  }
  /** A successful complete list only. Keep the current unsaved or private document too. */
  function prune(savedIds: Iterable<string>): void {
    const keep = new Set(savedIds);
    const current = documentId();
    if (current) keep.add(current);
    try {
      const stale: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        // Window/view namespaces contain ':' or '.'; document ids contain neither.
        // In particular, an unscoped editor must never prune embedded/viewer keys.
        if (!id || /[:.]/.test(id) || keep.has(id)) continue;
        stale.push(id);
      }
      for (const id of stale) remove(id, false);
    } catch { /* Blocked storage must not affect the document list. */ }
  }
  const cancelRestore = (): void => {
    ++restoreGeneration;
    restoring = false;
  };
  // User intent wins over restoration; input/history also cover programmatic edits.
  for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input', 'historychange', 'wheel', 'touchstart']) {
    field.addEventListener(type, cancelRestore);
  }
  for (const type of ['input', 'select', 'keyup', 'click', 'scroll', 'historychange']) field.addEventListener(type, schedule);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  return { save, restore, remove, prune };
}
