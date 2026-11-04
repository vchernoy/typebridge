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
 * Next fence value when acquiring or stealing after expiry.
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

/** Write gate: in-memory fence must match the stored fence for this instance. */
export function ownershipFenceAllowsWrite(
  record: EditOwnershipRecord | undefined,
  instanceId: string,
  fence: number,
): boolean {
  return !!record && record.ownerInstanceId === instanceId && record.fence === fence;
}
