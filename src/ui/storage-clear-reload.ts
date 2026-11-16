/** A successful global clear ends this page; only the next page opens fresh storage. */
import { clearContentMetadata, notifyStorageClear, onStorageClear } from '../editor/clear-data';
export const CLEARED_NOTICE_KEY = 'typebridge.clearedNotice.v1';
export type ClearedNotice = 'here' | 'elsewhere';
export function takeClearedNotice(storage: Storage): ClearedNotice | undefined {
  const value = storage.getItem(CLEARED_NOTICE_KEY);
  if (value !== null) storage.removeItem(CLEARED_NOTICE_KEY);
  return value === 'here' || value === 'elsewhere' ? value : undefined;
}
export function clearedNoticeText(notice: ClearedNotice): string {
  return notice === 'here' ? 'All local data was cleared' : 'Storage was cleared in another tab';
}
export function installStorageClearReload(deps: {
  stop: () => void;
  /** An embedded editor asks its host to stop all children and reload the top page. */
  delegate?: (here: boolean) => boolean;
  reload?: () => void;
}): (here: boolean) => void {
  let reloading = false;
  const reload = (here: boolean): void => {
    if (reloading) return;
    reloading = true;
    try {
      deps.stop();
      if (deps.delegate?.(here)) return;
      clearContentMetadata(sessionStorage);
      sessionStorage.setItem(CLEARED_NOTICE_KEY, here ? 'here' : 'elsewhere');
      (deps.reload ?? (() => location.reload()))();
    } catch {
      reloading = false;
      try { sessionStorage.removeItem(CLEARED_NOTICE_KEY); } catch { /* Report incomplete erasure. */ }
      notifyStorageClear(undefined, true);
    }
  };
  onStorageClear(detail => { if (!detail.documentId && !detail.failed) reload(detail.local); });
  return reload;
}
