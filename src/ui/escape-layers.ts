import { SHORTCUTS } from '../editor/keyboard-shortcuts';
type EscapeLayer = { element: HTMLElement; priority: number; close: () => void; visible?: () => boolean };
const layers: EscapeLayer[] = [];
let installed = false;

/**
 * Install the Escape coordinator before the Focus shortcut listener so a visible
 * Settings/menu/Find layer closes first when focus is in the editor (#132 / Codex P1).
 * Modal dialogs still win in the capture phase (#122).
 */
export function installEscapeLayers(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onEscape);
}

export function registerEscapeLayer(element: HTMLElement, priority: number, close: () => void, visible?: () => boolean): void {
  installEscapeLayers();
  layers.push({ element, priority, close, visible });
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== SHORTCUTS.escape.key || event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
  // Collapsed native selects own Escape for their popup; multi-row listboxes do not.
  if (event.target instanceof HTMLSelectElement && event.target.size <= 1) return;
  const layer = layers.filter(item => !item.element.hidden && item.element.getClientRects().length > 0 && (item.visible?.() ?? true))
    .sort((a, b) => b.priority - a.priority)[0];
  if (!layer) return;
  event.preventDefault();
  layer.close();
}
