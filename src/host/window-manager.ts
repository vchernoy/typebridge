/**
 * #175 step 5–6: free/stacked window manager for the host page.
 * Owns chrome (title bar, resize), tiling, layout mode, Focus maximize — never document text.
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
  stackPhoneWindows,
  tileSideBySide,
  tileStacked,
  writeHostLayout,
  type HostWindowLayout,
  type ViewportSize,
  type WindowRect,
} from './layout';
import {
  detectLayoutCapabilities,
  effectiveLayoutMode,
  readLayoutModePreference,
  type EffectiveLayoutMode,
  type LayoutModePreference,
} from './layout-mode';

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
  layoutMode: () => EffectiveLayoutMode;
  refreshLayoutMode: () => void;
  setHostFocusMode: (enabled: boolean, sourceWindowId?: string) => void;
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
  let mode: EffectiveLayoutMode = 'free';
  let preference: LayoutModePreference = 'auto';
  let hostFocus = false;
  let preFocusLayouts: HostWindowLayout[] | undefined;
  let activeId = 'main';

  const persist = (): void => {
    // While Focus maximizes a window, keep persisting the pre-Focus geometry so reload
    // can restore the prior free/stacked arrangement (and which window was focused).
    const base = hostFocus && preFocusLayouts ? preFocusLayouts : layouts;
    const next = base.map(win => {
      const frame = frames.get(win.id);
      // Prefer a live probe; if the iframe is already gone (host unload), keep the last known id.
      const probed = frame && deps.readDocumentId ? deps.readDocumentId(frame) : undefined;
      const documentId = probed ?? win.documentId;
      return documentId ? { ...win, documentId } : { ...win, documentId: undefined };
    });
    if (hostFocus && preFocusLayouts) preFocusLayouts = next;
    else layouts = next;
    writeHostLayout({
      version: 1,
      windows: next,
      ...(hostFocus ? { focusWindowId: activeId } : {}),
    }, storage);
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
    if (addBtn) addBtn.disabled = layouts.length >= MAX_HOST_WINDOWS || hostFocus;
    for (const action of ['tile-side', 'tile-stack'] as const) {
      const btn = deps.toolbar.querySelector<HTMLButtonElement>(`[data-host-action="${action}"]`);
      if (btn) btn.hidden = mode === 'stacked' || hostFocus;
    }
  };

  const applyModeChrome = (): void => {
    deps.root.dataset.layoutMode = mode;
    document.body.classList.toggle('host-stacked', mode === 'stacked');
    document.body.classList.toggle('host-focus-mode', hostFocus);
    for (const [wid, shell] of shells) {
      shell.classList.toggle('is-host-focused', hostFocus && wid === activeId);
      shell.hidden = hostFocus && wid !== activeId;
      const move = shell.querySelector<HTMLElement>('.host-window-move');
      if (move) {
        move.tabIndex = mode === 'stacked' || hostFocus ? -1 : 0;
        move.setAttribute(
          'aria-label',
          mode === 'stacked'
            ? `Window ${wid}`
            : `Move window ${wid} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`,
        );
      }
    }
    syncToolbar();
  };

  const applyAllGeometry = (): void => {
    for (const win of layouts) applyShellGeometry(win);
  };

  const restackPreservingHeights = (): void => {
    const view = viewportOf(deps.root);
    layouts = stackPhoneWindows(layouts, view, layouts.map(win => win.h));
    applyAllGeometry();
  };

  const enterStacked = (): void => {
    layouts = stackPhoneWindows(layouts, viewportOf(deps.root));
    applyAllGeometry();
  };

  const refreshMode = (nextPreference?: LayoutModePreference): void => {
    if (nextPreference) preference = nextPreference;
    else preference = readLayoutModePreference(storage);
    const next = effectiveLayoutMode(preference, detectLayoutCapabilities());
    if (next === mode && deps.root.dataset.layoutMode === mode) {
      applyModeChrome();
      return;
    }
    const previous = mode;
    mode = next;
    if (hostFocus) {
      applyModeChrome();
      return;
    }
    if (mode === 'stacked' && previous !== 'stacked') enterStacked();
    applyModeChrome();
    persist();
  };

  const setActive = (id: string): void => {
    activeId = id;
    if (mode === 'free' && !hostFocus) layouts = bringToFront(layouts, id);
    for (const win of layouts) applyShellGeometry(win);
    for (const [wid, shell] of shells) {
      shell.classList.toggle('is-active', wid === id);
      shell.setAttribute('aria-selected', wid === id ? 'true' : 'false');
    }
    if (hostFocus) applyModeChrome();
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
      if (mode === 'stacked' || hostFocus) return;
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
      if (mode === 'stacked' || hostFocus) return;
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
        if (hostFocus) return;
        const current = layouts.find(w => w.id === win.id);
        if (!current) return;
        const edge = handle.dataset.resize ?? '';
        // Phone stack: height grip only (south / south-east / south-west).
        if (mode === 'stacked' && !edge.includes('s')) return;
        drag = {
          type: 'resize',
          id: win.id,
          edges: mode === 'stacked'
            ? { bottom: true }
            : {
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
    if (mode === 'stacked' && drag.edges.bottom) {
      const index = layouts.findIndex(w => w.id === drag!.id);
      if (index < 0) return;
      const heights = layouts.map(win => win.h);
      heights[index] = Math.max(MIN_WINDOW_HEIGHT, drag.start.h + dy);
      layouts = stackPhoneWindows(layouts, view, heights);
      applyAllGeometry();
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
    const snapAfterMove = drag.type === 'move' && drag.didMove && mode === 'free';
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
    if (wasResize) {
      if (mode === 'stacked') restackPreservingHeights();
      persist();
    }
  };

  const mountWindows = (initial: HostWindowLayout[]): void => {
    layouts = initial;
    for (const win of layouts) createShell(win);
    syncToolbar();
  };

  let pendingFocusId: string | undefined;

  const boot = (): void => {
    const view = viewportOf(deps.root);
    const saved = readHostLayout(storage);
    if (saved?.windows.length) {
      mountWindows(saved.windows.map((win, index) => ({
        ...win,
        // Stacked heights may exceed the viewport (scrollable list); only clamp in free mode.
        ...(effectiveLayoutMode(readLayoutModePreference(storage), detectLayoutCapabilities()) === 'stacked'
          ? { x: 0, w: Math.max(MIN_WINDOW_WIDTH, view.width), h: Math.max(MIN_WINDOW_HEIGHT, win.h) }
          : clampRect(win, view)),
        z: win.z || index + 1,
      })));
      pendingFocusId = saved.focusWindowId;
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
    refreshMode();
    if (hostFocus) {
      const view = viewportOf(deps.root);
      layouts = layouts.map(win => (
        win.id === activeId
          ? { ...win, x: 0, y: 0, w: view.width, h: view.height }
          : win
      ));
      applyAllGeometry();
      persist();
      return;
    }
    if (mode === 'stacked') {
      restackPreservingHeights();
      persist();
      return;
    }
    const view = viewportOf(deps.root);
    layouts = layouts.map(win => ({ ...win, ...clampRect(win, view) }));
    applyAllGeometry();
    persist();
  };

  const api: WindowManager = {
    windows: () => layouts.slice(),
    addWindow: () => {
      if (hostFocus || layouts.length >= MAX_HOST_WINDOWS) return undefined;
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
      if (mode === 'stacked') enterStacked();
      setActive(id);
      applyModeChrome();
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
      if (preFocusLayouts) {
        preFocusLayouts = preFocusLayouts.filter(win => win.id !== id);
      }
      if (hostFocus && activeId === id) {
        hostFocus = false;
        preFocusLayouts = undefined;
      }
      if (activeId === id) activeId = layouts[0]?.id ?? 'main';
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
      if (mode === 'stacked' && !hostFocus) enterStacked();
      applyModeChrome();
      persist();
      return true;
    },
    tileSideBySide: () => {
      if (mode === 'stacked' || hostFocus) return;
      layouts = tileSideBySide(layouts, viewportOf(deps.root));
      applyAllGeometry();
      persist();
    },
    tileStacked: () => {
      if (mode === 'stacked' || hostFocus) return;
      layouts = tileStacked(layouts, viewportOf(deps.root));
      applyAllGeometry();
      persist();
    },
    layoutMode: () => mode,
    refreshLayoutMode: () => { refreshMode(); },
    setHostFocusMode: (enabled, sourceWindowId) => {
      if (enabled) {
        if (sourceWindowId && layouts.some(win => win.id === sourceWindowId)) {
          activeId = sourceWindowId;
        }
        if (!preFocusLayouts) {
          preFocusLayouts = layouts.map(win => ({ ...win }));
        }
        hostFocus = true;
        const view = viewportOf(deps.root);
        layouts = layouts.map(win => (
          win.id === activeId
            ? { ...win, x: 0, y: 0, w: view.width, h: view.height }
            : win
        ));
        applyAllGeometry();
        applyModeChrome();
        return;
      }
      if (!hostFocus) return;
      hostFocus = false;
      if (preFocusLayouts?.length) {
        const byId = new Map(preFocusLayouts.map(win => [win.id, win]));
        layouts = layouts.map(win => {
          const prior = byId.get(win.id);
          return prior ? { ...win, x: prior.x, y: prior.y, w: prior.w, h: prior.h, z: prior.z } : win;
        });
      }
      preFocusLayouts = undefined;
      if (mode === 'stacked') restackPreservingHeights();
      else {
        const view = viewportOf(deps.root);
        layouts = layouts.map(win => ({ ...win, ...clampRect(win, view) }));
      }
      applyAllGeometry();
      applyModeChrome();
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
      window.removeEventListener('message', onActiveDraftMessage);
      window.removeEventListener('typebridge-layout-mode', onLayoutModeEvent as EventListener);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onHostHidden);
      for (const mq of mediaQueries) mq.removeEventListener('change', onCapabilityChange);
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
  const onActiveDraftMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { type?: string; windowId?: string; documentId?: string } | null;
    if (!data || data.type !== 'typebridge-active-draft') return;
    if (typeof data.windowId !== 'string' || typeof data.documentId !== 'string' || !data.documentId) return;
    if (!layouts.some(win => win.id === data.windowId)) return;
    layouts = layouts.map(win => (
      win.id === data.windowId ? { ...win, documentId: data.documentId } : win
    ));
    writeHostLayout({ version: 1, windows: layouts }, storage);
  };
  const onLayoutModeEvent = (event: Event): void => {
    const detail = (event as CustomEvent<{ preference?: LayoutModePreference }>).detail;
    refreshMode(detail?.preference);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== 'typebridge.host.layoutMode.v1') return;
    refreshMode();
  };
  const onCapabilityChange = (): void => { refreshMode(); };
  const mediaQueries = typeof matchMedia === 'function'
    ? [
      matchMedia('(max-width: 640px)'),
      matchMedia('(any-pointer: fine)'),
      matchMedia('(hover: hover)'),
    ]
    : [];

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', onPersistDocumentIds);
  window.addEventListener('message', onActiveDraftMessage);
  window.addEventListener('typebridge-layout-mode', onLayoutModeEvent as EventListener);
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onHostHidden);
  for (const mq of mediaQueries) mq.addEventListener('change', onCapabilityChange);
  // Update notice / toolbar reflow change host-root without a window resize.
  const rootObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { onResize(); })
    : undefined;
  rootObserver?.observe(deps.root);

  boot();
  refreshMode();
  if (pendingFocusId && layouts.some(win => win.id === pendingFocusId)) {
    api.setHostFocusMode(true, pendingFocusId);
  }
  return api;
}
