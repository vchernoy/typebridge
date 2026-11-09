import { describe, expect, it } from 'vitest';
import { titleOpForKey } from './title-edits';

const key = (k: string, mods: Partial<{ isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, ...mods,
});

describe('titleOpForKey', () => {
  it('maps printable keys to an insertion, including non-Latin and space', () => {
    expect(titleOpForKey(key('a'))).toEqual({ inputType: 'insertText', data: 'a' });
    expect(titleOpForKey(key('ж'))).toEqual({ inputType: 'insertText', data: 'ж' });
    expect(titleOpForKey(key(' '))).toEqual({ inputType: 'insertText', data: ' ' });
  });

  it('maps Backspace and Delete to deletions', () => {
    expect(titleOpForKey(key('Backspace'))).toEqual({ inputType: 'deleteContentBackward', data: null });
    expect(titleOpForKey(key('Delete'))).toEqual({ inputType: 'deleteContentForward', data: null });
  });

  it('ignores shortcuts, composition and keys that do not edit', () => {
    expect(titleOpForKey(key('a', { ctrlKey: true }))).toBeUndefined();
    expect(titleOpForKey(key('v', { metaKey: true }))).toBeUndefined();
    expect(titleOpForKey(key('a', { altKey: true }))).toBeUndefined();
    expect(titleOpForKey(key('a', { isComposing: true }))).toBeUndefined();
    for (const k of ['Enter', 'Tab', 'ArrowLeft', 'Shift', 'Escape']) expect(titleOpForKey(key(k))).toBeUndefined();
  });
});
