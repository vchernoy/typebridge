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
  // Keep the button under the editor's right edge, so it follows the corner when
  // the width changes, not only the height (#70). The button stays right-aligned
  // in its container; the right margin covers the gap to the editor's edge.
  function alignResizeButton(): void {
    const parent = resizeEditor.parentElement;
    if (!parent) return;
    const style = getComputedStyle(parent);
    const contentRight = parent.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const gap = Math.max(0, contentRight - field.getBoundingClientRect().right);
    resizeEditor.style.marginRight = gap ? gap + 'px' : '';
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(alignResizeButton);
    observer.observe(field);
    if (resizeEditor.parentElement) observer.observe(resizeEditor.parentElement);
  }
  window.addEventListener('resize', alignResizeButton);
  alignResizeButton();
  let resizeDrag: { pointer: number; x: number; y: number; width: number; height: number } | undefined;
  resizeEditor.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = field.getBoundingClientRect();
    resizeDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    resizeEditor.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  resizeEditor.addEventListener('pointermove', event => {
    if (!resizeDrag || resizeDrag.pointer !== event.pointerId) return;
    field.style.width = Math.max(280, resizeDrag.width + event.clientX - resizeDrag.x) + 'px';
    field.style.height = Math.max(160, resizeDrag.height + event.clientY - resizeDrag.y) + 'px';
  });
  resizeEditor.addEventListener('pointerup', event => {
    if (resizeDrag?.pointer === event.pointerId) resizeDrag = undefined;
  });
  resizeEditor.addEventListener('pointercancel', () => { resizeDrag = undefined; });
  resizeEditor.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const rect = field.getBoundingClientRect();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') field.style.width = Math.max(280, rect.width + (event.key === 'ArrowRight' ? 20 : -20)) + 'px';
    else field.style.height = Math.max(160, rect.height + (event.key === 'ArrowDown' ? 20 : -20)) + 'px';
    event.preventDefault();
    persistEditorSize();
  });
  const focusButton = document.querySelector<HTMLButtonElement>('#focus-mode')!;
  const exitFocusButton = document.querySelector<HTMLButtonElement>('#exit-focus')!;
  let normalEditorSize = { width: '', height: '' };
  function applyFocusMode(enabled: boolean): void {
    if (enabled && !document.body.classList.contains('focus-mode')) {
      normalEditorSize = { width: field.style.width, height: field.style.height };
      field.style.width = ''; field.style.height = '';
    } else if (!enabled && document.body.classList.contains('focus-mode')) {
      field.style.width = normalEditorSize.width; field.style.height = normalEditorSize.height;
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
