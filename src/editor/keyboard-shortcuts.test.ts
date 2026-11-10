import { describe, expect, it } from 'vitest';
import { SHORTCUTS, formatShortcut, isApplePlatform, transliterationOptionLabel, transliterationShortcutLabel } from './keyboard-shortcuts';

describe('effective shortcut labels', () => {
  it('keeps Control as the typing default on Apple while primary commands use Command', () => {
    expect(transliterationShortcutLabel('default', true)).toBe('⌃⇧Space');
    expect(formatShortcut(SHORTCUTS.find, true)).toBe('⌘F');
    expect(formatShortcut(SHORTCUTS.focus, false)).toBe('Ctrl+Shift+Enter');
  });
  it('reflects saved F-key options and disabled shortcuts without changing them', () => {
    expect(transliterationShortcutLabel('f8', true)).toBe('⇧⌘F8');
    expect(transliterationShortcutLabel('f8', false)).toBe('Ctrl+Shift+F8');
    expect(transliterationShortcutLabel('off', true)).toBe('Shortcut disabled');
  });
});

describe('platform style', () => {
  it('writes Apple shortcuts as symbols in Apple order with no separators', () => {
    expect(formatShortcut(SHORTCUTS.redo, true)).toBe('⇧⌘Z');
    expect(formatShortcut(SHORTCUTS.convertCyrillic, true)).toBe('⇧⌘L');
    expect(formatShortcut(SHORTCUTS.focus, true)).toBe('⇧⌘Return');
    expect(formatShortcut(SHORTCUTS.escape, true)).toBe('Esc');
    expect(formatShortcut(SHORTCUTS.outdent, true)).toBe('⇧Tab');
  });
  it('writes Windows and Linux shortcuts as words joined by + with no spaces', () => {
    expect(transliterationShortcutLabel('default', false)).toBe('Ctrl+Shift+Space');
    expect(formatShortcut(SHORTCUTS.redo, false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut(SHORTCUTS.find, false)).toBe('Ctrl+F');
    expect(formatShortcut(SHORTCUTS.escape, false)).toBe('Escape');
    expect(formatShortcut(SHORTCUTS.outdent, false)).toBe('Shift+Tab');
  });
  it('labels the Settings picker for each platform', () => {
    expect(transliterationOptionLabel('default', true)).toBe('Default (⌃⇧Space)');
    expect(transliterationOptionLabel('default', false)).toBe('Default (Ctrl+Shift+Space)');
    expect(transliterationOptionLabel('f7', true)).toBe('⇧⌘F7');
    expect(transliterationOptionLabel('f7', false)).toBe('Ctrl+Shift+F7');
    expect(transliterationOptionLabel('off', true)).toBe('Disabled');
  });
  it('treats Mac, iPhone and iPad as Apple', () => {
    for (const platform of ['MacIntel', 'iPhone', 'iPad']) expect(isApplePlatform(platform)).toBe(true);
    for (const platform of ['Win32', 'Linux x86_64', 'Linux armv8l']) expect(isApplePlatform(platform)).toBe(false);
  });
});
