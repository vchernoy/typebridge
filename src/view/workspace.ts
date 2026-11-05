/**
 * Workspace shell for #159 S2/S3/S5.
 * One document session with an optional same-document live companion pane.
 * Persist/ownership stay in main.ts — never duplicated per pane.
 * S5 may move the editable role between same-session panes without bumping sessionGeneration.
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
export const SECOND_PANE_ID: PaneId = 'pane-b';
export const PRIMARY_SESSION_ID: SessionId = 'session-1';

export type WorkspaceOptions = {
  root: HTMLElement;
  paneSurface: HTMLElement;
  /** Same-session live companion (#159 S3). Omit for single-pane only. */
  companionSurface?: HTMLElement;
  sessionId?: SessionId;
  paneId?: PaneId;
};

export type Workspace = {
  readonly sessionId: SessionId;
  readonly paneId: PaneId;
  readonly companionPaneId: PaneId | undefined;
  sessionGeneration(): number;
  contentRevision(): number;
  paneGeneration(): number;
  bumpSessionGeneration(): number;
  bumpContentRevision(): number;
  documentId(): string;
  setDocumentId(id: string): void;
  dirty(): boolean;
  setDirty(value: boolean): void;
  splitOpen(): boolean;
  setSplitOpen(open: boolean): void;
  /** Overall session editability (external ownership / transfer freeze). */
  setPaneRole(role: PaneRole): void;
  /** Which same-session pane currently holds the editable role when not blocked. */
  editablePaneId(): PaneId;
  setEditablePaneId(id: PaneId): void;
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
  const companionPaneId = options.companionSurface ? SECOND_PANE_ID : undefined;
  if (!isSessionId(sessionId)) throw new Error('Invalid session id');
  if (!isPaneId(paneId)) throw new Error('Invalid pane id');
  if (companionPaneId && !isPaneId(companionPaneId)) throw new Error('Invalid companion pane id');

  let documentId = '';
  let dirty = false;
  let sessionGeneration = 0;
  let contentRevision = 0;
  let paneGeneration = 0;
  /** External/session block — when readonly, neither pane mutates. */
  let role: PaneRole = 'editable';
  /** Local editable role among same-session panes (S5). Ignored while role is readonly. */
  let editablePane: PaneId = paneId;
  let activePane: PaneId = paneId;
  let splitOpen = false;

  function roleFor(target: PaneId): PaneRole {
    if (role === 'readonly') return 'readonly';
    return editablePane === target ? 'editable' : 'readonly';
  }

  function syncDom(): void {
    options.root.dataset.sessionId = sessionId;
    options.root.dataset.activePane = activePane;
    options.root.dataset.split = splitOpen ? 'on' : 'off';
    if (documentId) options.root.dataset.documentId = documentId;
    else delete options.root.dataset.documentId;
    options.paneSurface.dataset.paneId = paneId;
    options.paneSurface.dataset.paneRole = roleFor(paneId);
    if (options.companionSurface && companionPaneId) {
      options.companionSurface.dataset.paneId = companionPaneId;
      options.companionSurface.dataset.paneRole = roleFor(companionPaneId);
    }
  }

  const workspace: Workspace = {
    sessionId,
    paneId,
    companionPaneId,
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
    splitOpen: () => splitOpen,
    setSplitOpen: open => {
      if (!companionPaneId) return;
      if (splitOpen === open) return;
      splitOpen = open;
      if (!open) {
        activePane = paneId;
        // Closing the companion returns the editable role to the primary surface.
        editablePane = paneId;
      }
      paneGeneration += 1;
      syncDom();
    },
    setPaneRole: next => {
      if (next === role) return;
      role = next;
      paneGeneration += 1;
      syncDom();
    },
    editablePaneId: () => editablePane,
    setEditablePaneId: id => {
      if (id !== paneId && id !== companionPaneId) return;
      if (!companionPaneId && id !== paneId) return;
      if (id === companionPaneId && !splitOpen) return;
      if (editablePane === id) return;
      editablePane = id;
      paneGeneration += 1;
      syncDom();
    },
    activePaneId: () => activePane,
    setActivePane: id => {
      if (id !== paneId && id !== companionPaneId) return;
      if (id === companionPaneId && !splitOpen) return;
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
      roleEditablePaneId: role === 'editable' ? editablePane : undefined,
      paneIds: splitOpen && companionPaneId ? [paneId, companionPaneId] : [paneId],
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
    snapshotPane: id => {
      const target = id ?? paneId;
      if (target === companionPaneId) {
        return {
          paneId: companionPaneId,
          sessionId,
          role: roleFor(companionPaneId),
          paneGeneration,
          active: activePane === companionPaneId,
        };
      }
      return {
        paneId,
        sessionId,
        role: roleFor(paneId),
        paneGeneration,
        active: activePane === paneId,
      };
    },
    syncDom,
  };

  syncDom();
  return workspace;
}
