/**
 * Session intent for update-reload discard markers (#255). Survives same-tab location.reload();
 * cleared on cancel so a stale IndexedDB marker never deletes change records.
 */
import type { RecoverySnapshot } from '../editor/recovery';

const INTENT_PREFIX = 'typebridge.reloadDiscard.v1.';

/** Consent payload: document id plus the exact journal entry this discard covers, if any. */
export type ReloadDiscardIntent = {
  documentId: string;
  /** Exact localStorage journal snapshot at consent; cleared only by exact match after apply. */
  journal?: RecoverySnapshot;
};

export function reloadDiscardIntentKey(instanceId: string): string {
  return INTENT_PREFIX + instanceId;
}

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecoverySnapshot>;
  return typeof item.token === 'string' && !!item.token
    && typeof item.tab === 'string' && !!item.tab
    && typeof item.documentId === 'string' && !!item.documentId
    && typeof item.title === 'string'
    && typeof item.text === 'string'
    && typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)
    && Number.isSafeInteger(item.revision) && (item.revision ?? -1) >= 0;
}

/** Record that this tab consented to discard `documentId` (and optionally one journal) and will reload. */
export function setReloadDiscardIntent(instanceId: string, intent: ReloadDiscardIntent): void {
  sessionStorage.setItem(reloadDiscardIntentKey(instanceId), JSON.stringify(intent));
}

/** Consent payload for this instance, if any. */
export function readReloadDiscardIntent(instanceId: string): ReloadDiscardIntent | undefined {
  try {
    const raw = sessionStorage.getItem(reloadDiscardIntentKey(instanceId));
    if (raw === null) return undefined;
    // Legacy plain document id (pre-journal binding) still means consent for that document.
    if (raw.length > 0 && raw[0] !== '{') return { documentId: raw };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const documentId = (parsed as { documentId?: unknown }).documentId;
    if (typeof documentId !== 'string' || !documentId) return undefined;
    const journalRaw = (parsed as { journal?: unknown }).journal;
    if (journalRaw === undefined) return { documentId };
    if (!isRecoverySnapshot(journalRaw)) return { documentId };
    return { documentId, journal: journalRaw };
  } catch {
    return undefined;
  }
}

/** Drop the session intent (cancel or after a successful apply). */
export function clearReloadDiscardIntent(instanceId: string): void {
  try { sessionStorage.removeItem(reloadDiscardIntentKey(instanceId)); } catch { /* optional */ }
}
