import { describe, expect, it } from 'vitest';
import { commandStillCurrent, contentCommandStillCurrent, sessionPersistStillCurrent } from './session';
import { PRIMARY_PANE_ID, PRIMARY_SESSION_ID, createSinglePaneWorkspace } from './workspace';

function fakeElement(): HTMLElement {
  return { dataset: {} } as unknown as HTMLElement;
}

describe('createSinglePaneWorkspace', () => {
  it('mints one session and one pane with DOM attributes', () => {
    const root = fakeElement();
    const pane = fakeElement();
    const workspace = createSinglePaneWorkspace({ root, paneSurface: pane });
    expect(workspace.sessionId).toBe(PRIMARY_SESSION_ID);
    expect(workspace.paneId).toBe(PRIMARY_PANE_ID);
    expect(root.dataset.sessionId).toBe(PRIMARY_SESSION_ID);
    expect(root.dataset.activePane).toBe(PRIMARY_PANE_ID);
    expect(root.dataset.split).toBeUndefined();
    expect(pane.dataset.paneId).toBe(PRIMARY_PANE_ID);
    expect(pane.dataset.paneRole).toBe('editable');
    expect(workspace.snapshotSession({
      autosaveOn: true, composing: false, saving: false, saveFailed: false, conflict: false, editBlock: '',
    }).roleEditablePaneId).toBe(PRIMARY_PANE_ID);
    expect(workspace.snapshotSession({
      autosaveOn: true, composing: false, saving: false, saveFailed: false, conflict: false, editBlock: '',
    }).paneIds).toEqual([PRIMARY_PANE_ID]);
  });

  it('keeps session and content counters independent', () => {
    const workspace = createSinglePaneWorkspace({ root: fakeElement(), paneSurface: fakeElement() });
    expect(workspace.bumpSessionGeneration()).toBe(1);
    expect(workspace.contentRevision()).toBe(0);
    expect(workspace.bumpContentRevision()).toBe(1);
    expect(workspace.sessionGeneration()).toBe(1);
  });

  it('bumps paneGeneration on role change without advancing sessionGeneration', () => {
    const pane = fakeElement();
    const workspace = createSinglePaneWorkspace({ root: fakeElement(), paneSurface: pane });
    const persist = workspace.capturePersistGeneration();
    workspace.setPaneRole('readonly');
    expect(pane.dataset.paneRole).toBe('readonly');
    expect(workspace.paneGeneration()).toBe(1);
    expect(workspace.sessionGeneration()).toBe(0);
    expect(sessionPersistStillCurrent(persist, {
      sessionId: workspace.sessionId,
      sessionGeneration: workspace.sessionGeneration(),
    })).toBe(true);
  });

  it('captures command tokens that track routing and content revisions', () => {
    const workspace = createSinglePaneWorkspace({ root: fakeElement(), paneSurface: fakeElement() });
    workspace.bumpContentRevision();
    const cmd = workspace.captureCommandGeneration({ contentRevision: workspace.contentRevision() });
    expect(commandStillCurrent(cmd, {
      sessionId: workspace.sessionId,
      paneId: workspace.paneId,
      paneGeneration: workspace.paneGeneration(),
      sessionGeneration: workspace.sessionGeneration(),
    })).toBe(true);
    workspace.bumpContentRevision();
    expect(contentCommandStillCurrent(cmd as typeof cmd & { contentRevision: number }, {
      sessionId: workspace.sessionId,
      paneId: workspace.paneId,
      paneGeneration: workspace.paneGeneration(),
      sessionGeneration: workspace.sessionGeneration(),
      contentRevision: workspace.contentRevision(),
    })).toBe(false);
  });

  it('keeps activePane on the primary surface', () => {
    const root = fakeElement();
    const workspace = createSinglePaneWorkspace({
      root,
      paneSurface: fakeElement(),
    });
    expect(workspace.activePaneId()).toBe(PRIMARY_PANE_ID);
    expect(root.dataset.activePane).toBe(PRIMARY_PANE_ID);
    workspace.setActivePane('pane-b');
    expect(workspace.activePaneId()).toBe(PRIMARY_PANE_ID);
    workspace.setActivePane(PRIMARY_PANE_ID);
    expect(workspace.snapshotPane(PRIMARY_PANE_ID).active).toBe(true);
    expect(workspace.sessionGeneration()).toBe(0);
  });

  it('syncs documentId into the root dataset without bumping sessionGeneration', () => {
    const root = fakeElement();
    const workspace = createSinglePaneWorkspace({ root, paneSurface: fakeElement() });
    workspace.setDocumentId('aaa');
    expect(root.dataset.documentId).toBe('aaa');
    expect(workspace.sessionGeneration()).toBe(0);
    workspace.setDocumentId('bbb');
    expect(root.dataset.documentId).toBe('bbb');
    expect(workspace.sessionGeneration()).toBe(0);
  });
});
