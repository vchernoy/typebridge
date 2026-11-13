import { afterEach, describe, expect, it } from 'vitest';
import type { RecoverySnapshot } from '../editor/recovery';
import {
  clearReloadDiscardIntent,
  clearReloadDiscardPending,
  isReloadDiscardPendingActive,
  readReloadDiscardIntent,
  readReloadDiscardPending,
  RELOAD_DISCARD_PENDING_TTL_MS,
  reloadDiscardIntentKey,
  reloadDiscardSalvageAction,
  setReloadDiscardIntent,
  setReloadDiscardPending,
} from './reload-discard';

function memoryStorage(): Storage {
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
const realLocal = (globalThis as { localStorage?: Storage }).localStorage;
afterEach(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = realSession;
  (globalThis as { localStorage?: Storage }).localStorage = realLocal;
});

const journal = (over: Partial<RecoverySnapshot> = {}): RecoverySnapshot => ({
  token: 'tok-1',
  tab: 'tab-a',
  documentId: 'doc-1',
  revision: 1,
  timestamp: 100,
  title: 'Untitled document',
  text: 'discarded',
  ...over,
});

describe('reload discard session intent (#255)', () => {
  it('stores and clears intent by instance id', () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
    setReloadDiscardIntent('inst-a', { documentId: 'doc-1' });
    expect(readReloadDiscardIntent('inst-a')).toEqual({ documentId: 'doc-1' });
    expect(sessionStorage.getItem(reloadDiscardIntentKey('inst-a'))).toContain('doc-1');
    clearReloadDiscardIntent('inst-a');
    expect(readReloadDiscardIntent('inst-a')).toBeUndefined();
  });

  it('keeps another instance intent when clearing one', () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
    setReloadDiscardIntent('inst-a', { documentId: 'doc-1' });
    setReloadDiscardIntent('inst-b', { documentId: 'doc-2' });
    clearReloadDiscardIntent('inst-a');
    expect(readReloadDiscardIntent('inst-b')).toEqual({ documentId: 'doc-2' });
  });

  it('round-trips the exact consented journal snapshot', () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
    const snap = journal();
    setReloadDiscardIntent('inst-a', { documentId: 'doc-1', journal: snap });
    expect(readReloadDiscardIntent('inst-a')).toEqual({ documentId: 'doc-1', journal: snap });
  });

  it('ignores a malformed journal field and still returns document consent', () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
    sessionStorage.setItem(reloadDiscardIntentKey('inst-a'), JSON.stringify({
      documentId: 'doc-1', journal: { token: '', text: 'x' },
    }));
    expect(readReloadDiscardIntent('inst-a')).toEqual({ documentId: 'doc-1' });
  });
});

describe('reload discard pending flag (#256 foreign-tab P0)', () => {
  it('is active until cleared or TTL elapses', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    const at = 1_000_000;
    setReloadDiscardPending('doc-1', 'inst-a', at);
    expect(readReloadDiscardPending('doc-1')).toEqual({ instanceId: 'inst-a', at });
    expect(isReloadDiscardPendingActive('doc-1', at + 1_000)).toBe(true);
    expect(isReloadDiscardPendingActive('doc-1', at + RELOAD_DISCARD_PENDING_TTL_MS + 1)).toBe(false);
    expect(clearReloadDiscardPending('doc-1', 'inst-a')).toBe(true);
    expect(isReloadDiscardPendingActive('doc-1', at + 1_000)).toBe(false);
  });

  it('does not clear a pending flag owned by another instance (#256 Codex P0)', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    const at = 1_000_000;
    setReloadDiscardPending('doc-1', 'consenting', at);
    expect(clearReloadDiscardPending('doc-1', 'foreign')).toBe(false);
    expect(readReloadDiscardPending('doc-1')).toEqual({ instanceId: 'consenting', at });
    expect(isReloadDiscardPendingActive('doc-1', at + 1_000)).toBe(true);
  });

  it('defers salvage for a foreign tab while pending is active without consent', () => {
    expect(reloadDiscardSalvageAction({ hasMarker: true, consented: false, pendingActive: true })).toBe('defer');
    expect(reloadDiscardSalvageAction({ hasMarker: true, consented: true, pendingActive: true })).toBe('apply');
    expect(reloadDiscardSalvageAction({ hasMarker: true, consented: false, pendingActive: false })).toBe('drop-marker');
    expect(reloadDiscardSalvageAction({ hasMarker: false, consented: false, pendingActive: true })).toBe('defer');
    expect(reloadDiscardSalvageAction({ hasMarker: false, consented: false, pendingActive: false })).toBe('none');
  });
});
