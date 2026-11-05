/**
 * #175 step 7: one Settings panel on the host page.
 * Preference writes use the shared UI modules; iframes apply via prefs-sync.
 */
import { setupAppearance } from '../ui/appearance';
import { setupResetSettings } from '../ui/reset-settings';
import { setupRules } from '../ui/rules';
import { setupSettings, openSettingsTo, ensureSettingsOpen } from '../ui/settings';
import { setupWindowLayoutSetting } from '../ui/window-layout-setting';
import { setAutosaveEnabled, autosaveEnabled } from '../editor/drafts';
import {
  TRANSLITERATION_SHORTCUTS,
  transliterationShortcutLabel,
  type TransliterationShortcut,
} from '../editor/keyboard-shortcuts';
import { applyPrefsToFrames, notifyPrefsChanged, onPrefsChanged, type PrefName } from '../view/prefs-sync';

const PREFS_ORIGIN = 'host';
const TAB_INDENT_KEY = 'typebridge.editor.tabIndent.v1';
const TRANSLITERATION_KEY = 'typebridge.transliteration.enabled.v1';
const SHORTCUT_KEY = 'typebridge.transliteration.shortcut.v1';

export type HostSettingsApi = {
  open: (opts?: { focus?: string }) => void;
};

function preferenceSaved(name: string, saved: boolean): void {
  // Host Settings has no combined status line; per-control statuses remain.
  void name;
  void saved;
}

export function installHostSettings(deps: {
  frames: () => HTMLIFrameElement[];
  /** Clear host Focus maximize when Reset clears Focus preference (#175 step 7). */
  exitHostFocus?: () => void;
}): HostSettingsApi {
  setupSettings();

  const appearance = setupAppearance(preferenceSaved, { prefsOrigin: PREFS_ORIGIN });
  const layout = setupWindowLayoutSetting(preferenceSaved, { prefsOrigin: PREFS_ORIGIN });
  const resetRules = setupRules(() => [], { prefsOrigin: PREFS_ORIGIN });

  const autosave = document.querySelector<HTMLInputElement>('#autosave')!;
  const tabIndent = document.querySelector<HTMLInputElement>('#tab-indent')!;
  const shortcutSelect = document.querySelector<HTMLSelectElement>('#translit-shortcut')!;
  const shortcutStatus = document.querySelector<HTMLElement>('#shortcut-status');
  const shortcutReset = document.querySelector<HTMLButtonElement>('#shortcut-reset');

  try { autosave.checked = autosaveEnabled(); } catch { autosave.checked = true; }
  try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { tabIndent.checked = true; }

  let shortcut: TransliterationShortcut = 'default';
  try {
    const stored = localStorage.getItem(SHORTCUT_KEY);
    if (TRANSLITERATION_SHORTCUTS.some(value => value === stored)) {
      shortcut = stored as TransliterationShortcut;
    }
  } catch { /* default */ }
  shortcutSelect.value = shortcut;

  function broadcast(name: PrefName): void {
    notifyPrefsChanged({ name, origin: PREFS_ORIGIN });
    applyPrefsToFrames(deps.frames(), name, PREFS_ORIGIN);
  }

  function saveShortcut(value: TransliterationShortcut): boolean {
    shortcut = value;
    shortcutSelect.value = value;
    try {
      localStorage.setItem(SHORTCUT_KEY, value);
      if (shortcutStatus) shortcutStatus.textContent = 'Shortcut saved';
      broadcast('shortcut');
      return true;
    } catch {
      if (shortcutStatus) shortcutStatus.textContent = 'Shortcut could not be saved';
      return false;
    }
  }

  shortcutSelect.addEventListener('change', () => {
    const value = shortcutSelect.value;
    if (TRANSLITERATION_SHORTCUTS.some(option => option === value)) {
      saveShortcut(value as TransliterationShortcut);
    }
  });
  shortcutReset?.addEventListener('click', () => { saveShortcut('default'); });

  autosave.addEventListener('change', () => {
    try { setAutosaveEnabled(autosave.checked); }
    catch { /* Keep the control state; windows still try to apply. */ }
    broadcast('autosave');
  });

  tabIndent.addEventListener('change', () => {
    try { localStorage.setItem(TAB_INDENT_KEY, tabIndent.checked ? 'on' : 'off'); } catch { /* ignore */ }
    broadcast('tabIndent');
  });

  // Typing mode lives in each window's chrome; keep host labels honest if storage changes.
  onPrefsChanged(detail => {
    if (detail.name === 'autosave' || detail.name === 'reset') {
      try { autosave.checked = autosaveEnabled(); } catch { /* keep */ }
    }
    if (detail.name === 'tabIndent' || detail.name === 'reset') {
      try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* keep */ }
    }
    if (detail.name === 'shortcut' || detail.name === 'reset') {
      try {
        const stored = localStorage.getItem(SHORTCUT_KEY);
        if (TRANSLITERATION_SHORTCUTS.some(value => value === stored)) {
          shortcut = stored as TransliterationShortcut;
          shortcutSelect.value = shortcut;
        }
      } catch { /* keep */ }
    }
    if (detail.name === 'transliteration' || detail.name === 'reset') {
      // No host mode switch; windows own the chrome.
      void localStorage.getItem(TRANSLITERATION_KEY);
    }
  }, { skipOrigin: PREFS_ORIGIN });

  function resetShortcut(): boolean {
    return saveShortcut('default');
  }

  function resetTabIndent(): boolean {
    tabIndent.checked = true;
    try {
      localStorage.setItem(TAB_INDENT_KEY, 'on');
      broadcast('tabIndent');
      return true;
    } catch {
      return false;
    }
  }

  function resetTransliteration(): boolean {
    try {
      localStorage.setItem(TRANSLITERATION_KEY, 'on');
      broadcast('transliteration');
      return true;
    } catch {
      return false;
    }
  }

  setupResetSettings({
    actions: [
      ['appearance', () => appearance.reset()],
      ['window layout', () => layout.reset()],
      ['typing mode', resetTransliteration],
      ['typing shortcut', resetShortcut],
      ['custom rules', resetRules],
      ['Tab indents', resetTabIndent],
      ['Find options', () => {
        // Find option keys are shared; ask every window to clear its chips.
        broadcast('reset');
        try {
          localStorage.removeItem('typebridge.find.matchCase.v1');
          localStorage.removeItem('typebridge.find.regex.v1');
          return true;
        } catch {
          return false;
        }
      }],
      ['editor sizes and Focus', () => {
        broadcast('reset');
        try {
          localStorage.removeItem('typebridge.editor.size.v1');
          localStorage.removeItem('typebridge.editor.focusSize.v1');
          localStorage.removeItem('typebridge.focusMode.v1');
          deps.exitHostFocus?.();
          return true;
        } catch {
          deps.exitHostFocus?.();
          return false;
        }
      }],
    ],
    announce: message => {
      const live = document.querySelector<HTMLElement>('#host-settings-status');
      if (live) live.textContent = message;
      broadcast('reset');
    },
  });

  function open(opts?: { focus?: string }): void {
    const openButton = document.querySelector<HTMLButtonElement>('#settings-open');
    if (!openButton) return;
    ensureSettingsOpen();
    if (opts?.focus) {
      const target = document.getElementById(opts.focus);
      if (target instanceof HTMLElement) openSettingsTo(target, openButton);
    }
  }

  // Expose for embedded "Change typing shortcut" / About bridges.
  (window as Window & { __typebridgeOpenSettings?: typeof open }).__typebridgeOpenSettings = open;

  // Mac label for the default option stays informative on the host panel.
  void transliterationShortcutLabel;

  return { open };
}
