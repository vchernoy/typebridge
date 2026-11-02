import { SHORTCUTS, formatShortcut, TRANSLITERATION_SHORTCUTS, transliterationShortcutLabel, type TransliterationShortcut } from '../editor/keyboard-shortcuts';
import { askConfirmChoice } from './confirm-dialog';
import { openSettingsTo } from './settings';

export function setupKeyboardShortcuts(): void {
  const trigger = document.querySelector<HTMLButtonElement>('#keyboard-shortcuts')!;
  const more = document.querySelector<HTMLButtonElement>('#more-open')!;
  const shortcut = document.querySelector<HTMLSelectElement>('#translit-shortcut')!;
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const label = (key: keyof typeof SHORTCUTS): string => formatShortcut(SHORTCUTS[key], apple);
  for (const [id, key] of [['convert-cyrillic', 'convertCyrillic'], ['convert-latin', 'convertLatin'], ['find-open', 'find'], ['goto-open', 'goto'], ['focus-mode', 'focus']] as const) {
    const control = document.getElementById(id)!;
    const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
    control.title = `${name} (${label(key)})`;
  }
  trigger.addEventListener('click', async () => {
    const choice: TransliterationShortcut = TRANSLITERATION_SHORTCUTS.some(value => value === shortcut.value)
      ? shortcut.value as TransliterationShortcut : 'default';
    const indent = document.querySelector<HTMLInputElement>('#tab-indent')!.checked;
    const lines = [
      `Toggle typing mode: ${transliterationShortcutLabel(choice, apple)}`,
      `Convert selection to Cyrillic: ${label('convertCyrillic')}`,
      `Convert selection to Latin: ${label('convertLatin')}`,
      `Find: ${label('find')}`,
      `Go to line: ${label('goto')}`,
      `Focus mode: ${label('focus')}`,
      `Undo: ${label('undo')}`,
      `Redo: ${label('redo')} or ${label('redoAlternate')}`,
      `Indent / outdent: ${label('indent')} / ${label('outdent')}${indent ? '' : ' (Tab indents is off)'}`,
      `Next / previous match in Find: ${label('nextMatch')} / ${label('previousMatch')}`,
      'Resize grip: arrow keys',
      `${label('escape')}: closes the current dialog, panel, menu or search bar first; otherwise toggles Focus from the editor, or exits Focus.`,
      '',
      'Some systems reserve Ctrl+Shift+Space for keyboard-language switching. Use Change typing shortcut to choose another binding or disable it. Browser/OS-reserved shortcuts may take priority.',
    ];
    const change = await askConfirmChoice({ title: 'Keyboard shortcuts', message: lines.join('\n'),
      confirmLabel: 'Change typing shortcut', cancelLabel: 'Close', returnFocus: accepted => accepted ? shortcut : more });
    if (change) openSettingsTo(shortcut, more);
  });
}
