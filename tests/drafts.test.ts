import { describe, expect, it } from 'vitest';
import { UNTITLED_TITLE, newDraft } from '../src/editor/drafts';

describe('document defaults (#108)', () => {
  it('names new documents "Untitled document"', () => {
    expect(UNTITLED_TITLE).toBe('Untitled document');
    const doc = newDraft('текст');
    expect(doc.title).toBe('Untitled document');
    expect(doc.text).toBe('текст');
  });
});
