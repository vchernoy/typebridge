import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import type { Workspace } from './workspace';
import type { StatusLine } from '../ui/status-line';
import type { StoredDraft } from '../editor/indexeddb';

vi.mock('../editor/indexeddb', async importOriginal => {
  const actual = await importOriginal<typeof import('../editor/indexeddb')>();
  return {
    ...actual,
    commitOrCreateConflictCopy: vi.fn(),
  };
});

vi.mock('../editor/recovery', () => ({
  clearRecovery: vi.fn(),
}));

import { commitOrCreateConflictCopy, EditOwnershipLostError } from '../editor/indexeddb';
import { createSaver } from './saver';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal('window', {} as Window);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(commitOrCreateConflictCopy).mockReset();
});

function makeWorkspace(documentId = 'doc'): Workspace {
  return {
    sessionId: 'session-1' as const,
    paneId: 'pane-a' as const,
    sessionGeneration: () => 1,
    contentRevision: () => 1,
    paneGeneration: () => 0,
    bumpSessionGeneration: () => 1,
    bumpContentRevision: () => 1,
    documentId: () => documentId,
    setDocumentId: () => undefined,
    dirty: () => false,
    setDirty: () => undefined,
    setPaneRole: () => undefined,
    activePaneId: () => 'pane-a' as const,
    setActivePane: () => undefined,
    captureCommandGeneration: () => ({
      sessionId: 'session-1' as const,
      paneId: 'pane-a' as const,
      paneGeneration: 0,
      sessionGeneration: 1,
    }),
    capturePersistGeneration: () => ({ sessionId: 'session-1' as const, sessionGeneration: 1 }),
    snapshotSession: () => ({}) as never,
    snapshotPane: () => ({}) as never,
    syncDom: () => undefined,
  };
}

describe('persistLastBeforePrivate (#257)', () => {
  it('calls rememberActive when the last save creates a conflict copy', async () => {
    const state = createEditorState();
    state.active = {
      id: 'doc',
      title: 'T',
      text: 'pre',
      updatedAt: 1,
      revision: 1,
      private: true,
    };
    state.db = {} as IDBDatabase;
    state.ownership = {
      documentId: 'doc',
      writeFence: async () => ({ instanceId: 'i', fence: 1 }),
      release: async () => undefined,
    } as never;

    const conflict: StoredDraft = {
      id: 'copy',
      title: 'T (conflict)',
      text: 'pre',
      updatedAt: 2,
      revision: 1,
      private: true,
    };
    vi.mocked(commitOrCreateConflictCopy).mockResolvedValue({
      draft: conflict,
      conflict: true,
    });

    const rememberActive = vi.fn();
    const takeOwnership = vi.fn(async () => undefined);
    const status = {
      setConflict: vi.fn(),
      shouldAttachDraftListRefreshFailure: () => false,
      markDraftListRefreshFailed: () => undefined,
    } as unknown as StatusLine;

    const saver = createSaver(state, status, {
      viewMode: false,
      mayWrite: () => false,
      draftTitle: { value: 'T' } as HTMLInputElement,
      workspace: makeWorkspace(),
      writingPosition: { save: () => undefined },
      snapshot: () => state.active,
      currentJournal: () => undefined,
      suppressEditTracking: () => false,
      readOnlyNow: () => false,
      preparePendingClear: () => () => undefined,
      clearVersionNotice: () => undefined,
      postSignal: () => undefined,
      journalEdit: () => undefined,
      changes: {
        edit: () => undefined,
        idle: async () => undefined,
        upToForSave: () => ({ upTo: 0, keepRun: 'run' }),
        saved: () => undefined,
      },
      onRecovered: () => undefined,
      rememberActive,
      updateSaveIndicator: () => undefined,
      syncTitleTooltip: () => undefined,
      takeOwnership,
      loseOwnership: () => undefined,
      refreshDrafts: async () => undefined,
      renderDrafts: () => undefined,
    });

    const frozen: StoredDraft = {
      id: 'doc',
      title: 'T',
      text: 'pre',
      updatedAt: 1,
      revision: 1,
    };
    const result = await saver.persistLastBeforePrivate(frozen, 1, { markPrivate: true });
    expect(result).toEqual({ saved: true, conflict: true });
    expect(state.active.id).toBe('copy');
    expect(rememberActive).toHaveBeenCalled();
    expect(takeOwnership).toHaveBeenCalledWith('copy');
  });

  it('session last-save commits without forcing private:true (#257 follow-up)', async () => {
    const state = createEditorState();
    state.active = {
      id: 'doc',
      title: 'T',
      text: 'old',
      updatedAt: 1,
      revision: 1,
    };
    state.db = {} as IDBDatabase;
    state.ownership = {
      documentId: 'doc',
      writeFence: async () => ({ instanceId: 'i', fence: 1 }),
      release: async () => undefined,
    } as never;

    const committed: StoredDraft = {
      id: 'doc',
      title: 'T',
      text: 'pre-session',
      find: 'pre-session find', replace: 'pre-session replace',
      updatedAt: 2,
      revision: 2,
    };
    vi.mocked(commitOrCreateConflictCopy).mockResolvedValue({
      draft: committed,
      conflict: false,
    });

    const saver = createSaver(state, {
      setConflict: vi.fn(),
      shouldAttachDraftListRefreshFailure: () => false,
      markDraftListRefreshFailed: () => undefined,
    } as unknown as StatusLine, {
      viewMode: false,
      mayWrite: () => false,
      draftTitle: { value: 'T' } as HTMLInputElement,
      workspace: makeWorkspace(),
      writingPosition: { save: () => undefined },
      snapshot: () => state.active,
      currentJournal: () => undefined,
      suppressEditTracking: () => false,
      readOnlyNow: () => false,
      preparePendingClear: () => () => undefined,
      clearVersionNotice: () => undefined,
      postSignal: () => undefined,
      journalEdit: () => undefined,
      changes: {
        edit: () => undefined,
        idle: async () => undefined,
        upToForSave: () => ({ upTo: 0, keepRun: 'run' }),
        saved: () => undefined,
      },
      onRecovered: () => undefined,
      rememberActive: () => undefined,
      updateSaveIndicator: () => undefined,
      syncTitleTooltip: () => undefined,
      takeOwnership: async () => undefined,
      loseOwnership: () => undefined,
      refreshDrafts: async () => undefined,
      renderDrafts: () => undefined,
    });

    const frozen: StoredDraft = {
      id: 'doc',
      title: 'T',
      text: 'pre-session',
      find: 'pre-session find', replace: 'pre-session replace',
      updatedAt: 1,
      revision: 1,
    };
    state.active.find = 'SECRET find'; state.active.replace = 'SECRET replace';
    const result = await saver.persistLastBeforePrivate(frozen, 1, { markPrivate: false });
    expect(result).toEqual({ saved: true, conflict: false });
    const committedArg = vi.mocked(commitOrCreateConflictCopy).mock.calls[0]![1] as StoredDraft;
    expect(committedArg.text).toBe('pre-session');
    expect(committedArg.find).toBe('pre-session find');
    expect(committedArg.replace).toBe('pre-session replace');
    expect(committedArg.private).toBeUndefined();
    expect(state.active.private).toBeUndefined();
    expect(state.active.text).toBe('pre-session');
  });
});

it.each([false, true, 'released'])('claims a new document before its first save, respecting privacy during acquisition: %s', async cancel => {
  const state = createEditorState(); state.db = {} as IDBDatabase;
  state.active = { id: 'new', title: 'T', text: 'body', revision: 0, updatedAt: 1 };
  let dirty = true, writable = true;
  const order: string[] = [];
  const takeOwnership = vi.fn(async () => {
    order.push('claim');
    if (cancel) writable = false;
    if (cancel === 'released') throw new EditOwnershipLostError();
    state.ownership = { documentId: 'new', writeFence: async () => ({ instanceId: 'i', fence: 1 }), release: async () => {} };
  });
  vi.mocked(commitOrCreateConflictCopy).mockImplementation(async () => {
    order.push('commit'); expect(state.ownership?.documentId).toBe('new');
    return { draft: { ...state.active, revision: 1 }, conflict: false };
  });
  const workspace = { ...makeWorkspace('new'), dirty: () => dirty, setDirty: (value: boolean) => { dirty = value; } };
  const saver = createSaver(state, {
    showSaving: () => {}, kind: () => 'action', shouldAttachDraftListRefreshFailure: () => false,
  } as unknown as StatusLine, {
    viewMode: false, mayWrite: () => writable, draftTitle: { value: 'T' } as HTMLInputElement, workspace,
    writingPosition: { save: () => {} }, snapshot: () => state.active, currentJournal: () => undefined,
    suppressEditTracking: () => false, readOnlyNow: () => false, preparePendingClear: () => () => {},
    clearVersionNotice: () => {}, postSignal: () => {}, journalEdit: () => {},
    changes: { edit: () => {}, idle: async () => {}, upToForSave: () => ({ upTo: 0, keepRun: 'run' }), saved: () => {} },
    onRecovered: () => {}, rememberActive: () => { order.push('identity'); }, updateSaveIndicator: () => {},
    syncTitleTooltip: () => {}, takeOwnership, loseOwnership: () => {}, refreshDrafts: async () => {}, renderDrafts: () => {},
  });
  expect(await saver.persist()).toEqual({ saved: !cancel, conflict: false });
  expect(order).toEqual(cancel ? ['claim'] : ['claim', 'commit', 'identity']);
});

it.each([
  { transitioning: false, risk: '', primary: '' },
  { transitioning: true, risk: '', primary: 'Saved locally' },
  { transitioning: true, risk: 'Storage unavailable.', primary: '' },
])('keeps committed conflict progress visible only during a risk-free transition: %j', async ({ transitioning, risk, primary }) => {
  const state = createEditorState();
  state.db = {} as IDBDatabase;
  state.active = { id: 'doc', title: 'T', text: 'body', revision: 1, updatedAt: 1 };
  state.transitioning = transitioning;
  state.ownership = { documentId: 'doc', writeFence: async () => ({ instanceId: 'i', fence: 1 }), release: async () => {} };
  let dirty = true;
  const updateStatus = vi.fn();
  const setConflict = vi.fn();
  vi.mocked(commitOrCreateConflictCopy).mockResolvedValue({ draft: { ...state.active, id: 'copy' }, conflict: true });
  const saver = createSaver(state, {
    showSaving: () => {}, kind: () => 'progress', riskText: () => risk, updateStatus, setConflict,
    shouldAttachDraftListRefreshFailure: () => false,
  } as unknown as StatusLine, {
    viewMode: false, mayWrite: () => true, draftTitle: { value: 'T' } as HTMLInputElement,
    workspace: { ...makeWorkspace(), dirty: () => dirty, setDirty: (value: boolean) => { dirty = value; } },
    writingPosition: { save: () => {} }, snapshot: () => state.active, currentJournal: () => undefined,
    suppressEditTracking: () => false, readOnlyNow: () => false, preparePendingClear: () => () => {},
    clearVersionNotice: () => {}, postSignal: () => {}, journalEdit: () => {},
    changes: { edit: () => {}, idle: async () => {}, upToForSave: () => ({ upTo: 0, keepRun: 'run' }), saved: () => {} },
    onRecovered: () => {}, rememberActive: () => {}, updateSaveIndicator: () => {}, syncTitleTooltip: () => {},
    takeOwnership: async () => {
      // This callback may await: the status must already describe the durable commit.
      expect(updateStatus).toHaveBeenLastCalledWith({ primary, risk }, transitioning ? 'progress' : 'conflict');
    },
    loseOwnership: () => {}, refreshDrafts: async () => {}, renderDrafts: () => {},
  });
  expect(await saver.persist()).toEqual({ saved: true, conflict: true });
  expect(setConflict).toHaveBeenCalledTimes(transitioning ? 0 : 1);
});
