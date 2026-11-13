/**
 * Session intent for update-reload discard markers (#255). Survives same-tab location.reload();
 * cleared on cancel so a stale IndexedDB marker never deletes change records.
 */
const INTENT_PREFIX = 'typebridge.reloadDiscard.v1.';

export function reloadDiscardIntentKey(instanceId: string): string {
  return INTENT_PREFIX + instanceId;
}

/** Record that this tab consented to discard `documentId` and will reload. */
export function setReloadDiscardIntent(instanceId: string, documentId: string): void {
  sessionStorage.setItem(reloadDiscardIntentKey(instanceId), documentId);
}

/** Document id this instance consented to discard, if any. */
export function readReloadDiscardIntent(instanceId: string): string | undefined {
  try {
    return sessionStorage.getItem(reloadDiscardIntentKey(instanceId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drop the session intent (cancel or after a successful apply). */
export function clearReloadDiscardIntent(instanceId: string): void {
  try { sessionStorage.removeItem(reloadDiscardIntentKey(instanceId)); } catch { /* optional */ }
}
