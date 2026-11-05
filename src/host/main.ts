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
  __typebridgeAssertSafeUpdateReload?: () => void;
  __typebridgeCancelUpdateReload?: () => void;
};

function editorHooks(): EditorHooks {
  return (frame.contentWindow ?? {}) as EditorHooks;
}

function editorWorkspace(): HTMLElement | null {
  try {
    return frame.contentDocument?.querySelector<HTMLElement>('main > section') ?? null;
  } catch {
    return null;
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        mount: noticeMount,
        // Freeze the iframe editor section only — confirm dialogs append to iframe body.
        freezeSurface: editorWorkspace,
        dismissedKey: 'typebridge.updateNotice.dismissed.v1',
        prepareReload: async () => {
          const prepare = editorHooks().__typebridgePrepareUpdateReload;
          if (!prepare) return false;
          return prepare();
        },
        reload: () => {
          const assertSafe = editorHooks().__typebridgeAssertSafeUpdateReload;
          if (!assertSafe) throw new Error('Editor reload unavailable');
          // Intentional throws ("Private edits changed", backup missing, busy) must
          // abort the host navigation — same as standalone watchForUpdates.
          assertSafe();
          window.location.reload();
        },
        cancelReload: () => { editorHooks().__typebridgeCancelUpdateReload?.(); },
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
