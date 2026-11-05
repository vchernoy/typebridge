/**
 * #175 step 5: free-layout window manager for the host page.
 * Owns chrome (title bar, resize), tiling, persistence — never document text.
 */
import {
  KEYBOARD_MOVE_STEP_PX,
  MAX_HOST_WINDOWS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  bringToFront,
  clampRect,
  clampResizeRect,
  defaultRectForIndex,
  MOVE_RESTORE_THRESHOLD_PX,
  isFullscreenRect,
  mintWindowId,
  readHostLayout,
  restoreForMove,
  snapRect,
  tileSideBySide,
  tileStacked,
  writeHostLayout,
  type HostWindowLayout,
  type ViewportSize,
  type WindowRect,
} from './layout';

export type WindowManagerDeps = {
  root: HTMLElement;
  toolbar: HTMLElement;
  /** Build the iframe src for a window id (embed mode; may include saved document id). */
  editorSrc: (windowId: string, documentId?: string) => string;
  storage?: Storage;
  /** Ask the iframe whether it is safe to close (unsaved/private prompts). */
  prepareClose: (frame: HTMLIFrameElement) => Promise<boolean>;
  /** After prepareClose succeeds, arm discard/unload suppression before removing the iframe. */
  commitClose?: (frame: HTMLIFrameElement) => void;
  /** Optional document-id probe for layout persistence (never text). */
  readDocumentId?: (frame: HTMLIFrameElement) => string | undefined;
};

type DragKind =
  | {
    type: 'move';
    id: string;
    originX: number;
    originY: number;
    start: WindowRect;
    /** Full-bleed windows restore only after the pointer passes the move threshold. */
    restoreOnDrag: boolean;
    /** True once the pointer moved far enough to count as a drag (enables snap). */
    didMove: boolean;
  }
  | {
    type: 'resize';
    id: string;
    edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };
    originX: number;
    originY: number;
    start: WindowRect;
  };

export type WindowManager = {
  windows: () => HostWindowLayout[];
  addWindow: () => string | undefined;
  closeWindow: (id: string) => Promise<boolean>;
  tileSideBySide: () => void;
  tileStacked: () => void;
  dispose: () => void;
};

function viewportOf(root: HTMLElement): ViewportSize {
  const rect = root.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  // Fallback only when the box is unmeasurable — do not invent a larger viewport.
  return {
    width: width > 0 ? width : MIN_FALLBACK,
    height: height > 0 ? height : MIN_FALLBACK,
  };
}

const MIN_FALLBACK = 320;

export function installWindowManager(deps: WindowManagerDeps): WindowManager {
  let storage: Storage | undefined = deps.storage;
  if (storage === undefined) {
    try { storage = localStorage; } catch { storage = undefined; }
  }

  let layouts: HostWindowLayout[] = [];
  const shells = new Map<string, HTMLElement>();
  const frames = new Map<string, HTMLIFrameElement>();
  let drag: DragKind | undefined;
  let disposed = false;

  const persist = (): void => {
    const next = layouts.map(win => {
      const frame = frames.get(win.id);
      const documentId = frame && deps.readDocumentId ? deps.readDocumentId(frame) : win.documentId;
      return documentId ? { ...win, documentId } : { ...win, documentId: undefined };
    });
    layouts = next;
    writeHostLayout({ version: 1, windows: layouts }, storage);
  };

  const applyShellGeometry = (win: HostWindowLayout): void => {
    const shell = shells.get(win.id);
    if (!shell) return;
    shell.style.left = `${win.x}px`;
    shell.style.top = `${win.y}px`;
    shell.style.width = `${win.w}px`;
    shell.style.height = `${win.h}px`;
    shell.style.zIndex = String(win.z);
  };

  const syncToolbar = (): void => {
    const addBtn = deps.toolbar.querySelector<HTMLButtonElement>('[data-host-action="new-window"]');
    if (addBtn) addBtn.disabled = layouts.length >= MAX_HOST_WINDOWS;
  };

  const setActive = (id: string): void => {
    layouts = bringToFront(layouts, id);
    for (const win of layouts) applyShellGeometry(win);
    for (const [wid, shell] of shells) {
      shell.classList.toggle('is-active', wid === id);
      shell.setAttribute('aria-selected', wid === id ? 'true' : 'false');
    }
    persist();
  };

  const updateLayout = (id: string, rect: WindowRect): void => {
    layouts = layouts.map(win => (win.id === id ? { ...win, ...rect } : win));
    const win = layouts.find(w => w.id === id);
    if (win) applyShellGeometry(win);
  };

  const createShell = (win: HostWindowLayout): void => {
    const shell = document.createElement('section');
    shell.className = 'host-window';
    shell.dataset.windowId = win.id;
    shell.setAttribute('role', 'group');
    shell.setAttribute('aria-label', `Editor window ${win.id}`);

    const titleBar = document.createElement('header');
    titleBar.className = 'host-window-titlebar';

    const moveHandle = document.createElement('div');
    moveHandle.className = 'host-window-move';
    moveHandle.tabIndex = 0;
    moveHandle.setAttribute('role', 'button');
    moveHandle.setAttribute(
      'aria-label',
      `Move window ${win.id} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`,
    );

    const title = document.createElement('span');
    title.className = 'host-window-title';
    title.textContent = win.id === 'main' ? 'TypeBridge' : `Window ${win.id}`;
    moveHandle.append(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'host-window-close';
    closeBtn.dataset.hostAction = 'close-window';
    closeBtn.setAttribute('aria-label', `Close window ${win.id}`);
    closeBtn.textContent = '×';

    titleBar.append(moveHandle, closeBtn);

    const frame = document.createElement('iframe');
    frame.className = 'host-editor';
    frame.dataset.windowId = win.id;
    frame.title = `TypeBridge editor ${win.id}`;
    frame.allow = 'clipboard-read; clipboard-write';
    frame.src = deps.editorSrc(win.id, win.documentId);

    const handles: Array<[string, string]> = [
      ['n', 'top'],
      ['s', 'bottom'],
      ['e', 'right'],
      ['w', 'left'],
      ['ne', 'top-right'],
      ['nw', 'top-left'],
      ['se', 'bottom-right'],
      ['sw', 'bottom-left'],
    ];
    for (const [edge, label] of handles) {
      const handle = document.createElement('div');
      handle.className = `host-window-resize host-window-resize-${edge}`;
      handle.dataset.resize = edge;
      handle.setAttribute('aria-hidden', 'true');
      handle.title = `Resize ${label}`;
      shell.append(handle);
    }

    shell.append(titleBar, frame);
    deps.root.append(shell);
    shells.set(win.id, shell);
    frames.set(win.id, frame);
    applyShellGeometry(win);

    shell.addEventListener('pointerdown', () => { setActive(win.id); });

    // Iframe pointer/focus events do not bubble to the shell. Wire same-origin
    // content so clicking or focusing the editor still raises the window.
    const activateFromIframe = (): void => { setActive(win.id); };
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        doc.addEventListener('pointerdown', activateFromIframe);
        doc.addEventListener('focusin', activateFromIframe);
      } catch { /* Unexpected cross-origin — chrome-only activation remains. */ }
    });

    moveHandle.addEventListener('pointerdown', event => {
      event.preventDefault();
      setActive(win.id);
      const current = layouts.find(w => w.id === win.id);
      if (!current) return;
      const view = viewportOf(deps.root);
      drag = {
        type: 'move',
        id: win.id,
        originX: event.clientX,
        originY: event.clientY,
        start: { x: current.x, y: current.y, w: current.w, h: current.h },
        restoreOnDrag: isFullscreenRect(current, view),
        didMove: false,
      };
      moveHandle.setPointerCapture(event.pointerId);
    });

    moveHandle.addEventListener('keydown', event => {
      const current = layouts.find(w => w.id === win.id);
      if (!current) return;
      const view = viewportOf(deps.root);
      const step = event.shiftKey && !event.ctrlKey && !event.metaKey
        ? KEYBOARD_MOVE_STEP_PX * 4
        : KEYBOARD_MOVE_STEP_PX;
      // Ctrl/⌘+Shift+Arrow resizes (avoid Alt+Arrow, which navigates history on Windows/Linux).
      const resize = (event.ctrlKey || event.metaKey) && event.shiftKey;
      // Restore full-bleed only for real moves — resize keeps the current size.
      const base = resize ? current : restoreForMove(current, view);
      let next: WindowRect | undefined;
      if (event.key === 'ArrowLeft') {
        next = resize
          ? { ...base, w: base.w - step }
          : { ...base, x: base.x - step };
      } else if (event.key === 'ArrowRight') {
        next = resize
          ? { ...base, w: base.w + step }
          : { ...base, x: base.x + step };
      } else if (event.key === 'ArrowUp') {
        next = resize
          ? { ...base, h: base.h - step }
          : { ...base, y: base.y - step };
      } else if (event.key === 'ArrowDown') {
        next = resize
          ? { ...base, h: base.h + step }
          : { ...base, y: base.y + step };
      }
      if (!next) return;
      event.preventDefault();
      setActive(win.id);
      updateLayout(win.id, clampRect(next, view));
      persist();
    });

    closeBtn.addEventListener('click', () => { void api.closeWindow(win.id); });

    shell.querySelectorAll<HTMLElement>('[data-resize]').forEach(handle => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        setActive(win.id);
        const current = layouts.find(w => w.id === win.id);
        if (!current) return;
        const edge = handle.dataset.resize ?? '';
        drag = {
          type: 'resize',
          id: win.id,
          edges: {
            left: edge.includes('w'),
            right: edge.includes('e'),
            top: edge.includes('n'),
            bottom: edge.includes('s'),
          },
          originX: event.clientX,
          originY: event.clientY,
          start: { x: current.x, y: current.y, w: current.w, h: current.h },
        };
        handle.setPointerCapture(event.pointerId);
      });
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    const view = viewportOf(deps.root);
    if (drag.type === 'move') {
      const distance = Math.hypot(dx, dy);
      if (distance < MOVE_RESTORE_THRESHOLD_PX && !drag.didMove) return;
      drag.didMove = true;
      if (drag.restoreOnDrag) {
        const rootBox = deps.root.getBoundingClientRect();
        drag.start = restoreForMove(drag.start, view, {
          x: event.clientX - rootBox.left,
          y: event.clientY - rootBox.top,
        });
        drag.originX = event.clientX;
        drag.originY = event.clientY;
        drag.restoreOnDrag = false;
        updateLayout(drag.id, drag.start);
        return;
      }
      updateLayout(drag.id, clampRect({
        x: drag.start.x + dx,
        y: drag.start.y + dy,
        w: drag.start.w,
        h: drag.start.h,
      }, view));
      return;
    }
    let { x, y, w, h } = drag.start;
    if (drag.edges.left) {
      const nextX = drag.start.x + dx;
      const maxX = drag.start.x + drag.start.w - MIN_WINDOW_WIDTH;
      x = Math.min(nextX, maxX);
      w = drag.start.w + (drag.start.x - x);
    }
    if (drag.edges.right) w = drag.start.w + dx;
    if (drag.edges.top) {
      const nextY = drag.start.y + dy;
      const maxY = drag.start.y + drag.start.h - MIN_WINDOW_HEIGHT;
      y = Math.min(nextY, maxY);
      h = drag.start.h + (drag.start.y - y);
    }
    if (drag.edges.bottom) h = drag.start.h + dy;
    updateLayout(drag.id, clampResizeRect({ x, y, w, h }, view, drag.edges, drag.start));
  };

  const onPointerUp = (): void => {
    if (!drag) return;
    const id = drag.id;
    const snapAfterMove = drag.type === 'move' && drag.didMove;
    const wasResize = drag.type === 'resize';
    const current = layouts.find(w => w.id === id);
    drag = undefined;
    if (!current) return;
    // Snap only after a real drag — a title-bar click must not restore or quarter-snap.
    if (snapAfterMove) {
      updateLayout(id, snapRect(current, viewportOf(deps.root)));
      persist();
      return;
    }
    if (wasResize) persist();
  };

  const mountWindows = (initial: HostWindowLayout[]): void => {
    layouts = initial;
    for (const win of layouts) createShell(win);
    syncToolbar();
  };

  const boot = (): void => {
    const view = viewportOf(deps.root);
    const saved = readHostLayout(storage);
    if (saved?.windows.length) {
      mountWindows(saved.windows.map((win, index) => ({
        ...win,
        ...clampRect(win, view),
        z: win.z || index + 1,
      })));
      return;
    }
    const primary: HostWindowLayout = {
      id: 'main',
      ...defaultRectForIndex(0, view),
      z: 1,
    };
    // First window fills the host for single-window parity with step 3.
    primary.x = 0;
    primary.y = 0;
    primary.w = view.width;
    primary.h = view.height;
    mountWindows([primary]);
    persist();
  };

  const onResize = (): void => {
    const view = viewportOf(deps.root);
    layouts = layouts.map(win => ({ ...win, ...clampRect(win, view) }));
    for (const win of layouts) applyShellGeometry(win);
    persist();
  };

  const api: WindowManager = {
    windows: () => layouts.slice(),
    addWindow: () => {
      if (layouts.length >= MAX_HOST_WINDOWS) return undefined;
      const view = viewportOf(deps.root);
      const id = mintWindowId(layouts.map(w => w.id));
      const maxZ = layouts.reduce((m, win) => Math.max(m, win.z), 0);
      const win: HostWindowLayout = {
        id,
        ...defaultRectForIndex(layouts.length, view),
        z: maxZ + 1,
      };
      layouts = [...layouts, win];
      createShell(win);
      setActive(id);
      syncToolbar();
      persist();
      return id;
    },
    closeWindow: async (id: string) => {
      if (layouts.length <= 1) return false;
      const frame = frames.get(id);
      if (frame) {
        try {
          if (frame.contentDocument && frame.contentDocument.readyState !== 'complete') {
            return false;
          }
        } catch { /* Cross-origin unexpectedly — fall through to prepareClose. */ }
        const ok = await deps.prepareClose(frame);
        if (!ok) return false;
        // Another close may have finished while we awaited consent — never drop the last window.
        if (layouts.length <= 1 || !layouts.some(win => win.id === id)) return false;
        deps.commitClose?.(frame);
      } else if (layouts.length <= 1 || !layouts.some(win => win.id === id)) {
        return false;
      }
      shells.get(id)?.remove();
      shells.delete(id);
      frames.delete(id);
      layouts = layouts.filter(win => win.id !== id);
      // Drop scoped session keys after the iframe is gone. prepareClose only returns
      // true for a clean close or an explicit discard, so pendingDraft is safe to
      // remove here — and doing it *after* unload beats a pagehide that recreates it.
      try {
        const marker = `::w:${id}`;
        const writingMarker = `w:${id}.`;
        const remove: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (!key) continue;
          if (key.includes(marker) || key.includes(writingMarker)) remove.push(key);
        }
        for (const key of remove) sessionStorage.removeItem(key);
        sessionStorage.removeItem(`typebridge.pendingDraft.v1${marker}`);
        sessionStorage.removeItem(`typebridge.pendingDraft.paneB.v1${marker}`);
      } catch { /* Blocked sessionStorage — layout still closes. */ }
      syncToolbar();
      persist();
      return true;
    },
    tileSideBySide: () => {
      layouts = tileSideBySide(layouts, viewportOf(deps.root));
      for (const win of layouts) applyShellGeometry(win);
      persist();
    },
    tileStacked: () => {
      layouts = tileStacked(layouts, viewportOf(deps.root));
      for (const win of layouts) applyShellGeometry(win);
      persist();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', onPersistDocumentIds);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onHostHidden);
      rootObserver?.disconnect();
      for (const shell of shells.values()) shell.remove();
      shells.clear();
      frames.clear();
    },
  };

  deps.toolbar.querySelector('[data-host-action="new-window"]')
    ?.addEventListener('click', () => { api.addWindow(); });
  deps.toolbar.querySelector('[data-host-action="tile-side"]')
    ?.addEventListener('click', () => { api.tileSideBySide(); });
  deps.toolbar.querySelector('[data-host-action="tile-stack"]')
    ?.addEventListener('click', () => { api.tileStacked(); });

  const onPersistDocumentIds = (): void => { persist(); };
  const onHostHidden = (): void => {
    if (document.visibilityState === 'hidden') onPersistDocumentIds();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== sessionStorage) return;
    if (!event.key?.includes('activeDraft')) return;
    persist();
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', onPersistDocumentIds);
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onHostHidden);
  // Update notice / toolbar reflow change host-root without a window resize.
  const rootObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { onResize(); })
    : undefined;
  rootObserver?.observe(deps.root);

  boot();
  return api;
}
