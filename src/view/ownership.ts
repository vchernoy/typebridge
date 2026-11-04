/**
 * Editing-ownership naming and fence helpers for #159 (W4).
 * Recovery locks stay separate: `typebridge-recovery-owner:{journalTab}`.
 */

export const EDIT_OWNER_LOCK_PREFIX = 'typebridge-edit-owner:';
export const EDIT_OWNERSHIP_STORE = 'editOwnership';

/** Heartbeat expiry used only when `navigator.locks` is unavailable (milliseconds). */
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
 * Next fence value when acquiring or stealing after expiry.
 * Callers persist the new record in the same IndexedDB transaction as the decision.
 */
export function nextOwnershipFence(current: EditOwnershipRecord | undefined): number {
  return (current?.fence ?? 0) + 1;
}

/**
 * Without Web Locks, a missing record or an expired heartbeat may be acquired.
 * Contested fresh records must not be overwritten here — UI fails closed to read-only.
 */
export function ownershipHeartbeatExpired(
  record: EditOwnershipRecord,
  now: number,
  ttlMs: number = EDIT_OWNER_HEARTBEAT_MS,
): boolean {
  return now - record.updatedAt > ttlMs;
}

export function canAcquireWithoutWebLock(
  record: EditOwnershipRecord | undefined,
  requesterInstanceId: string,
  now: number,
  ttlMs: number = EDIT_OWNER_HEARTBEAT_MS,
): boolean {
  if (!record) return true;
  if (record.ownerInstanceId === requesterInstanceId) return true;
  return ownershipHeartbeatExpired(record, now, ttlMs);
}

/** Write gate: in-memory fence must match the stored fence for this instance. */
export function ownershipFenceAllowsWrite(
  record: EditOwnershipRecord | undefined,
  instanceId: string,
  fence: number,
): boolean {
  return !!record && record.ownerInstanceId === instanceId && record.fence === fence;
}
