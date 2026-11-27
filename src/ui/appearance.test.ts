import { expect, test } from 'vitest';
import { appearanceChoice, sketchChoice } from './appearance';

test('unknown or corrupt appearance preferences fall back to System', () => {
  for (const value of [null, undefined, '', 'auto', 'DARK', {}, 1]) expect(appearanceChoice(value)).toBe('system');
  expect(appearanceChoice('light')).toBe('light');
  expect(appearanceChoice('dark')).toBe('dark');
});

test('hand-drawn controls are on only for the exact saved value', () => {
  expect(sketchChoice('on')).toBe(true);
  for (const value of [null, undefined, '', 'off', 'ON', 'true', true, 1, {}]) expect(sketchChoice(value)).toBe(false);
});
