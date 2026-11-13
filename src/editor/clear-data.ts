/** Content-only erasure (#257 step 4). Preferences and offline app assets are retained. */
export const STORAGE_CLEAR_KEY = 'typebridge.storageClear.v1';
export const STORAGE_CLEAR_EVENT = 'typebridge-storage-cleared';
export type StorageClear = { nonce: string; documentId?: string; failed?: true };
const prefixes = ['typebridge.recovery.v1.', 'typebridge.pendingDraft.', 'typebridge.activeDraft.',
  'typebridge.writingPosition.v1.', 'typebridge.find.query.v1', 'typebridge.find.replace.v1', 'typebridge.drafts.v1', 'typebridge.reloadDiscard.', 'typebridge.reloadDiscardPending.'];
export function clearContentMetadata(storage: Storage): void {
  for (const key of Object.keys(storage)) {
    if (key === 'typebridge.host.windows.v1' || prefixes.some(prefix => key.startsWith(prefix))) storage.removeItem(key);
  }
}
export function clearDocumentMetadata(storage: Storage, id: string): void {
  for (const key of Object.keys(storage)) {
    const raw = storage.getItem(key);
    if (key.startsWith('typebridge.activeDraft.') && raw === id) storage.removeItem(key);
    else if (key.startsWith('typebridge.writingPosition.v1.') && key.endsWith(id)) storage.removeItem(key);
    else if (key.startsWith('typebridge.pendingDraft.') || key.startsWith('typebridge.recovery.v1.')) {
      try { const item = JSON.parse(raw ?? 'null'); if (item?.id === id || item?.documentId === id) storage.removeItem(key); } catch { /* Unrelated corrupt backup. */ }
    } else if (key === 'typebridge.host.windows.v1' && raw) {
      const layout = JSON.parse(raw);
      if (Array.isArray(layout.windows)) {
        for (const win of layout.windows) if (win.documentId === id) delete win.documentId;
        storage.setItem(key, JSON.stringify(layout));
      }
    }
  }
}
export function parseStorageClear(value: unknown): StorageClear | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (typeof v.nonce !== 'string' || !v.nonce || (v.documentId !== undefined && (typeof v.documentId !== 'string' || !v.documentId))) return;
  if (v.failed !== undefined && v.failed !== true) return;
  return { nonce: v.nonce, ...(typeof v.documentId === 'string' ? { documentId: v.documentId } : {}), ...(v.failed ? { failed: true as const } : {}) };
}
let channel: BroadcastChannel | undefined;
let started = false;
const seen = new Set<string>();
function receive(value: unknown, local = false): void {
  const detail = parseStorageClear(value);
  if (!detail || seen.has(detail.nonce)) return;
  seen.add(detail.nonce);
  window.dispatchEvent(new CustomEvent(STORAGE_CLEAR_EVENT, { detail: { ...detail, local } }));
}
function start(): void {
  if (started) return; started = true;
  try { channel = new BroadcastChannel('typebridge.storage.v1'); channel.addEventListener('message', event => receive(event.data)); } catch { /* storage events remain available */ }
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_CLEAR_KEY) return;
    try { receive(JSON.parse(event.newValue ?? 'null')); } catch { /* Invalid notification. */ }
  });
}
export function onStorageClear(callback: (detail: StorageClear & { local: boolean }) => void): void {
  start(); window.addEventListener(STORAGE_CLEAR_EVENT, event => callback((event as CustomEvent<StorageClear & { local: boolean }>).detail));
}
export function notifyStorageClear(documentId?: string, failed = false): void {
  start(); const detail = { nonce: crypto.randomUUID(), ...(documentId ? { documentId } : {}), ...(failed ? { failed: true as const } : {}) };
  receive(detail, true);
  try { channel?.postMessage(detail); } catch { /* Optional channel. */ }
  try { localStorage.setItem(STORAGE_CLEAR_KEY, JSON.stringify(detail)); localStorage.removeItem(STORAGE_CLEAR_KEY); } catch { /* IndexedDB deletion still notifies connected editors. */ }
}
/** Deletion invalidates old connections/fences; it waits for transactions that already started. */
export function deleteContentDatabase(blocked: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('typebridge');
    request.onblocked = blocked;
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}
