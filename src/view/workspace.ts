/**
 * Single-pane workspace shell for #159 S2.
 * One document session + one pane view; no split UI yet. Persist/ownership stay in main.ts.
 */

import {
  type CommandGeneration,
  type DocumentSessionSnapshot,
  type PaneId,
  type PaneRole,
  type PaneViewSnapshot,
  type SessionId,
  type SessionPersistGeneration,
  isPaneId,
  isSessionId,
} from './session';

export const PRIMARY_PANE_ID: PaneId = 'pane-a';
export const PRIMARY_SESSION_ID: SessionId = 'session-1';

export type WorkspaceOptions = {
  root: HTMLElement;
  paneSurface: HTMLElement;
  sessionId?: SessionId;
  paneId?: PaneId;
};

export type Workspace = {
  readonly sessionId: SessionId;
  readonly paneId: PaneId;
  sessionGeneration(): number;
  contentRevision(): number;
  paneGeneration(): number;
  bumpSessionGeneration(): number;
  bumpContentRevision(): number;
  documentId(): string;
  setDocumentId(id: string): void;
  dirty(): boolean;
  setDirty(value: boolean): void;
  setPaneRole(role: PaneRole): void;
  setActive(active: boolean): void;
  captureCommandGeneration(extra?: { contentRevision?: number }): CommandGeneration;
  capturePersistGeneration(): SessionPersistGeneration;
  snapshotSession(extra: {
    autosaveOn: boolean;
    composing: boolean;
    saving: boolean;
    saveFailed: boolean;
    conflict: boolean;
    editBlock: string;
  }): DocumentSessionSnapshot;
  snapshotPane(): PaneViewSnapshot;
  syncDom(): void;
};

export function createSinglePaneWorkspace(options: WorkspaceOptions): Workspace {
  const sessionId = options.sessionId ?? PRIMARY_SESSION_ID;
  const paneId = options.paneId ?? PRIMARY_PANE_ID;
  if (!isSessionId(sessionId)) throw new Error('Invalid session id');
  if (!isPaneId(paneId)) throw new Error('Invalid pane id');

  let documentId = '';
  let dirty = false;
  let sessionGeneration = 0;
  let contentRevision = 0;
  let paneGeneration = 0;
  let role: PaneRole = 'editable';
  let active = true;

  function syncDom(): void {
    options.root.dataset.sessionId = sessionId;
    options.root.dataset.activePane = active ? paneId : '';
    options.paneSurface.dataset.paneId = paneId;
    options.paneSurface.dataset.paneRole = role;
  }

  const workspace: Workspace = {
    sessionId,
    paneId,
    sessionGeneration: () => sessionGeneration,
    contentRevision: () => contentRevision,
    paneGeneration: () => paneGeneration,
    bumpSessionGeneration: () => { sessionGeneration += 1; return sessionGeneration; },
    bumpContentRevision: () => { contentRevision += 1; return contentRevision; },
    documentId: () => documentId,
    setDocumentId: id => { documentId = id; },
    dirty: () => dirty,
    setDirty: value => { dirty = value; },
    setPaneRole: next => {
      if (next === role) return;
      role = next;
      paneGeneration += 1;
      syncDom();
    },
    setActive: next => {
      if (next === active) return;
      active = next;
      syncDom();
    },
    captureCommandGeneration: extra => ({
      sessionId,
      paneId,
      paneGeneration,
      sessionGeneration,
      ...(extra?.contentRevision !== undefined ? { contentRevision: extra.contentRevision } : {}),
    }),
    capturePersistGeneration: () => ({ sessionId, sessionGeneration }),
    snapshotSession: extra => ({
      sessionId,
      documentId,
      roleEditablePaneId: role === 'editable' ? paneId : undefined,
      paneIds: [paneId],
      dirty,
      autosaveOn: extra.autosaveOn,
      composing: extra.composing,
      saving: extra.saving,
      saveFailed: extra.saveFailed,
      conflict: extra.conflict,
      editBlock: extra.editBlock,
      sessionGeneration,
      contentRevision,
    }),
    snapshotPane: () => ({
      paneId,
      sessionId,
      role,
      paneGeneration,
      active,
    }),
    syncDom,
  };

  syncDom();
  return workspace;
}
