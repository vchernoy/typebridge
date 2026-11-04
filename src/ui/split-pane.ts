/**
 * Accessible split divider for #159 S3: drag, arrow keys, and Reset.
 * Layout preference (open + ratio) is optional chrome state — never stores document text.
 */

const SPLIT_LAYOUT_KEY = 'typebridge.split.v1';
const DEFAULT_RATIO = 50;
const MIN_RATIO = 20;
const MAX_RATIO = 80;

export type SplitLayout = { open: boolean; ratio: number };

export type SplitPaneControls = {
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
  setRatio: (percent: number) => void;
  reset: () => void;
  syncOrientation: () => void;
};

function readLayout(): SplitLayout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SPLIT_LAYOUT_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return { open: false, ratio: DEFAULT_RATIO };
    const value = raw as { open?: unknown; ratio?: unknown };
    const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio)
      ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(value.ratio)))
      : DEFAULT_RATIO;
    return { open: value.open === true, ratio };
  } catch {
    return { open: false, ratio: DEFAULT_RATIO };
  }
}

function writeLayout(layout: SplitLayout): void {
  try {
    localStorage.setItem(SPLIT_LAYOUT_KEY, JSON.stringify(layout));
  } catch { /* Layout preference is optional. */ }
}

export function setupSplitPane(options: {
  shell: HTMLElement;
  divider: HTMLElement;
  primaryPane: HTMLElement;
  companionPane: HTMLElement;
  resetButton?: HTMLButtonElement;
  onOpenChange?: (open: boolean) => void;
  /** When false, never restore a remembered open state (e.g. comparison viewers). */
  allowOpen?: boolean;
}): SplitPaneControls {
  const allowOpen = options.allowOpen !== false;
  let layout = readLayout();
  if (!allowOpen) layout = { ...layout, open: false };
  let ratio = layout.ratio;
  let open = allowOpen && layout.open;
  let drag: { pointer: number; startX: number; startY: number; startRatio: number; horizontal: boolean } | undefined;

  function stacked(): boolean {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function applyRatio(): void {
    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(ratio)));
    ratio = clamped;
    options.shell.style.setProperty('--split-ratio', `${clamped}%`);
    options.divider.setAttribute('aria-valuenow', String(clamped));
  }

  function syncOrientation(): void {
    const horizontal = stacked();
    options.divider.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    options.shell.dataset.splitOrientation = horizontal ? 'stacked' : 'side';
  }

  /** Viewers force the UI closed locally but must not overwrite the editor's preference. */
  function persistLayout(): void {
    if (!allowOpen) return;
    writeLayout({ open, ratio });
  }

  function setOpen(next: boolean): void {
    const resolved = allowOpen && next;
    open = resolved;
    options.shell.dataset.split = resolved ? 'on' : 'off';
    options.companionPane.hidden = !resolved;
    options.divider.hidden = !resolved;
    if (options.resetButton) options.resetButton.hidden = !resolved;
    if (resolved) {
      applyRatio();
      syncOrientation();
    }
    persistLayout();
    options.onOpenChange?.(resolved);
    window.dispatchEvent(new Event('resize'));
  }

  function setRatio(percent: number): void {
    ratio = percent;
    applyRatio();
    persistLayout();
  }

  function reset(): void {
    setRatio(DEFAULT_RATIO);
  }

  options.divider.setAttribute('role', 'separator');
  options.divider.setAttribute('aria-valuemin', String(MIN_RATIO));
  options.divider.setAttribute('aria-valuemax', String(MAX_RATIO));
  options.divider.tabIndex = 0;

  options.divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !open || drag) return;
    drag = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRatio: ratio,
      horizontal: stacked(),
    };
    options.divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  options.divider.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const box = options.shell.getBoundingClientRect();
    if (drag.horizontal) {
      const delta = ((event.clientY - drag.startY) / Math.max(1, box.height)) * 100;
      setRatio(drag.startRatio + delta);
    } else {
      const delta = ((event.clientX - drag.startX) / Math.max(1, box.width)) * 100;
      setRatio(drag.startRatio + delta);
    }
  });
  function endDrag(event: PointerEvent): void {
    if (!drag || drag.pointer !== event.pointerId) return;
    drag = undefined;
    if (options.divider.hasPointerCapture(event.pointerId)) {
      options.divider.releasePointerCapture(event.pointerId);
    }
  }
  options.divider.addEventListener('pointerup', endDrag);
  options.divider.addEventListener('pointercancel', endDrag);
  options.divider.addEventListener('lostpointercapture', endDrag);

  options.divider.addEventListener('keydown', event => {
    if (!open) return;
    const horizontal = stacked();
    const step = event.shiftKey ? 10 : 5;
    if ((!horizontal && event.key === 'ArrowLeft') || (horizontal && event.key === 'ArrowUp')) {
      setRatio(ratio - step);
      event.preventDefault();
    } else if ((!horizontal && event.key === 'ArrowRight') || (horizontal && event.key === 'ArrowDown')) {
      setRatio(ratio + step);
      event.preventDefault();
    } else if (event.key === 'Home') {
      setRatio(MIN_RATIO);
      event.preventDefault();
    } else if (event.key === 'End') {
      setRatio(MAX_RATIO);
      event.preventDefault();
    }
  });

  options.resetButton?.addEventListener('click', () => { reset(); });
  window.addEventListener('resize', syncOrientation);

  setOpen(open);
  applyRatio();
  syncOrientation();

  return {
    setOpen,
    isOpen: () => open,
    setRatio,
    reset,
    syncOrientation,
  };
}
