import { describe, expect, it } from 'vitest';
import { SHORTCUTS, formatShortcut, transliterationShortcutLabel } from './keyboard-shortcuts';

describe('effective shortcut labels', () => {
  it('keeps Control as the typing default on Apple while primary commands use Command', () => {
    expect(transliterationShortcutLabel('default', true)).toBe('Ctrl+Shift+Space');
    expect(formatShortcut(SHORTCUTS.find, true)).toBe('⌘+F');
    expect(formatShortcut(SHORTCUTS.focus, false)).toBe('Ctrl+Shift+Enter');
  });
  it('reflects saved F-key options and disabled shortcuts without changing them', () => {
    expect(transliterationShortcutLabel('f8', true)).toBe('⌘+Shift+F8');
    expect(transliterationShortcutLabel('f8', false)).toBe('Ctrl+Shift+F8');
    expect(transliterationShortcutLabel('off', true)).toBe('Shortcut disabled');
  });
});
