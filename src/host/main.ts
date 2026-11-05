/**
 * #175 step 5 host page: free-layout editor windows; update notice on the host.
 * Settings stay in the iframe until step 7.
 */
import '../style.css';
import { ACTIVE_DRAFT_KEY_BASE } from '../editor/drafts';
import { watchForUpdates } from '../ui/update-notice';
import { scopeSessionKey } from '../view/window-id';
import { installWindowManager } from './window-manager';

const root = document.querySelector<HTMLElement>('#host-root')!;
const toolbar = document.querySelector<HTMLElement>('#host-toolbar')!;
const noticeMount = document.querySelector<HTMLElement>('#host-notice')!;

type EditorHooks = {
  __typebridgePrepareUpdateReload?: () => Promise<boolean>;
  __typebridgeAssertSafeUpdateReload?: () => void;
  __typebridgeCancelUpdateReload?: () => void;
  __typebridgePrepareWindowClose?: () => Promise<boolean>;
};

function editorHooks(frame: HTMLIFrameElement): EditorHooks {
  return (frame.contentWindow ?? {}) as EditorHooks;
}

function editorWorkspace(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.querySelector<HTMLElement>('main > section') ?? null;
  } catch {
    return null;
  }
}

function readDocumentId(frame: HTMLIFrameElement): string | undefined {
  const id = frame.dataset.windowId
    ?? frame.closest<HTMLElement>('[data-window-id]')?.dataset.windowId;
  if (!id) return undefined;
  try {
    const key = scopeSessionKey(ACTIVE_DRAFT_KEY_BASE, id);
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

const manager = installWindowManager({
  root,
  toolbar,
  editorSrc: windowId => `/?window=${encodeURIComponent(windowId)}&embed=1`,
  prepareClose: async frame => {
    const prepare = editorHooks(frame).__typebridgePrepareWindowClose
      ?? editorHooks(frame).__typebridgePrepareUpdateReload;
    if (!prepare) return true;
    return prepare();
  },
  readDocumentId: frame => {
    const shell = frame.closest<HTMLElement>('[data-window-id]');
    if (shell?.dataset.windowId) {
      try {
        return sessionStorage.getItem(scopeSessionKey(ACTIVE_DRAFT_KEY_BASE, shell.dataset.windowId))
          ?? undefined;
      } catch {
        return undefined;
      }
    }
    return readDocumentId(frame);
  },
});

// Expose for e2e probes without growing a public API surface.
(window as Window & { __typebridgeHostWindows?: () => ReturnType<typeof manager.windows> })
  .__typebridgeHostWindows = () => manager.windows();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => {
        const primaryFrame = () => root.querySelector<HTMLIFrameElement>('iframe.host-editor');
        return watchForUpdates(registration, {
          mount: noticeMount,
          freezeSurface: () => {
            const frame = primaryFrame();
            return frame ? editorWorkspace(frame) : null;
          },
          dismissedKey: 'typebridge.updateNotice.dismissed.v1',
          prepareReload: async () => {
            const frame = primaryFrame();
            if (!frame) return false;
            const prepare = editorHooks(frame).__typebridgePrepareUpdateReload;
            if (!prepare) return false;
            return prepare();
          },
          reload: () => {
            const frame = primaryFrame();
            const assertSafe = frame && editorHooks(frame).__typebridgeAssertSafeUpdateReload;
            if (!assertSafe) throw new Error('Editor reload unavailable');
            assertSafe();
            window.location.reload();
          },
          cancelReload: () => {
            const frame = primaryFrame();
            if (frame) editorHooks(frame).__typebridgeCancelUpdateReload?.();
          },
        });
      })
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
