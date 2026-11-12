/**
 * Change-log writer for the shown document (#37 R2c). Each edit becomes one small record, written
 * in change-id order through a single queue so typing never waits for storage. A full save takes
 * `upTo` from here at the same moment it takes the text and title, so the saved row and the log agree.
 *
 * Every record continues state that is durable: the stored row, plus the records before it. A run
 * belongs to one document shown once (its id and session generation) and only ever starts at a
 * full save, never from the shown text, which can be unsaved (a reload backup, a handoff): the
 * first edits after a document is shown reach storage through that first save. When a save stores
 * state the log does not already produce (a new run, a write that failed, an edit that was not
 * recorded), the records after it continue that state, so they are held until the save commits
 * and dropped if it fails (#251 review). Title changes are recorded with an optional `title` on
 * the record (#37 R2c 2d-1). Nothing is written while Autosave is off or in a viewer, matching
 * the privacy rule for saving.
 *
 * `protects()` is true while a live run covers the latest edit (no failure, no hold). The
 * localStorage journal writes only when this is false or IndexedDB is unusable (#37 R2c 2d-2).
 */
import { changeBetween, TITLE_ONLY_CHANGE, type ChangeRecord } from '../editor/change-log';

export type ChangeWriterDeps = {
  /** False while Autosave is off, in a viewer, or while edits must not be recorded. */
  mayRecord: () => boolean;
  /** The shown document and its session generation (bumped whenever it is shown again). */
  shown: () => { id: string; generation: number };
  text: () => string;
  /** Normalized title (`trim() || UNTITLED_TITLE`), matching the saved snapshot. */
  title: () => string;
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
  /** The title the next change starts from. */
  baseTitle: string;
  /** Set when a write failed or was refused: stop until a full save covers everything queued. */
  failed: boolean;
  /** While a save of state the log does not produce is in flight: resolves with its outcome. */
  anchor?: Promise<boolean>;
};

export function createChangeWriter(deps: ChangeWriterDeps) {
  let writer: Writer | undefined;
  let queue: Promise<void> = Promise.resolve();
  /** The save whose outcome releases (or drops) the held records. */
  let pending: { run: string; writer: Writer; settle: (ok: boolean) => void } | undefined;
  const unprotectedListeners: Array<() => void> = [];

  /** The run of the shown document, if a save started one; never one started from shown text. */
  function current(): Writer | undefined {
    const shown = deps.shown();
    return writer && writer.documentId === shown.id && writer.generation === shown.generation ? writer : undefined;
  }

  function notifyUnprotected(): void {
    for (const listener of unprotectedListeners) {
      try { listener(); } catch { /* A journal listener must not break the writer. */ }
    }
  }

  function markFailed(w: Writer): void {
    if (w.failed) return;
    w.failed = true;
    notifyUnprotected();
  }

  function enqueue(w: Writer, record: ChangeRecord): void {
    const anchor = w.anchor;
    // Records queued behind a failed one are skipped, not written: the run stops at the failure
    // until a save covers everything queued. Nothing lands once Autosave is off, not even a
    // record queued before, and nothing continues a save that did not commit (#251 review).
    queue = queue.then(async () => {
      if (anchor && !await anchor) return;
      if (w.failed) return;
      if (!deps.mayRecord()) { markFailed(w); return; }
      return deps.append(record);
    }).catch(() => { markFailed(w); });
  }

  return {
    /** Record the edit that led to the current text and/or title. */
    edit(): void {
      if (!deps.mayRecord()) {
        // Stop the run: after private edits the next run starts at the next save.
        writer = undefined;
        return;
      }
      const w = current();
      if (!w || w.failed) return;
      const text = deps.text();
      const title = deps.title();
      const change = changeBetween(w.base, text);
      const titleChanged = title !== w.baseTitle;
      if (!change && !titleChanged) return;
      w.seq += 1;
      w.base = text;
      w.baseTitle = title;
      const record: ChangeRecord = {
        documentId: w.documentId,
        seq: w.seq,
        run: w.run,
        change: change ?? TITLE_ONLY_CHANGE,
        length: text.length,
        ...(titleChanged ? { title } : {}),
      };
      enqueue(w, record);
    },
    /**
     * Called as a full save takes `savedText` and `savedTitle` of `documentId` (after `idle()`):
     * `upTo` is the last change-id queued for that state, and `keepRun` the run that continues it.
     * The save deletes every other run's records (a crashed run's tail must never replay onto this
     * text) and this run's records up to `upTo`. Report the outcome with `saved(keepRun, ok)`.
     *
     * When the log already produces `savedText` and `savedTitle`, later records continue them
     * either way. Otherwise (no current run, a failed write, an unrecorded edit), later records
     * continue that saved state only: they are held until the save commits, and dropped if it
     * does not (#251 review).
     */
    upToForSave(documentId: string, savedText: string, savedTitle: string): { upTo: number; keepRun: string } {
      const shown = deps.shown();
      let w = writer;
      if (!w || w.documentId !== documentId || shown.id !== documentId || w.generation !== shown.generation) {
        w = { documentId, generation: shown.generation, run: deps.newRunId(), seq: 0, base: savedText, baseTitle: savedTitle, failed: false };
        writer = shown.id === documentId ? w : undefined;
      } else if (w.base === savedText && w.baseTitle === savedTitle && !w.failed && !w.anchor) {
        return { upTo: w.seq, keepRun: w.run };
      }
      w.base = savedText;
      w.baseTitle = savedTitle;
      w.failed = false;
      let settle: (ok: boolean) => void = () => undefined;
      w.anchor = new Promise<boolean>(resolve => { settle = resolve; });
      pending?.settle(false);
      pending = { run: w.run, writer: w, settle };
      return { upTo: w.seq, keepRun: w.run };
    },
    /**
     * The outcome of the save `upToForSave` prepared for `run`. On success the held records go
     * ahead; otherwise they are dropped and the run ends: the next save starts a new one.
     */
    saved(run: string, ok: boolean): void {
      if (!pending || pending.run !== run) return;
      const { writer: w, settle } = pending;
      pending = undefined;
      w.anchor = undefined;
      if (!ok && writer === w) writer = undefined;
      settle(ok);
      if (!ok) notifyUnprotected();
    },
    /**
     * True when the change log covers the latest edit of the shown document: a current run exists
     * for its id and session generation, recording is allowed, the run has not failed, and no
     * save is holding later records (#37 R2c 2d-2).
     */
    protects(): boolean {
      if (!deps.mayRecord()) return false;
      const w = current();
      return !!w && !w.failed && !w.anchor;
    },
    /** Called when an append fails or a held save is reported failed (protection lost asynchronously). */
    onUnprotected(listener: () => void): void {
      unprotectedListeners.push(listener);
    },
    /** The run this window has for `documentId`, if any. */
    runOf: (documentId: string): string | undefined => writer?.documentId === documentId ? writer.run : undefined,
    /** Resolves once every queued record was written, skipped or dropped. */
    idle: (): Promise<void> => queue,
  };
}
