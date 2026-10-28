/** Emergency text snapshots are separate from authoritative IndexedDB documents. */
export const RECOVERY_PREFIX = 'typebridge.recovery.v1.';
export type RecoverySnapshot = {
  token: string;
  tab: string;
  documentId: string;
  revision: number;
  timestamp: number;
  title: string;
  text: string;
};

export function recoveryKey(tab: string, documentId: string): string {
  return RECOVERY_PREFIX + tab + '.' + documentId;
}
export function writeRecovery(storage: Storage, snapshot: RecoverySnapshot): void {
  storage.setItem(recoveryKey(snapshot.tab, snapshot.documentId), JSON.stringify(snapshot));
}
export function listRecovery(storage: Storage): RecoverySnapshot[] {
  const records: RecoverySnapshot[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(RECOVERY_PREFIX)) continue;
    try {
      const raw: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Partial<RecoverySnapshot>;
      if (typeof item.token !== 'string' || !item.token || typeof item.tab !== 'string' || !item.tab ||
          typeof item.documentId !== 'string' || !item.documentId || typeof item.title !== 'string' ||
          typeof item.text !== 'string' || typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) ||
          !Number.isSafeInteger(item.revision) || (item.revision ?? -1) < 0 ||
          recoveryKey(item.tab, item.documentId) !== key) continue;
      records.push(item as RecoverySnapshot);
    } catch { /* Leave malformed entries untouched for manual recovery. */ }
  }
  return records;
}
/** Clear only the exact version observed before an IndexedDB commit. */
export function clearRecovery(storage: Storage, item: RecoverySnapshot): void {
  const key = recoveryKey(item.tab, item.documentId);
  if (storage.getItem(key) === JSON.stringify(item)) storage.removeItem(key);
}
