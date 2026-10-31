import type { Editor } from '../editor/editor';

/**
 * Transliteration on/off: the saved mode, the shortcut picker and its key handler, and the
 * toggle's change handler. The shortcut works from the editor, Find, Replace and the title
 * (#89, #102); the default is Ctrl+Shift+Space on every platform (#68).
 */
export function setupTransliteration(enabled: HTMLInputElement, editor: Editor, deps: {
  syncSearchEditors: () => void;
  preferenceSaved: (name: string, saved: boolean) => void;
}): void {
  const { syncSearchEditors, preferenceSaved } = deps;
  // Plain-text writing is a first-class mode. Remember the choice per browser.
  const TRANSLITERATION_KEY = 'typebridge.transliteration.enabled.v1';
  try { enabled.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; }
  catch { /* Storage may be unavailable; keep the default enabled mode. */ }
  editor.setEnabled(enabled.checked);
  const shortcutSelect = document.querySelector<HTMLSelectElement>('#translit-shortcut')!;
  const shortcutLabel = document.querySelector<HTMLElement>('#shortcut-label')!;
  const modeAnnouncement = document.querySelector<HTMLElement>('#mode-announcement')!;
  const shortcutStatus = document.querySelector<HTMLElement>('#shortcut-status')!;
  const SHORTCUT_KEY = 'typebridge.transliteration.shortcut.v1';
  const shortcutOptions = ['default', 'f7', 'f8', 'f9', 'off'] as const;
  type Shortcut = typeof shortcutOptions[number];
  let shortcut: Shortcut = 'default';
  try {
    const stored = localStorage.getItem(SHORTCUT_KEY);
    if (shortcutOptions.some(value => value === stored)) shortcut = stored as Shortcut;
  } catch { /* Keep the default if preferences are unavailable. */ }
  shortcutSelect.value = shortcut;
  function renderShortcut(): void {
    // The default uses Control on every platform: Command+Shift+Space can invoke Siri.
    // Keep the established Command modifier for explicitly saved macOS F-key choices.
    const modifier = shortcut !== 'default' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    const label = shortcut === 'off' ? 'Shortcut disabled' : `${modifier}+Shift+${shortcut === 'default' ? 'Space' : shortcut.toUpperCase()}`;
    shortcutLabel.textContent = `(${label})`;
    enabled.title = label;
  }
  renderShortcut();
  function saveShortcut(value: Shortcut): void {
    shortcut = value; shortcutSelect.value = value; renderShortcut();
    try { localStorage.setItem(SHORTCUT_KEY, value); shortcutStatus.textContent = 'Shortcut saved'; }
    catch { shortcutStatus.textContent = 'Shortcut could not be saved'; }
  }
  shortcutSelect.addEventListener('change', () => {
    const value = shortcutSelect.value;
    if (shortcutOptions.some(option => option === value)) saveShortcut(value as Shortcut);
  });
  document.querySelector<HTMLButtonElement>('#shortcut-reset')!.addEventListener('click', () => saveShortcut('default'));
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || !event.shiftKey || shortcut === 'off') return;
    const usesCommand = shortcut !== 'default' && /Mac|iPhone|iPad/.test(navigator.platform);
    if (usesCommand ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return;
    if (event.code !== (shortcut === 'default' ? 'Space' : shortcut.toUpperCase())) return;
    if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
    if (!['editor', 'find-text', 'replace-text', 'draft-title'].includes(event.target.id)) return;
    event.preventDefault();
    enabled.checked = !enabled.checked;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
  });
  enabled.addEventListener('change', () => {
    editor.setEnabled(enabled.checked);
    syncSearchEditors();
    modeAnnouncement.textContent = enabled.checked ? 'Transliteration on' : 'Transliteration off';
    // Editing continues even when browser storage is blocked.
    try { localStorage.setItem(TRANSLITERATION_KEY, enabled.checked ? 'on' : 'off'); preferenceSaved('transliteration', true); }
    catch { preferenceSaved('transliteration', false); }
  });
}
