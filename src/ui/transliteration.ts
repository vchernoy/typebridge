import { TRANSLITERATION_SHORTCUTS, transliterationShortcutLabel, transliterationBinding, type TransliterationShortcut } from '../editor/keyboard-shortcuts';
import type { Editor } from '../editor/editor';
import { notifyPrefsChanged, onPrefsChanged } from '../view/prefs-sync';

/**
 * Transliteration on/off: the saved mode, the shortcut picker and its key handler, and the
 * toggle's change handler. The shortcut works from the editor, Find, Replace and the title
 * (#89, #102); the default is Ctrl+Shift+Space on every platform (#68).
 */
export function setupTransliteration(enabled: HTMLInputElement, editor: Editor, deps: {
  syncSearchEditors: () => void;
  preferenceSaved: (name: string, saved: boolean) => void;
  /** Additional editors that follow the global Latin/Cyrillic mode (#159 S4). */
  extraEditors?: () => Editor[];
  /** #175 step 7: skip echoing the writer's own prefs event. */
  prefsOrigin?: string;
}): { reset: () => boolean; applyFromStorage: () => void } {
  const { syncSearchEditors, preferenceSaved, extraEditors, prefsOrigin = 'editor' } = deps;
  function syncEditorModes(): void {
    editor.setEnabled(enabled.checked);
    for (const extra of extraEditors?.() ?? []) extra.setEnabled(enabled.checked);
  }
  // Plain-text writing is a first-class mode. Remember the choice per browser.
  const TRANSLITERATION_KEY = 'typebridge.transliteration.enabled.v1';
  try { enabled.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; }
  catch { /* Storage may be unavailable; keep the default enabled mode. */ }
  syncEditorModes();
  const shortcutSelect = document.querySelector<HTMLSelectElement>('#translit-shortcut');
  const shortcutLabel = document.querySelector<HTMLElement>('#shortcut-label');
  const modeAnnouncement = document.querySelector<HTMLElement>('#mode-announcement');
  const shortcutStatus = document.querySelector<HTMLElement>('#shortcut-status');
  const SHORTCUT_KEY = 'typebridge.transliteration.shortcut.v1';
  const shortcutOptions = TRANSLITERATION_SHORTCUTS;
  type Shortcut = TransliterationShortcut;
  let shortcut: Shortcut = 'default';
  let applyingRemote = false;
  try {
    const stored = localStorage.getItem(SHORTCUT_KEY);
    if (shortcutOptions.some(value => value === stored)) shortcut = stored as Shortcut;
  } catch { /* Keep the default if preferences are unavailable. */ }
  if (shortcutSelect) shortcutSelect.value = shortcut;
  function renderShortcut(): void {
    const label = transliterationShortcutLabel(shortcut, /Mac|iPhone|iPad/.test(navigator.platform));
    if (shortcutLabel) shortcutLabel.textContent = `(${label})`;
    enabled.title = label;
  }
  renderShortcut();
  function saveShortcut(value: Shortcut, opts?: { silent?: boolean }): boolean {
    shortcut = value;
    if (shortcutSelect) shortcutSelect.value = value;
    renderShortcut();
    try {
      localStorage.setItem(SHORTCUT_KEY, value);
      if (shortcutStatus) shortcutStatus.textContent = 'Shortcut saved';
      if (!opts?.silent) notifyPrefsChanged({ name: 'shortcut', origin: prefsOrigin });
      return true;
    } catch {
      if (shortcutStatus) shortcutStatus.textContent = 'Shortcut could not be saved';
      return false;
    }
  }
  shortcutSelect?.addEventListener('change', () => {
    if (applyingRemote) return;
    const value = shortcutSelect.value;
    if (shortcutOptions.some(option => option === value)) {
      const saved = saveShortcut(value as Shortcut);
      preferenceSaved('shortcut', saved);
    }
  });
  document.querySelector<HTMLButtonElement>('#shortcut-reset')?.addEventListener('click', () => {
    const saved = saveShortcut('default');
    preferenceSaved('shortcut', saved);
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || !event.shiftKey || shortcut === 'off') return;
    const usesCommand = shortcut !== 'default' && /Mac|iPhone|iPad/.test(navigator.platform);
    if (usesCommand ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return;
    if (event.code !== transliterationBinding(shortcut, usesCommand)?.key) return;
    if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
    if (!['editor', 'find-text', 'replace-text', 'draft-title'].includes(event.target.id)) return;
    event.preventDefault();
    enabled.checked = !enabled.checked;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The words beside the switch choose a side rather than toggling: "Latin" turns
  // transliteration off and "Кириллица" turns it on (#123, step 5).
  function choose(on: boolean): void {
    if (enabled.checked === on) return;
    enabled.checked = on;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const [latinSide, cyrillicSide] = document.querySelectorAll<HTMLElement>('.mode-switch .mode-side');
  latinSide?.addEventListener('click', () => { choose(false); enabled.focus(); });
  cyrillicSide?.addEventListener('click', event => { event.preventDefault(); choose(true); enabled.focus(); });
  let modeSaved = true;
  enabled.addEventListener('change', () => {
    syncEditorModes();
    syncSearchEditors();
    if (modeAnnouncement) {
      modeAnnouncement.textContent = enabled.checked ? 'Transliteration on' : 'Transliteration off';
    }
    if (applyingRemote) return;
    // Editing continues even when browser storage is blocked.
    try {
      localStorage.setItem(TRANSLITERATION_KEY, enabled.checked ? 'on' : 'off');
      modeSaved = true;
      preferenceSaved('transliteration', true);
      notifyPrefsChanged({ name: 'transliteration', origin: prefsOrigin });
    } catch {
      modeSaved = false;
      preferenceSaved('transliteration', false);
    }
  });

  function applyFromStorage(): void {
    applyingRemote = true;
    try {
      try { enabled.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; }
      catch { /* Keep the current mode when storage is blocked. */ }
      // Dispatch so listeners outside this module (title editors in main.ts) sync too.
      // applyingRemote keeps the change handler from rewriting storage or re-notifying.
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        const stored = localStorage.getItem(SHORTCUT_KEY);
        if (shortcutOptions.some(value => value === stored)) shortcut = stored as Shortcut;
      } catch { /* Keep the current shortcut. */ }
      if (shortcutSelect) shortcutSelect.value = shortcut;
      renderShortcut();
    } finally {
      applyingRemote = false;
    }
  }

  onPrefsChanged(detail => {
    if (detail.name === 'transliteration' || detail.name === 'shortcut' || detail.name === 'reset') {
      applyFromStorage();
    }
  }, { skipOrigin: prefsOrigin });

  return {
    applyFromStorage,
    reset: () => {
      enabled.checked = true;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
      const shortcutSaved = saveShortcut('default');
      return modeSaved && shortcutSaved;
    },
  };
}
