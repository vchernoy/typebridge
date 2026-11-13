import { afterEach, expect, it, vi } from 'vitest';
import { createRecovery, type RecoveryDeps } from './recovery';
import { createEditorState } from './editor-state';
import { commitDraft } from '../editor/indexeddb';
import type { StatusLine } from '../ui/status-line';
vi.mock('../editor/indexeddb', () => ({ commitDraft: vi.fn(), getStoredDraft: async () => undefined }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['generation', 'backup'])('a pending Recover cannot recreate cleared content after %s invalidation', async invalidation => {
  type El = { textContent: string; hidden: boolean; handlers: Map<string, () => Promise<void>> };
  const elements: El[] = [];
  vi.stubGlobal('document', { createElement: () => {
    const el = { textContent: '', hidden: false, handlers: new Map(), setAttribute: () => {},
      append: () => {}, replaceChildren: () => {}, addEventListener: (name: string, fn: () => Promise<void>) => el.handlers.set(name, fn) };
    elements.push(el); return el;
  } });
  vi.stubGlobal('window', { addEventListener: () => {} }); vi.stubGlobal('setInterval', () => 0);
  const item = { token: 'token', tab: 'old', documentId: 'doc', text: 'erased recovery', title: 'Erased', timestamp: 1, revision: 1 };
  const key = 'typebridge.recovery.v1.old.doc', data = new Map([[key, JSON.stringify(item)]]);
  vi.stubGlobal('localStorage', { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => data.delete(key) });
  const query = vi.fn(async () => ({ held: [] }));
  vi.stubGlobal('navigator', { locks: { query, request: (_name: string, fn: () => void) => { fn(); return Promise.resolve(); } } });
  const state = createEditorState(); state.db = {} as IDBDatabase;
  const announceAction = vi.fn(), refreshDrafts = vi.fn(async () => undefined);
  const deps = { viewMode: false, anchor: { before: () => {} }, refreshDrafts } as unknown as RecoveryDeps;
  const recovery = createRecovery(state, { announceAction } as unknown as StatusLine, deps);
  await recovery.ownerReady; await recovery.renderRecovery();
  const button = elements.find(el => el.textContent.startsWith('Recover Erased'))!;
  let release!: () => void;
  query.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ held: [] }); }));
  const recovering = button.handlers.get('click')!();
  data.delete(key);
  if (invalidation === 'generation') { state.storageGeneration++; state.db = {} as IDBDatabase; }
  release(); await recovering;
  expect(commitDraft).not.toHaveBeenCalled(); expect(refreshDrafts).not.toHaveBeenCalled();
  expect(announceAction).not.toHaveBeenCalled();
});
