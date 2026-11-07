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

  // One shared Latin/Кириллица switch in the host top bar; windows no longer show their own.
  const hostMode = document.querySelector<HTMLInputElement>('#host-enabled');
  const hostModeHint = document.querySelector<HTMLElement>('#host-shortcut-label');
  function renderHostMode(): void {
    if (!hostMode) return;
    try { hostMode.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; } catch { /* keep */ }
    const label = transliterationShortcutLabel(shortcut, /Mac|iPhone|iPad/.test(navigator.platform));
    hostMode.title = label;
    if (hostModeHint) hostModeHint.textContent = shortcut === 'off' ? '' : `(${label})`;
  }
  // Clicking a side picks that mode (same as the window switch on the standalone page).
  const [hostLatin, hostCyrillic] = document.querySelectorAll<HTMLElement>('.host-toolbar .mode-switch .mode-side');
  const chooseHostMode = (cyrillic: boolean): void => {
    if (!hostMode || hostMode.checked === cyrillic) return;
    hostMode.checked = cyrillic;
    hostMode.dispatchEvent(new Event('change', { bubbles: true }));
  };
  hostLatin?.addEventListener('click', () => { chooseHostMode(false); hostMode?.focus(); });
  hostCyrillic?.addEventListener('click', event => { event.preventDefault(); chooseHostMode(true); hostMode?.focus(); });
  hostMode?.addEventListener('change', () => {
    const requested = hostMode.checked;
    try {
      localStorage.setItem(TRANSLITERATION_KEY, requested ? 'on' : 'off');
      broadcast('transliteration');
    } catch {
      // Storage blocked or full: still switch every open window for this session.
      // Each window's own switch applies the mode in memory and shows its warning.
      for (const frame of deps.frames()) {
        try {
          const box = frame.contentDocument?.querySelector<HTMLInputElement>('#enabled');
          if (box && box.checked !== requested) {
            box.checked = requested;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch { /* Frame mid-navigation. */ }
      }
      hostMode.checked = requested;
      preferenceSaved('typing mode', false);
    }
  });

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
    if (detail.name === 'transliteration' || detail.name === 'shortcut' || detail.name === 'reset') {
      // Shortcut changes are host-origin too; render after the stored value updates.
      queueMicrotask(renderHostMode);
    }
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

  renderHostMode();

  return { open };
}
