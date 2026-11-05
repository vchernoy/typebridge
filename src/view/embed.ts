/**
 * Embedded editor mode for #175 step 3.
 * Host page owns Settings and the update notice; the iframe runs the editor chrome.
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

/** postMessage type: iframe asks the host to open Settings. */
export const HOST_OPEN_SETTINGS = 'typebridge.host.openSettings';

/** postMessage type: host tells the iframe a preference changed. */
export const HOST_PREF_CHANGED = 'typebridge.host.prefChanged';

export type HostOpenSettingsMessage = {
  type: typeof HOST_OPEN_SETTINGS;
  section?: 'about';
};

export type HostPrefChangedMessage = {
  type: typeof HOST_PREF_CHANGED;
  key: 'autosave' | 'appearance' | 'tab-indent' | 'transliteration' | 'rules' | 'shortcut';
};
