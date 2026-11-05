export const APPEARANCE_KEY = 'typebridge.appearance.v1';
export type Appearance = 'system' | 'light' | 'dark';
export function appearanceChoice(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function setupAppearance(preferenceSaved: (name: string, saved: boolean) => void): { reset: () => boolean } {
  const select = document.querySelector<HTMLSelectElement>('#appearance')!;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice: Appearance = 'system';
  try { choice = appearanceChoice(localStorage.getItem(APPEARANCE_KEY)); } catch { /* Keep System when storage is blocked. */ }
  function apply(): void {
    const scheme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.colorScheme = scheme;
    select.value = choice;
    // #175 host page: Settings panel may live on the parent while this runs in the iframe.
    try {
      if (window.parent !== window) window.parent.document.documentElement.dataset.colorScheme = scheme;
    } catch { /* Cross-origin parent is out of scope. */ }
  }
  function save(value: Appearance): boolean {
    choice = value;
    apply();
    try { localStorage.setItem(APPEARANCE_KEY, value); preferenceSaved('appearance', true); return true; }
    catch { preferenceSaved('appearance', false); return false; }
  }
  apply();
  system.addEventListener('change', () => { if (choice === 'system') apply(); });
  select.addEventListener('change', () => save(appearanceChoice(select.value)));
  return { reset: () => save('system') };
}
