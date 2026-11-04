/**
 * Explicit Edit here / handoff contracts for #159 (W5).
 * Metadata only — never text, title or history.
 */

import { isDocumentId } from './route';

export const EDIT_HANDOFF_CHANNEL = 'typebridge.edit-handoff.v1';

/**
 * Why a live owner cannot transfer editing yet (or declined).
 * - declined: owner chose Keep editing
 * - private: Autosave off with unsaved text (must not auto-enable Autosave or discard)
 * - ime: composition in progress
 * - saving: a persist is in flight
 * - save-failed: last save failed
 * - conflict: a conflict copy was just created / conflict notice is active
 * - busy: owner is mid document switch/delete/transfer freeze
 */
export type HandoffRefuseReason =
  | 'declined'
  | 'private'
  | 'ime'
  | 'saving'
  | 'save-failed'
  | 'conflict'
  | 'busy';

export type HandoffSignal =
  | { v: 1; type: 'request'; documentId: string; requesterId: string; requestId: string; at: number }
  | { v: 1; type: 'released'; documentId: string; requesterId: string; requestId: string; at: number }
  | { v: 1; type: 'refused'; documentId: string; requesterId: string; requestId: string; at: number; reason: HandoffRefuseReason };

const HANDOFF_TYPES = new Set(['request', 'released', 'refused']);
const REFUSE_REASONS = new Set<HandoffRefuseReason>([
  'declined', 'private', 'ime', 'saving', 'save-failed', 'conflict', 'busy',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an unknown handoff payload; returns undefined when it must be ignored. */
export function parseHandoffSignal(value: unknown): HandoffSignal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.type !== 'string' || !HANDOFF_TYPES.has(record.type)) return undefined;
  if (typeof record.documentId !== 'string' || !isDocumentId(record.documentId)) return undefined;
  if (typeof record.requesterId !== 'string' || !record.requesterId) return undefined;
  if (typeof record.requestId !== 'string' || !record.requestId) return undefined;
  if (!isFiniteNumber(record.at)) return undefined;
  if (record.type === 'refused') {
    if (typeof record.reason !== 'string' || !REFUSE_REASONS.has(record.reason as HandoffRefuseReason)) {
      return undefined;
    }
    return {
      v: 1,
      type: 'refused',
      documentId: record.documentId,
      requesterId: record.requesterId,
      requestId: record.requestId,
      at: record.at,
      reason: record.reason as HandoffRefuseReason,
    };
  }
  return {
    v: 1,
    type: record.type as 'request' | 'released',
    documentId: record.documentId,
    requesterId: record.requesterId,
    requestId: record.requestId,
    at: record.at,
  };
}

export function createHandoffRequest(
  documentId: string, requesterId: string, requestId: string, at: number,
): HandoffSignal {
  return { v: 1, type: 'request', documentId, requesterId, requestId, at };
}

export function createHandoffReleased(
  documentId: string, requesterId: string, requestId: string, at: number,
): HandoffSignal {
  return { v: 1, type: 'released', documentId, requesterId, requestId, at };
}

export function createHandoffRefused(
  documentId: string,
  requesterId: string,
  requestId: string,
  at: number,
  reason: HandoffRefuseReason,
): HandoffSignal {
  return { v: 1, type: 'refused', documentId, requesterId, requestId, at, reason };
}

/** Owner-side gate: which refusal applies, or '' when a transfer prompt may be shown. */
export function ownerHandoffBlock(input: {
  isOwner: boolean;
  composing: boolean;
  dirty: boolean;
  autosaveOn: boolean;
  saving: boolean;
  saveFailed: boolean;
  conflictNotice: boolean;
  transitioning: boolean;
  transferFrozen: boolean;
}): HandoffRefuseReason | '' {
  if (!input.isOwner) return 'busy';
  if (input.transitioning || input.transferFrozen) return 'busy';
  if (input.composing) return 'ime';
  if (input.saving) return 'saving';
  if (input.saveFailed) return 'save-failed';
  if (input.conflictNotice) return 'conflict';
  if (input.dirty && !input.autosaveOn) return 'private';
  return '';
}

/** Whether this window should show Edit here for the displayed document. */
export function mayShowEditHere(input: {
  viewMode: boolean;
  viewMissing: boolean;
  editBlock: string;
  webLocksAvailable: boolean;
  fieldDisabled: boolean;
}): boolean {
  if (input.fieldDisabled || input.viewMissing) return false;
  if (!input.webLocksAvailable) return false;
  if (input.viewMode) return true;
  return input.editBlock === 'busy' || input.editBlock === 'lost' || input.editBlock === 'error';
}

/** User-facing copy when a transfer is refused. */
export function handoffRefuseGuidance(reason: HandoffRefuseReason): string {
  switch (reason) {
    case 'declined':
      return 'The other window is still editing this document. Try Edit here again after they finish or close it.';
    case 'private':
      return 'The editing window still has unsaved or private changes. Finish or export there, then try Edit here again.';
    case 'ime':
      return 'The editing window is mid-composition. Finish the composition there, then try Edit here again.';
    case 'saving':
      return 'The editing window is still saving. Wait a moment, then try Edit here again.';
    case 'save-failed':
      return 'The editing window could not save. Fix or export there, then try Edit here again.';
    case 'conflict':
      return 'The editing window just created a conflict copy. Resolve that there, then try Edit here again.';
    case 'busy':
      return 'The editing window is busy with another document action. Try Edit here again in a moment.';
  }
}
