import { notifyPrefsChanged, onPrefsChanged } from '../view/prefs-sync';

export const APPEARANCE_KEY = 'typebridge.appearance.v1';
export type Appearance = 'system' | 'light' | 'dark';
export function appearanceChoice(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function setupAppearance(
  preferenceSaved: (name: string, saved: boolean) => void,
  options?: { prefsOrigin?: string },
): { reset: () => boolean; applyFromStorage: () => void } {
  const select = document.querySelector<HTMLSelectElement>('#appearance');
  const prefsOrigin = options?.prefsOrigin ?? 'editor';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice: Appearance = 'system';
  let applyingRemote = false;
  try { choice = appearanceChoice(localStorage.getItem(APPEARANCE_KEY)); } catch { /* Keep System when storage is blocked. */ }
  function apply(): void {
    const scheme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.colorScheme = scheme;
    if (select) select.value = choice;
    // #175 host page: keep the parent document in sync when this runs in an iframe.
    try {
      if (window.parent !== window) window.parent.document.documentElement.dataset.colorScheme = scheme;
    } catch { /* Cross-origin parent is out of scope. */ }
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
  onPrefsChanged(detail => {
    if (detail.name === 'appearance' || detail.name === 'reset') applyFromStorage();
  }, { skipOrigin: prefsOrigin });
  return { reset: () => save('system'), applyFromStorage };
}
