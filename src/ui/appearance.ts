import { notifyPrefsChanged, onPrefsChanged } from '../view/prefs-sync';

export const APPEARANCE_KEY = 'typebridge.appearance.v1';
export type Appearance = 'system' | 'light' | 'dark';
export function appearanceChoice(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}
/** Optional hand-drawn document controls (ActiveMD sketch.css), off unless saved as 'on'. */
export const SKETCH_KEY = 'typebridge.sketch.v1';
export const SKETCH_CLASS = 'active-sketch';
export function sketchChoice(value: unknown): boolean {
  return value === 'on';
}

export function setupAppearance(
  preferenceSaved: (name: string, saved: boolean) => void,
  options?: { prefsOrigin?: string },
): { reset: () => boolean; applyFromStorage: () => void } {
  const select = document.querySelector<HTMLSelectElement>('#appearance');
  const sketchBox = document.querySelector<HTMLInputElement>('#sketch-controls');
  const prefsOrigin = options?.prefsOrigin ?? 'editor';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice: Appearance = 'system';
  let applyingRemote = false;
  let sketch = false;
  try { choice = appearanceChoice(localStorage.getItem(APPEARANCE_KEY)); } catch { /* Keep System when storage is blocked. */ }
  try { sketch = sketchChoice(localStorage.getItem(SKETCH_KEY)); } catch { /* Keep the plain look when storage is blocked. */ }
  function apply(): void {
    const scheme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.colorScheme = scheme;
    document.documentElement.classList.toggle(SKETCH_CLASS, sketch);
    if (select) select.value = choice;
    if (sketchBox) sketchBox.checked = sketch;
    // #175 host page: keep the parent document in sync when this runs in an iframe.
    try {
      if (window.parent !== window) {
        window.parent.document.documentElement.dataset.colorScheme = scheme;
        window.parent.document.documentElement.classList.toggle(SKETCH_CLASS, sketch);
      }
    } catch { /* Cross-origin parent is out of scope. */ }
  }
  function saveSketch(value: boolean, opts?: { silent?: boolean }): boolean {
    sketch = value;
    apply();
    try {
      if (value) localStorage.setItem(SKETCH_KEY, 'on');
      else localStorage.removeItem(SKETCH_KEY);
      preferenceSaved('hand-drawn controls', true);
      if (!opts?.silent) notifyPrefsChanged({ name: 'appearance', origin: prefsOrigin });
      return true;
    } catch {
      preferenceSaved('hand-drawn controls', false);
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
      try { sketch = sketchChoice(localStorage.getItem(SKETCH_KEY)); } catch { /* keep */ }
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
  sketchBox?.addEventListener('change', () => {
    if (applyingRemote) return;
    saveSketch(sketchBox.checked);
  });
  onPrefsChanged(detail => {
    if (detail.name === 'appearance' || detail.name === 'reset') applyFromStorage();
  }, { skipOrigin: prefsOrigin });
  return {
    // Both run so one storage failure does not leave the other preference unreset.
    reset: () => { const scheme = save('system', { silent: true }); const look = saveSketch(false); return scheme && look; },
    applyFromStorage,
  };
}
