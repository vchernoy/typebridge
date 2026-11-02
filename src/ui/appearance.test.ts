import { expect, test } from 'vitest';
import { appearanceChoice } from './appearance';

test('unknown or corrupt appearance preferences fall back to System', () => {
  for (const value of [null, undefined, '', 'auto', 'DARK', {}, 1]) expect(appearanceChoice(value)).toBe('system');
  expect(appearanceChoice('light')).toBe('light');
  expect(appearanceChoice('dark')).toBe('dark');
});
