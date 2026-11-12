/**
 * #175 step 5–7 host page: free-layout editor windows, update notice, and Settings.
 */
import '../style.css';
import { ACTIVE_DRAFT_KEY_BASE } from '../editor/drafts';
import { watchForUpdates } from '../ui/update-notice';
import { editorWindowApi, exposeHostPageApi, type EditorWindowApi } from '../view/embed-api';
import { isDocumentId } from '../view/route';
import { scopeSessionKey } from '../view/window-id';
import { installHostSettings } from './settings';
import { readHostLayout } from './layout';
import { migrateStandaloneSession } from './session-migration';
import { installToolbarFit } from './toolbar-fit';
import { installWindowManager } from './window-manager';

const root = document.querySelector<HTMLElement>('#host-root')!;
const toolbar = document.querySelector<HTMLElement>('#host-toolbar')!;
const noticeMount = document.querySelector<HTMLElement>('#host-notice')!;

/** A window's side of the host↔window contract (see view/embed-api.ts); empty until it loads. */
function editorHooks(frame: HTMLIFrameElement): Partial<EditorWindowApi> {
  return editorWindowApi(frame.contentWindow) ?? {};
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

// A tab that ran the single editor at `/` before the cutover keeps its document, unsaved
// reload backup and caret: move that session state into the window that shows first.
try {
  const ids = readHostLayout(localStorage)?.windows.map(win => win.id) ?? [];
  const focusId = readHostLayout(localStorage)?.focusWindowId;
  migrateStandaloneSession(sessionStorage, (focusId && ids.includes(focusId) ? focusId : ids[0]) ?? 'main');
} catch { /* Blocked storage: windows start without the old session hints. */ }

const manager = installWindowManager({
  root,
  toolbar,
  editorSrc: (windowId, documentId) => {
    const params = new URLSearchParams({ window: windowId, embed: '1' });
    if (documentId) params.set('doc', documentId);
    return `/editor.html?${params.toString()}`;
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
  cancelClose: frame => {
    editorHooks(frame).__typebridgeCancelWindowClose?.();
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

// The host's side of the host↔window contract (see view/embed-api.ts).
exposeHostPageApi({
  __typebridgeHostWindows: () => manager.windows(),
  __typebridgeHostLayoutMode: () => manager.layoutMode(),
  __typebridgeHostFocusMode: (enabled, sourceWindowId) => {
    manager.setHostFocusMode(enabled, sourceWindowId);
  },
  __typebridgeHostRename: windowId => { manager.renameWindow(windowId); },
  __typebridgeOpenDocumentIds: exceptWindowId => manager.openDocumentIds(exceptWindowId),
  __typebridgeOpenTitles: exceptWindowId => manager.openTitles(exceptWindowId),
});

installToolbarFit(toolbar);
installHostSettings({
  frames: editorFrames,
  exitHostFocus: () => { manager.setHostFocusMode(false); },
});

/** Run after the page load event — or now, when this module (imported by entry.ts) arrives later. */
function afterLoad(run: () => void): void {
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  afterLoad(() => {
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

// `/?open=<id>` (Edit a copy from a shared link, #39): show that saved document in a window,
// then drop the parameter so a reload does not open it again.
{
  const params = new URLSearchParams(location.search);
  const requested = params.get('open');
  if (requested !== null) {
    params.delete('open');
    const query = params.toString();
    history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + location.hash);
    if (isDocumentId(requested)) {
      const outcome = manager.openDocument(requested);
      const status = document.createElement('p');
      status.className = 'host-status';
      status.setAttribute('role', 'status');
      toolbar.after(status);
      status.textContent = outcome === 'full'
        ? 'Saved as a new document in your Documents. Close a window, then open it from ▾ Documents.'
        : 'Saved as a new document in your Documents.';
      window.setTimeout(() => { status.remove(); }, 8000);
    }
  }
}
