/**
 * Change-log writer for the shown document (#37 R2c). Each edit becomes one small record, written
 * in change-id order through a single queue so typing never waits for storage. A full save takes
 * `upTo` from here at the same moment it takes the text, so the saved row and the log agree.
 *
 * A writer belongs to one document shown once (its id and session generation). It starts right
 * after the stored row's `upTo`: its first change continues exactly the stored text. Nothing is
 * written while Autosave is off or in a viewer, matching the privacy rule for saving.
 */
import { changeBetween, type ChangeRecord } from '../editor/change-log';

export type ChangeWriterDeps = {
  /** False while Autosave is off, in a viewer, or while edits must not be recorded. */
  mayRecord: () => boolean;
  /** The shown document: id, the stored row's text and `upTo` (revision 0: no stored row). */
  shown: () => { id: string; generation: number; storedText: string; upTo: number; revision: number };
  text: () => string;
  /** Write one record (with the ownership fence); rejects when it cannot be written. */
  append: (record: ChangeRecord) => Promise<void>;
  newRunId: () => string;
};

type Writer = {
  documentId: string;
  generation: number;
  run: string;
  /** Change-id of the last record queued. */
  seq: number;
  /** The text the next change starts from. */
  base: string;
  /** Set when a write failed: stop until a full save covers everything queued. */
  failed: boolean;
};

export function createChangeWriter(deps: ChangeWriterDeps) {
  let writer: Writer | undefined;
  let queue: Promise<void> = Promise.resolve();

  function current(): Writer | undefined {
    const shown = deps.shown();
    if (writer && writer.documentId === shown.id && writer.generation === shown.generation) return writer;
    // A newly shown document (or a new generation of it) starts a new run after the stored row.
    writer = {
      documentId: shown.id,
      generation: shown.generation,
      run: deps.newRunId(),
      seq: shown.revision > 0 ? shown.upTo : 0,
      base: shown.revision > 0 ? shown.storedText : '',
      failed: false,
    };
    return writer;
  }

  return {
    /** Record the edit that led to the current text. */
    edit(): void {
      if (!deps.mayRecord()) {
        // Stop the run: after private edits the next run restarts from the stored row.
        writer = undefined;
        return;
      }
      const w = current();
      if (!w || w.failed) return;
      const text = deps.text();
      const change = changeBetween(w.base, text);
      if (!change) return;
      w.seq += 1;
      w.base = text;
      const record: ChangeRecord = { documentId: w.documentId, seq: w.seq, run: w.run, change, length: text.length };
      queue = queue.then(() => deps.append(record)).catch(() => { w.failed = true; });
    },
    /**
     * Called as a full save takes `savedText` of `documentId` (after `idle()`): `upTo` is the
     * last change-id queued for that text, so later changes continue from `savedText` and a
     * failed writer resumes. With no current run for the document (Autosave was off, or the
     * document was shown again), `clearAll`: records an earlier run left must never be replayed
     * onto this text, so the save removes the whole log and the next run starts after 0.
     */
    upToForSave(documentId: string, savedText: string): { upTo: number; clearAll: boolean } {
      const shown = deps.shown();
      const w = writer;
      if (!w || w.documentId !== documentId || shown.id !== documentId || w.generation !== shown.generation) {
        return { upTo: 0, clearAll: true };
      }
      w.base = savedText;
      w.failed = false;
      return { upTo: w.seq, clearAll: false };
    },
    /** Forget the run, e.g. when the document is deleted or editing moves elsewhere. */
    reset(): void { writer = undefined; },
    /** Resolves once every queued record was written or failed (tests and shutdown). */
    idle: (): Promise<void> => queue,
  };
}
