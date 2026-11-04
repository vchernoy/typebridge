import { describe, expect, it } from 'vitest';
import { parseDocumentSignal, shouldApplyDocumentSignal } from './signals';

const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const OTHER = 'b2c3d4e5-f6a7-4890-b123-456789abcdef';

describe('document signals', () => {
  it('accepts v1 saved/renamed/deleted metadata', () => {
    for (const type of ['saved', 'renamed', 'deleted'] as const) {
      expect(parseDocumentSignal({ v: 1, type, documentId: DOC, revision: 3, at: 100 })).toEqual({
        v: 1,
        type,
        documentId: DOC,
        revision: 3,
        at: 100,
      });
    }
  });

  it('drops malformed or text-bearing payloads', () => {
    expect(parseDocumentSignal(null)).toBeUndefined();
    expect(parseDocumentSignal({ v: 2, type: 'saved', documentId: DOC, revision: 1, at: 1 })).toBeUndefined();
    expect(parseDocumentSignal({ v: 1, type: 'saved', documentId: 'x', revision: 1, at: 1 })).toBeUndefined();
    expect(parseDocumentSignal({ v: 1, type: 'saved', documentId: DOC, revision: -1, at: 1 })).toBeUndefined();
    expect(parseDocumentSignal({ v: 1, type: 'saved', documentId: DOC, revision: 1, at: NaN })).toBeUndefined();
    expect(parseDocumentSignal({
      v: 1, type: 'saved', documentId: DOC, revision: 1, at: 1, text: 'secret',
    })).toEqual({ v: 1, type: 'saved', documentId: DOC, revision: 1, at: 1 });
  });

  it('applies only newer revisions for the displayed document', () => {
    const saved = parseDocumentSignal({ v: 1, type: 'saved', documentId: DOC, revision: 4, at: 1 })!;
    expect(shouldApplyDocumentSignal(saved, DOC, 3)).toBe(true);
    expect(shouldApplyDocumentSignal(saved, DOC, 4)).toBe(false);
    expect(shouldApplyDocumentSignal(saved, OTHER, 3)).toBe(false);
    const deleted = parseDocumentSignal({ v: 1, type: 'deleted', documentId: DOC, revision: 4, at: 1 })!;
    expect(shouldApplyDocumentSignal(deleted, DOC, 99)).toBe(true);
  });
});
