/**
 * Editor layout: resize control with saved Normal-mode size, and Focus mode
 * with its Escape and Cmd/Ctrl+Shift+Enter keys (#67, #83).
 */
export function setupLayout(field: HTMLTextAreaElement): { setFocusMode: (enabled: boolean) => void; restoreFocusMode: () => void } {
  const FOCUS_KEY = 'typebridge.focusMode.v1';
  const EDITOR_SIZE_KEY = 'typebridge.editor.size.v1';
  const editorSizeWarning = document.createElement('span');
  editorSizeWarning.setAttribute('aria-live', 'polite');
  field.after(editorSizeWarning);
  try {
    const size: unknown = JSON.parse(localStorage.getItem(EDITOR_SIZE_KEY) ?? 'null');
    if (size && typeof size === 'object') {
      const value = size as { width?: unknown; height?: unknown };
      if (typeof value.width === 'string' && /^\d+(?:\.\d+)?px$/.test(value.width)) field.style.width = value.width;
      if (typeof value.height === 'string' && /^\d+(?:\.\d+)?px$/.test(value.height)) field.style.height = value.height;
    }
  } catch { /* Storage or malformed settings must not prevent editing. */ }
  let savedEditorSize = JSON.stringify({ width: field.style.width, height: field.style.height });
  function persistEditorSize(): void {
    if (document.body.classList.contains('focus-mode') || (!field.style.width && !field.style.height)) return;
    const next = JSON.stringify({ width: field.style.width, height: field.style.height });
    if (next === savedEditorSize) return;
    try { localStorage.setItem(EDITOR_SIZE_KEY, next); savedEditorSize = next; editorSizeWarning.textContent = ''; }
    catch { editorSizeWarning.textContent = 'Editor size could not be saved in this browser.'; }
  }
  window.addEventListener('pointerup', persistEditorSize);
  const resizeEditor = document.querySelector<HTMLButtonElement>('#resize-editor')!;
  // A drawn corner grip: iOS Safari ignores CSS resize, so the native grip never
  // appears there (#70). It is a pointer shortcut only; keyboard users use the button.
  const resizeGrip = document.querySelector<HTMLElement>('#resize-grip');
  const MIN_WIDTH = 160;
  const MIN_HEIGHT = 96;
  // Keep the button under the editor's right edge, so it follows the corner when
  // the width changes, not only the height (#70). The button stays right-aligned
  // in its container; the right margin covers the gap to the editor's edge.
  function alignResizeControls(): void {
    const parent = resizeEditor.parentElement;
    if (!parent) return;
    const style = getComputedStyle(parent);
    const fieldBox = field.getBoundingClientRect();
    const parentBox = parent.getBoundingClientRect();
    const contentRight = parentBox.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const gap = Math.max(0, contentRight - fieldBox.right);
    resizeEditor.style.marginRight = gap ? gap + 'px' : '';
    if (resizeGrip && resizeGrip.offsetParent === parent) {
      // The grip's box reaches past the corner (mostly downward) so inside the editor
      // it covers only the bottom padding, not text.
      const gripStyle = getComputedStyle(resizeGrip);
      const outsetX = parseFloat(gripStyle.getPropertyValue('--grip-outset-x')) || 0;
      const outsetY = parseFloat(gripStyle.getPropertyValue('--grip-outset-y')) || 0;
      resizeGrip.style.left = fieldBox.right - parentBox.left - parent.clientLeft + outsetX - resizeGrip.offsetWidth + 'px';
      resizeGrip.style.top = fieldBox.bottom - parentBox.top - parent.clientTop + outsetY - resizeGrip.offsetHeight + 'px';
    }
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
    if (document.body.classList.contains('focus-mode')) field.style.maxWidth = '100%';
  }
  let resizeDrag: { pointer: number; x: number; y: number; width: number; height: number; widthFactor: number } | undefined;
  function enableDragResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = field.getBoundingClientRect();
      // Focus mode centers the editor, so its right edge moves half as far as its width
      // changes; doubling the width change keeps the corner under the pointer (#70).
      const widthFactor = document.body.classList.contains('focus-mode') ? 2 : 1;
      resizeDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, widthFactor };
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
      if (resizeDrag?.pointer === event.pointerId) resizeDrag = undefined;
    });
    handle.addEventListener('pointercancel', () => { resizeDrag = undefined; });
  }
  enableDragResize(resizeEditor);
  if (resizeGrip) enableDragResize(resizeGrip);
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
    if (enabled && !document.body.classList.contains('focus-mode')) {
      normalEditorSize = { width: field.style.width, height: field.style.height };
      field.style.width = ''; field.style.height = ''; field.style.maxWidth = '';
    } else if (!enabled && document.body.classList.contains('focus-mode')) {
      field.style.width = normalEditorSize.width; field.style.height = normalEditorSize.height; field.style.maxWidth = '';
    }
    document.body.classList.toggle('focus-mode', enabled);
    focusButton.setAttribute('aria-pressed', String(enabled));
    exitFocusButton.hidden = !enabled;
    field.focus({ preventScroll: true });
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
    if (event.key === 'Escape' && !event.repeat && !event.isComposing && !event.defaultPrevented) {
      // Escape toggles Focus mode from the editor or with nothing focused (body),
      // and always exits it; it keeps its cancel role in Find/Replace, selects
      // and other controls (#67).
      const inFocusMode = document.body.classList.contains('focus-mode');
      if (inFocusMode || event.target === field || event.target === document.body) {
        event.preventDefault();
        setFocusMode(!inFocusMode);
      }
    }
    // Cmd/Ctrl+Shift+Enter toggles Focus mode; Cmd/Ctrl+Shift+E opened Firefox's Network panel.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter' && !event.repeat && !event.isComposing) {
      event.preventDefault();
      setFocusMode(!document.body.classList.contains('focus-mode'));
    }
  });
  return { setFocusMode, restoreFocusMode };
}
