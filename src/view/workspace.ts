/**
 * Workspace shell for #159 S2/S3.
 * One document session with an optional same-document live companion pane.
 * Persist/ownership stay in main.ts — never duplicated per pane.
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
  let role: PaneRole = 'editable';
  let active = true;
  let splitOpen = false;

  function syncDom(): void {
    options.root.dataset.sessionId = sessionId;
    options.root.dataset.activePane = active ? paneId : '';
    options.root.dataset.split = splitOpen ? 'on' : 'off';
    if (documentId) options.root.dataset.documentId = documentId;
    else delete options.root.dataset.documentId;
    options.paneSurface.dataset.paneId = paneId;
    options.paneSurface.dataset.paneRole = role;
    if (options.companionSurface && companionPaneId) {
      options.companionSurface.dataset.paneId = companionPaneId;
      options.companionSurface.dataset.paneRole = 'readonly';
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
      paneGeneration += 1;
      syncDom();
    },
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
          role: 'readonly',
          paneGeneration,
          active: false,
        };
      }
      return {
        paneId,
        sessionId,
        role,
        paneGeneration,
        active,
      };
    },
    syncDom,
  };

  syncDom();
  return workspace;
}
