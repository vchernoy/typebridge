/**
 * #175 step 7: shared preference notifications across host + editor windows.
 * localStorage is shared, but `storage` events do not fire in the writing document —
 * same-tab windows need a CustomEvent (and optional direct frame calls).
 */
import { editorWindowApi } from './embed-api';

export const PREFS_EVENT = 'typebridge-prefs';

export type PrefName =
  | 'transliteration'
  | 'shortcut'
  | 'appearance'
  | 'tabIndent'
  | 'autosave'
  | 'rules'
  | 'windowLayout'
  | 'reset';

export type PrefsDetail = {
  name: PrefName;
  /** Optional opaque token so the writer can ignore its own echo. */
  origin?: string;
};

/** Dispatch a same-tab prefs change on this window and, when embedded, the host parent. */
export function notifyPrefsChanged(detail: PrefsDetail): void {
  const event = new CustomEvent(PREFS_EVENT, { detail });
  try {
    window.dispatchEvent(event);
  } catch { /* Ignore dispatch failures. */ }
  try {
    if (window.parent !== window) {
      window.parent.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail }));
    }
  } catch { /* Cross-origin parent is out of scope. */ }
}

/**
 * Listen for prefs changes on this window.
 * Embedded editors must not register on `window.parent`: removing an iframe does not
 * remove parent-owned listeners, and a discarded Autosave-off handler could later
 * recreate journals. The host fans out via `applyPrefsToFrames` instead.
 * Returns an unsubscribe function.
 */
export function onPrefsChanged(
  handler: (detail: PrefsDetail) => void,
  options?: { skipOrigin?: string },
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<PrefsDetail>).detail;
    if (!detail?.name) return;
    if (options?.skipOrigin && detail.origin === options.skipOrigin) return;
    handler(detail);
  };
  window.addEventListener(PREFS_EVENT, listener);
  return () => {
    window.removeEventListener(PREFS_EVENT, listener);
  };
}

/** Ask every same-origin editor iframe to apply a preference. */
export function applyPrefsToFrames(
  frames: Iterable<HTMLIFrameElement>,
  name: PrefName,
  origin?: string,
): void {
  for (const frame of frames) {
    try {
      editorWindowApi(frame.contentWindow)?.__typebridgeApplyPrefs?.(name, origin);
    } catch { /* Frame may be mid-navigation. */ }
  }
}
