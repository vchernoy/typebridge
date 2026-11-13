import { clearContentMetadata, deleteContentDatabase, notifyStorageClear } from '../editor/clear-data';
import { askConfirmChoice } from './confirm-dialog';
export function setupClearLocalData(): void {
  const button = document.querySelector<HTMLButtonElement>('#clear-local-data');
  if (!button) return;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); button.after(status);
  let active = false;
  button.addEventListener('click', () => { void (async () => {
    if (active) return; active = true;
    try {
      if (!await askConfirmChoice({ title: 'Clear local data?',
        message: 'Permanently delete all documents, change records, crash and reload backups, window layout, Find/Replace text, and saved document positions on this device? This cannot be undone. Settings and offline access are kept. Text already open stays privately in its window until you leave.',
        confirmLabel: 'Clear local data', cancelLabel: 'Cancel', returnFocus: button })) return;
      button.disabled = true;
      await deleteContentDatabase(() => { status.textContent = 'Waiting for other TypeBridge tabs to release storage. Close older tabs to continue.'; });
      notifyStorageClear();
      clearContentMetadata(localStorage); clearContentMetadata(sessionStorage);
      status.textContent = 'Storage was cleared. Settings are kept. Reload before saving new documents.';
    } catch { status.textContent = 'Some local data could not be cleared. Close other TypeBridge tabs and retry. Copy or export open text before leaving.'; }
    finally {
      active = false; button.disabled = false;
      if (document.activeElement === document.body && button.offsetParent !== null) button.focus({ preventScroll: true });
    }
  })(); });
}
