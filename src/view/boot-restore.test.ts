import { afterEach, expect, it, vi } from 'vitest';
import { initializeDrafts, type BootDeps } from './boot';
import { createEditorState } from './editor-state';
import type { StatusLine } from '../ui/status-line';

vi.mock('../editor/drafts', async original => ({ ...await original<typeof import('../editor/drafts')>(), readActiveDraftId: () => null }));
vi.mock('../editor/indexeddb', () => ({ openDraftDatabase: async () => ({}), listStoredDrafts: async () => [], getStoredDraft: async () => undefined }));
afterEach(() => vi.unstubAllGlobals());

it('recaches restored pending content after the dirty/revision bump, before persist (#263)', async () => {
  vi.stubGlobal('window', { location: { search: '' } });
  const state = createEditorState();
  const pending = { ...state.active, text: 'recovered', revision: 1 };
  let dirty = false, revision = 0;
  const cached: Array<{ dirty: boolean; revision: number }> = [];
  const cache = () => { cached.push({ dirty, revision }); };
  const persist = vi.fn(async () => {
    expect(cached.at(-1)).toEqual({ dirty: true, revision: 1 });
    expect(state.active.text).toBe('recovered');
    return { saved: true, conflict: false };
  });
  const deps = {
    ownerReady: Promise.resolve(), readPending: () => pending, allocateNewDraft: () => state.active,
    acquireFor: async () => ({ block: '', generation: 0 }), installOwnership: () => {},
    rememberActive: () => {}, showDraft: cache, noteWritableSnapshot: cache,
    workspace: { setDirty: (value: boolean) => { dirty = value; }, bumpContentRevision: () => { revision++; } },
    writingPosition: { prune: () => {}, restore: () => {} },
    applyEditAccess: () => {}, mayWrite: () => true, persist,
    field: {}, draftSelect: {}, draftTitle: {}, restoreFocusMode: () => {}, renderRecovery: async () => {}, finishInitialization: () => {},
  } as unknown as BootDeps;
  await initializeDrafts(state, { setSaveStatus: () => {} } as unknown as StatusLine, deps);
  expect(cached).toEqual([{ dirty: false, revision: 0 }, { dirty: true, revision: 1 }]);
  expect(persist).toHaveBeenCalledOnce();
});
