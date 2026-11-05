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
  /** Document ids currently open in host windows (optionally excluding one window). */
  openDocumentIds: (exceptWindowId?: string) => string[];
  /** Live on-screen titles across windows (for distinct Untitled defaults). */
  openTitles: (exceptWindowId?: string) => string[];
  addWindow: () => string | undefined;
  closeWindow: (id: string) => Promise<boolean>;
  tileSideBySide: () => void;
  tileStacked: () => void;
  layoutMode: () => EffectiveLayoutMode;
  refreshLayoutMode: () => void;
  setHostFocusMode: (enabled: boolean, sourceWindowId?: string) => void;
  /** #175 step 11: F6 — activate the next window and focus its editor (or title). */
  cycleFocus: () => void;
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

  const syncEmbeddedFocusChrome = (enabled: boolean): void => {
    for (const [wid, frame] of frames) {
      try {
        const hooks = frame.contentWindow as (Window & {
          __typebridgeSetFocusMode?: (on: boolean) => void;
        }) | null;
        const want = enabled && wid === activeId;
        const doc = frame.contentDocument;
        const already = !!doc?.body.classList.contains('focus-mode');
        if (want === already) continue;
        // Only the focused window shows Exit focus; others stay Normal.
        hooks?.__typebridgeSetFocusMode?.(want);
      } catch { /* Unexpected cross-origin. */ }
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
        // Keep the title handle focusable in stacked mode for keyboard height resize.
        move.tabIndex = hostFocus ? -1 : 0;
        const titleInput = shell.querySelector<HTMLInputElement>('.host-window-title');
        const label = (titleInput?.value.trim() || titleInput?.title || 'Untitled document');
        move.setAttribute(
          'aria-label',
          mode === 'stacked'
            ? `Move window ${wid}: ${label} (Ctrl/⌘+Shift+Up/Down to resize height)`
            : `Move window ${wid}: ${label} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`,
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
      // Mode can change under Focus (Auto + viewport). Keep the saved pre-Focus
      // geometry reachable for the mode that will apply on exit.
      const base = preFocusLayouts ?? layouts;
      if (mode === 'stacked' && previous !== 'stacked') {
        preFocusLayouts = stackPhoneWindows(base, viewportOf(deps.root));
      } else if (mode === 'free' && previous === 'stacked') {
        preFocusLayouts = tileSideBySide(base, viewportOf(deps.root));
      }
      applyModeChrome();
      persist();
      return;
    }
    if (mode === 'stacked' && previous !== 'stacked') enterStacked();
    else if (mode === 'free' && previous === 'stacked') {
      // Scrollable stack may place windows below the free-mode viewport — tile so all remain reachable.
      layouts = tileSideBySide(layouts, viewportOf(deps.root));
      applyAllGeometry();
    }
    applyModeChrome();
    persist();
  };

  const setActive = (id: string): void => {
    activeId = id;
    if (mode === 'free' && !hostFocus) layouts = bringToFront(layouts, id);
    for (const win of layouts) applyShellGeometry(win);
    for (const [wid, shell] of shells) {
      shell.classList.toggle('is-active', wid === id);
      // Regions do not support aria-selected; mark the active shell with aria-current.
      if (wid === id) shell.setAttribute('aria-current', 'true');
      else shell.removeAttribute('aria-current');
    }
    if (hostFocus) {
      applyModeChrome();
      syncEmbeddedFocusChrome(true);
    }
    persist();
  };

  /** Focus the editor field, falling back to the host title when the iframe is mid-boot. */
  const focusWindowSurface = (id: string): void => {
    const frame = frames.get(id);
    const shell = shells.get(id);
    const title = shell?.querySelector<HTMLInputElement>('.host-window-title');
    try {
      const editor = frame?.contentDocument?.querySelector<HTMLElement>('#editor');
      if (editor && !(editor as HTMLTextAreaElement).disabled) {
        editor.focus();
        return;
      }
    } catch { /* Mid-navigation — fall through to title. */ }
    title?.focus();
  };

  /** True when a confirm modal is open on the host or any embedded window. */
  const confirmModalOpen = (): boolean => {
    if (document.querySelector('.confirm-backdrop, [aria-modal="true"]')) return true;
    for (const frame of frames.values()) {
      try {
        if (frame.contentDocument?.querySelector('.confirm-backdrop, [aria-modal="true"]')) {
          return true;
        }
      } catch { /* Mid-navigation. */ }
    }
    return false;
  };

  /** Maximize the active window to the host viewport without rewriting preFocusLayouts. */
  const maximizeActiveForFocus = (): void => {
    if (!hostFocus || !activeId) return;
    const view = viewportOf(deps.root);
    layouts = layouts.map(win => (
      win.id === activeId
        ? { ...win, x: 0, y: 0, w: view.width, h: view.height }
        : win
    ));
    applyAllGeometry();
  };

  /**
   * Cycle to the next host window (DOM/layout order). Raises z-order in free mode.
   * `fromId` is the cycle origin when focus is in a window that is not yet active
   * (host title pointerdown stops shell activation).
   */
  const cycleFocus = (fromId?: string): void => {
    if (layouts.length === 0) return;
    // Keep modal focus traps intact (discard / Edit here / private reload).
    if (confirmModalOpen()) return;
    const origin = (fromId && layouts.some(win => win.id === fromId)) ? fromId : activeId;
    const index = layouts.findIndex(win => win.id === origin);
    const next = layouts[(index < 0 ? 0 : index + 1) % layouts.length]!;
    setActive(next.id);
    // In host Focus, setActive only swaps visibility — apply full-viewport geometry
    // so the newly active window matches setHostFocusMode(true) maximize behavior.
    if (hostFocus) maximizeActiveForFocus();
    // After Focus maximize swaps the visible shell, focus on the next frame.
    window.requestAnimationFrame(() => { focusWindowSurface(next.id); });
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
    // #175 step 11: named region for AT — aria-label tracks the document title.
    shell.setAttribute('role', 'region');
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

    // #175 step 8: document title lives on the host chrome; rename write-through to the iframe.
    // Keep the title input a sibling of the move handle (not inside the button).
    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'host-window-title';
    title.value = 'Untitled document';
    title.setAttribute('aria-label', 'Document title');
    title.spellcheck = false;
    // Locked until the iframe mounts an editable #draft-title (avoids lost renames).
    title.readOnly = true;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'host-window-close';
    closeBtn.dataset.hostAction = 'close-window';
    closeBtn.setAttribute('aria-label', `Close window ${win.id}`);
    closeBtn.textContent = '×';

    titleBar.append(moveHandle, title, closeBtn);

    const frame = document.createElement('iframe');
    frame.className = 'host-editor';
    frame.dataset.windowId = win.id;
    frame.title = 'TypeBridge editor';
    frame.allow = 'clipboard-read; clipboard-write';

    const displayTitle = (raw: string): string => raw.trim() || 'Untitled document';

    const applyMoveAria = (label: string): void => {
      moveHandle.setAttribute(
        'aria-label',
        mode === 'stacked'
          ? `Move window ${win.id}: ${label} (Ctrl/⌘+Shift+Up/Down to resize height)`
          : `Move window ${win.id}: ${label} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`,
      );
    };

    /** Update chrome metadata without rewriting the input while the user is typing. */
    const applyChromeMeta = (raw: string): void => {
      const label = displayTitle(raw);
      title.title = label;
      shell.setAttribute('aria-label', label);
      frame.title = label;
      applyMoveAria(label);
      closeBtn.setAttribute('aria-label', `Close ${label}`);
    };

    const applyChromeTitle = (next: string): void => {
      const label = displayTitle(next);
      if (document.activeElement !== title && title.value !== label) title.value = label;
      applyChromeMeta(title.value);
    };

    const syncTitleEditable = (): void => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const draft = doc.querySelector<HTMLInputElement>('#draft-title');
        // Stay locked until the iframe title exists (and is editable).
        if (!draft) {
          title.readOnly = true;
          return;
        }
        title.readOnly = draft.readOnly || draft.disabled;
      } catch { /* Cross-origin or mid-navigation — keep current state. */ }
    };

    type TitleHooks = Window & {
      __typebridgeGetTitle?: () => string;
      __typebridgeSetTitle?: (value: string) => void;
      __typebridgeTitleCommit?: (
        value: string,
        start?: number,
        end?: number,
      ) => { value: string; start: number; end: number } | null;
      __typebridgeTitleEdit?: (payload: {
        inputType: string;
        data: string | null;
        start: number;
        end: number;
      }) => { value: string; start: number; end: number } | null;
      __typebridgeToggleTransliteration?: () => void;
      __typebridgeOpenFind?: () => void;
    };

    let applyingFromIframe = false;
    let hostTitleComposing = false;
    const applyHostTitleResult = (result: { value: string; start: number; end: number }): void => {
      applyingFromIframe = true;
      title.value = result.value;
      try { title.setSelectionRange(result.start, result.end); } catch { /* Input type may reject. */ }
      applyingFromIframe = false;
      applyChromeMeta(title.value);
    };

    title.addEventListener('pointerdown', event => { event.stopPropagation(); syncTitleEditable(); });
    title.addEventListener('focus', () => { syncTitleEditable(); });
    title.addEventListener('compositionstart', () => { hostTitleComposing = true; });
    title.addEventListener('compositionend', () => {
      hostTitleComposing = false;
      if (title.readOnly) return;
      try {
        const result = (frame.contentWindow as TitleHooks | null)?.__typebridgeTitleCommit?.(
          title.value,
          title.selectionStart ?? title.value.length,
          title.selectionEnd ?? title.value.length,
        );
        if (result) applyHostTitleResult(result);
        else applyChromeMeta(title.value);
      } catch { applyChromeMeta(title.value); }
    });
    title.addEventListener('keydown', event => {
      // Keep arrow-key window move on the handle; let the input own typing keys.
      // F6 must cycle windows even while renaming — handle before stopPropagation so
      // the document-level host listener is not required for the title field.
      if (event.key === 'F6' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && !event.isComposing && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        // Title clicks do not activate the shell — cycle from this window, not stale activeId.
        cycleFocus(win.id);
        return;
      }
      event.stopPropagation();
      if (event.isComposing) return;
      try {
        const hooks = frame.contentWindow as TitleHooks | null;
        // #175 step 9: Find stays available in read-only windows (Replace does not).
        // Handle Ctrl/⌘+F before the read-only guard so a read-only title still opens Find.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
          && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          hooks?.__typebridgeOpenFind?.();
          return;
        }
        if (title.readOnly) return;
        // Forward undo/redo to the iframe title Editor (host input has no native history
        // when inserts are applied programmatically).
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = event.key.toLowerCase();
          if (key === 'z' || key === 'y') {
            const redo = key === 'y' || (key === 'z' && event.shiftKey);
            event.preventDefault();
            const result = hooks?.__typebridgeTitleEdit?.({
              inputType: redo ? 'historyRedo' : 'historyUndo',
              data: null,
              start: title.selectionStart ?? 0,
              end: title.selectionEnd ?? 0,
            });
            if (result) applyHostTitleResult(result);
            return;
          }
        }
        // Forward the transliteration mode shortcut into the iframe (listener is document-local there).
        if (event.shiftKey && !event.altKey && !event.repeat
          && ((event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey))
          && (event.code === 'Space' || event.code === 'F7' || event.code === 'F8' || event.code === 'F9')) {
          hooks?.__typebridgeToggleTransliteration?.();
          event.preventDefault();
          return;
        }
      } catch { /* Frame mid-navigation. */ }
    });
    // Route insert typing through the iframe title Editor (transliteration). Let
    // deletes/clear/IME composition run natively on the host input, then write through.
    title.addEventListener('beforeinput', event => {
      syncTitleEditable();
      if (title.readOnly) {
        event.preventDefault();
        return;
      }
      if (hostTitleComposing || event.inputType.includes('Composition')) return;
      const insert = event.inputType === 'insertText'
        || event.inputType === 'insertFromPaste'
        || event.inputType === 'insertReplacementText'
        || event.inputType === 'insertFromDrop';
      if (!insert) return;
      event.preventDefault();
      try {
        const hooks = frame.contentWindow as TitleHooks | null;
        const result = hooks?.__typebridgeTitleEdit?.({
          inputType: event.inputType === 'insertReplacementText' ? 'insertText' : event.inputType,
          data: event.data,
          start: title.selectionStart ?? 0,
          end: title.selectionEnd ?? 0,
        });
        if (result) applyHostTitleResult(result);
        else {
          const authoritative = hooks?.__typebridgeGetTitle?.();
          if (authoritative !== undefined) {
            applyingFromIframe = true;
            title.value = authoritative;
            applyingFromIframe = false;
            applyChromeMeta(title.value);
          }
        }
      } catch { /* Frame mid-navigation. */ }
    });
    title.addEventListener('input', () => {
      if (applyingFromIframe || hostTitleComposing) return;
      syncTitleEditable();
      if (title.readOnly) {
        try {
          const hooks = frame.contentWindow as TitleHooks | null;
          const authoritative = hooks?.__typebridgeGetTitle?.();
          if (authoritative !== undefined) title.value = authoritative;
        } catch { /* Frame mid-navigation. */ }
        applyChromeMeta(title.value);
        return;
      }
      // Deletes, fill(), and other non-intercepted edits: commit through the title
      // Editor so undo history stays in sync (setTitle alone skips Editor deltas).
      if (title.value.length > 150) title.value = title.value.slice(0, 150);
      applyChromeMeta(title.value);
      try {
        const result = (frame.contentWindow as TitleHooks | null)?.__typebridgeTitleCommit?.(
          title.value,
          title.selectionStart ?? title.value.length,
          title.selectionEnd ?? title.value.length,
        );
        if (result) applyHostTitleResult(result);
      } catch { /* Frame mid-navigation. */ }
    });
    title.addEventListener('blur', () => {
      if (title.readOnly) {
        applyChromeMeta(title.value);
        return;
      }
      const label = displayTitle(title.value);
      if (title.value !== label) {
        title.value = label;
        try {
          (frame.contentWindow as TitleHooks | null)?.__typebridgeSetTitle?.(label);
        } catch { /* Frame mid-navigation. */ }
      }
      applyChromeMeta(label);
    });

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
    applyChromeTitle(title.value);
    const onFrameCycleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.isComposing || event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      cycleFocus();
    };

    // load + readyState=complete can both call wireFrame for the same document —
    // bind activation/F6 once per Document so F6 does not skip a window.
    let wiredDoc: Document | null = null;
    const wireFrame = (): void => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        if (wiredDoc !== doc) {
          wiredDoc = doc;
          doc.addEventListener('pointerdown', activateFromIframe);
          doc.addEventListener('focusin', activateFromIframe);
          // F6 inside the iframe does not bubble to the host — listen here too.
          doc.addEventListener('keydown', onFrameCycleKey);
        }
        // Hooks register at the end of the editor boot — retry briefly after load.
        // Keep refreshing title editability after hooks appear: draft init may still
        // hold the iframe title read-only for a few frames (ownership acquire).
        let attempts = 0;
        const syncHooks = (): void => {
          const hooks = frame.contentWindow as (Window & {
            __typebridgeSetFocusMode?: (on: boolean) => void;
            __typebridgeGetTitle?: () => string;
          }) | null;
          if (hooks?.__typebridgeGetTitle) applyChromeTitle(hooks.__typebridgeGetTitle());
          syncTitleEditable();
          if (hostFocus) hooks?.__typebridgeSetFocusMode?.(win.id === activeId);
          const hooksReady = !!hooks?.__typebridgeGetTitle && (!hostFocus || !!hooks.__typebridgeSetFocusMode);
          const titleReady = !title.readOnly;
          if ((hooksReady && titleReady) || attempts++ >= 80) return;
          window.setTimeout(syncHooks, 50);
        };
        syncHooks();
      } catch { /* Unexpected cross-origin — chrome-only activation remains. */ }
    };
    frame.addEventListener('load', wireFrame);
    frame.src = deps.editorSrc(win.id, win.documentId);
    // Cached navigations may complete before the listener is attached.
    try {
      if (frame.contentDocument?.readyState === 'complete') wireFrame();
    } catch { /* Ignore. */ }

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
      if (hostFocus) return;
      const current = layouts.find(w => w.id === win.id);
      if (!current) return;
      const view = viewportOf(deps.root);
      const step = event.shiftKey && !event.ctrlKey && !event.metaKey
        ? KEYBOARD_MOVE_STEP_PX * 4
        : KEYBOARD_MOVE_STEP_PX;
      // Ctrl/⌘+Shift+Arrow resizes (avoid Alt+Arrow, which navigates history on Windows/Linux).
      const resize = (event.ctrlKey || event.metaKey) && event.shiftKey;
      if (mode === 'stacked') {
        // Stacked: height only — keep the title handle as the keyboard resize surface.
        if (!resize || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        setActive(win.id);
        const heights = layouts.map(w => w.h);
        const index = layouts.findIndex(w => w.id === win.id);
        if (index < 0) return;
        heights[index] = Math.max(
          MIN_WINDOW_HEIGHT,
          current.h + (event.key === 'ArrowDown' ? step : -step),
        );
        layouts = stackPhoneWindows(layouts, view, heights);
        applyAllGeometry();
        persist();
        return;
      }
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
    openDocumentIds: (exceptWindowId?: string) => {
      const ids: string[] = [];
      for (const win of layouts) {
        if (exceptWindowId && win.id === exceptWindowId) continue;
        if (win.documentId) ids.push(win.documentId);
      }
      return ids;
    },
    openTitles: (exceptWindowId?: string) => {
      const titles: string[] = [];
      for (const win of layouts) {
        if (exceptWindowId && win.id === exceptWindowId) continue;
        const shell = shells.get(win.id);
        const input = shell?.querySelector<HTMLInputElement>('.host-window-title');
        const fromChrome = input?.value.trim();
        if (fromChrome) {
          titles.push(fromChrome);
          continue;
        }
        try {
          const hooks = frames.get(win.id)?.contentWindow as (Window & { __typebridgeGetTitle?: () => string }) | null;
          const fromFrame = hooks?.__typebridgeGetTitle?.()?.trim();
          if (fromFrame) titles.push(fromFrame);
        } catch { /* Mid-navigation. */ }
      }
      return titles;
    },
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
    cycleFocus: () => { cycleFocus(); },
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
        syncEmbeddedFocusChrome(true);
        persist();
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
      syncEmbeddedFocusChrome(false);
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
      document.removeEventListener('keydown', onHostCycleKey);
      for (const mq of mediaQueries) mq.removeEventListener('change', onCapabilityChange);
      rootObserver?.disconnect();
      for (const shell of shells.values()) shell.remove();
      shells.clear();
      frames.clear();
    },
  };

  /** Host-chrome F6 (iframe keydowns are handled per-frame in createShell). */
  const onHostCycleKey = (event: KeyboardEvent): void => {
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.isComposing || event.repeat || event.defaultPrevented) return;
    event.preventDefault();
    // Move/close controls activate only on pointer — Tab into them leaves activeId stale.
    const focused = document.activeElement;
    const shell = focused instanceof Element ? focused.closest('.host-window') : null;
    const fromId = shell instanceof HTMLElement ? shell.dataset.windowId : undefined;
    cycleFocus(fromId);
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
    const data = event.data as {
      type?: string;
      windowId?: string;
      documentId?: string;
      title?: string;
    } | null;
    if (!data || data.type !== 'typebridge-active-draft') return;
    if (typeof data.windowId !== 'string' || typeof data.documentId !== 'string' || !data.documentId) return;
    if (!layouts.some(win => win.id === data.windowId)) return;
    layouts = layouts.map(win => (
      win.id === data.windowId ? { ...win, documentId: data.documentId } : win
    ));
    if (preFocusLayouts) {
      preFocusLayouts = preFocusLayouts.map(win => (
        win.id === data.windowId ? { ...win, documentId: data.documentId } : win
      ));
    }
    if (typeof data.title === 'string') {
      const shell = shells.get(data.windowId);
      const titleInput = shell?.querySelector<HTMLInputElement>('.host-window-title');
      const frame = frames.get(data.windowId);
      if (titleInput && frame && shell) {
        const label = data.title.trim() || 'Untitled document';
        if (document.activeElement !== titleInput) {
          titleInput.value = label;
        }
        titleInput.title = label;
        shell.setAttribute('aria-label', label);
        frame.title = label;
        const move = shell.querySelector<HTMLElement>('.host-window-move');
        move?.setAttribute(
          'aria-label',
          mode === 'stacked'
            ? `Move window ${data.windowId}: ${label} (Ctrl/⌘+Shift+Up/Down to resize height)`
            : `Move window ${data.windowId}: ${label} (arrow keys; Ctrl/⌘+Shift+arrows to resize)`,
        );
        shell.querySelector('.host-window-close')?.setAttribute('aria-label', `Close ${label}`);
      }
    }
    // Use Focus-aware persist so maximized geometry / focusWindowId stay correct.
    persist();
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
  document.addEventListener('keydown', onHostCycleKey);
  for (const mq of mediaQueries) mq.addEventListener('change', onCapabilityChange);
  // Update notice / toolbar reflow change host-root without a window resize.
  const rootObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { onResize(); })
    : undefined;
  rootObserver?.observe(deps.root);

  boot();
  refreshMode();
  // Mark the initial active shell without bringToFront/persist — restoring a free-layout
  // session must keep the saved z-order (Codex P1: activating `main` hid a front `w2`).
  {
    const topmost = layouts.reduce<HostWindowLayout | undefined>(
      (best, win) => (!best || win.z > best.z ? win : best),
      undefined,
    );
    const bootActive = (pendingFocusId && layouts.some(win => win.id === pendingFocusId))
      ? pendingFocusId
      : (topmost?.id ?? layouts[0]?.id);
    if (bootActive) {
      activeId = bootActive;
      for (const [wid, shell] of shells) {
        shell.classList.toggle('is-active', wid === bootActive);
        if (wid === bootActive) shell.setAttribute('aria-current', 'true');
        else shell.removeAttribute('aria-current');
      }
    }
  }
  if (pendingFocusId && layouts.some(win => win.id === pendingFocusId)) {
    api.setHostFocusMode(true, pendingFocusId);
  }
  return api;
}
