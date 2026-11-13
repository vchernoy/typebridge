import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  documentAutosaveChecked,
  newPrivateDocument,
  PRIVATE_SWITCH_FLAG_FAILED,
  PRIVATE_SWITCH_SAVE_FAILED,
  privateNow,
  privateSessionOn,
  setPrivateSessionOn,
} from './privacy';

const realLocal = globalThis.localStorage;
afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = realLocal;
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

describe('privateNow (#257 step 1)', () => {
  it('is false when the session is off and the document has no private flag', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(privateSessionOn()).toBe(false);
    expect(privateNow(undefined)).toBe(false);
    expect(privateNow({})).toBe(false);
    expect(documentAutosaveChecked({})).toBe(true);
  });

  it('is true when the document flag is set', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    expect(privateNow({ private: true })).toBe(true);
    expect(documentAutosaveChecked({ private: true })).toBe(false);
  });

  it('is true for every document when the private session is on', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage({
      'typebridge.autosave.v1': 'off',
    });
    expect(privateSessionOn()).toBe(true);
    expect(privateNow({})).toBe(true);
    expect(privateNow({ private: false })).toBe(true);
    expect(documentAutosaveChecked({ private: false })).toBe(false);
  });

  it('setPrivateSessionOn writes the legacy Autosave preference key', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    setPrivateSessionOn(true);
    expect(localStorage.getItem('typebridge.autosave.v1')).toBe('off');
    setPrivateSessionOn(false);
    expect(localStorage.getItem('typebridge.autosave.v1')).toBe('on');
  });

  it('fails closed to the last known session when localStorage throws (#257 P0)', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    setPrivateSessionOn(true);
    expect(privateSessionOn()).toBe(true);
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() { return 0; },
      key: () => null,
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      removeItem: () => undefined,
      clear: () => undefined,
    };
    expect(privateSessionOn()).toBe(true);
    expect(privateNow({})).toBe(true);
    expect(documentAutosaveChecked({})).toBe(false);
  });

  it('fails closed before the first preference read when localStorage throws (#257 P0)', async () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() { return 0; },
      key: () => null,
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      removeItem: () => undefined,
      clear: () => undefined,
    };
    vi.resetModules();
    const fresh = await import('./privacy');
    expect(fresh.privateSessionOn()).toBe(true);
    expect(fresh.privateNow({})).toBe(true);
    expect(fresh.documentAutosaveChecked({})).toBe(false);
  });

  it('exposes the switch-time warning strings from the issue notes', () => {
    expect(PRIVATE_SWITCH_SAVE_FAILED).toMatch(/before going private/);
    expect(PRIVATE_SWITCH_FLAG_FAILED).toMatch(/may not reopen as private/);
  });
});

it('hides only never-saved private identities, including global private session', () => {
  expect(newPrivateDocument({ revision: 0 }, true)).toBe(true);
  expect(newPrivateDocument({ revision: 0, private: true }, false)).toBe(true);
  expect(newPrivateDocument({ revision: 0 }, false)).toBe(false);
  expect(newPrivateDocument({ revision: 1, private: true }, true)).toBe(false);
});
