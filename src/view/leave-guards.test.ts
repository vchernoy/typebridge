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
      saver: { cancel: () => undefined },
      persist: async () => ({ saved: false, conflict: false }),
      snapshot: () => ({ ...state.active, text: field.value, title: 'T', updatedAt: 1 }),
      reloadBackup: {
        save: () => undefined,
        read: () => undefined,
        remove: () => undefined,
        suppressed: () => false,
        setSuppressed: () => undefined,
      },
      recovery: { takeCurrentJournal: () => undefined },
      discardUnsavedRecovery,
      freezeForDiscard,
      unfreezeAfterDiscard,
    };
    const guards = createLeaveGuards(state, deps);
    return {
      guards, workspace, field, discardUnsavedRecovery,
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

  it('update-reload consent does not clear recovery (deferred to #255)', async () => {
    // Maintainer split: Discard changes and reload matches main — no change-log clear yet.
    const { guards, discardUnsavedRecovery, freezeForDiscard } = harness({ autosaveOn: false });
    await expect(guards.prepareUpdateReload()).resolves.toBe(true);
    expect(freezeForDiscard).not.toHaveBeenCalled();
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
    guards.cancelUpdateReload();
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
  });
});
