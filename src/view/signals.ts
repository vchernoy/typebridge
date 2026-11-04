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
 * Deleted applies when still showing that document. Saved/renamed require a strictly newer revision.
 */
export function shouldApplyDocumentSignal(
  signal: DocumentSignal,
  displayedId: string,
  displayedRevision: number,
): boolean {
  if (signal.documentId !== displayedId) return false;
  if (signal.type === 'deleted') return true;
  return signal.revision > displayedRevision;
}
