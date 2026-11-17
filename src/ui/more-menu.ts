/**
 * Documents → Tools (#351): Go to line, Clear text and Keyboard shortcuts. Opening focuses the
 * first item; Up/Down/Home/End move between items; Escape closes it and returns focus
 * to Tools; choosing an item or clicking outside closes it.
 */
import { registerEscapeLayer } from './escape-layers';

export function setupMoreMenu(): void {
  const button = document.querySelector<HTMLButtonElement>('#more-open')!;
  const menu = document.querySelector<HTMLElement>('#more-menu')!;
  const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  // Retain the menu positioning fallback; Documents uses an in-flow menu.
  function place(): void {
    menu.style.left = ''; menu.style.right = '';
    if (menu.getBoundingClientRect().left < 8) { menu.style.left = '0'; menu.style.right = 'auto'; }
  }
  function open(): void {
    menu.hidden = false;
    place();
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }
  function close(returnFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }
  button.addEventListener('click', () => { if (menu.hidden) open(); else close(true); });
  registerEscapeLayer(menu, 21, () => close(true));
  menu.addEventListener('keydown', event => {
    if (event.isComposing || event.defaultPrevented) return;
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number): void => { event.preventDefault(); list[(to + list.length) % list.length]?.focus(); };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Tab') close(false);
  });
  // Choosing a tool closes Documents and restores its opener; Go to line then
  // moves focus to its field, and Clear text to the editor once confirmed.
  for (const item of items()) item.addEventListener('click', () => {
    close(false);
    if (!document.querySelector<HTMLElement>('#doc-menu')!.hidden) document.querySelector<HTMLButtonElement>('#doc-menu-open')!.click();
  });
  document.querySelector('#doc-menu-open')!.addEventListener('click', () => close(false));
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node | null;
    if (!menu.hidden && target && !menu.contains(target) && !button.contains(target)) close(false);
  });
}
