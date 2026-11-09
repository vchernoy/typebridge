/**
 * Keep the host toolbar on one line (#175 follow-up): when it would wrap, drop the
 * shortcut hint first, then show icon-only buttons (their names stay for assistive tech).
 */
export const TOOLBAR_FIT_LEVELS = 2;

/** True when the visible items of `bar` sit on more than one row. */
export function toolbarWraps(bar: HTMLElement): boolean {
  const boxes = [...bar.children]
    .map(el => el.getBoundingClientRect())
    .filter(box => box.width > 0 && box.height > 0);
  if (boxes.length < 2) return false;
  // On one row every item overlaps the shortest item's vertical span.
  const firstBottom = Math.min(...boxes.map(box => box.bottom));
  return boxes.some(box => box.top >= firstBottom - 1);
}

/** Apply the smallest fit level (0 = full labels) at which the toolbar stays on one row. */
export function fitToolbar(bar: HTMLElement): number {
  let level = 0;
  bar.dataset.fit = '0';
  while (level < TOOLBAR_FIT_LEVELS && toolbarWraps(bar)) {
    level += 1;
    bar.dataset.fit = String(level);
  }
  return level;
}

/** Refit on width changes and on content changes (hidden buttons, shortcut text). */
export function installToolbarFit(bar: HTMLElement): () => void {
  let lastWidth = -1;
  let frame = 0;
  const schedule = (force: boolean): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const width = bar.clientWidth;
      // Our own level change only alters the height: ignore it, so this cannot loop.
      if (!force && width === lastWidth) return;
      lastWidth = width;
      fitToolbar(bar);
    });
  };
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { schedule(false); }) : undefined;
  resize?.observe(bar);
  const onWindowResize = (): void => { schedule(false); };
  window.addEventListener('resize', onWindowResize);
  const mutations = new MutationObserver(() => { schedule(true); });
  mutations.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  schedule(true);
  // Web fonts can change widths after the first fit.
  void document.fonts?.ready.then(() => { schedule(true); });
  return () => {
    resize?.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', onWindowResize);
    if (frame) cancelAnimationFrame(frame);
  };
}
