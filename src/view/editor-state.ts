/**
 * The editor window's core document state, shared by main.ts and the modules split out of it
 * (#99). Each module receives this object plus the few functions it calls, so "what does this
 * touch" is the fields it reads. Plain mutable fields: no behavior beyond holding values.
 */
import { newDraft } from '../editor/drafts';
import type { EditOwnership } from '../editor/edit-ownership';
import type { StoredDraft } from '../editor/indexeddb';
import type { EditBlock } from './ownership';

export type EditorState = {
  /** Open IndexedDB connection; undefined while unavailable or after an upgrade elsewhere. */
  db: IDBDatabase | undefined;
  /** The document this window shows. */
  active: StoredDraft;
  /** Saved documents, as last listed. */
  drafts: StoredDraft[];
  /** The last save failed; cleared only by a successful commit. */
  saveFailed: boolean;
  /**
   * Non-empty while browser storage cannot be used (failed or blocked initialization, or an
   * upgrade in another tab). Nothing in this page restores it; only a reload can.
   */
  storageProblem: string;
  /**
   * Why this window cannot edit the shown document ('' when it can). Single editing owner per
   * document (#159 W4): an ordinary window edits only while it holds the document's Web Lock
   * and IndexedDB fence. Viewers never acquire.
   */
  editBlock: EditBlock;
  /** This window's edit ownership of the shown document, when it holds it. */
  ownership: EditOwnership | undefined;
  /** A document switch, open or close is in progress. */
  transitioning: boolean;
  /** A document deletion is in progress. */
  deleting: boolean;
  /** The editor is being loaded with a document (input events are not edits). */
  loadingDraft: boolean;
  /** Comparison window shows the missing-document state (nothing to save or restore). */
  viewMissing: boolean;
  /** The shown document was deleted in another window; this window holds the last copy of its text. */
  deletedElsewhere: boolean;
};

export function createEditorState(): EditorState {
  return {
    db: undefined,
    active: { ...newDraft(), revision: 0 },
    drafts: [],
    saveFailed: false,
    storageProblem: '',
    editBlock: '',
    ownership: undefined,
    transitioning: false,
    deleting: false,
    loadingDraft: false,
    viewMissing: false,
    deletedElsewhere: false,
  };
}
