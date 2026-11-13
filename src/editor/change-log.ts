/**
 * One gap-free, ordered log per document across text, title, find and replace (#257 / #37).
 * Replay returns one consistent prefix for the whole document, never independent field cuts.
 * Pure: no storage, DOM or Undo/Redo behavior.
 */
import { documentFields, DOCUMENT_FIELDS, type DocumentField, type DocumentFields, type DocumentFieldsInput } from './document-fields';

/** UTF-16 offsets; at position, deleted was replaced by inserted. */
export type TextChange = [position: number, deleted: string, inserted: string];
export const SHORT_VALUE_LIMIT = 256;
type RecordIdentity = { documentId: string; seq: number; run: string; field: DocumentField };
export type ChangeRecord = RecordIdentity & (
  | { value: string; change?: never; length?: never }
  | { change: TextChange; length: number; value?: never }
);
export type ReplayStop = 'gap' | 'other-run' | 'mismatch';
export type ReplayResult = DocumentFields & { lastSeq: number; applied: number; stopped?: ReplayStop };

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

/** Capture a value, never a reference to live document state (queued pre-private records stay safe). */
export function fieldRecord(identity: RecordIdentity, before: string, after: string): ChangeRecord {
  return after.length < SHORT_VALUE_LIMIT
    ? { ...identity, value: after }
    : { ...identity, change: changeBetween(before, after) ?? [0, '', ''], length: after.length };
}

function validRecord(value: unknown, documentId: string): value is ChangeRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r.documentId !== documentId || !Number.isSafeInteger(r.seq) || (r.seq as number) <= 0 ||
      typeof r.run !== 'string' || !r.run || !DOCUMENT_FIELDS.includes(r.field as DocumentField)) return false;
  if ('value' in r) return typeof r.value === 'string' && r.value.length < SHORT_VALUE_LIMIT && !('change' in r) && !('length' in r);
  return Number.isSafeInteger(r.length) && (r.length as number) >= SHORT_VALUE_LIMIT &&
    Array.isArray(r.change) && r.change.length === 3 && Number.isSafeInteger(r.change[0]) && r.change[0] >= 0 &&
    typeof r.change[1] === 'string' && typeof r.change[2] === 'string';
}

/**
 * Apply records after the snapshot's single upTo. An invalid record is a gap, including an
 * invalid tail (never silently discard it and continue). Other documents and covered ids are
 * ignored. All four fields stop together at the first gap, foreign run or non-fitting change.
 */
export function replayDocument(documentId: string, snapshot: DocumentFieldsInput, upTo: number, records: readonly unknown[]): ReplayResult {
  const later = records.filter((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return r.documentId === documentId && Number.isSafeInteger(r.seq) && (r.seq as number) > upTo;
  }).sort((a, b) => (a.seq as number) - (b.seq as number));
  const current = documentFields(snapshot);
  let lastSeq = upTo;
  let applied = 0;
  let run: string | undefined;
  const result = (stopped?: ReplayStop): ReplayResult => ({ ...current, lastSeq, applied, ...(stopped ? { stopped } : {}) });
  for (const raw of later) {
    if (raw.seq !== lastSeq + 1 || !validRecord(raw, documentId)) return result('gap');
    const record = raw;
    run ??= record.run;
    if (record.run !== run) return result('other-run');
    const next = record.value !== undefined ? record.value : applyChange(current[record.field], record.change);
    if (next === undefined || (record.change !== undefined && next.length !== record.length)) return result('mismatch');
    current[record.field] = next;
    lastSeq = record.seq;
    applied++;
  }
  return result();
}
