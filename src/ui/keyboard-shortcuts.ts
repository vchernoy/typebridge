import { SHORTCUTS, formatShortcut, isApplePlatform, TRANSLITERATION_SHORTCUTS, transliterationShortcutLabel, type TransliterationShortcut } from '../editor/keyboard-shortcuts';
import { askConfirmChoice } from './confirm-dialog';
import { openHostSettings, openSettingsTo } from './settings';

export function setupKeyboardShortcuts(): void {
  const trigger = document.querySelector<HTMLButtonElement>('#keyboard-shortcuts')!;
  const more = document.querySelector<HTMLButtonElement>('#more-open')!;
  const shortcut = document.querySelector<HTMLSelectElement>('#translit-shortcut');
  const apple = isApplePlatform();
  const label = (key: keyof typeof SHORTCUTS): string => formatShortcut(SHORTCUTS[key], apple);
  // Tooltips name the shortcut in this platform's style (the HTML holds a Cmd/Ctrl fallback).
  for (const [id, key] of [['convert-cyrillic', 'convertCyrillic'], ['convert-latin', 'convertLatin'], ['find-open', 'find'], ['goto-open', 'goto'], ['focus-mode', 'focus'], ['undo', 'undo'], ['redo', 'redo']] as const) {
    const control = document.getElementById(id);
    if (!control) continue;
    const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
    control.title = `${name} (${label(key)})`;
  }
  const gotoField = document.getElementById('goto-line');
  if (gotoField) gotoField.title = label('goto');
  trigger.addEventListener('click', async () => {
    let choice: TransliterationShortcut = 'default';
    try {
      const stored = shortcut?.value ?? localStorage.getItem('typebridge.transliteration.shortcut.v1');
      if (TRANSLITERATION_SHORTCUTS.some(value => value === stored)) choice = stored as TransliterationShortcut;
    } catch { /* default */ }
    const indent = document.querySelector<HTMLInputElement>('#tab-indent')?.checked
      ?? (() => { try { return localStorage.getItem('typebridge.editor.tabIndent.v1') !== 'off'; } catch { return true; } })();
    const rows: Array<[string, string]> = [
      ['Toggle typing mode', transliterationShortcutLabel(choice, apple)],
      ['Convert selection to Cyrillic', label('convertCyrillic')],
      ['Convert selection to Latin', label('convertLatin')],
      ['Find', label('find')],
      ['Go to line', label('goto')],
      ['Focus mode', label('focus')],
      ['Undo', label('undo')],
      ['Redo', `${label('redo')} or ${label('redoAlternate')}`],
      ['Indent / outdent', `${label('indent')} / ${label('outdent')}${indent ? '' : ' (Tab indents is off)'}`],
      ['Next / previous match in Find', `${label('nextMatch')} / ${label('previousMatch')}`],
      ['Resize grip', 'arrow keys'],
    ];
    // #175 step 11: host window cycle is only meaningful inside an embedded editor.
    if (document.documentElement.dataset.embed === '1') {
      rows.push(['Next / previous editor window', 'F6 / Shift+F6']);
    }
    const content = document.createElement('div');
    const list = document.createElement('dl');
    list.className = 'shortcut-list';
    for (const [action, keys] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = action;
      const dd = document.createElement('dd');
      dd.textContent = keys;
      list.append(dt, dd);
    }
    const escapeNote = document.createElement('p');
    escapeNote.className = 'shortcut-note';
    escapeNote.textContent = `${label('escape')}: closes the current dialog, panel, menu or search bar first; otherwise toggles Focus from the editor, or exits Focus.`;
    const reserveNote = document.createElement('p');
    reserveNote.className = 'shortcut-note';
    reserveNote.textContent = `Some systems reserve ${transliterationShortcutLabel('default', apple)} for keyboard-language switching. Use Change typing shortcut to choose another binding or disable it. Browser/OS-reserved shortcuts may take priority.`;
    content.append(list, escapeNote, reserveNote);
    const change = await askConfirmChoice({
      title: 'Keyboard shortcuts',
      message: content,
      confirmLabel: 'Change typing shortcut',
      cancelLabel: 'Close',
      returnFocus: more,
    });
    if (!change) return;
    if (document.documentElement.dataset.embed === '1' && openHostSettings('translit-shortcut', more)) return;
    if (shortcut) openSettingsTo(shortcut, more);
  });
}
