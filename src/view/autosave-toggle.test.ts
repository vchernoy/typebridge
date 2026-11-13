import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { createAutosaveToggle } from './autosave-toggle';
import { PRIVATE_SWITCH_FLAG_FAILED, PRIVATE_SWITCH_SAVE_FAILED } from '../editor/privacy';
import type { StatusLine } from '../ui/status-line';
import type { Workspace } from './workspace';
import type { StoredDraft } from '../editor/indexeddb';

vi.mock('../editor/indexeddb', async importOriginal => {
  const actual = await importOriginal<typeof import('../editor/indexeddb')>();
  return {
    ...actual,
    updateDocumentPrivateFlag: vi.fn(),
  };
});

import { updateDocumentPrivateFlag } from '../editor/indexeddb';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(updateDocumentPrivateFlag).mockReset();
});

function makeWorkspace(dirty = false, revision = { value: 1 }): Workspace {
  return {
    sessionId: 'session-1' as const,
    paneId: 'pane-a' as const,
    sessionGeneration: () => 1,
    contentRevision: () => revision.value,
    paneGeneration: () => 0,
    bumpSessionGeneration: () => 1,
    bumpContentRevision: () => { revision.value += 1; return revision.value; },
    documentId: () => 'doc',
    setDocumentId: () => undefined,
    dirty: () => dirty,
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

function harness(options: {
  dirty?: boolean;
  revision?: number;
  persistSaved?: boolean;
  flagOk?: boolean;
  changeLogProtects?: boolean;
} = {}) {
  const state = createEditorState();
  state.active = {
    id: 'doc',
    title: 'T',
    text: 'saved',
    updatedAt: 1,
    revision: options.revision ?? 1,
  };
  state.db = {} as IDBDatabase;
  state.ownership = {
    documentId: 'doc',
    writeFence: async () => ({ instanceId: 'i', fence: 1 }),
    release: async () => undefined,
  } as never;

  const autosave = { checked: true, disabled: false } as HTMLInputElement;
  const privateMarker = { hidden: true } as HTMLElement;
  const announceAction = vi.fn();
  const setSaveStatus = vi.fn();
  const clearNotices = vi.fn();
  const showSaveState = vi.fn();
  const showSaving = vi.fn();
  const status = {
    announceAction,
    setSaveStatus,
    clearNotices,
    showSaveState,
    showSaving,
    riskText: () => '',
  } as unknown as StatusLine;

  const revision = { value: 1 };
  const persistLastBeforePrivate = vi.fn(async () => ({
    saved: options.persistSaved !== false,
    conflict: false,
  }));
  const persist = vi.fn(async () => ({ saved: true, conflict: false }));
  const cancel = vi.fn();
  const drainChanges = vi.fn(async () => {
    // Private typing during drain bumps the content revision past the freeze.
    revision.value += 1;
  });
  const abandonChangeRun = vi.fn();
  const renderDrafts = vi.fn();
  const syncAutosaveControl = vi.fn();

  vi.mocked(updateDocumentPrivateFlag).mockResolvedValue(
    options.flagOk === false
      ? { ok: false, reason: 'conflict', current: state.active }
      : { ok: true, draft: { ...state.active, private: true } },
  );

  const toggle = createAutosaveToggle(state, status, {
    autosave,
    privateMarker,
    workspace: makeWorkspace(options.dirty === true, revision),
    viewMode: false,
    embedded: true,
    transferFrozen: () => false,
    controlBlocked: () => false,
    journalEdit: () => undefined,
    persist,
    persistLastBeforePrivate,
    snapshot: (): StoredDraft => ({ ...state.active, text: 'saved', title: 'T' }),
    changeLogProtects: () => options.changeLogProtects === true,
    saver: { cancel, inFlight: () => undefined, drainChanges },
    abandonChangeRun,
    refreshDrafts: async () => undefined,
    renderDrafts,
    loseOwnership: () => undefined,
    syncAutosaveControl,
  });

  return {
    toggle, state, autosave, privateMarker, persistLastBeforePrivate,
    announceAction, setSaveStatus, abandonChangeRun, revision,
  };
}

describe('createAutosaveToggle going private (#257)', () => {
  it('saves private:true then announces Autosave off', async () => {
    const { toggle, state, autosave, privateMarker, persistLastBeforePrivate, setSaveStatus } = harness();
    await toggle.applyDocumentChange(false);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ private: true, text: 'saved', title: 'T' }),
      1,
    );
    expect(state.active.private).toBe(true);
    expect(autosave.checked).toBe(false);
    expect(privateMarker.hidden).toBe(false);
    expect(setSaveStatus).toHaveBeenCalled();
  });

  it('falls back to flag-only update and warns when dirty text was not change-log covered', async () => {
    const { toggle, announceAction, abandonChangeRun } = harness({
      dirty: true,
      persistSaved: false,
      flagOk: true,
      changeLogProtects: false,
    });
    await toggle.applyDocumentChange(false);
    expect(updateDocumentPrivateFlag).toHaveBeenCalled();
    expect(abandonChangeRun).toHaveBeenCalled();
    expect(announceAction).toHaveBeenCalledWith(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
  });

  it('warns when the flag-only update also fails', async () => {
    const { toggle, announceAction } = harness({
      dirty: true,
      persistSaved: false,
      flagOk: false,
    });
    await toggle.applyDocumentChange(false);
    expect(announceAction).toHaveBeenCalledWith(PRIVATE_SWITCH_FLAG_FAILED, { keepConflict: true });
  });

  it('passes the freeze-time content revision, not a post-drain bump (#257 P0)', async () => {
    const { toggle, persistLastBeforePrivate, revision } = harness();
    await toggle.applyDocumentChange(false);
    expect(revision.value).toBe(2);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(expect.anything(), 1);
  });
});
