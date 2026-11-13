/**
 * Session intent + cross-tab pending flag for update-reload discard markers (#255).
 * Session intent survives same-tab location.reload(); the localStorage pending flag is visible to
 * other tabs so they do not consume a marker or salvage records while a consented reload is in flight.
 */
import type { RecoverySnapshot } from '../editor/recovery';

const INTENT_PREFIX = 'typebridge.reloadDiscard.v1.';
const PENDING_PREFIX = 'typebridge.reloadDiscardPending.v1.';

/** After this, a pending flag without session intent is treated as abandoned (allow salvage). */
export const RELOAD_DISCARD_PENDING_TTL_MS = 120_000;

/** Consent payload: document id plus the exact journal entry this discard covers, if any. */
export type ReloadDiscardIntent = {
  documentId: string;
  /** Exact localStorage journal snapshot at consent; cleared only by exact match after apply. */
  journal?: RecoverySnapshot;
};

export type ReloadDiscardPending = {
  instanceId: string;
  at: number;
};

export function reloadDiscardIntentKey(instanceId: string): string {
  return INTENT_PREFIX + instanceId;
}

export function reloadDiscardPendingKey(documentId: string): string {
  return PENDING_PREFIX + documentId;
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

/** Cross-tab: a consented reload for `documentId` is in flight (shared localStorage). */
export function setReloadDiscardPending(documentId: string, instanceId: string, at = Date.now()): void {
  const pending: ReloadDiscardPending = { instanceId, at };
  localStorage.setItem(reloadDiscardPendingKey(documentId), JSON.stringify(pending));
}

export function readReloadDiscardPending(documentId: string): ReloadDiscardPending | undefined {
  try {
    const raw = localStorage.getItem(reloadDiscardPendingKey(documentId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const instanceId = (parsed as { instanceId?: unknown }).instanceId;
    const at = (parsed as { at?: unknown }).at;
    if (typeof instanceId !== 'string' || !instanceId) return undefined;
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
    return { instanceId, at };
  } catch {
    return undefined;
  }
}

/** True while another context may still be completing a consented reload for this document. */
export function isReloadDiscardPendingActive(documentId: string, now = Date.now()): boolean {
  const pending = readReloadDiscardPending(documentId);
  if (!pending) return false;
  return now - pending.at <= RELOAD_DISCARD_PENDING_TTL_MS;
}

/**
 * Drop the cross-tab pending flag only when this tab owns it (`instanceId` matches).
 * Foreign cancel/prepare-fail must not erase another tab's in-flight consent (#256 Codex P0).
 * Returns whether the flag was removed.
 */
export function clearReloadDiscardPending(documentId: string, instanceId: string): boolean {
  try {
    const pending = readReloadDiscardPending(documentId);
    if (!pending || pending.instanceId !== instanceId) return false;
    localStorage.removeItem(reloadDiscardPendingKey(documentId));
    return true;
  } catch {
    return false;
  }
}

/** What salvageOnOwn should do for a marker / pending combination (#256 foreign-tab P0). */
export type ReloadDiscardSalvageAction = 'apply' | 'defer' | 'drop-marker' | 'none';

export function reloadDiscardSalvageAction(input: {
  hasMarker: boolean;
  consented: boolean;
  pendingActive: boolean;
}): ReloadDiscardSalvageAction {
  if (input.hasMarker) {
    if (input.consented) return 'apply';
    if (input.pendingActive) return 'defer';
    return 'drop-marker';
  }
  if (input.pendingActive) return 'defer';
  return 'none';
}
