/**
 * #175 step 3 host page: one embedded editor window; update notice on the host.
 * Settings stay in the iframe for this slice (page-level Settings is step 7).
 */
import '../style.css';
import { watchForUpdates } from '../ui/update-notice';
import { ensurePrimaryWindowId } from './window-ids';

const frame = document.querySelector<HTMLIFrameElement>('#editor-window')!;
const noticeMount = document.querySelector<HTMLElement>('#host-notice')!;

const windowId = ensurePrimaryWindowId();
frame.src = `/?window=${encodeURIComponent(windowId)}&embed=1`;

type EditorHooks = {
  __typebridgePrepareUpdateReload?: () => Promise<boolean>;
  __typebridgeReloadAfterUpdate?: () => void;
  __typebridgeCancelUpdateReload?: () => void;
};

function editorHooks(): EditorHooks {
  return (frame.contentWindow ?? {}) as EditorHooks;
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        // Notice sits outside the iframe so prepareReload confirmations inside the
        // editor stay interactive (do not freeze #host-root / the iframe).
        mount: noticeMount,
        freezeSurface: null,
        dismissedKey: 'typebridge.updateNotice.dismissed.v1',
        prepareReload: async () => {
          const prepare = editorHooks().__typebridgePrepareUpdateReload;
          if (!prepare) return false;
          return prepare();
        },
        reload: () => {
          try { editorHooks().__typebridgeReloadAfterUpdate?.(); } catch { /* Host reload still proceeds. */ }
          window.location.reload();
        },
        cancelReload: () => { editorHooks().__typebridgeCancelUpdateReload?.(); },
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
