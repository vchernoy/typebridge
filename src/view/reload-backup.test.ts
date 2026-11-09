import { afterEach, describe, expect, it } from 'vitest';
import type { StoredDraft } from '../editor/indexeddb';
import { createReloadBackup, parsePendingDraft, sameContent, savedCoversBackup } from './reload-backup';

const draft = (over: Partial<StoredDraft> = {}): StoredDraft => ({
  id: 'doc-1', title: 'Заметка', text: 'текст', updatedAt: 100, revision: 2, ...over,
} as StoredDraft);

function memorySession(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}
const realSession = (globalThis as { sessionStorage?: Storage }).sessionStorage;
afterEach(() => { (globalThis as { sessionStorage?: Storage }).sessionStorage = realSession; });

describe('reload backup rules', () => {
  it('accepts only well-formed backups', () => {
    expect(parsePendingDraft(JSON.stringify(draft()))).toEqual(draft());
    expect(parsePendingDraft(null)).toBeUndefined();
    expect(parsePendingDraft('not json')).toBeUndefined();
    expect(parsePendingDraft(JSON.stringify({ ...draft(), id: '' }))).toBeUndefined();
    expect(parsePendingDraft(JSON.stringify({ ...draft(), revision: -1 }))).toBeUndefined();
    expect(parsePendingDraft(JSON.stringify({ ...draft(), revision: 1.5 }))).toBeUndefined();
  });

  it('a save covers a backup with the same content or one that is not newer', () => {
    expect(sameContent(draft(), draft({ updatedAt: 5 }))).toBe(true);
    expect(sameContent(draft(), draft({ text: 'другой' }))).toBe(false);
    expect(savedCoversBackup(draft({ text: 'новее', updatedAt: 200 }), draft({ updatedAt: 150 }))).toBe(false);
    expect(savedCoversBackup(draft({ text: 'новее', updatedAt: 200 }), draft({ updatedAt: 200 }))).toBe(true);
    expect(savedCoversBackup(draft({ id: 'other' }), draft())).toBe(false);
  });
});

describe('reload backup', () => {
  it('saves only when there is text to protect, and never after a confirmed discard', () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memorySession();
    let may = true;
    let current = draft({ text: 'несохранённое', updatedAt: 300 });
    const backup = createReloadBackup({ key: 'k', snapshot: () => current, mayBackUp: () => may, onFailed: () => {} });
    backup.save();
    expect(backup.read()?.text).toBe('несохранённое');
    backup.clear(draft({ updatedAt: 200 }));
    expect(backup.read()).toBeDefined();
    backup.clear(draft({ updatedAt: 300 }));
    expect(backup.read()).toBeUndefined();
    backup.setSuppressed(true);
    backup.save();
    expect(backup.read()).toBeUndefined();
    backup.setSuppressed(false);
    may = false;
    backup.save();
    expect(backup.read()).toBeUndefined();
    may = true;
    current = draft();
    backup.save();
    backup.remove();
    expect(backup.read()).toBeUndefined();
  });

  it('reports a backup that cannot be written', () => {
    const failing = memorySession();
    failing.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    (globalThis as { sessionStorage?: Storage }).sessionStorage = failing;
    let failed = 0;
    createReloadBackup({ key: 'k', snapshot: () => draft(), mayBackUp: () => true, onFailed: () => { failed++; } }).save();
    expect(failed).toBe(1);
  });
});
