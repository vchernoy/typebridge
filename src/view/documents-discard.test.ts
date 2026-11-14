import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { createDocumentActions, type DocumentActionsDeps } from './documents';
import type { StatusLine } from '../ui/status-line';
import type { Workspace } from './workspace';

vi.mock('../ui/confirm-dialog', () => ({
  askConfirmChoice: vi.fn(async () => true),
}));
vi.mock('../editor/indexeddb', async importOriginal => {
  const actual = await importOriginal<typeof import('../editor/indexeddb')>();
  return {
    ...actual,
    getStoredDraft: vi.fn(async () => undefined),
  };
});

import { askConfirmChoice } from '../ui/confirm-dialog';
import { getStoredDraft } from '../editor/indexeddb';

beforeEach(() => {
  vi.stubGlobal('document', {
    querySelector: () => ({ focus: () => undefined }),
    addEventListener: () => undefined,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(askConfirmChoice).mockReset();
  vi.mocked(askConfirmChoice).mockResolvedValue(true);
});

function makeWorkspace(): Workspace {
  let revision = 1;
  let dirty = true;
  return {
    sessionId: 'session-1' as const,
    paneId: 'pane-a' as const,
    sessionGeneration: () => 1,
    contentRevision: () => revision,
    paneGeneration: () => 0,
    bumpSessionGeneration: () => 1,
    bumpContentRevision: () => { revision += 1; return revision; },
    documentId: () => 'doc',
    setDocumentId: () => undefined,
    dirty: () => dirty,
    setDirty: next => { dirty = next; },
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

describe('switchDraft discard cleanup (#254 Codex P1)', () => {
  it('cancels the switch when content changes during discardUnsavedRecovery', async () => {
    // Fails if switchDraft ignores a contentRevision bump while awaiting discard cleanup.
    let resolveDiscard!: () => void;
    const discardDone = new Promise<void>(resolve => { resolveDiscard = resolve; });
    const state = createEditorState();
    state.active = { id: 'doc-a', title: 'A', text: 'private', updatedAt: 1, revision: 1 };
    state.db = {} as IDBDatabase;
    const workspace = makeWorkspace();
    const announceAction = vi.fn();
    const allocateNewDraft = vi.fn(() => ({
      id: 'doc-b', title: 'Untitled document', text: '', updatedAt: 2, revision: 0,
    }));
    const discardUnsavedRecovery = vi.fn(async () => {
      workspace.bumpContentRevision();
      await discardDone;
    });
    const deps: DocumentActionsDeps = {
      viewMode: false,
      autosave: { checked: false } as HTMLInputElement,
      mayWrite: () => false,
      workspace,
      writingPosition: { save: () => undefined, remove: () => undefined },
      saver: {
        cancel: () => undefined,
        saveSoon: () => undefined,
        inFlight: () => undefined,
        drainChanges: async () => undefined,
      },
      persist: async () => ({ saved: false, conflict: false }),
      autosaveGate: () => undefined,
      focusHandoff: () => undefined,
      clearHeldEdits: () => undefined,
      readOnlyNow: () => false,
      freezeEditorsForTransition: () => undefined,
      unfreezeEditorsAfterTransition: () => undefined,
      syncAutosaveControl: () => undefined,
      allocateNewDraft,
      acquireFor: async () => ({ block: '', generation: 0 }),
      installOwnership: () => undefined,
      loseOwnership: () => undefined,
      rememberActive: () => undefined,
      showDraft: () => undefined,
      renderDrafts: () => undefined,
      refreshDrafts: async () => undefined,
      openDocumentIdsElsewhere: () => new Set(),
      postSignal: () => undefined,
      discardUnsavedRecovery,
    };
    const status = {
      setConflict: () => undefined,
      announceAction,
      showSaveState: () => undefined,
    } as unknown as StatusLine;
    const { switchDraft } = createDocumentActions(state, status, deps);
    const switching = switchDraft();
    await vi.waitFor(() => expect(discardUnsavedRecovery).toHaveBeenCalled());
    resolveDiscard();
    await expect(switching).resolves.toEqual({ opened: false, conflict: false });
    expect(allocateNewDraft).not.toHaveBeenCalled();
    expect(announceAction).toHaveBeenCalledWith(
      'Discard cancelled — the document changed while the dialog was open.',
    );
  });
});

it.each([false, true])('storage invalidation cancels a switch awaiting ownership (acquired=%s)', async acquired => {
  const state = createEditorState();
  state.active = { id: 'old', title: 'Old', text: 'old', revision: 1, updatedAt: 1 };
  state.db = {} as IDBDatabase;
  const target = { id: 'target', title: 'Target', text: 'erased target', revision: 1, updatedAt: 1 };
  vi.mocked(getStoredDraft).mockResolvedValueOnce(target);
  const workspace = makeWorkspace(); workspace.setDirty(false);
  let finishAcquire!: () => void;
  const acquiring = new Promise<void>(resolve => { finishAcquire = resolve; });
  const release = vi.fn(async () => undefined);
  const acquireFor = vi.fn(async () => {
    await acquiring;
    return { block: acquired ? '' as const : 'error' as const, generation: 0,
      ...(acquired ? { ownership: { documentId: target.id, release } as never } : {}) };
  });
  const installOwnership = vi.fn(), showDraft = vi.fn(), unfreeze = vi.fn();
  const noop = () => undefined;
  const deps = {
    viewMode: false, workspace, mayWrite: () => true,
    autosaveGate: noop, clearHeldEdits: noop, focusHandoff: noop, syncAutosaveControl: noop,
    saver: { cancel: noop }, freezeEditorsForTransition: noop, acquireFor,
    writingPosition: { save: noop }, rememberActive: noop, showDraft, installOwnership,
    refreshDrafts: async () => undefined, renderDrafts: noop, unfreezeEditorsAfterTransition: unfreeze,
  } as unknown as DocumentActionsDeps;
  const status = { showSaveState: noop, setConflict: noop, announceAction: vi.fn() } as unknown as StatusLine;
  const switching = createDocumentActions(state, status, deps).switchDraft(target.id);
  await vi.waitFor(() => expect(acquireFor).toHaveBeenCalledOnce());
  state.storageGeneration++;
  state.active = { id: 'fresh', title: 'Empty', text: '', revision: 0, updatedAt: 2 };
  state.transitioning = false;
  finishAcquire();
  await expect(switching).resolves.toEqual({ opened: false, conflict: false });
  expect(state.active.id).toBe('fresh'); expect(state.active.text).toBe('');
  expect(showDraft).not.toHaveBeenCalled(); expect(installOwnership).not.toHaveBeenCalled();
  expect(unfreeze).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(acquired ? 1 : 0);
});
