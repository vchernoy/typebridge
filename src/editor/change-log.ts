/**
 * Change log for crash recovery (#37 R2c). Each change that reaches a document's text or title is a
 * small record with an increasing change-id (`seq`); the full save (snapshot) records `upTo`, the
 * last change-id it already contains. After a crash, the text (and title, when a record set one) is
 * the snapshot plus a gap-free run of the later changes. See the design in #37 and
 * docs/evidence/37/README.md.
 *
 * This module is pure: it never touches storage or the DOM. Replay trusts nothing it reads: it
 * stops at the first record that does not continue the chain, so the result is always the snapshot
 * plus a consistent prefix of the changes, never a guess.
 */

/** One text change: at `position`, `deleted` was replaced by `inserted` (UTF-16 offsets). */
export type TextChange = [position: number, deleted: string, inserted: string];

/** Title-only records use a no-op text change so length and fit checks still apply. */
export const TITLE_ONLY_CHANGE: TextChange = [0, '', ''];

export type ChangeRecord = {
  documentId: string;
  /** Change-id: increases by exactly one per change of this document. */
  seq: number;
  /**
   * The editing run (one window's editing session) that wrote this change. A run continues only
   * its own changes: a later window that started from the same snapshot never extends the changes
   * a crashed window left behind.
   */
  run: string;
  change: TextChange;
  /** Text length after the change: a cheap check that replay is on the right text. */
  length: number;
  /**
   * The document title after this record, when the title changed. Absent on older records and when
   * only the text changed. Title-only records use `TITLE_ONLY_CHANGE` and keep `length` unchanged.
   */
  title?: string;
};

/** Why replay stopped before the end of the records, if it did. */
export type ReplayStop =
  | 'gap'          // the next change-id is missing
  | 'other-run'    // the next change belongs to a different editing run
  | 'mismatch';    // the change does not fit the text (deleted text or length differ)

export type ReplayResult = {
  text: string;
  /** Change-id of the last applied change (`upTo` when none applied). */
  lastSeq: number;
  applied: number;
  /** Last title set by an applied record; undefined when none of them set a title. */
  title?: string;
  /** Set when replay stopped before the last record after `upTo`. */
  stopped?: ReplayStop;
};

/** The single change that turns `before` into `after` (common prefix and suffix removed). */
export function changeBetween(before: string, after: string): TextChange | undefined {
  if (before === after) return undefined;
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < shorter - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return [start, before.slice(start, before.length - end), after.slice(start, after.length - end)];
}

/** Apply `change` to `text`, or undefined when the text at `position` is not `deleted`. */
export function applyChange(text: string, change: TextChange): string | undefined {
  const [position, deleted, inserted] = change;
  if (position > text.length || text.slice(position, position + deleted.length) !== deleted) return undefined;
  return text.slice(0, position) + inserted + text.slice(position + deleted.length);
}

function validRecord(value: unknown, documentId: string): value is ChangeRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ChangeRecord>;
  if (!(r.documentId === documentId && Number.isSafeInteger(r.seq) && (r.seq ?? 0) > 0 &&
    typeof r.run === 'string' && r.run.length > 0 && Number.isSafeInteger(r.length) && (r.length ?? -1) >= 0 &&
    Array.isArray(r.change) && r.change.length === 3 && Number.isSafeInteger(r.change[0]) && r.change[0] >= 0 &&
    typeof r.change[1] === 'string' && typeof r.change[2] === 'string')) return false;
  // Older records have no title; a present title must be a string.
  if (r.title !== undefined && typeof r.title !== 'string') return false;
  return true;
}

/**
 * Snapshot `text` (which contains changes up to `upTo`) plus the records of `documentId` after it,
 * in change-id order. Applies records only while they continue the chain from `upTo + 1` with no
 * gap, all from the run of the first one, and each fits the text. Records at or below `upTo` are
 * already in the snapshot and are ignored. An invalid record is skipped, so its change-id becomes
 * a gap and replay stops just before it. `title` is the last title set by an applied record.
 */
export function replayText(documentId: string, text: string, upTo: number, records: readonly unknown[]): ReplayResult {
  const later = records
    .filter((r): r is ChangeRecord => validRecord(r, documentId) && r.seq > upTo)
    .sort((a, b) => a.seq - b.seq);
  let current = text;
  let lastSeq = upTo;
  let applied = 0;
  let title: string | undefined;
  const run = later[0]?.run;
  for (const record of later) {
    if (record.seq !== lastSeq + 1) return stop({ text: current, lastSeq, applied, title }, 'gap');
    if (record.run !== run) return stop({ text: current, lastSeq, applied, title }, 'other-run');
    const next = applyChange(current, record.change);
    if (next === undefined || next.length !== record.length) return stop({ text: current, lastSeq, applied, title }, 'mismatch');
    current = next;
    if (record.title !== undefined) title = record.title;
    lastSeq = record.seq;
    applied++;
  }
  return title === undefined ? { text: current, lastSeq, applied } : { text: current, lastSeq, applied, title };
}

function stop(result: ReplayResult, stopped: ReplayStop): ReplayResult {
  return { ...result, stopped };
}
