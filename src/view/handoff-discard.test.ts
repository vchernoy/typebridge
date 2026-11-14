import { beforeEach, expect, it, vi } from 'vitest';
import { createEditorState } from './editor-state';
import { discardForHandoff } from './handoff-discard';
import { getStoredDraft } from '../editor/indexeddb';

vi.mock('../editor/indexeddb', async importOriginal => ({
  ...await importOriginal<typeof import('../editor/indexeddb')>(),
  getStoredDraft: vi.fn(),
}));
beforeEach(() => vi.mocked(getStoredDraft).mockReset());

function setup() {
  const state = createEditorState();
  state.db = {} as IDBDatabase;
  let revision = 1;
  let generation = 1;
  const workspace = {
    sessionId: 'session-1',
    capturePersistGeneration: () => ({ sessionId: 'session-1', sessionGeneration: generation }),
    sessionGeneration: () => generation,
    contentRevision: () => revision,
    dirty: () => true,
  };
  const deps = {
    confirm: vi.fn(async () => true),
    discardRecovery: vi.fn<(stillCurrent: () => boolean) => Promise<void>>(async () => undefined),
    restoreRecovery: vi.fn(),
    applyDraft: vi.fn(),
    announceCancelled: vi.fn(),
  };
  const saved = { ...state.active, text: 'committed text' };
  vi.mocked(getStoredDraft).mockResolvedValue(saved);
  return { state, workspace, deps, saved, edit: () => revision++, switchSession: () => generation++,
    run: () => discardForHandoff(state, workspace, deps) };
}

it('discards unchanged dirty text and applies the committed row', async () => {
  const f = setup();
  expect(await f.run()).toBe(true);
  expect(f.deps.applyDraft).toHaveBeenCalledWith(f.saved);
  expect(f.deps.restoreRecovery).not.toHaveBeenCalled();
});
it('keeps recovery and avoids cleanup when consent is declined', async () => {
  const f = setup(); f.deps.confirm.mockResolvedValue(false);
  expect(await f.run()).toBe(false);
  expect(f.deps.discardRecovery).not.toHaveBeenCalled();
});
it('cancels changed content before destructive cleanup starts', async () => {
  const f = setup();
  f.deps.confirm.mockImplementation(async () => { f.edit(); return true; });
  expect(await f.run()).toBe(false);
  expect(f.deps.discardRecovery).not.toHaveBeenCalled();
  expect(f.deps.applyDraft).not.toHaveBeenCalled();
  expect(f.deps.announceCancelled).toHaveBeenCalledOnce();
});
it('invalidates cleanup consent and restores recovery for edits arriving during cleanup', async () => {
  const f = setup();
  f.deps.discardRecovery.mockImplementation(async stillCurrent => {
    expect(stillCurrent()).toBe(true); f.edit(); expect(stillCurrent()).toBe(false);
  });
  expect(await f.run()).toBe(false);
  expect(getStoredDraft).not.toHaveBeenCalled();
  expect(f.deps.applyDraft).not.toHaveBeenCalled();
  expect(f.deps.restoreRecovery).toHaveBeenCalledOnce();
});
it('does not overwrite edits arriving during the durable read, and restores recovery', async () => {
  const f = setup();
  vi.mocked(getStoredDraft).mockImplementation(async () => { f.edit(); return f.saved; });
  expect(await f.run()).toBe(false);
  expect(f.deps.applyDraft).not.toHaveBeenCalled();
  expect(f.deps.restoreRecovery).toHaveBeenCalledOnce();
});
for (const phase of ['confirmation', 'cleanup', 'read'] as const) {
  it(`never applies old data or journals the replacement session after ${phase}`, async () => {
    const f = setup();
    if (phase === 'confirmation') f.deps.confirm.mockImplementation(async () => { f.switchSession(); return true; });
    if (phase === 'cleanup') f.deps.discardRecovery.mockImplementation(async () => { f.switchSession(); });
    if (phase === 'read') vi.mocked(getStoredDraft).mockImplementation(async () => { f.switchSession(); return f.saved; });
    expect(await f.run()).toBe(false);
    expect(f.deps.applyDraft).not.toHaveBeenCalled();
    expect(f.deps.restoreRecovery).not.toHaveBeenCalled();
    expect(f.deps.announceCancelled).not.toHaveBeenCalled();
  });
}
it('rejects a storage generation change during the read', async () => {
  const f = setup();
  vi.mocked(getStoredDraft).mockImplementation(async () => { f.state.storageGeneration++; return f.saved; });
  expect(await f.run()).toBe(false);
  expect(f.deps.applyDraft).not.toHaveBeenCalled();
  expect(f.deps.restoreRecovery).not.toHaveBeenCalled();
});
