/**
 * Workspace shell for the primary editor surface (#159 S2 foundations, #175 step 10).
 * One document session and one pane. Persist/ownership stay in main.ts.
 * In-page companion/split was removed in #175 step 10.
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
  /** Overall session editability (external ownership / transfer freeze). */
  setPaneRole(role: PaneRole): void;
  activePaneId(): PaneId;
  setActivePane(id: PaneId): void;
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
  snapshotPane(paneId?: PaneId): PaneViewSnapshot;
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
  let activePane: PaneId = paneId;

  function syncDom(): void {
    options.root.dataset.sessionId = sessionId;
    options.root.dataset.activePane = activePane;
    if (documentId) options.root.dataset.documentId = documentId;
    else delete options.root.dataset.documentId;
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
    setDocumentId: id => {
      if (documentId === id) return;
      documentId = id;
      syncDom();
    },
    dirty: () => dirty,
    setDirty: value => { dirty = value; },
    setPaneRole: next => {
      if (next === role) return;
      role = next;
      paneGeneration += 1;
      syncDom();
    },
    activePaneId: () => activePane,
    setActivePane: id => {
      if (id !== paneId) return;
      if (activePane === id) return;
      activePane = id;
      syncDom();
    },
    captureCommandGeneration: extra => ({
      sessionId,
      paneId: activePane,
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
    snapshotPane: id => ({
      paneId: id ?? paneId,
      sessionId,
      role,
      paneGeneration,
      active: activePane === (id ?? paneId),
    }),
    syncDom,
  };

  syncDom();
  return workspace;
}
