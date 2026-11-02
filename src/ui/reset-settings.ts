import { askConfirmChoice } from './confirm-dialog';

/** Explicit reset of editor preferences, without reloading or touching document stores. */
export function setupResetSettings(deps: {
  actions: Array<[string, () => boolean]>;
  announce: (message: string) => void;
}): void {
  const button = document.querySelector<HTMLButtonElement>('#reset-settings')!;
  button.addEventListener('click', async () => {
    if (!await askConfirmChoice({
      title: 'Reset settings to defaults?',
      message: 'Reset appearance, typing mode, typing shortcut, custom rules, Tab indents, Find options, both editor sizes and Focus preference. Documents, current text, Undo history and the Autosave privacy choice are kept.',
      confirmLabel: 'Reset settings', cancelLabel: 'Keep settings', returnFocus: button,
    })) return;
    const failed: string[] = [];
    for (const [name, reset] of deps.actions) {
      try { if (!reset()) failed.push(name); } catch { failed.push(name); }
    }
    deps.announce(failed.length
      ? `Reset incomplete — could not save ${failed.join(', ')}. Documents and Autosave were kept.`
      : 'Settings reset to defaults. Documents and Autosave were kept.');
  });
}
