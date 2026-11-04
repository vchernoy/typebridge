import { describe, expect, it } from 'vitest';
import { comparisonViewerHref, isDocumentId, parseComparisonRoute } from './route';

const DOC = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const RECOVERY = `recovery-${DOC}`;

describe('comparison route', () => {
  it('accepts UUID and recovery-<uuid> document ids', () => {
    expect(isDocumentId(DOC)).toBe(true);
    expect(isDocumentId(RECOVERY)).toBe(true);
    expect(isDocumentId('not-a-uuid')).toBe(false);
    expect(isDocumentId('recovery-nope')).toBe(false);
    expect(isDocumentId('')).toBe(false);
  });

  it('treats missing mode as ordinary boot', () => {
    expect(parseComparisonRoute('')).toEqual({ kind: 'ordinary' });
    expect(parseComparisonRoute(`?doc=${DOC}`)).toEqual({ kind: 'ordinary' });
  });

  it('parses a viewer route', () => {
    expect(parseComparisonRoute(`?doc=${DOC}&mode=view`)).toEqual({
      kind: 'viewer',
      documentId: DOC,
    });
    expect(parseComparisonRoute(`doc=${DOC}&mode=view`)).toEqual({
      kind: 'viewer',
      documentId: DOC,
    });
  });

  it('rejects view mode without a valid document id', () => {
    expect(parseComparisonRoute('?mode=view')).toEqual({ kind: 'invalid', reason: 'missing-doc' });
    expect(parseComparisonRoute('?mode=view&doc=')).toEqual({ kind: 'invalid', reason: 'missing-doc' });
    expect(parseComparisonRoute('?mode=view&doc=nope')).toEqual({ kind: 'invalid', reason: 'bad-doc' });
  });

  it('rejects unknown mode values', () => {
    expect(parseComparisonRoute(`?doc=${DOC}&mode=edit`)).toEqual({ kind: 'invalid', reason: 'bad-mode' });
  });

  it('builds a viewer href under the Vite base, including recovery ids', () => {
    expect(comparisonViewerHref('/', DOC)).toBe(`/?doc=${DOC}&mode=view`);
    expect(comparisonViewerHref('/app/', DOC)).toBe(`/app/?doc=${DOC}&mode=view`);
    expect(comparisonViewerHref('/', RECOVERY)).toBe(`/?doc=${encodeURIComponent(RECOVERY)}&mode=view`);
    expect(comparisonViewerHref('/', 'bad')).toBeUndefined();
  });
});
