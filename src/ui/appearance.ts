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
    document.documentElement.dataset.colorScheme = choice === 'system' ? (system.matches ? 'dark' : 'light') : choice;
    select.value = choice;
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
