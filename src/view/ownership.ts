/**
 * Editing-ownership naming and fence helpers for #159 (W4).
 * Recovery locks stay separate: `typebridge-recovery-owner:{journalTab}`.
 */

export const EDIT_OWNER_LOCK_PREFIX = 'typebridge-edit-owner:';
export const EDIT_OWNERSHIP_STORE = 'editOwnership';

/**
 * Heartbeat staleness threshold for diagnostics only (milliseconds).
 * A stale heartbeat must never be used to take over a record that a lock-backed
 * client may still own: heartbeats can lapse while a tab is throttled or suspended
 * even though its Web Lock is still held (#159 ADR, mixed-ownership rule).
 */
export const EDIT_OWNER_HEARTBEAT_MS = 30_000;

export type EditOwnershipRecord = {
  documentId: string;
  ownerInstanceId: string;
  fence: number;
  updatedAt: number;
};

export function editOwnerLockName(documentId: string): string {
  return EDIT_OWNER_LOCK_PREFIX + documentId;
}

/**
 * Next fence value when acquiring (under the document's Web Lock).
 * Callers persist the new record in the same IndexedDB transaction as the decision.
 */
export function nextOwnershipFence(current: EditOwnershipRecord | undefined): number {
  return (current?.fence ?? 0) + 1;
}

/**
 * Whether the stored heartbeat is older than `ttlMs`. Diagnostic only — not an
 * acquisition rule. Do not call this to decide whether to claim ownership.
 */
export function ownershipHeartbeatExpired(
  record: EditOwnershipRecord,
  now: number,
  ttlMs: number = EDIT_OWNER_HEARTBEAT_MS,
): boolean {
  return now - record.updatedAt > ttlMs;
}

/**
 * Only clients with Web Locks may acquire editing ownership (W4). Clients without
 * `navigator.locks` stay viewers: they must not take over a live lock-backed owner
 * by waiting for its heartbeat to expire, and cannot prove they are the only owner.
 * Callers pass the capability, never a stored record, so a fallback client cannot
 * accidentally "win" on an expired heartbeat.
 */
export function mayAcquireEditOwnership(webLocksAvailable: boolean): boolean {
  return webLocksAvailable;
}

/**
 * Why an ordinary window cannot edit the document it shows; '' while it is the editing owner
 * (or while storage is unavailable, when nothing can be written and there is nothing to own).
 * - busy: another window held the lock when this one tried.
 * - lost: this window owned the document, then its fence or lock was taken.
 * - unsupported: no Web Locks, so this client never acquires.
 * - error: the fence could not be claimed (storage error).
 */
export type EditBlock = '' | 'busy' | 'lost' | 'unsupported' | 'error';

/** Only blocks that another attempt could resolve are retried (on focus/visibility). */
export function mayRetryEditOwnership(block: EditBlock): boolean {
  return block === 'busy' || block === 'lost' || block === 'error';
}

/**
 * Guidance for a read-only ordinary window. `dirty` means this window still holds text it could
 * not save (kept in memory for copy/export, never discarded silently).
 */
export function editBlockGuidance(block: EditBlock, dirty: boolean): string {
  if (block === '') return '';
  if (block === 'unsupported') {
    return 'Editing needs a browser with Web Locks, which is not available here, so documents are read-only in this window. You can still read, copy and export them.';
  }
  const unsaved = dirty ? ' Your unsaved changes here were not saved; copy or export them to keep them.' : '';
  if (block === 'error') {
    return 'This window could not confirm that it is the only one editing this document, so it is read-only. Reload to try again.' + unsaved;
  }
  if (block === 'lost') {
    return 'Another TypeBridge window is now editing this document, so this window is read-only.' + unsaved;
  }
  return 'This document is open for editing in another TypeBridge window, so it is read-only here. You can read, copy and export it, or choose another document. Click or tap in the text to edit here when the other window can yield, or close that window first.' + unsaved;
}

/** Write gate: in-memory fence must match the stored fence for this instance. A released record (no owner) matches nobody. */
export function ownershipFenceAllowsWrite(
  record: EditOwnershipRecord | undefined,
  instanceId: string,
  fence: number,
): boolean {
  return !!record && !!instanceId && record.ownerInstanceId === instanceId && record.fence === fence;
}
