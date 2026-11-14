import { afterEach, expect, it, vi } from 'vitest';
import { initializeDrafts, type BootDeps } from './boot';
import { createEditorState } from './editor-state';
import type { StatusLine } from '../ui/status-line';
import { listStoredDrafts, openDraftDatabase } from '../editor/indexeddb';

vi.mock('../editor/drafts', async original => ({ ...await original<typeof import('../editor/drafts')>(), readActiveDraftId: () => null }));
vi.mock('../editor/indexeddb', () => ({ openDraftDatabase: vi.fn(), listStoredDrafts: vi.fn(), getStoredDraft: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['error', 'acquired', 'rejected'])('invalidated startup cannot install erased content or finalize over a fresh session (%s)', async outcome => {
  vi.stubGlobal('window', { location: { search: '' } });
  const state = createEditorState();
  const erased = { ...state.active, text: 'erased startup', revision: 1 };
  const oldDb = { close: vi.fn() } as unknown as IDBDatabase;
  const newDb = { close: vi.fn() } as unknown as IDBDatabase;
  vi.mocked(openDraftDatabase).mockResolvedValueOnce(oldDb);
  vi.mocked(listStoredDrafts).mockResolvedValueOnce([erased]);
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const release = vi.fn(async () => undefined);
  const acquireFor = vi.fn(async () => {
    await gate;
    if (outcome === 'rejected') throw new Error('Storage invalidated');
    return { block: outcome === 'acquired' ? '' as const : 'error' as const, generation: 0,
      ...(outcome === 'acquired' ? { ownership: { documentId: erased.id, release } as never } : {}) };
  });
  const showDraft = vi.fn(), installOwnership = vi.fn(), finishInitialization = vi.fn(), applyEditAccess = vi.fn();
  const field = { disabled: false }, select = { disabled: false }, title = { disabled: false };
  const deps = {
    ownerReady: Promise.resolve(), readPending: () => erased, clearPending: () => undefined, acquireFor,
    showDraft, installOwnership, applyEditAccess, finishInitialization,
    field, draftSelect: select, draftTitle: title,
  } as unknown as BootDeps;
  const initializing = initializeDrafts(state, {} as StatusLine, deps);
  await vi.waitFor(() => expect(acquireFor).toHaveBeenCalledOnce());
  state.storageGeneration++;
  state.active = { ...state.active, id: 'fresh', text: '', revision: 0 };
  state.db = newDb;
  complete(); await initializing;
  expect(state.active.id).toBe('fresh'); expect(state.active.text).toBe('');
  expect(state.db).toBe(newDb); expect(newDb.close).not.toHaveBeenCalled();
  expect(showDraft).not.toHaveBeenCalled(); expect(installOwnership).not.toHaveBeenCalled();
  expect(applyEditAccess).not.toHaveBeenCalled(); expect(finishInitialization).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(outcome === 'acquired' ? 1 : 0);
});
