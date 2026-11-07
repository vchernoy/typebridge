import { describe, expect, test } from 'vitest';
import { nextCharacterBoundary, previousCharacterBoundary } from './characters';

describe('character boundaries', () => {
  test('step over a surrogate-pair emoji as one character', () => {
    expect(nextCharacterBoundary('😀a', 0)).toBe(2);
    expect(previousCharacterBoundary('a😀', 3)).toBe(1);
  });
  test('step over combining marks and plain letters', () => {
    expect(nextCharacterBoundary('е́x', 0)).toBe(2);
    expect(previousCharacterBoundary('Имя', 3)).toBe(2);
    expect(nextCharacterBoundary('Имя', 1)).toBe(2);
  });
});
