/**
 * In-tab split-workspace contracts for #159 (S1).
 * Document sessions are distinct from pane views. Pure helpers only — no DOM.
 */

import { isDocumentId } from './route';

/** Stable id for a pane surface inside one browser tab (not a document id). */
export type PaneId = string;

/** Stable id for an in-memory document session attached to zero or more panes. */
export type SessionId = string;

export type PaneRole = 'editable' | 'readonly';

export type CommandTarget =
  | { kind: 'session'; sessionId: SessionId; paneId: PaneId }
  | { kind: 'pane-only'; paneId: PaneId };

/**
 * Captured when a shared toolbar/shortcut **UI command** starts (Replace, Convert,
 * Go to line, confirm dialogs, …). Async completion must revalidate before mutating.
 *
 * This is **not** the session persistence token. An in-flight autosave / explicit save
 * belongs to the session: changing the active pane must not cancel or drop it.
 */
export type CommandGeneration = {
  sessionId: SessionId;
  paneId: PaneId;
  /** Bumped whenever the pane's bound session or role changes. */
  paneGeneration: number;
  /**
   * Bumped when the session's document identity or editable-role owner changes
   * (switch document, attach/detach, local Edit in this pane). Not bumped on every keystroke.
   */
  sessionGeneration: number;
  /**
   * Monotonic content counter for commands that capture offsets or text snapshots
   * (Replace, Convert selection, Clear confirm, …). Bump on each committed edit to
   * the session's canonical text/title so a delayed apply cannot use stale ranges.
   * Omit / leave undefined for routing-only checks that do not touch offsets.
   */
  contentRevision?: number;
};

/**
 * Identity token for a session persist loop. Pane focus/activation is irrelevant:
 * dirty/save/conflict lifecycle stays on the session until it completes or fails.
 */
export type SessionPersistGeneration = {
  sessionId: SessionId;
  /** Same bump rule as CommandGeneration.sessionGeneration (identity / role owner). */
  sessionGeneration: number;
};

export type DocumentSessionSnapshot = {
  sessionId: SessionId;
  documentId: string;
  roleEditablePaneId: PaneId | undefined;
  paneIds: readonly PaneId[];
  dirty: boolean;
  autosaveOn: boolean;
  composing: boolean;
  saving: boolean;
  saveFailed: boolean;
  conflict: boolean;
  editBlock: string;
  sessionGeneration: number;
  /** Bumped on each committed canonical text/title edit (for content-scoped UI commands). */
  contentRevision: number;
};

export type PaneViewSnapshot = {
  paneId: PaneId;
  sessionId: SessionId | undefined;
  role: PaneRole;
  paneGeneration: number;
  /** True when this pane is the shared toolbar / shortcut target. */
  active: boolean;
};

/** True for opaque pane ids used in the DOM (`pane-a`, `pane-b`, …). */
export function isPaneId(value: string): boolean {
  return /^pane-[a-z0-9-]+$/i.test(value) && value.length <= 64;
}

export function isSessionId(value: string): boolean {
  return /^session-[a-z0-9-]+$/i.test(value) && value.length <= 64;
}

/**
 * Routing revalidation for async UI commands: same session, pane, and role-binding
 * generations. Does **not** look at contentRevision (use `contentCommandStillCurrent`
 * when the command captured offsets or text). Does **not** apply to session persists —
 * use `sessionPersistStillCurrent` so an active-pane change cannot drop a required save.
 */
export function commandStillCurrent(
  started: CommandGeneration,
  live: { sessionId: SessionId; paneId: PaneId; paneGeneration: number; sessionGeneration: number },
): boolean {
  return (
    started.sessionId === live.sessionId
    && started.paneId === live.paneId
    && started.paneGeneration === live.paneGeneration
    && started.sessionGeneration === live.sessionGeneration
  );
}

/**
 * For Replace/Convert/other commands that captured offsets or a text snapshot.
 * Requires routing currency plus an unchanged contentRevision.
 */
export function contentCommandStillCurrent(
  started: CommandGeneration & { contentRevision: number },
  live: {
    sessionId: SessionId;
    paneId: PaneId;
    paneGeneration: number;
    sessionGeneration: number;
    contentRevision: number;
  },
): boolean {
  return commandStillCurrent(started, live) && started.contentRevision === live.contentRevision;
}

/**
 * Whether an in-flight session save may still commit. Active-pane changes are ignored.
 * Invalidate only when the session identity/role owner changed (document switch, release).
 */
export function sessionPersistStillCurrent(
  started: SessionPersistGeneration,
  live: { sessionId: SessionId; sessionGeneration: number },
): boolean {
  return started.sessionId === live.sessionId && started.sessionGeneration === live.sessionGeneration;
}

/**
 * Same-document local Edit in this pane (S5). Never a cross-window handoff (#164 deferred).
 * Returns '' when the transfer may proceed; otherwise a short refuse token.
 * Callers must invoke this (or equivalent) before applying `paneCloseDisposition` transfer.
 */
export function localPaneTransferBlock(input: {
  sameSession: boolean;
  targetAlreadyEditable: boolean;
  composing: boolean;
  transitioning: boolean;
  /** External tab holds the document lock — neither local pane may edit. */
  externallyBlocked: boolean;
}): '' | 'different-session' | 'already-editable' | 'composing' | 'busy' | 'external' {
  if (!input.sameSession) return 'different-session';
  if (input.targetAlreadyEditable) return 'already-editable';
  if (input.externallyBlocked) return 'external';
  if (input.transitioning) return 'busy';
  if (input.composing) return 'composing';
  return '';
}

/**
 * Guards that must pass before closing a pane or transferring its editable role.
 * `paneCloseDisposition` alone does not enforce these — check here first (S5).
 */
export function paneCloseBlock(input: {
  composing: boolean;
  transitioning: boolean;
}): '' | 'composing' | 'busy' {
  if (input.transitioning) return 'busy';
  if (input.composing) return 'composing';
  return '';
}

/**
 * Closing a pane: whether the session must still be retained in memory.
 * Last view of a dirty/private/failed session needs existing discard protection.
 * Does not encode IME/transition guards — call `paneCloseBlock` first.
 */
export function paneCloseDisposition(input: {
  remainingPanesForSession: number;
  dirty: boolean;
  autosaveOn: boolean;
  saveFailed: boolean;
  wasEditable: boolean;
}): 'detach-only' | 'transfer-editable' | 'ask-discard' | 'release-clean' {
  if (input.remainingPanesForSession > 0) {
    return input.wasEditable ? 'transfer-editable' : 'detach-only';
  }
  if (input.dirty && (!input.autosaveOn || input.saveFailed)) return 'ask-discard';
  if (input.dirty) return 'ask-discard';
  return 'release-clean';
}

/**
 * Choosing a document already open in another pane must reuse that session
 * (never invent a second session for the same documentId in one tab).
 */
export function resolveSessionForDocument(
  documentId: string,
  sessions: readonly { sessionId: SessionId; documentId: string }[],
): SessionId | undefined {
  if (!isDocumentId(documentId)) return undefined;
  return sessions.find(entry => entry.documentId === documentId)?.sessionId;
}

/**
 * Active-pane routing for shared chrome: editable panes become active on focus;
 * a same-document read-only pane may be active for Find/Copy but not for mutations.
 */
export function commandAllowedOnPane(input: {
  activePaneId: PaneId;
  targetPaneId: PaneId;
  role: PaneRole;
  mutatesDocument: boolean;
}): boolean {
  if (input.activePaneId !== input.targetPaneId) return false;
  if (input.mutatesDocument && input.role !== 'editable') return false;
  return true;
}
