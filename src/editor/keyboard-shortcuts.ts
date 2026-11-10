/** Shared effective key metadata. Capture/remapping is a separate #69 feature. */
type Binding = { key: string; primary?: boolean; control?: boolean; command?: boolean; shift?: boolean };
export const SHORTCUTS = {
  undo: { key: 'z', primary: true },
  redo: { key: 'z', primary: true, shift: true },
  redoAlternate: { key: 'y', primary: true },
  convertCyrillic: { key: 'l', primary: true, shift: true },
  convertLatin: { key: 'k', primary: true, shift: true },
  find: { key: 'f', primary: true },
  goto: { key: 'g', primary: true },
  focus: { key: 'Enter', primary: true, shift: true },
  indent: { key: 'Tab' },
  outdent: { key: 'Tab', shift: true },
  escape: { key: 'Escape' },
  nextMatch: { key: 'Enter' },
  previousMatch: { key: 'Enter', shift: true },
} as const satisfies Record<string, Binding>;
export const TRANSLITERATION_SHORTCUTS = ['default', 'f7', 'f8', 'f9', 'off'] as const;
export type TransliterationShortcut = typeof TRANSLITERATION_SHORTCUTS[number];
/** Key names as Apple keyboards and menus show them. */
const APPLE_KEY_NAMES: Record<string, string> = { Enter: 'Return', Escape: 'Esc' };
/**
 * A shortcut as people expect to read it: Apple symbols in Apple's modifier order
 * (⌃ Control, ⇧ Shift, ⌘ Command, no separators, e.g. ⌃⇧Space), or words joined by +
 * elsewhere (Ctrl+Shift+Space). VoiceOver reads the Apple symbols as their key names.
 */
export function formatShortcut(binding: Binding, apple: boolean): string {
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  if (apple) {
    const modifiers = (binding.control ? '⌃' : '') + (binding.shift ? '⇧' : '')
      + (binding.command || binding.primary ? '⌘' : '');
    return modifiers + (APPLE_KEY_NAMES[key] ?? key);
  }
  const keys: string[] = [];
  if (binding.control || binding.primary) keys.push('Ctrl');
  if (binding.shift) keys.push('Shift');
  keys.push(key);
  return keys.join('+');
}
export function transliterationBinding(choice: TransliterationShortcut, apple: boolean): Binding | undefined {
  if (choice === 'off') return undefined;
  // Default is Control everywhere (#68); saved F-key options retain Command on Apple.
  return { key: choice === 'default' ? 'Space' : choice.toUpperCase(), shift: true,
    control: choice === 'default' || !apple, command: choice !== 'default' && apple };
}
export function transliterationShortcutLabel(choice: TransliterationShortcut, apple: boolean): string {
  const binding = transliterationBinding(choice, apple);
  return binding ? formatShortcut(binding, apple) : 'Shortcut disabled';
}
/** The Settings picker's text for one choice (the HTML holds a platform-neutral fallback). */
export function transliterationOptionLabel(choice: TransliterationShortcut, apple: boolean): string {
  if (choice === 'off') return 'Disabled';
  const label = transliterationShortcutLabel(choice, apple);
  return choice === 'default' ? `Default (${label})` : label;
}
/** Shortcut labels follow the platform's conventions only on Apple devices. */
export function isApplePlatform(platform: string = navigator.platform): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}
