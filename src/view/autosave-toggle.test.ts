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
    deleteStoredDraft: vi.fn(),
  };
});

vi.mock('../ui/confirm-dialog', () => ({
  askConfirmChoice: vi.fn(async () => false),
}));

import { deleteStoredDraft, updateDocumentPrivateFlag } from '../editor/indexeddb';
import { askConfirmChoice } from '../ui/confirm-dialog';

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
  vi.mocked(deleteStoredDraft).mockReset();
  vi.mocked(askConfirmChoice).mockReset();
  vi.mocked(askConfirmChoice).mockResolvedValue(false);
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
    setDirty: vi.fn(),
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
  /** After await, changeLogProtects() returns this (defaults to changeLogProtects). */
  changeLogProtectsAfterAwait?: boolean;
  /** In-flight save moves active/ownership to this conflict copy before resolving. */
  inFlightConflict?: StoredDraft;
  deleteSaved?: boolean;
  sessionDirty?: boolean;
  /** Hold persistLastBeforePrivate until this promise resolves (session last-save races). */
  persistGate?: Promise<void>;
  firstCommit?: Promise<StoredDraft | undefined>;
  syncIdentity?: () => void;
  documentCleared?: (id: string) => void;
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
  let protects = options.changeLogProtects === true;
  const persistLastBeforePrivate = vi.fn(async (_frozen, _rev, opts?: { markPrivate?: boolean }) => {
    if (options.persistGate) await options.persistGate;
    return {
      saved: options.persistSaved !== false,
      conflict: false,
      markPrivate: opts?.markPrivate,
    };
  });
  const persist = vi.fn(async () => ({ saved: true, conflict: false }));
  const cancel = vi.fn();
  const drainChanges = vi.fn(async () => {
    // Private typing during drain bumps the content revision past the freeze.
    revision.value += 1;
  });
  const abandonChangeRun = vi.fn();
  const renderDrafts = vi.fn();
  const syncAutosaveControl = vi.fn();
  const postSignal = vi.fn();
  const clearDocumentBackups = vi.fn();
  const setDirty = vi.fn();
  const workspace = makeWorkspace(options.dirty === true || options.sessionDirty === true, revision);
  workspace.setDirty = setDirty;
  const frozenSnapshot: StoredDraft = {
    id: 'doc',
    title: 'T',
    text: options.inFlightConflict ? 'later edits' : 'saved',
    updatedAt: 1,
    revision: options.revision ?? 1,
  };

  vi.mocked(updateDocumentPrivateFlag).mockImplementation(async (_db, id, privateFlag, rev) => {
    if (options.flagOk === false) return { ok: false, reason: 'conflict', current: state.active };
    return {
      ok: true,
      draft: { ...state.active, id, revision: rev, private: privateFlag },
    };
  });
  vi.mocked(deleteStoredDraft).mockResolvedValue(true);
  vi.mocked(askConfirmChoice).mockResolvedValue(options.deleteSaved === true);

  const inFlight = options.firstCommit
    ? () => options.firstCommit!.then(draft => {
      if (draft) state.active = { ...draft, private: state.active.private };
      return { saved: !!draft, conflict: false };
    })
    : options.inFlightConflict
    ? () => Promise.resolve().then(() => {
      const copy = options.inFlightConflict!;
      state.active = { ...copy };
      state.ownership = {
        documentId: copy.id,
        writeFence: async () => ({ instanceId: 'i', fence: 2 }),
        release: async () => undefined,
      } as never;
      if (options.changeLogProtectsAfterAwait !== undefined) {
        protects = options.changeLogProtectsAfterAwait;
      }
      return { saved: false, conflict: true };
    })
    : () => undefined;

  const toggle = createAutosaveToggle(state, status, {
    syncIdentity: options.syncIdentity,
    documentCleared: options.documentCleared,
    autosave,
    privateMarker,
    workspace,
    viewMode: false,
    embedded: true,
    transferFrozen: () => false,
    controlBlocked: () => false,
    journalEdit: () => undefined,
    persist,
    persistLastBeforePrivate,
    snapshot: (): StoredDraft => ({ ...frozenSnapshot }),
    changeLogProtects: () => protects,
    saver: { cancel, inFlight, drainChanges },
    abandonChangeRun,
    refreshDrafts: async () => undefined,
    renderDrafts,
    loseOwnership: () => undefined,
    postSignal,
    clearDocumentBackups,
    syncAutosaveControl,
  });

  return {
    toggle, state, autosave, privateMarker, persistLastBeforePrivate,
    announceAction, setSaveStatus, abandonChangeRun, revision,
    postSignal, clearDocumentBackups, setDirty, cancel, frozenSnapshot, drainChanges,
  };
}

describe('createAutosaveToggle going private (#257)', () => {
  it('saves private:true then announces Autosave off', async () => {
    const { toggle, state, autosave, privateMarker, persistLastBeforePrivate, setSaveStatus } = harness();
    await toggle.applyDocumentChange(false);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ private: true, text: 'saved', title: 'T' }),
      1,
      { markPrivate: true },
    );
    expect(state.active.private).toBe(true);
    expect(autosave.checked).toBe(false);
    expect(privateMarker.hidden).toBe(false);
    expect(askConfirmChoice).toHaveBeenCalled();
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
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(expect.anything(), 1, { markPrivate: true });
  });

  it('rebases the freeze onto an in-flight conflict copy (#257 P1)', async () => {
    const conflict: StoredDraft = {
      id: 'copy',
      title: 'T (conflict)',
      text: 'earlier save',
      updatedAt: 2,
      revision: 1,
    };
    const { toggle, persistLastBeforePrivate, state } = harness({
      dirty: true,
      changeLogProtects: true,
      changeLogProtectsAfterAwait: false,
      inFlightConflict: conflict,
    });
    await toggle.applyDocumentChange(false);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'copy',
        revision: 1,
        text: 'later edits',
        title: 'T',
        private: true,
      }),
      1,
      { markPrivate: true },
    );
    expect(state.active.id).toBe('copy');
    expect(state.active.private).toBe(true);
  });

  it('warns when an in-flight conflict drops change-log coverage (#257 P1)', async () => {
    const conflict: StoredDraft = {
      id: 'copy',
      title: 'T (conflict)',
      text: 'earlier save',
      updatedAt: 2,
      revision: 1,
    };
    const { toggle, announceAction } = harness({
      dirty: true,
      persistSaved: false,
      flagOk: true,
      changeLogProtects: true,
      changeLogProtectsAfterAwait: false,
      inFlightConflict: conflict,
    });
    await toggle.applyDocumentChange(false);
    expect(announceAction).toHaveBeenCalledWith(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
  });

  it('deletes the saved copy, change records and backups when chosen (#257 follow-up)', async () => {
    const { toggle, state, postSignal, clearDocumentBackups, setDirty } = harness({
      deleteSaved: true,
    });
    await toggle.applyDocumentChange(false);
    expect(deleteStoredDraft).toHaveBeenCalled();
    expect(clearDocumentBackups).toHaveBeenCalledWith('doc');
    expect(postSignal).toHaveBeenCalledWith('deleted', 'doc', 1);
    expect(state.active.revision).toBe(0);
    expect(state.active.private).toBe(true);
    expect(setDirty).toHaveBeenCalledWith(true);
  });

  it('keeps delete-failure feedback instead of Autosave off (#260 Codex P1)', async () => {
    const { toggle, announceAction, setSaveStatus } = harness({ deleteSaved: true });
    vi.mocked(deleteStoredDraft).mockResolvedValue(false);
    await toggle.applyDocumentChange(false);
    expect(announceAction).toHaveBeenCalledWith(
      'Could not delete saved document; current text is kept',
      { keepConflict: true },
    );
    expect(setSaveStatus.mock.calls.every(call => !String(call[0]).includes('Autosave off'))).toBe(true);
    expect(announceAction.mock.calls.at(-1)?.[0]).toBe('Could not delete saved document; current text is kept');
  });

  it('reports list-refresh failure separately from a successful delete (#260 Codex P2)', async () => {
    const state = createEditorState();
    state.active = { id: 'doc', title: 'T', text: 'saved', updatedAt: 1, revision: 1 };
    state.db = {} as IDBDatabase;
    state.ownership = {
      documentId: 'doc',
      writeFence: async () => ({ instanceId: 'i', fence: 1 }),
      release: async () => undefined,
    } as never;
    const autosave = { checked: true, disabled: false } as HTMLInputElement;
    const announceAction = vi.fn();
    const setSaveStatus = vi.fn();
    const status = {
      announceAction,
      setSaveStatus,
      clearNotices: vi.fn(),
      showSaveState: vi.fn(),
      showSaving: vi.fn(),
      riskText: () => '',
    } as unknown as StatusLine;
    vi.mocked(deleteStoredDraft).mockResolvedValue(true);
    vi.mocked(askConfirmChoice).mockResolvedValue(true);
    const toggle = createAutosaveToggle(state, status, {
      autosave,
      privateMarker: { hidden: true } as HTMLElement,
      workspace: makeWorkspace(false),
      viewMode: false,
      embedded: true,
      transferFrozen: () => false,
      controlBlocked: () => false,
      journalEdit: () => undefined,
      persist: async () => ({ saved: true, conflict: false }),
      persistLastBeforePrivate: async () => ({ saved: true, conflict: false }),
      snapshot: () => ({ ...state.active }),
      changeLogProtects: () => true,
      saver: { cancel: () => undefined, inFlight: () => undefined, drainChanges: async () => undefined },
      abandonChangeRun: () => undefined,
      refreshDrafts: async () => { throw new Error('list failed'); },
      renderDrafts: () => undefined,
      loseOwnership: () => undefined,
      postSignal: () => undefined,
      clearDocumentBackups: () => undefined,
      syncAutosaveControl: () => undefined,
    });
    await toggle.applyDocumentChange(false);
    expect(announceAction).toHaveBeenCalledWith(
      'Saved copy deleted, but the document list could not be refreshed',
      { keepConflict: true },
    );
    expect(announceAction).not.toHaveBeenCalledWith(
      'Could not delete saved document; current text is kept',
      expect.anything(),
    );
    expect(state.active.revision).toBe(0);
  });
});

describe('createAutosaveToggle private session (#257 follow-up)', () => {
  it('saves dirty text without private:true when the session turns on', async () => {
    const { toggle, persistLastBeforePrivate, state, abandonChangeRun } = harness({
      sessionDirty: true,
    });
    // Preference already flipped by Settings before applySessionChange.
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'saved', title: 'T' }),
      1,
      { markPrivate: false },
    );
    expect(state.active.private).toBeUndefined();
    expect(abandonChangeRun).toHaveBeenCalled();
    expect(askConfirmChoice).not.toHaveBeenCalled();
  });

  it('does not last-save private-period text when the document was already private', async () => {
    const { toggle, persistLastBeforePrivate, state } = harness({ sessionDirty: true });
    state.active = { ...state.active, private: true };
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).not.toHaveBeenCalled();
  });

  it('syncFromStorage last-saves dirty text when another tab enabled Private session', async () => {
    const { toggle, persistLastBeforePrivate, state, abandonChangeRun } = harness({
      sessionDirty: true,
    });
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    toggle.syncFromStorage();
    await vi.waitFor(() => {
      expect(persistLastBeforePrivate).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'saved', title: 'T' }),
        1,
        { markPrivate: false },
      );
    });
    expect(state.active.private).toBeUndefined();
    expect(abandonChangeRun).toHaveBeenCalled();
  });

  it('warns when the private-session last-save fails instead of announcing Autosave off', async () => {
    const { toggle, persistLastBeforePrivate, announceAction, setSaveStatus } = harness({
      sessionDirty: true,
      persistSaved: false,
    });
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalled();
    expect(announceAction).toHaveBeenCalledWith(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
    expect(setSaveStatus.mock.calls.some(call => String(call[0]).includes('Autosave off'))).toBe(false);
  });

  it('does not last-save post-session typing when session-on is notified twice (#260 P1)', async () => {
    let releaseGate!: () => void;
    const persistGate = new Promise<void>(resolve => { releaseGate = resolve; });
    const { toggle, persistLastBeforePrivate, frozenSnapshot } = harness({
      sessionDirty: true,
      persistGate,
    });
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const first = toggle.applySessionChange(true);
    await vi.waitFor(() => expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1));
    // Typing after Private session is already on — must not enter a replayed last-save.
    frozenSnapshot.text = 'POST SESSION SECRET';
    toggle.syncFromStorage();
    releaseGate();
    await first;
    // Allow a queued microtask replay if one were scheduled.
    await Promise.resolve();
    await Promise.resolve();
    expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'saved', title: 'T' }),
      1,
      { markPrivate: false },
    );
  });

  it('skips a duplicate session-on after the transition already finished', async () => {
    const { toggle, persistLastBeforePrivate } = harness({ sessionDirty: true });
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1);
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1);
  });

  it('cancels a stale queued session-off when session-on is reasserted in flight (#260 P1)', async () => {
    let releaseGate!: () => void;
    const persistGate = new Promise<void>(resolve => { releaseGate = resolve; });
    const { toggle, persistLastBeforePrivate } = harness({
      sessionDirty: true,
      persistGate,
    });
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const first = toggle.applySessionChange(true);
    await vi.waitFor(() => expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1));
    // on → off → on while the first last-save awaits: the third event must cancel queued false.
    void toggle.applySessionChange(false);
    toggle.syncFromStorage();
    releaseGate();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1);
    // appliedSessionOn must remain true (not flipped by a stale queued off), so a further
    // session-on is an echo and must not start another last-save.
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledTimes(1);
  });

  it('last-saves the cached writable snapshot when storage is delayed after private typing (#260 P1)', async () => {
    const { toggle, persistLastBeforePrivate, frozenSnapshot, revision } = harness({
      sessionDirty: true,
    });
    // Writes still allowed — record the pre-privacy boundary after the edit bump (#262).
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    revision.value = 2;
    toggle.noteWritableSnapshot();
    // Another tab flipped Private session; localStorage already says private, but the
    // storage handler has not run yet. Post-private typing lands in the live field.
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    frozenSnapshot.text = 'POST PRIVATE TYPING';
    revision.value = 99;
    toggle.noteWritableSnapshot(); // must no-op while privateNow
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'saved', title: 'T' }),
      2,
      { markPrivate: false },
    );
  });

  it('pairs the writable cache with the post-edit content revision (#262)', async () => {
    const { toggle, persistLastBeforePrivate, revision } = harness({ sessionDirty: true });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    // Simulate scheduleSave bumping before noteWritableSnapshot (main.ts call order).
    revision.value = 5;
    toggle.noteWritableSnapshot();
    vi.stubGlobal('localStorage', {
      getItem: () => 'off',
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await toggle.applySessionChange(true);
    expect(persistLastBeforePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'saved', title: 'T' }),
      5,
      { markPrivate: false },
    );
  });
});

it('going private before the first save never makes a last save, even when dirty', async () => {
  const { toggle, persistLastBeforePrivate } = harness({ revision: 0, dirty: true });
  await toggle.applyDocumentChange(false);
  expect(persistLastBeforePrivate).not.toHaveBeenCalled();
  expect(updateDocumentPrivateFlag).not.toHaveBeenCalled();
});
it('session privacy never last-saves a new document', async () => {
  const { toggle, persistLastBeforePrivate } = harness({ revision: 0, sessionDirty: true });
  await toggle.applySessionChange(true);
  expect(persistLastBeforePrivate).not.toHaveBeenCalled();
});

for (const committed of [true, false]) it(`reconciles an in-flight first commit before finishing privacy: ${committed}`, async () => {
  let finish!: (draft: StoredDraft | undefined) => void;
  const firstCommit = new Promise<StoredDraft | undefined>(resolve => { finish = resolve; });
  const { toggle, state, autosave, persistLastBeforePrivate, revision } = harness({ revision: 0, dirty: true, firstCommit });
  const owner = state.ownership;
  const transition = toggle.applyDocumentChange(false);
  expect(toggle.isActive()).toBe(true); expect(state.active.private).toBe(true);
  expect(persistLastBeforePrivate).not.toHaveBeenCalled(); expect(state.ownership).toBe(owner);
  await toggle.applyDocumentChange(true); // Refused by the existing active-transition gate.
  expect(toggle.isActive()).toBe(true);
  expect(state.active.private).toBe(true); expect(persistLastBeforePrivate).not.toHaveBeenCalled();
  revision.value = 2;
  finish(committed ? { ...state.active, revision: 1 } : undefined);
  await transition;
  expect(autosave.checked).toBe(false); expect(toggle.isActive()).toBe(false);
  if (committed) expect(persistLastBeforePrivate).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'doc', revision: 1, text: 'saved', private: true }), 1, { markPrivate: true });
  else { expect(persistLastBeforePrivate).not.toHaveBeenCalled(); expect(askConfirmChoice).not.toHaveBeenCalled(); }
});

for (const committed of [true, false]) it(`session waits for first save settlement before final identity sync: ${committed}`, async () => {
  let finish!: (draft: StoredDraft | undefined) => void;
  const firstCommit = new Promise<StoredDraft | undefined>(resolve => { finish = resolve; });
  let settled = false;
  const synchronized: boolean[] = [];
  const { toggle, state, persistLastBeforePrivate } = harness({ revision: 0, sessionDirty: true, firstCommit,
    syncIdentity: () => synchronized.push(settled) });
  vi.stubGlobal('localStorage', { getItem: () => 'off' });
  const transition = toggle.applySessionChange(true);
  expect(toggle.isActive()).toBe(true); expect(synchronized.at(-1)).toBe(false);
  await toggle.applySessionChange(false);
  await toggle.applySessionChange(true); // Cancel the queued opposite target while the first save is held.
  expect(toggle.isActive()).toBe(true); expect(persistLastBeforePrivate).not.toHaveBeenCalled();
  settled = true;
  finish(committed ? { ...state.active, revision: 1 } : undefined);
  await transition;
  expect(toggle.isActive()).toBe(false); expect(synchronized.at(-1)).toBe(true);
  expect(state.active.private).not.toBe(true);
  expect(persistLastBeforePrivate).not.toHaveBeenCalled();
});

it('explicit document clear requires confirmation and never makes a replacement last-save', async () => {
  const documentCleared = vi.fn();
  const { toggle, state, persistLastBeforePrivate, clearDocumentBackups } = harness({ deleteSaved: true, documentCleared });
  await toggle.clearSavedData();
  expect(deleteStoredDraft).toHaveBeenCalled(); expect(documentCleared).toHaveBeenCalledWith('doc');
  expect(clearDocumentBackups).toHaveBeenCalledWith('doc'); expect(state.active).toMatchObject({ revision: 0, private: true });
  expect(persistLastBeforePrivate).not.toHaveBeenCalled();
});
it('cancelling document clear leaves its row and privacy state unchanged', async () => {
  const { toggle, state } = harness();
  await toggle.clearSavedData();
  expect(state.active.private).not.toBe(true); expect(deleteStoredDraft).not.toHaveBeenCalled();
});

it('document clearing abandons and drains queued records before deletion and ownership release', async () => {
  const { toggle, state, abandonChangeRun, drainChanges } = harness({ deleteSaved: true });
  let release!: () => void;
  drainChanges.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const held = state.ownership!;
  held.release = vi.fn(async () => undefined);
  const operation = toggle.clearSavedData();
  await vi.waitFor(() => expect(drainChanges).toHaveBeenCalledOnce());
  expect(abandonChangeRun).toHaveBeenCalledOnce();
  expect(deleteStoredDraft).not.toHaveBeenCalled(); expect(held.release).not.toHaveBeenCalled();
  release(); await operation;
  expect(deleteStoredDraft).toHaveBeenCalledOnce(); expect(held.release).toHaveBeenCalledOnce();
  expect(state.active.id).not.toBe('doc'); expect(state.ownership).toBeUndefined();
  expect(abandonChangeRun.mock.invocationCallOrder[0]).toBeLessThan(drainChanges.mock.invocationCallOrder[0]);
  expect(drainChanges.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteStoredDraft).mock.invocationCallOrder[0]);
  expect(vi.mocked(deleteStoredDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(held.release).mock.invocationCallOrder[0]);
});

it.each(['before', 'last-save', 'flag-write'] as const)('keeps the live format through flag-only privacy fallback: %s', async phase => {
  const h = harness({ dirty: true, persistSaved: false, flagOk: true, changeLogProtects: false });
  const stored = { ...h.state.active, format: 'plain' as const };
  if (phase === 'before') h.state.active.format = 'markdown';
  if (phase === 'last-save') h.persistLastBeforePrivate.mockImplementation(async () => {
    h.state.active.format = 'markdown'; h.revision.value++;
    return { saved: false, conflict: false, markPrivate: true };
  });
  vi.mocked(updateDocumentPrivateFlag).mockImplementation(async () => {
    if (phase === 'flag-write') { h.state.active.format = 'markdown'; h.revision.value++; }
    return { ok: true, draft: { ...stored, private: true, revision: 2 } };
  });
  await h.toggle.applyDocumentChange(false);
  expect(h.state.active).toMatchObject({ format: 'markdown', private: true, revision: 2 });
  expect(h.autosave.checked).toBe(false);
});
