/**
 * Per-window identity for #175 step 2.
 * Same-origin iframes in one tab share sessionStorage; key tab-scoped state by window id.
 * Pure helpers only — no DOM.
 */

/** Opaque window id from `?window=` (host assigns; not a document id). */
export type WindowId = string;

const WINDOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function isWindowId(value: string): boolean {
  return WINDOW_ID_RE.test(value);
}

/**
 * Read `window` from a query string (with or without leading `?`).
 * Absent/empty → undefined (legacy single-page keys). Invalid → undefined
 * (fail soft to unscoped keys rather than blocking boot).
 */
export function parseWindowId(search: string): WindowId | undefined {
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(normalized);
  } catch {
    return undefined;
  }
  const raw = params.get('window');
  if (raw === null || raw === '') return undefined;
  return isWindowId(raw) ? raw : undefined;
}

/**
 * Scope a sessionStorage key to a window instance.
 * Unscoped when `windowId` is undefined so today's top-level editor keeps
 * stable key names and existing e2e fixtures keep working.
 */
export function scopeSessionKey(baseKey: string, windowId: WindowId | undefined): string {
  if (!windowId) return baseKey;
  return `${baseKey}::w:${windowId}`;
}

/**
 * Writing-position namespace segment (before document id).
 * Combines optional window scope with the viewer namespace from #159 W2.
 */
export function writingPositionNamespace(
  windowId: WindowId | undefined,
  viewer = false,
): string {
  const windowPart = windowId ? `w:${windowId}.` : '';
  const viewerPart = viewer ? 'view:' : '';
  return windowPart + viewerPart;
}
