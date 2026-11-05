/**
 * Comparison-window routing contracts for #159.
 * Query params only (hash reserved for portable share links, #39).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ViewMode = 'view';

export type ComparisonRoute =
  | { kind: 'viewer'; documentId: string }
  | { kind: 'ordinary' }
  | { kind: 'invalid'; reason: 'missing-doc' | 'bad-doc' | 'bad-mode' };

/**
 * True for ids TypeBridge stores in IndexedDB: a UUID, or a recovery copy
 * (`recovery-<uuid>` from emergency recovery).
 */
export function isDocumentId(value: string): boolean {
  if (UUID_RE.test(value)) return true;
  return value.startsWith('recovery-') && UUID_RE.test(value.slice('recovery-'.length));
}

/**
 * Parse comparison routing from a query string (with or without leading `?`).
 * Unknown params are ignored. `mode=view` without a valid `doc` is invalid.
 * Only an absent/empty `mode` yields ordinary boot. Any other mode value is
 * invalid and must take the no-write missing/error path (not ordinary editor).
 */
export function parseComparisonRoute(search: string): ComparisonRoute {
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(normalized);
  } catch {
    return { kind: 'ordinary' };
  }

  const mode = params.get('mode');
  if (mode === null || mode === '') return { kind: 'ordinary' };
  if (mode !== 'view') return { kind: 'invalid', reason: 'bad-mode' };

  const doc = params.get('doc');
  if (doc === null || doc === '') return { kind: 'invalid', reason: 'missing-doc' };
  if (!isDocumentId(doc)) return { kind: 'invalid', reason: 'bad-doc' };
  return { kind: 'viewer', documentId: doc };
}

/**
 * Build a same-origin comparison URL path+query for `window.open`.
 * `base` is Vite's base (e.g. `/`); trailing slashes are normalized.
 * Optional `windowId` keeps #175 per-window sessionStorage identity across
 * viewer document switches / reloads (same-tab iframe host).
 */
export function comparisonViewerHref(
  base: string,
  documentId: string,
  windowId?: string,
): string | undefined {
  if (!isDocumentId(documentId)) return undefined;
  const root = base.endsWith('/') ? base : `${base}/`;
  const path = root === '/' ? '/' : root;
  const query = new URLSearchParams({ doc: documentId, mode: 'view' });
  if (windowId) query.set('window', windowId);
  return `${path}?${query.toString()}`;
}
