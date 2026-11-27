import { notifyPrefsChanged, onPrefsChanged } from '../view/prefs-sync';

export const APPEARANCE_KEY = 'typebridge.appearance.v1';
export type Appearance = 'system' | 'light' | 'dark';
export function appearanceChoice(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}
/**
 * Settings → Appearance → Style: the look of the app and of rendered documents (ActiveMD
 * styles.css). The ids match ActiveMD's ACTIVE_STYLES (a unit test keeps them in step); the list
 * is duplicated so the main bundle never loads the renderer. Plain sets no attribute.
 */
export const STYLE_KEY = 'typebridge.style.v1';
/** The Hand-drawn checkbox (#406) saved 'on' here; read as the sketch style while no style is saved. */
export const LEGACY_SKETCH_KEY = 'typebridge.sketch.v1';
export const STYLE_IDS = ['plain', 'sketch', 'brutal', 'notebook', 'chalkboard'] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export function styleChoice(value: unknown): StyleId {
  return STYLE_IDS.some(id => id === value) ? value as StyleId : 'plain';
}
/** The saved style, or the Hand-drawn checkbox of the previous release. Throws when storage is blocked. */
export function storedStyle(storage: Pick<Storage, 'getItem'>): StyleId {
  const saved = storage.getItem(STYLE_KEY);
  if (saved !== null) return styleChoice(saved);
  return storage.getItem(LEGACY_SKETCH_KEY) === 'on' ? 'sketch' : 'plain';
}
function applyStyle(root: HTMLElement, style: StyleId): void {
  if (style === 'plain') delete root.dataset.activeStyle;
  else root.dataset.activeStyle = style;
}

export function setupAppearance(
  preferenceSaved: (name: string, saved: boolean) => void,
  options?: { prefsOrigin?: string },
): { reset: () => boolean; applyFromStorage: () => void } {
  const select = document.querySelector<HTMLSelectElement>('#appearance');
  const styleSelect = document.querySelector<HTMLSelectElement>('#doc-style');
  const prefsOrigin = options?.prefsOrigin ?? 'editor';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice: Appearance = 'system';
  let applyingRemote = false;
  let style: StyleId = 'plain';
  try { choice = appearanceChoice(localStorage.getItem(APPEARANCE_KEY)); } catch { /* Keep System when storage is blocked. */ }
  try { style = storedStyle(localStorage); } catch { /* Keep the plain look when storage is blocked. */ }
  function apply(): void {
    const scheme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.colorScheme = scheme;
    applyStyle(document.documentElement, style);
    if (select) select.value = choice;
    if (styleSelect) styleSelect.value = style;
    // #175 host page: keep the parent document in sync when this runs in an iframe.
    try {
      if (window.parent !== window) {
        window.parent.document.documentElement.dataset.colorScheme = scheme;
        applyStyle(window.parent.document.documentElement, style);
      }
    } catch { /* Cross-origin parent is out of scope. */ }
  }
  function saveStyle(value: StyleId, opts?: { silent?: boolean }): boolean {
    style = value;
    apply();
    try {
      if (value === 'plain') localStorage.removeItem(STYLE_KEY);
      else localStorage.setItem(STYLE_KEY, value);
      // The previous release's checkbox would otherwise bring the sketch style back.
      localStorage.removeItem(LEGACY_SKETCH_KEY);
      preferenceSaved('style', true);
      if (!opts?.silent) notifyPrefsChanged({ name: 'appearance', origin: prefsOrigin });
      return true;
    } catch {
      preferenceSaved('style', false);
      return false;
    }
  }
  function save(value: Appearance, opts?: { silent?: boolean }): boolean {
    choice = value;
    apply();
    try {
      localStorage.setItem(APPEARANCE_KEY, value);
      preferenceSaved('appearance', true);
      if (!opts?.silent) notifyPrefsChanged({ name: 'appearance', origin: prefsOrigin });
      return true;
    } catch {
      preferenceSaved('appearance', false);
      return false;
    }
  }
  function applyFromStorage(): void {
    applyingRemote = true;
    try {
      try { choice = appearanceChoice(localStorage.getItem(APPEARANCE_KEY)); } catch { /* keep */ }
      try { style = storedStyle(localStorage); } catch { /* keep */ }
      apply();
    } finally {
      applyingRemote = false;
    }
  }
  apply();
  system.addEventListener('change', () => { if (choice === 'system') apply(); });
  select?.addEventListener('change', () => {
    if (applyingRemote) return;
    save(appearanceChoice(select.value));
  });
  styleSelect?.addEventListener('change', () => {
    if (applyingRemote) return;
    saveStyle(styleChoice(styleSelect.value));
  });
  onPrefsChanged(detail => {
    if (detail.name === 'appearance' || detail.name === 'reset') applyFromStorage();
  }, { skipOrigin: prefsOrigin });
  return {
    // Both run so one storage failure does not leave the other preference unreset.
    reset: () => { const scheme = save('system', { silent: true }); const look = saveStyle('plain'); return scheme && look; },
    applyFromStorage,
  };
}
