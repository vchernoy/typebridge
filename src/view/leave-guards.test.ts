import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { createLeaveGuards, type LeaveGuardDeps } from './leave-guards';
import type { Workspace } from './workspace';

vi.mock('../ui/confirm-dialog', () => ({
  askConfirmChoice: vi.fn(async () => true),
}));

import { askConfirmChoice } from '../ui/confirm-dialog';

/** Minimal textarea stand-in — unit tests stay node-only (no happy-dom). */
function makeField(initial = 'a'): HTMLTextAreaElement {
  return {
    value: initial,
    disabled: false,
    readOnly: false,
  } as unknown as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.stubGlobal('document', {
    querySelector: () => null,
    addEventListener: () => undefined,
  });
  const self = { addEventListener: () => undefined, parent: null as Window | null } as unknown as Window;
  Object.defineProperty(self, 'parent', { value: self, configurable: true });
  vi.stubGlobal('window', self);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeWorkspace(): Workspace {
  let revision = 1;
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
    dirty: () => true,
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

describe('leave-guards discard consent (#37 R2c 2d-2 / #254)', () => {
  beforeEach(() => {
    vi.mocked(askConfirmChoice).mockReset();
    vi.mocked(askConfirmChoice).mockResolvedValue(true);
  });

  function harness(options: { autosaveOn?: boolean } = {}) {
    const state = createEditorState();
    state.active = { id: 'doc', title: 'T', text: 'a', updatedAt: 1, revision: 1 };
    const workspace = makeWorkspace();
    const field = makeField('a');
    const autosave = { checked: options.autosaveOn !== false } as HTMLInputElement;
    const discardUnsavedRecovery = vi.fn(async () => undefined);
    let frozen = false;
    const freezeForDiscard = vi.fn(() => { frozen = true; });
    const unfreezeAfterDiscard = vi.fn(() => { frozen = false; });
    const deps: LeaveGuardDeps = {
      viewMode: true,
      field,
      autosave,
      workspace,
      saver: { cancel: vi.fn(() => undefined) },
      persist: async () => ({ saved: false, conflict: false }),
      snapshot: () => ({ ...state.active, text: field.value, title: 'T', updatedAt: 1 }),
      reloadBackup: {
        save: vi.fn(() => undefined),
        read: () => undefined,
        remove: () => undefined,
        take: vi.fn(() => undefined),
        put: vi.fn(() => undefined),
        suppressed: () => false,
        setSuppressed: vi.fn(() => undefined),
      },
      recovery: { takeCurrentJournal: () => undefined },
      discardUnsavedRecovery,
      markReloadDiscard: vi.fn(async () => undefined),
      clearReloadDiscard: vi.fn(() => undefined),
      freezeForDiscard,
      unfreezeAfterDiscard,
    };
    const guards = createLeaveGuards(state, deps);
    return {
      guards, state, workspace, field, discardUnsavedRecovery, deps,
      freezeForDiscard, unfreezeAfterDiscard, isFrozen: () => frozen,
    };
  }

  it('aborts close when content changes during the discard dialog', async () => {
    const { guards, workspace, discardUnsavedRecovery } = harness();
    vi.mocked(askConfirmChoice).mockImplementation(async () => {
      workspace.bumpContentRevision();
      return true;
    });
    await expect(guards.prepareWindowClose()).resolves.toBe(false);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
  });

  it('defers destructive clear until commit so cancel keeps recovery', async () => {
    // Fails if prepareWindowClose clears journal/change-log before host commit (#254 Codex P1).
    const { guards, discardUnsavedRecovery, freezeForDiscard, unfreezeAfterDiscard, isFrozen } = harness();
    await expect(guards.prepareWindowClose()).resolves.toBe(true);
    expect(freezeForDiscard).toHaveBeenCalledOnce();
    expect(isFrozen()).toBe(true);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
    guards.cancelWindowClose();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
    expect(isFrozen()).toBe(false);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
    guards.cancelWindowClose();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });

  it('runs discardUnsavedRecovery on commit after a deferred close prepare', async () => {
    const { guards, discardUnsavedRecovery } = harness();
    await expect(guards.prepareWindowClose()).resolves.toBe(true);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
    await guards.commitWindowClose();
    expect(discardUnsavedRecovery).toHaveBeenCalledOnce();
  });

  it('update-reload confirm writes the discard marker (#255)', async () => {
    const { guards, discardUnsavedRecovery, freezeForDiscard, deps } = harness({ autosaveOn: false });
    await expect(guards.prepareUpdateReload()).resolves.toBe(true);
    expect(deps.markReloadDiscard).toHaveBeenCalledOnce();
    expect(deps.reloadBackup.take).toHaveBeenCalledOnce();
    expect(deps.reloadBackup.setSuppressed).toHaveBeenCalledWith(true);
    expect(freezeForDiscard).toHaveBeenCalledOnce();
    // Freeze must arm before the marker await so Autosave cannot persist mid-prepare (#256 P1).
    expect(freezeForDiscard.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.markReloadDiscard).mock.invocationCallOrder[0]);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
  });

  it('update-reload cancel restores a taken pendingDraft backup (#256 Codex P0)', async () => {
    const { guards, deps, unfreezeAfterDiscard } = harness({ autosaveOn: false });
    const stashed = { id: 'doc', title: 'T', text: 'backed', updatedAt: 1, revision: 1 };
    vi.mocked(deps.reloadBackup.take).mockReturnValue(stashed);
    await expect(guards.prepareUpdateReload()).resolves.toBe(true);
    guards.cancelUpdateReload();
    expect(deps.reloadBackup.put).toHaveBeenCalledWith(stashed);
    expect(deps.reloadBackup.setSuppressed).toHaveBeenCalledWith(false);
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });

  it('update-reload cancel does not thaw a freeze this prepare did not arm (#256 Codex P1)', async () => {
    const { guards, unfreezeAfterDiscard, field } = harness({ autosaveOn: false });
    Object.defineProperty(field, 'disabled', { value: true, configurable: true });
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    guards.cancelUpdateReload();
    expect(unfreezeAfterDiscard).not.toHaveBeenCalled();
  });

  it('update-reload refuses when already transferFrozen (#256 Codex P1)', async () => {
    const { guards, state, freezeForDiscard, deps } = harness({ autosaveOn: false });
    state.transferFrozen = true;
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    expect(deps.markReloadDiscard).not.toHaveBeenCalled();
    expect(freezeForDiscard).not.toHaveBeenCalled();
  });

  it('update-reload refuses when Autosave turns on during the dialog (#256 Codex P1)', async () => {
    const { guards, deps, freezeForDiscard } = harness({ autosaveOn: false });
    vi.mocked(askConfirmChoice).mockImplementation(async () => {
      (deps.autosave as { checked: boolean }).checked = true;
      return true;
    });
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    expect(deps.saver.cancel).toHaveBeenCalled();
    expect(deps.markReloadDiscard).not.toHaveBeenCalled();
    expect(freezeForDiscard).not.toHaveBeenCalled();
  });

  it('assert after discard consent ignores Autosave-on backup recreate (#256 review P0)', async () => {
    const { guards, deps, workspace } = harness({ autosaveOn: false });
    await expect(guards.prepareUpdateReload()).resolves.toBe(true);
    // Prefs sync flipped Autosave on after consent — must stay on private-revision path.
    (deps.autosave as { checked: boolean }).checked = true;
    expect(() => guards.assertSafeToReloadAfterUpdate()).not.toThrow();
    expect(deps.reloadBackup.save).not.toHaveBeenCalled();
    workspace.bumpContentRevision();
    expect(() => guards.assertSafeToReloadAfterUpdate()).toThrow(/Private edits changed/);
  });

  it('update-reload Keep editing writes no marker (#255)', async () => {
    const { guards, deps } = harness({ autosaveOn: false });
    vi.mocked(askConfirmChoice).mockResolvedValue(false);
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    expect(deps.markReloadDiscard).not.toHaveBeenCalled();
  });

  it('update-reload aborts when content changes during the dialog (#255)', async () => {
    const { guards, workspace, deps } = harness({ autosaveOn: false });
    vi.mocked(askConfirmChoice).mockImplementation(async () => {
      workspace.bumpContentRevision();
      return true;
    });
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    expect(deps.markReloadDiscard).not.toHaveBeenCalled();
  });

  it('update-reload cancel clears the discard marker (#255)', async () => {
    const { guards, deps } = harness({ autosaveOn: false });
    await expect(guards.prepareUpdateReload()).resolves.toBe(true);
    guards.cancelUpdateReload();
    expect(deps.clearReloadDiscard).toHaveBeenCalled();
  });

  it('update-reload prepare returns false when the marker write fails (#255)', async () => {
    const { guards, deps, unfreezeAfterDiscard } = harness({ autosaveOn: false });
    vi.mocked(deps.markReloadDiscard).mockRejectedValue(new Error('quota'));
    await expect(guards.prepareUpdateReload()).resolves.toBe(false);
    expect(deps.clearReloadDiscard).toHaveBeenCalled();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });
});
