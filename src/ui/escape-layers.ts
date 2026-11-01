type EscapeLayer = { element: HTMLElement; priority: number; close: () => void };
const layers: EscapeLayer[] = [];

/** Register before the page's Focus shortcut; modal dialogs still win in capture. */
export function registerEscapeLayer(element: HTMLElement, priority: number, close: () => void): void {
  if (!layers.length) document.addEventListener('keydown', onEscape);
  layers.push({ element, priority, close });
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
  // Collapsed native selects own Escape for their popup; multi-row listboxes do not.
  if (event.target instanceof HTMLSelectElement && event.target.size <= 1) return;
  const layer = layers.filter(item => !item.element.hidden && item.element.getClientRects().length > 0)
    .sort((a, b) => b.priority - a.priority)[0];
  if (!layer) return;
  event.preventDefault();
  layer.close();
}
