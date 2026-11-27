import { expect, test } from 'vitest';
import { ACTIVE_STYLES } from '@vchernoy/active-runtime';
import { appearanceChoice, LEGACY_SKETCH_KEY, STYLE_IDS, STYLE_KEY, storedStyle, styleChoice } from './appearance';

test('unknown or corrupt appearance preferences fall back to System', () => {
  for (const value of [null, undefined, '', 'auto', 'DARK', {}, 1]) expect(appearanceChoice(value)).toBe('system');
  expect(appearanceChoice('light')).toBe('light');
  expect(appearanceChoice('dark')).toBe('dark');
});

test('the style list matches ActiveMD; unknown or corrupt styles are Plain', () => {
  expect([...STYLE_IDS]).toEqual(ACTIVE_STYLES.map(style => style.id));
  for (const id of STYLE_IDS) expect(styleChoice(id)).toBe(id);
  for (const value of [null, undefined, '', 'Sketch', 'on', 'url(x)', 1, {}]) expect(styleChoice(value)).toBe('plain');
});

test('a saved style wins; otherwise the previous Hand-drawn checkbox becomes the sketch style', () => {
  const storage = (items: Record<string, string>) => ({ getItem: (key: string) => items[key] ?? null });
  expect(storedStyle(storage({}))).toBe('plain');
  expect(storedStyle(storage({ [LEGACY_SKETCH_KEY]: 'on' }))).toBe('sketch');
  expect(storedStyle(storage({ [LEGACY_SKETCH_KEY]: 'off' }))).toBe('plain');
  expect(storedStyle(storage({ [STYLE_KEY]: 'notebook', [LEGACY_SKETCH_KEY]: 'on' }))).toBe('notebook');
  expect(storedStyle(storage({ [STYLE_KEY]: 'nonsense', [LEGACY_SKETCH_KEY]: 'on' }))).toBe('plain');
});
