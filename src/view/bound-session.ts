/**
 * Per-document session binding for #159 S4.
 * One BoundSession owns draft identity, Editor history, dirty/save counters and ownership
 * for a pane surface. Same documentId must never mint a second session in one tab.
 */

import type { Editor } from '../editor/editor';
import type { EditOwnership } from '../editor/edit-ownership';
import type { StoredDraft } from '../editor/indexeddb';
import type { EditBlock } from './ownership';
import {
  type PaneId,
  type PaneRole,
  type SessionId,
  isPaneId,
  isSessionId,
} from './session';

export type BoundSession = {
  sessionId: SessionId;
  /** Pane that currently owns the editable role for this session (S5 may move it). */
  editablePaneId: PaneId;
  draft: StoredDraft;
  editor: Editor;
  field: HTMLTextAreaElement;
  title: HTMLInputElement;
  ownership: EditOwnership | undefined;
  editBlock: EditBlock;
  dirty: boolean;
  saveFailed: boolean;
  contentRevision: number;
  sessionGeneration: number;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  saving: Promise<{ saved: boolean; conflict: boolean }> | undefined;
  role: PaneRole;
};

export function createBoundSession(input: {
  sessionId: SessionId;
  editablePaneId: PaneId;
  draft: StoredDraft;
  editor: Editor;
  field: HTMLTextAreaElement;
  title: HTMLInputElement;
}): BoundSession {
  if (!isSessionId(input.sessionId)) throw new Error('Invalid session id');
  if (!isPaneId(input.editablePaneId)) throw new Error('Invalid pane id');
  return {
    sessionId: input.sessionId,
    editablePaneId: input.editablePaneId,
    draft: input.draft,
    editor: input.editor,
    field: input.field,
    title: input.title,
    ownership: undefined,
    editBlock: '',
    dirty: false,
    saveFailed: false,
    contentRevision: 0,
    sessionGeneration: 0,
    saveTimer: undefined,
    saving: undefined,
    role: 'editable',
  };
}

/** Snapshot canonical draft fields from the bound surfaces. */
export function snapshotBoundSession(session: BoundSession, untitledTitle: string): StoredDraft {
  return {
    ...session.draft,
    text: session.field.value,
    title: session.title.value.trim() || untitledTitle,
    history: session.editor.exportHistory(),
    updatedAt: Date.now(),
  };
}

export function bumpSessionIdentity(session: BoundSession): number {
  session.sessionGeneration += 1;
  return session.sessionGeneration;
}

export function bumpSessionContent(session: BoundSession): number {
  session.contentRevision += 1;
  return session.contentRevision;
}

export function setSessionRole(session: BoundSession, role: PaneRole): void {
  if (session.role === role) return;
  session.role = role;
}

/**
 * Registry of in-tab sessions. Choosing a document already represented reuses
 * that entry (never a second lock/history for the same id).
 */
export type SessionRegistry = {
  primary: BoundSession;
  secondary: BoundSession | undefined;
  all(): BoundSession[];
  byDocumentId(documentId: string): BoundSession | undefined;
  bySessionId(sessionId: SessionId): BoundSession | undefined;
  setSecondary(session: BoundSession | undefined): void;
};

export function createSessionRegistry(primary: BoundSession): SessionRegistry {
  let secondary: BoundSession | undefined;
  return {
    primary,
    get secondary() { return secondary; },
    all: () => secondary ? [primary, secondary] : [primary],
    byDocumentId: documentId => {
      if (primary.draft.id === documentId) return primary;
      if (secondary?.draft.id === documentId) return secondary;
      return undefined;
    },
    bySessionId: sessionId => {
      if (primary.sessionId === sessionId) return primary;
      if (secondary?.sessionId === sessionId) return secondary;
      return undefined;
    },
    setSecondary: next => { secondary = next; },
  };
}
