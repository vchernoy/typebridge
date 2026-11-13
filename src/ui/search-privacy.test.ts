import { describe, expect, it, vi } from 'vitest';
import { createSearchPrivacy } from './search-privacy';

describe('private search persistence boundaries (#264)', () => {
  it('restores on queued private→public reversal, even before last-save finishes', () => {
    let writable = true;
    const restore = vi.fn();
    const scope = createSearchPrivacy(() => ({ documentId: 'a', writable }), restore);
    scope.sync(); restore.mockClear();
    writable = false; scope.sync();
    expect(scope.mayPersist()).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    writable = true; scope.sync();
    expect(restore).toHaveBeenCalledOnce();
    expect(scope.mayPersist()).toBe(true);
  });
  it('input observes privacy before preference-handler completion and cannot publish on exit', () => {
    let writable = true;
    const restore = vi.fn();
    const scope = createSearchPrivacy(() => ({ documentId: 'a', writable }), restore);
    scope.sync(); restore.mockClear();
    writable = false;
    expect(scope.mayPersist()).toBe(false);
    scope.sync(); // finishing entry must not erase a query typed privately
    expect(restore).not.toHaveBeenCalled();
    writable = true;
    expect(scope.mayPersist()).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
    expect(scope.mayPersist()).toBe(true);
  });
  it('document changes discard private search state even if both documents are private', () => {
    let documentId = 'a';
    const restore = vi.fn();
    const scope = createSearchPrivacy(() => ({ documentId, writable: false }), restore);
    scope.sync(); restore.mockClear();
    documentId = 'b';
    expect(scope.mayPersist()).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
  });
});
