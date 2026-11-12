import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { createRecovery } from './recovery';
import type { StatusLine } from '../ui/status-line';

vi.mock('../ui/confirm-dialog', () => ({
  askConfirmChoice: vi.fn(async () => false),
}));

type StubEl = {
  hidden: boolean;
  textContent: string;
  className: string;
  setAttribute: (name: string, value: string) => void;
  addEventListener: () => void;
  replaceChildren: () => void;
  append: () => void;
  before: (node: StubEl) => void;
  role?: string;
};

beforeEach(() => {
  const storageMap = new Map<string, string>();
  const inserted: StubEl[] = [];
  const makeEl = (): StubEl => {
    const el: StubEl = {
      hidden: false,
      textContent: '',
      className: '',
      setAttribute: (name, value) => { if (name === 'role') el.role = value; },
      addEventListener: () => undefined,
      replaceChildren: () => undefined,
      append: () => undefined,
      before: node => { inserted.push(node); },
    };
    return el;
  };
  vi.stubGlobal('document', {
    createElement: () => makeEl(),
    addEventListener: () => undefined,
    querySelector: () => null,
  });
  vi.stubGlobal('localStorage', {
    get length() { return storageMap.size; },
    key: (i: number) => [...storageMap.keys()][i] ?? null,
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => { storageMap.set(k, v); },
    removeItem: (k: string) => { storageMap.delete(k); },
    clear: () => { storageMap.clear(); },
  });
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    setInterval: () => 0,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => undefined,
    crypto: { randomUUID: () => 'tab-1' },
  });
  vi.stubGlobal('navigator', { locks: undefined });
  (globalThis as { __recoveryStorage?: Map<string, string> }).__recoveryStorage = storageMap;
  (globalThis as { __recoveryInserted?: StubEl[] }).__recoveryInserted = inserted;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recovery read warning (#254 Codex P2)', () => {
  it('clears a sticky read warning after listRecovery succeeds', async () => {
    // Fails if renderRecovery leaves journalWarningKind=read after a successful retry.
    const storageMap = (globalThis as unknown as { __recoveryStorage: Map<string, string> }).__recoveryStorage;
    storageMap.set('typebridge.recovery.v1.other.doc', JSON.stringify({
      token: 't', tab: 'other', documentId: 'doc', revision: 0, timestamp: 1,
      title: 'X', text: 'y',
    }));

    let failKey = true;
    const storage = localStorage;
    const originalKey = storage.key.bind(storage);
    storage.key = (index: number) => {
      const key = originalKey(index);
      if (failKey && key?.startsWith('typebridge.recovery.v1.')) {
        throw new DOMException('blocked', 'UnknownError');
      }
      return key;
    };

    const state = createEditorState();
    const status = { announceAction: () => undefined } as unknown as StatusLine;
    const recovery = createRecovery(state, status, {
      viewMode: false,
      autosave: { checked: true } as HTMLInputElement,
      field: { value: '' } as HTMLTextAreaElement,
      draftTitle: { value: '' } as HTMLInputElement,
      anchor: document.createElement('div') as unknown as Element,
      postSignal: () => undefined,
      refreshDrafts: async () => undefined,
      changeLogProtects: () => false,
      changeLogIdle: async () => undefined,
      indexedDbUsable: () => true,
    });

    const inserted = (globalThis as unknown as { __recoveryInserted: StubEl[] }).__recoveryInserted;
    const warning = inserted.find(el => el.role === 'alert');
    expect(warning).toBeTruthy();

    await recovery.renderRecovery();
    expect(warning!.hidden).toBe(false);
    expect(warning!.textContent).toContain('cannot be read');

    failKey = false;
    await recovery.renderRecovery();
    expect(warning!.hidden).toBe(true);
  });
});
