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
  const live = document.querySelector<HTMLElement>('#host-settings-status');
  if (!live) return;
  live.textContent = saved ? '' : `${name} preference could not be saved in this browser.`;
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
    // onPrefsChanged below fans out to every live iframe.
    notifyPrefsChanged({ name, origin: PREFS_ORIGIN });
  }

  function saveShortcut(value: TransliterationShortcut): boolean {
    const previous = shortcut;
    shortcutSelect.value = value;
    try {
      localStorage.setItem(SHORTCUT_KEY, value);
      shortcut = value;
      if (shortcutStatus) shortcutStatus.textContent = 'Shortcut saved';
      broadcast('shortcut');
      return true;
    } catch {
      shortcut = previous;
      shortcutSelect.value = previous;
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

  const autosaveStatus = document.querySelector<HTMLElement>('#host-settings-status');
  autosave.addEventListener('change', () => {
    const requested = autosave.checked;
    try {
      setAutosaveEnabled(requested);
      if (autosaveStatus) autosaveStatus.textContent = '';
      broadcast('autosave');
    } catch {
      // Do not promise privacy (or saving) when the preference could not be stored.
      try { autosave.checked = autosaveEnabled(); } catch { autosave.checked = !requested; }
      if (autosaveStatus) {
        autosaveStatus.textContent = 'Autosave preference could not be saved in this browser.';
      }
    }
  });

  tabIndent.addEventListener('change', () => {
    const requested = tabIndent.checked;
    try {
      localStorage.setItem(TAB_INDENT_KEY, requested ? 'on' : 'off');
      if (autosaveStatus) autosaveStatus.textContent = '';
      broadcast('tabIndent');
    } catch {
      try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; }
      catch { tabIndent.checked = !requested; }
      if (autosaveStatus) {
        autosaveStatus.textContent = 'Tab indents preference could not be saved in this browser.';
      }
    }
  });

  // Fan out every prefs event to live iframes (host writes and window mode chrome).
  // Do not skip host origin: appearance/layout/rules notify without broadcast().
  onPrefsChanged(detail => {
    applyPrefsToFrames(deps.frames(), detail.name, detail.origin);
    if (detail.origin === PREFS_ORIGIN) return;
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
  });

  function resetShortcut(): boolean {
    return saveShortcut('default');
  }

  function resetTabIndent(): boolean {
    try {
      localStorage.setItem(TAB_INDENT_KEY, 'on');
      tabIndent.checked = true;
      broadcast('tabIndent');
      return true;
    } catch {
      try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; }
      catch { /* keep */ }
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

  function open(opts?: { focus?: string; returnFocus?: HTMLElement | null }): void {
    const openButton = document.querySelector<HTMLButtonElement>('#settings-open');
    if (!openButton) return;
    const restore = opts?.returnFocus ?? openButton;
    ensureSettingsOpen(restore);
    if (opts?.focus) {
      const target = document.getElementById(opts.focus);
      if (target instanceof HTMLElement) openSettingsTo(target, restore);
    }
  }

  // Expose for embedded "Change typing shortcut" / About bridges.
  (window as Window & { __typebridgeOpenSettings?: typeof open }).__typebridgeOpenSettings = open;

  // Mac label for the default option stays informative on the host panel.
  void transliterationShortcutLabel;

  return { open };
}
