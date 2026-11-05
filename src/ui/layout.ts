import { SHORTCUTS } from '../editor/keyboard-shortcuts';
/**
 * Editor layout: resize control with separately saved Normal and Focus sizes, and Focus mode
 * with its Escape and Cmd/Ctrl+Shift+Enter keys (#67, #83).
 */
export function setupLayout(
  field: HTMLTextAreaElement,
  options?: {
    getFocusTarget?: () => HTMLTextAreaElement;
    /** Surfaces where Escape enters Focus from Normal mode (defaults to the primary field). */
    focusToggleSurfaces?: () => Iterable<HTMLTextAreaElement>;
    /** #175 step 6: host maximizes the active window when Focus mode toggles in an embed. */
    onFocusModeChange?: (enabled: boolean) => void;
  },
): { setFocusMode: (enabled: boolean) => void; restoreFocusMode: () => void; resetLayout: () => boolean } {
  const FOCUS_KEY = 'typebridge.focusMode.v1';
  const EDITOR_SIZE_KEY = 'typebridge.editor.size.v1';
  const editorSizeWarning = document.createElement('span');
  editorSizeWarning.setAttribute('aria-live', 'polite');
  field.after(editorSizeWarning);
  // Normal and Focus mode each keep their own saved size (#120).
  const FOCUS_SIZE_KEY = 'typebridge.editor.focusSize.v1';
  type EditorSize = { width: string; height: string };
  function readSize(key: string): EditorSize {
    const result = { width: '', height: '' };
    try {
      const size: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (size && typeof size === 'object') {
        const value = size as { width?: unknown; height?: unknown };
        if (typeof value.width === 'string' && /^\d+(?:\.\d+)?px$/.test(value.width)) result.width = value.width;
        if (typeof value.height === 'string' && /^\d+(?:\.\d+)?px$/.test(value.height)) result.height = value.height;
      }
    } catch { /* Storage or malformed settings must not prevent editing. */ }
    return result;
  }
  const initialSize = readSize(EDITOR_SIZE_KEY);
  if (initialSize.width) field.style.width = initialSize.width;
  if (initialSize.height) field.style.height = initialSize.height;
  const savedSizes: Record<string, string> = {
    [EDITOR_SIZE_KEY]: JSON.stringify({ width: field.style.width, height: field.style.height }),
    [FOCUS_SIZE_KEY]: JSON.stringify(readSize(FOCUS_SIZE_KEY)),
  };
  function persistEditorSize(): void {
    if (!field.style.width && !field.style.height) return;
    const key = document.body.classList.contains('focus-mode') ? FOCUS_SIZE_KEY : EDITOR_SIZE_KEY;
    const next = JSON.stringify({ width: field.style.width, height: field.style.height });
    if (next === savedSizes[key]) return;
    try { localStorage.setItem(key, next); savedSizes[key] = next; editorSizeWarning.textContent = ''; }
    catch { editorSizeWarning.textContent = 'Editor size could not be saved in this browser.'; }
  }
  // The resize control is a grip drawn on the editor's bottom-right corner: iOS Safari
  // ignores CSS resize, so a native grip never appears there (#70). It is a real button,
  // so keyboard users can Tab to it and resize with the arrow keys.
  const resizeEditor = document.querySelector<HTMLButtonElement>('#resize-editor')!;
  const MIN_WIDTH = 160;
  const MIN_HEIGHT = 96;
  // Keep the grip on the editor's corner as the editor changes size or moves.
  function alignResizeControls(): void {
    const parent = resizeEditor.parentElement;
    if (!parent || resizeEditor.offsetParent !== parent) return;
    const fieldBox = field.getBoundingClientRect();
    const parentBox = parent.getBoundingClientRect();
    // The grip's box reaches past the corner (mostly downward) so inside the editor
    // it covers only the bottom padding, not text.
    const gripStyle = getComputedStyle(resizeEditor);
    const outsetX = parseFloat(gripStyle.getPropertyValue('--grip-outset-x')) || 0;
    const outsetY = parseFloat(gripStyle.getPropertyValue('--grip-outset-y')) || 0;
    resizeEditor.style.left = fieldBox.right - parentBox.left - parent.clientLeft + outsetX - resizeEditor.offsetWidth + 'px';
    resizeEditor.style.top = fieldBox.bottom - parentBox.top - parent.clientTop + outsetY - resizeEditor.offsetHeight + 'px';
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(alignResizeControls);
    observer.observe(field);
    if (resizeEditor.parentElement) observer.observe(resizeEditor.parentElement);
  }
  window.addEventListener('resize', alignResizeControls);
  alignResizeControls();
  // Focus mode caps its default width at 900 px; a resize there may use the full
  // width like Normal mode. The cap returns when Focus mode is entered or left.
  function liftFocusWidthCap(): void {
    if (!document.body.classList.contains('focus-mode')) return;
    // Pin the current width first, so a height-only change (ArrowUp/ArrowDown) does
    // not let the editor jump to the full container width.
    if (!field.style.width) field.style.width = field.getBoundingClientRect().width + 'px';
    field.style.maxWidth = '100%';
  }
  let resizeDrag: { pointer: number; x: number; y: number; width: number; height: number; widthFactor: number; initial: { width: string; height: string; maxWidth: string } } | undefined;
  function cancelResize(): void {
    const drag = resizeDrag;
    if (!drag) return;
    resizeDrag = undefined;
    Object.assign(field.style, drag.initial);
    if (resizeEditor.hasPointerCapture(drag.pointer)) resizeEditor.releasePointerCapture(drag.pointer);
    alignResizeControls();
  }
  function enableDragResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || resizeDrag) return;
      const rect = field.getBoundingClientRect();
      // Focus mode centers the editor, so its right edge moves half as far as its width
      // changes; doubling the width change keeps the corner under the pointer (#70).
      const widthFactor = document.body.classList.contains('focus-mode') ? 2 : 1;
      resizeDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, widthFactor, initial: { width: field.style.width, height: field.style.height, maxWidth: field.style.maxWidth } };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!resizeDrag || resizeDrag.pointer !== event.pointerId) return;
      liftFocusWidthCap();
      field.style.width = Math.max(MIN_WIDTH, resizeDrag.width + (event.clientX - resizeDrag.x) * resizeDrag.widthFactor) + 'px';
      field.style.height = Math.max(MIN_HEIGHT, resizeDrag.height + event.clientY - resizeDrag.y) + 'px';
    });
    handle.addEventListener('pointerup', event => {
      if (resizeDrag?.pointer !== event.pointerId) return;
      resizeDrag = undefined;
      persistEditorSize();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, event => {
        if (resizeDrag?.pointer === (event as PointerEvent).pointerId) cancelResize();
      });
    }
  }
  enableDragResize(resizeEditor);
  resizeEditor.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const rect = field.getBoundingClientRect();
    liftFocusWidthCap();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') field.style.width = Math.max(MIN_WIDTH, rect.width + (event.key === 'ArrowRight' ? 20 : -20)) + 'px';
    else field.style.height = Math.max(MIN_HEIGHT, rect.height + (event.key === 'ArrowDown' ? 20 : -20)) + 'px';
    event.preventDefault();
    persistEditorSize();
  });
  const focusButton = document.querySelector<HTMLButtonElement>('#focus-mode')!;
  const exitFocusButton = document.querySelector<HTMLButtonElement>('#exit-focus')!;
  let normalEditorSize = { width: '', height: '' };
  function applyFocusMode(enabled: boolean): void {
    cancelResize();
    if (enabled && !document.body.classList.contains('focus-mode')) {
      normalEditorSize = { width: field.style.width, height: field.style.height };
      field.style.width = ''; field.style.height = ''; field.style.maxWidth = '';
      // Apply Focus mode's own saved size, if any (#120). Read it fresh: another tab may
      // have changed it. A saved width may exceed Focus mode's 900 px default.
      const focusSize = readSize(FOCUS_SIZE_KEY);
      if (focusSize.width) { field.style.width = focusSize.width; field.style.maxWidth = '100%'; }
      if (focusSize.height) field.style.height = focusSize.height;
      savedSizes[FOCUS_SIZE_KEY] = JSON.stringify({ width: field.style.width, height: field.style.height });
    } else if (!enabled && document.body.classList.contains('focus-mode')) {
      field.style.width = normalEditorSize.width; field.style.height = normalEditorSize.height; field.style.maxWidth = '';
    }
    document.body.classList.toggle('focus-mode', enabled);
    focusButton.setAttribute('aria-pressed', String(enabled));
    exitFocusButton.hidden = !enabled;
    options?.onFocusModeChange?.(enabled);
    // Prefer the active pane surface so Focus entry/exit does not silently retarget commands.
    (options?.getFocusTarget?.() ?? field).focus({ preventScroll: true });
  }
  function setFocusMode(enabled: boolean): void {
    applyFocusMode(enabled);
    try { localStorage.setItem(FOCUS_KEY, enabled ? 'on' : 'off'); }
    catch { /* Optional layout preference; editing remains available. */ }
  }
  function restoreFocusMode(): void {
    // Called after the draft is loaded and the textarea is enabled. Do not write
    // the preference or Normal-mode size while restoring it.
    try { if (localStorage.getItem(FOCUS_KEY) === 'on') applyFocusMode(true); }
    catch { /* Start in Normal mode when storage is unavailable. */ }
  }
  focusButton.addEventListener('click', () => setFocusMode(!document.body.classList.contains('focus-mode')));
  exitFocusButton.addEventListener('click', () => setFocusMode(false));
  document.addEventListener('keydown', event => {
    if (event.key === SHORTCUTS.escape.key && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented
      && !(event.target instanceof HTMLSelectElement && event.target.size <= 1)) {
      // Escape toggles Focus mode from either editor surface or with nothing focused (body),
      // and always exits it; it keeps its cancel role in Find/Replace, selects
      // and other controls (#67).
      const inFocusMode = document.body.classList.contains('focus-mode');
      const surfaces = options?.focusToggleSurfaces?.() ?? [field];
      const onEditor = [...surfaces].some(surface => event.target === surface);
      if (inFocusMode || onEditor || event.target === document.body) {
        event.preventDefault();
        setFocusMode(!inFocusMode);
      }
    }
    // Cmd/Ctrl+Shift+Enter toggles Focus mode; Cmd/Ctrl+Shift+E opened Firefox's Network panel.
    // Skip while an in-page confirmation owns the keyboard (#137 / Firefox).
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === SHORTCUTS.focus.key && !event.repeat && !event.isComposing
      && !document.querySelector('.confirm-backdrop')) {
      event.preventDefault();
      setFocusMode(!document.body.classList.contains('focus-mode'));
    }
  });
  function resetLayout(): boolean {
    cancelResize();
    applyFocusMode(false);
    field.style.width = ''; field.style.height = ''; field.style.maxWidth = '';
    normalEditorSize = { width: '', height: '' };
    savedSizes[EDITOR_SIZE_KEY] = savedSizes[FOCUS_SIZE_KEY] = JSON.stringify(normalEditorSize);
    let saved = true;
    for (const key of [EDITOR_SIZE_KEY, FOCUS_SIZE_KEY, FOCUS_KEY]) {
      try { localStorage.removeItem(key); } catch { saved = false; }
    }
    editorSizeWarning.textContent = saved ? '' : 'Editor layout defaults could not be saved in this browser.';
    return saved;
  }
  return { setFocusMode, restoreFocusMode, resetLayout };
}
