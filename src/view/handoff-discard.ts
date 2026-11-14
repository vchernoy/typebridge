/** Dirty Edit-here consent belongs to one document, storage session and content revision. */
import { getStoredDraft, type StoredDraft } from '../editor/indexeddb';
import type { EditorState } from './editor-state';
import { sessionPersistStillCurrent } from './session';
import type { Workspace } from './workspace';

export async function discardForHandoff(
  state: EditorState,
  workspace: Pick<Workspace, 'capturePersistGeneration' | 'sessionId' | 'sessionGeneration' | 'contentRevision' | 'dirty'>,
  deps: {
    confirm: () => Promise<boolean>;
    discardRecovery: (stillCurrent: () => boolean) => Promise<void>;
    restoreRecovery: () => void;
    applyDraft: (draft: StoredDraft) => void;
    announceCancelled: () => void;
  },
): Promise<boolean> {
  const token = workspace.capturePersistGeneration();
  const documentId = state.active.id;
  const storageGeneration = state.storageGeneration;
  const revision = workspace.contentRevision();
  const sameSession = (): boolean => state.storageGeneration === storageGeneration && state.active.id === documentId &&
    sessionPersistStillCurrent(token, { sessionId: workspace.sessionId, sessionGeneration: workspace.sessionGeneration() });
  const stillCurrent = (): boolean => sameSession() && workspace.contentRevision() === revision;
  const cancelled = (cleanupStarted: boolean): false => {
    // Cleanup can abandon this session's log. Re-journal surviving edits, respecting privacy.
    // Never write recovery or feedback into a replacement document/storage session.
    if (sameSession()) {
      if (cleanupStarted && workspace.dirty()) deps.restoreRecovery();
      deps.announceCancelled();
    }
    return false;
  };
  if (!await deps.confirm()) return false;
  if (!stillCurrent()) return cancelled(false);
  await deps.discardRecovery(stillCurrent);
  if (!stillCurrent()) return cancelled(true);
  let fresh: StoredDraft | undefined;
  try {
    if (state.db) fresh = await getStoredDraft(state.db, documentId);
  } catch { /* Takeover rereads under its new fence if the session is still current. */ }
  if (!stillCurrent()) return cancelled(true);
  if (fresh) deps.applyDraft(fresh);
  return true;
}
