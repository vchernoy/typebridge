/**
 * Embedded editor mode for #175 step 3+.
 * Host page owns the update notice and (step 7) the Settings panel.
 * Pure helpers only — no DOM.
 */

/** True when `embed=1` (or `embed=true`) is present in the query string. */
export function parseEmbedMode(search: string): boolean {
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(normalized);
  } catch {
    return false;
  }
  const raw = params.get('embed');
  return raw === '1' || raw === 'true';
}
