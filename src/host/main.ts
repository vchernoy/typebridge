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
  __typebridgeCommitWindowClose?: () => void;
};

function editorHooks(frame: HTMLIFrameElement): EditorHooks {
  return (frame.contentWindow ?? {}) as EditorHooks;
}

function editorFrames(): HTMLIFrameElement[] {
  return [...root.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
}

function editorWorkspace(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.querySelector<HTMLElement>('main > section') ?? null;
  } catch {
    return null;
  }
}

function allEditorWorkspaces(): HTMLElement[] {
  return editorFrames()
    .map(editorWorkspace)
    .filter((el): el is HTMLElement => !!el);
}

const manager = installWindowManager({
  root,
  toolbar,
  editorSrc: (windowId, documentId) => {
    const params = new URLSearchParams({ window: windowId, embed: '1' });
    if (documentId) params.set('doc', documentId);
    return `/?${params.toString()}`;
  },
  prepareClose: async frame => {
    const prepare = editorHooks(frame).__typebridgePrepareWindowClose
      ?? editorHooks(frame).__typebridgePrepareUpdateReload;
    if (!prepare) return true;
    return prepare();
  },
  commitClose: frame => {
    editorHooks(frame).__typebridgeCommitWindowClose?.();
  },
  readDocumentId: frame => {
    const shell = frame.closest<HTMLElement>('[data-window-id]');
    const id = shell?.dataset.windowId ?? frame.dataset.windowId;
    if (!id) return undefined;
    try {
      return sessionStorage.getItem(scopeSessionKey(ACTIVE_DRAFT_KEY_BASE, id)) ?? undefined;
    } catch {
      return undefined;
    }
  },
});

// Expose for e2e probes and embedded Focus-mode handoff (#175 step 6).
const hostHooks = window as Window & {
  __typebridgeHostWindows?: () => ReturnType<typeof manager.windows>;
  __typebridgeHostLayoutMode?: () => ReturnType<typeof manager.layoutMode>;
  __typebridgeHostFocusMode?: (enabled: boolean, sourceWindowId?: string) => void;
};
hostHooks.__typebridgeHostWindows = () => manager.windows();
hostHooks.__typebridgeHostLayoutMode = () => manager.layoutMode();
hostHooks.__typebridgeHostFocusMode = (enabled, sourceWindowId) => {
  manager.setHostFocusMode(enabled, sourceWindowId);
};

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        mount: noticeMount,
        // Freeze every window's editor section so multi-window private text is protected.
        freezeSurface: () => allEditorWorkspaces(),
        dismissedKey: 'typebridge.updateNotice.dismissed.v1',
        prepareReload: async () => {
          // Ask each window in turn so each Autosave-off dialog appears in its iframe.
          for (const frame of editorFrames()) {
            const prepare = editorHooks(frame).__typebridgePrepareUpdateReload;
            if (!prepare) continue;
            if (!await prepare()) return false;
          }
          return true;
        },
        reload: () => {
          try {
            for (const frame of editorFrames()) {
              const assertSafe = editorHooks(frame).__typebridgeAssertSafeUpdateReload;
              if (!assertSafe) throw new Error('Editor reload unavailable');
              // Intentional throws ("Private edits changed", backup missing, busy) must abort.
              assertSafe();
            }
            window.location.reload();
          } catch (error) {
            // A later window's throw must not leave earlier windows with allowUpdateReload set —
            // that would silence their beforeunload private-text warning.
            for (const frame of editorFrames()) {
              editorHooks(frame).__typebridgeCancelUpdateReload?.();
            }
            throw error;
          }
        },
        cancelReload: () => {
          for (const frame of editorFrames()) {
            editorHooks(frame).__typebridgeCancelUpdateReload?.();
          }
        },
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
