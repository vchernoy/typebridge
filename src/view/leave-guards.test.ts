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

describe('leave-guards discard consent (#37 R2c 2d-2 / #254 Codex P1)', () => {
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
    let clearStarted: (() => void) | undefined;
    const clearGate = new Promise<void>(resolve => { clearStarted = resolve; });
    let resolveClear!: () => void;
    const clearDone = new Promise<void>(resolve => { resolveClear = resolve; });
    const discardUnsavedRecovery = vi.fn(async () => {
      clearStarted?.();
      await clearDone;
    });
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
      guards, workspace, field, discardUnsavedRecovery, clearGate, resolveClear,
      freezeForDiscard, unfreezeAfterDiscard, isFrozen: () => frozen,
    };
  }

  it('aborts close when content changes during the discard dialog', async () => {
    // Fails if prepareWindowClose clears recovery after the user edited while the dialog was open.
    const { guards, workspace, discardUnsavedRecovery, resolveClear } = harness();
    vi.mocked(askConfirmChoice).mockImplementation(async () => {
      workspace.bumpContentRevision();
      return true;
    });
    await expect(guards.prepareWindowClose()).resolves.toBe(false);
    expect(discardUnsavedRecovery).not.toHaveBeenCalled();
    resolveClear();
  });

  it('aborts close when content changes during async discard cleanup', async () => {
    // Fails if prepareWindowClose returns true after edits land during discardUnsavedRecovery.
    const { guards, workspace, field, discardUnsavedRecovery, clearGate, resolveClear, unfreezeAfterDiscard } = harness();
    const closing = guards.prepareWindowClose();
    await clearGate;
    workspace.bumpContentRevision();
    field.value = 'newer';
    resolveClear();
    await expect(closing).resolves.toBe(false);
    expect(discardUnsavedRecovery).toHaveBeenCalledOnce();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });

  it('freezes editors while discard cleanup runs and keeps freeze on successful close', async () => {
    const { guards, clearGate, resolveClear, freezeForDiscard, unfreezeAfterDiscard, isFrozen } = harness();
    const closing = guards.prepareWindowClose();
    await clearGate;
    expect(freezeForDiscard).toHaveBeenCalledOnce();
    expect(isFrozen()).toBe(true);
    resolveClear();
    await expect(closing).resolves.toBe(true);
    // Successful close leaves freeze armed until the host commits removal.
    expect(unfreezeAfterDiscard).not.toHaveBeenCalled();
  });

  it('thaws after discard on update-reload so later private edits are detected', async () => {
    const { guards, clearGate, resolveClear, freezeForDiscard, unfreezeAfterDiscard } = harness({ autosaveOn: false });
    const reloading = guards.prepareUpdateReload();
    await clearGate;
    expect(freezeForDiscard).toHaveBeenCalledOnce();
    resolveClear();
    await expect(reloading).resolves.toBe(true);
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });

  it('cancelWindowClose thaws after a successful close prepare the host then aborts', async () => {
    // Fails if keepFrozenOnSuccess leaves the editor frozen with no host cancel hook (#254 Codex P1).
    const { guards, clearGate, resolveClear, unfreezeAfterDiscard, isFrozen } = harness();
    const closing = guards.prepareWindowClose();
    await clearGate;
    resolveClear();
    await expect(closing).resolves.toBe(true);
    expect(isFrozen()).toBe(true);
    guards.cancelWindowClose();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
    expect(isFrozen()).toBe(false);
    // Idempotent: a second cancel must not unfreeze again.
    guards.cancelWindowClose();
    expect(unfreezeAfterDiscard).toHaveBeenCalledOnce();
  });
});
