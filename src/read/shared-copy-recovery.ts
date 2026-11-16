import { RECOVERY_PREFIX } from '../editor/recovery';

const PENDING = 'typebridge.pendingDraft.v1';

/**
 * Snapshot observable recovery IDs without modifying any backup. Other tabs'
 * sessionStorage is not observable; their active owners remain ineligible.
 * Undefined means inspection failed: create a new copy instead of guessing.
 * This read is deliberately outside the IndexedDB transaction, not cross-store CAS.
 */
export function sharedCopyRecoveryExclusions(
  readStores: () => [Storage, Storage] = () => [localStorage, sessionStorage],
): ReadonlySet<string> | undefined {
  try {
    const [local, session] = readStores();
    const excluded = new Set<string>();
    for (const [store, field] of [[local, 'documentId'], [session, 'id']] as const) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key || (field === 'documentId'
          ? !key.startsWith(RECOVERY_PREFIX)
          : key !== PENDING && !key.startsWith(PENDING + '::w:'))) continue;
        const raw = store.getItem(key);
        if (raw === null) continue;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object') return undefined;
        const id = (value as Record<string, unknown>)[field];
        if (typeof id !== 'string' || !id) return undefined;
        excluded.add(id);
      }
    }
    return excluded;
  } catch { return undefined; }
}
