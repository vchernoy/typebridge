/**
 * Cross-window document notification contracts for #159 / #48 (W3).
 * Metadata only — never text, title or history.
 */

import { isDocumentId } from './route';

export const DOCUMENT_SIGNAL_CHANNEL = 'typebridge.documents.v1';

export type DocumentSignal =
  | { v: 1; type: 'saved'; documentId: string; revision: number; at: number }
  | { v: 1; type: 'renamed'; documentId: string; revision: number; at: number }
  | { v: 1; type: 'deleted'; documentId: string; revision: number; at: number };

const SIGNAL_TYPES = new Set(['saved', 'renamed', 'deleted']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an unknown channel payload; returns undefined when it must be ignored. */
export function parseDocumentSignal(value: unknown): DocumentSignal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.type !== 'string' || !SIGNAL_TYPES.has(record.type)) return undefined;
  if (typeof record.documentId !== 'string' || !isDocumentId(record.documentId)) return undefined;
  if (!isFiniteNumber(record.revision) || record.revision < 0) return undefined;
  if (!isFiniteNumber(record.at)) return undefined;
  return {
    v: 1,
    type: record.type as DocumentSignal['type'],
    documentId: record.documentId,
    revision: record.revision,
    at: record.at,
  };
}

/**
 * Whether a validated signal should update a viewer showing `displayedId` at `displayedRevision`.
 * Deleted applies when still showing that document. Saved/renamed require a strictly newer revision,
 * except a missing viewer must reread a same-ID recreation even when its revision restarted.
 */
export function shouldApplyDocumentSignal(
  signal: DocumentSignal,
  displayedId: string,
  displayedRevision: number,
  missing = false,
): boolean {
  if (signal.documentId !== displayedId) return false;
  if (signal.type === 'deleted') return true;
  return missing || signal.revision > displayedRevision;
}

/** Build a metadata-only signal; never accepts text, title or history. */
export function createDocumentSignal(
  type: DocumentSignal['type'],
  documentId: string,
  revision: number,
  at: number,
): DocumentSignal {
  return { v: 1, type, documentId, revision, at };
}

/** Slowest allowed fallback reread interval (ms) while a viewer is visible and no channel exists. */
export const SIGNAL_POLL_INTERVAL_MS = 15_000;

export type RereadAction =
  /** Nothing newer than what is displayed. */
  | 'none'
  /** Viewer: replace content/title with the committed snapshot. */
  | 'refresh'
  /** Viewer: the saved document is gone. */
  | 'missing'
  /** Editor: show a non-destructive notice that a newer saved version exists. */
  | 'notice-newer'
  /** Editor: show a non-destructive notice that the saved document was deleted elsewhere. */
  | 'notice-deleted';

/**
 * Decide what an authoritative reread means for the displayed document.
 * `stored` is the IndexedDB row (or undefined when absent). Revisions below 1 are not committed.
 * Editors never replace content: they only get notices, and only for a document that has
 * a committed revision of its own (a never-saved or privately kept document has nothing to compare).
 */
export function decideReread(input: {
  role: 'viewer' | 'editor';
  displayedRevision: number;
  displayedUpdatedAt?: number;
  stored: { revision: number; updatedAt?: number } | undefined;
}): RereadAction {
  const { role, displayedRevision, displayedUpdatedAt, stored } = input;
  const committed = stored !== undefined && stored.revision >= 1;
  if (role === 'viewer') {
    if (!committed) return 'missing';
    // Refresh when revision or updatedAt differs (Delete saved copy can recreate the same revision).
    if (stored.revision !== displayedRevision) return 'refresh';
    if (displayedUpdatedAt !== undefined && stored.updatedAt !== undefined && stored.updatedAt !== displayedUpdatedAt) {
      return 'refresh';
    }
    return 'none';
  }
  if (displayedRevision < 1) return 'none';
  if (!committed) return 'notice-deleted';
  return stored.revision > displayedRevision ? 'notice-newer' : 'none';
}
