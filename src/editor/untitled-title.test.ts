import { describe, expect, it } from 'vitest';
import { UNTITLED_TITLE } from './drafts';
import { nextUntitledTitle } from './untitled-title';

describe('nextUntitledTitle (#175 step 8)', () => {
  it('uses the base name when nothing else is untitled', () => {
    expect(nextUntitledTitle([])).toBe(UNTITLED_TITLE);
    expect(nextUntitledTitle(['Notes', 'Letter'])).toBe(UNTITLED_TITLE);
  });

  it('numbers further untitled documents', () => {
    expect(nextUntitledTitle([UNTITLED_TITLE])).toBe('Untitled document 2');
    expect(nextUntitledTitle([UNTITLED_TITLE, 'Untitled document 2'])).toBe('Untitled document 3');
  });

  it('fills gaps in the numbering', () => {
    expect(nextUntitledTitle([UNTITLED_TITLE, 'Untitled document 3'])).toBe('Untitled document 2');
  });

  it('ignores blank titles', () => {
    expect(nextUntitledTitle(['', '  '])).toBe(UNTITLED_TITLE);
  });
});
