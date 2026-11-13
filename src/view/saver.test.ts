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

import { commitOrCreateConflictCopy } from '../editor/indexeddb';
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
      updatedAt: 1,
      revision: 1,
    };
    const result = await saver.persistLastBeforePrivate(frozen, 1, { markPrivate: false });
    expect(result).toEqual({ saved: true, conflict: false });
    const committedArg = vi.mocked(commitOrCreateConflictCopy).mock.calls[0]![1] as StoredDraft;
    expect(committedArg.text).toBe('pre-session');
    expect(committedArg.private).toBeUndefined();
    expect(state.active.private).toBeUndefined();
    expect(state.active.text).toBe('pre-session');
  });
});
