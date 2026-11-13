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

  it('a save covers a backup only with matching content and history', () => {
    expect(sameContent(draft(), draft({ updatedAt: 5 }))).toBe(true);
    expect(sameContent(draft(), draft({ text: 'другой' }))).toBe(false);
    expect(savedCoversBackup(draft({ text: 'новее', updatedAt: 200 }), draft({ updatedAt: 150 }))).toBe(false);
    expect(savedCoversBackup(draft({ text: 'новее', updatedAt: 200 }), draft({ updatedAt: 200 }))).toBe(false);
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
    backup.clear(current);
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


it.each([100, 99])('keeps a different backup written during a save despite timestamp %s', timestamp => {
  const storage = memorySession();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
  let current = draft({ text: 'old', updatedAt: 100 });
  const backup = createReloadBackup({ key: 'k', snapshot: () => current, mayBackUp: () => true, onFailed: () => {} });
  backup.save();
  const saved = current;
  const finishSave = backup.prepareClear(saved);
  current = draft({ text: 'new', updatedAt: timestamp });
  backup.save();
  finishSave();
  expect(backup.read()?.text).toBe('new');
});

it('removes an unchanged older backup observed before a newer save', () => {
  const storage = memorySession();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
  const backup = createReloadBackup({ key: 'k', snapshot: () => draft({ text: 'old' }), mayBackUp: () => true, onFailed: () => {} });
  backup.save();
  const finishSave = backup.prepareClear(draft({ text: 'new' }));
  finishSave();
  expect(backup.read()).toBeUndefined();
});

it('retains different titles/history and foreign-document backups regardless of clocks', () => {
  const saved = draft();
  expect(savedCoversBackup(draft({ title: 'Changed', updatedAt: 1 }), saved)).toBe(false);
  const history = { v: 1 as const, current: saved.text, undo: [], redo: [] };
  expect(savedCoversBackup(draft({ history, updatedAt: 1 }), saved)).toBe(false);
  expect(savedCoversBackup(draft({ id: 'other', updatedAt: 1 }), saved)).toBe(false);
});


it('distinguishes a new identical backup write from the pre-save backup at the same timestamp', () => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = memorySession();
  const backup = createReloadBackup({ key: 'k', snapshot: () => draft({ text: 'old' }), mayBackUp: () => true, onFailed: () => {} });
  backup.save();
  const finishSave = backup.prepareClear(draft({ text: 'new' }));
  backup.save(); // A later revert can recreate identical content and timestamps.
  finishSave();
  expect(backup.read()?.text).toBe('old');
  expect(backup.read()).not.toHaveProperty('reloadBackupToken');
});

it('keeps backups with search-only changes and round-trips four fields without changing histories', () => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = memorySession();
  const publicDraft = draft({ find: 'public find', replace: 'public replace' });
  let current = publicDraft;
  let mayWrite = true;
  const backup = createReloadBackup({ key: 'k', snapshot: () => current, mayBackUp: () => mayWrite, onFailed: () => {} });
  backup.save();
  const finishSave = backup.prepareClear(publicDraft);
  current = draft({ find: 'new find', replace: 'new replace' });
  backup.save();
  finishSave();
  expect(backup.read()).toMatchObject({ find: 'new find', replace: 'new replace' });
  backup.clear(publicDraft);
  expect(backup.read()).toBeDefined();
  mayWrite = false;
  current = draft({ find: 'SECRET find', replace: 'SECRET replace' });
  backup.save();
  expect(sessionStorage.getItem('k')).not.toContain('SECRET');
  expect(sameContent(draft(), draft({ find: '', replace: '' }))).toBe(true);
  expect(sameContent(publicDraft, draft({ find: 'public find', replace: 'different' }))).toBe(false);
  expect(parsePendingDraft(JSON.stringify({ ...draft(), find: 42 }))).toBeUndefined();
});
