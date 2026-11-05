/**
 * #175 step 3 host page: one embedded editor window, Settings panel + update notice here.
 */
import '../style.css';
import { watchForUpdates } from '../ui/update-notice';
import { ensurePrimaryWindowId } from './window-ids';

const root = document.querySelector<HTMLElement>('#host-root')!;
const frame = document.querySelector<HTMLIFrameElement>('#editor-window')!;
const settingsRoot = document.querySelector<HTMLElement>('#host-settings-root')!;

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

function adoptSettingsPanel(): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  const panel = doc.getElementById('settings-panel');
  if (!panel || panel.parentElement === settingsRoot) return;
  settingsRoot.appendChild(panel);
}

frame.addEventListener('load', () => {
  adoptSettingsPanel();
  // Escape while focus is in the host-owned Settings panel (keydown targets the host document).
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const panel = settingsRoot.querySelector<HTMLElement>('#settings-panel');
    if (!panel || panel.hidden) return;
    event.preventDefault();
    settingsRoot.querySelector<HTMLButtonElement>('#settings-close')?.click();
  });
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        mount: root,
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
