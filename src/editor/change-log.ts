/**
 * Change log for crash recovery (#37 R2c). Each change that reaches a document's text is a small
 * record with an increasing change-id (`seq`); the full save (snapshot) records `upTo`, the last
 * change-id it already contains. After a crash, the text is the snapshot plus a gap-free run of the
 * later changes. See the design in #37 and docs/evidence/37/README.md.
 *
 * This module is pure: it never touches storage or the DOM. Replay trusts nothing it reads: it
 * stops at the first record that does not continue the chain, so the result is always the snapshot
 * plus a consistent prefix of the changes, never a guess.
 */

/** One text change: at `position`, `deleted` was replaced by `inserted` (UTF-16 offsets). */
export type TextChange = [position: number, deleted: string, inserted: string];

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
  return r.documentId === documentId && Number.isSafeInteger(r.seq) && (r.seq ?? 0) > 0 &&
    typeof r.run === 'string' && r.run.length > 0 && Number.isSafeInteger(r.length) && (r.length ?? -1) >= 0 &&
    Array.isArray(r.change) && r.change.length === 3 && Number.isSafeInteger(r.change[0]) && r.change[0] >= 0 &&
    typeof r.change[1] === 'string' && typeof r.change[2] === 'string';
}

/**
 * Text-only replay: the snapshot `text` (which contains changes up to `upTo`) plus the records of
 * `documentId` after it, in change-id order. Applies records only while they continue the chain
 * from `upTo + 1` with no gap, all from the run of the first one, and each fits the text.
 * Records at or below `upTo` are already in the snapshot and are ignored. An invalid record is
 * skipped, so its change-id becomes a gap and replay stops just before it.
 */
export function replayText(documentId: string, text: string, upTo: number, records: readonly unknown[]): ReplayResult {
  const later = records
    .filter((r): r is ChangeRecord => validRecord(r, documentId) && r.seq > upTo)
    .sort((a, b) => a.seq - b.seq);
  let current = text;
  let lastSeq = upTo;
  let applied = 0;
  const run = later[0]?.run;
  for (const record of later) {
    if (record.seq !== lastSeq + 1) return { text: current, lastSeq, applied, stopped: 'gap' };
    if (record.run !== run) return { text: current, lastSeq, applied, stopped: 'other-run' };
    const next = applyChange(current, record.change);
    if (next === undefined || next.length !== record.length) return { text: current, lastSeq, applied, stopped: 'mismatch' };
    current = next;
    lastSeq = record.seq;
    applied++;
  }
  return { text: current, lastSeq, applied };
}
