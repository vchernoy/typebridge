import { clearContentMetadata, deleteContentDatabase, notifyStorageClear, onStorageClear } from '../editor/clear-data';
import { askConfirmChoice } from './confirm-dialog';
export function setupClearLocalData(): void {
  const button = document.querySelector<HTMLButtonElement>('#clear-local-data');
  if (!button) return;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); button.after(status);
  let active = false;
  let incomplete = false;
  onStorageClear(detail => {
    if (!detail.documentId && detail.failed) { incomplete = true; status.textContent = 'Some local data could not be cleared. The clear is incomplete; retry before leaving this device.'; }
  });
  button.addEventListener('click', () => { void (async () => {
    if (active) return; active = true;
    try {
      if (!await askConfirmChoice({ title: 'Clear local data?',
        message: 'Permanently delete all documents, change records, crash and reload backups, window layout, Find/Replace text, and saved document positions on this device? This cannot be undone. Settings and offline access are kept. Every open TypeBridge window and tab will start with an empty document.',
        confirmLabel: 'Clear local data', cancelLabel: 'Cancel', returnFocus: button })) return;
      button.disabled = true; incomplete = false;
      await deleteContentDatabase(() => { status.textContent = 'Waiting for other TypeBridge tabs to release storage. Close older tabs to continue.'; });
      clearContentMetadata(localStorage); clearContentMetadata(sessionStorage);
      notifyStorageClear();
      if (!incomplete) status.textContent = 'All local data was cleared. Settings are kept.';
    } catch { notifyStorageClear(undefined, true); status.textContent = 'Some local data could not be cleared. Close other TypeBridge tabs and retry. The clear is incomplete; retry before leaving this device.'; }
    finally {
      active = false; button.disabled = false;
      if (document.activeElement === document.body && button.offsetParent !== null) button.focus({ preventScroll: true });
    }
  })(); });
}
