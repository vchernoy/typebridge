import { describe, expect, it } from 'vitest';
import {
  SIGNAL_POLL_INTERVAL_MS,
  createDocumentSignal,
  decideReread,
  parseDocumentSignal,
  shouldApplyDocumentSignal,
} from './signals';

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

describe('createDocumentSignal', () => {
  it('builds payloads that parse and carry only metadata', () => {
    for (const type of ['saved', 'renamed', 'deleted'] as const) {
      const signal = createDocumentSignal(type, DOC, 4, 99);
      expect(Object.keys(signal).sort()).toEqual(['at', 'documentId', 'revision', 'type', 'v']);
      expect(parseDocumentSignal(JSON.parse(JSON.stringify(signal)))).toEqual(signal);
    }
  });
});

describe('decideReread', () => {
  it('refreshes a viewer when revision or updatedAt changes', () => {
    expect(decideReread({ role: 'viewer', displayedRevision: 2, stored: { revision: 3 } })).toBe('refresh');
    expect(decideReread({ role: 'viewer', displayedRevision: 3, stored: { revision: 3 } })).toBe('none');
    // Delete saved copy then recreate can reset the revision below what a reader still shows.
    expect(decideReread({ role: 'viewer', displayedRevision: 3, stored: { revision: 1 } })).toBe('refresh');
    expect(decideReread({
      role: 'viewer',
      displayedRevision: 1,
      displayedUpdatedAt: 100,
      stored: { revision: 1, updatedAt: 200 },
    })).toBe('refresh');
  });

  it('shows the missing state for a viewer when the row is absent or uncommitted', () => {
    expect(decideReread({ role: 'viewer', displayedRevision: 2, stored: undefined })).toBe('missing');
    expect(decideReread({ role: 'viewer', displayedRevision: 2, stored: { revision: 0 } })).toBe('missing');
  });

  it('never replaces editor content, only notifies', () => {
    expect(decideReread({ role: 'editor', displayedRevision: 1, stored: { revision: 2 } })).toBe('notice-newer');
    expect(decideReread({ role: 'editor', displayedRevision: 2, stored: { revision: 2 } })).toBe('none');
    expect(decideReread({ role: 'editor', displayedRevision: 2, stored: undefined })).toBe('notice-deleted');
  });

  it('gives editors with no committed copy of their own nothing to compare', () => {
    expect(decideReread({ role: 'editor', displayedRevision: 0, stored: { revision: 5 } })).toBe('none');
    expect(decideReread({ role: 'editor', displayedRevision: 0, stored: undefined })).toBe('none');
  });

  it('keeps the fallback poll slow', () => {
    expect(SIGNAL_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(15_000);
  });
});

describe('missing viewer recreation (#257 step 2 residual)', () => {
  it('accepts a same-id revision-one recreation only for a missing viewer', () => {
    const signal = createDocumentSignal('saved', DOC, 1, 20);
    expect(shouldApplyDocumentSignal(signal, DOC, 5)).toBe(false);
    expect(shouldApplyDocumentSignal(signal, DOC, 5, true)).toBe(true);
    expect(shouldApplyDocumentSignal(signal, OTHER, 5, true)).toBe(false);
    expect(decideReread({ role: 'viewer', displayedRevision: 0, stored: { revision: 1 } })).toBe('refresh');
  });
});
