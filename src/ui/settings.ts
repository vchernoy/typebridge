/**
 * Settings: one non-modal side panel for the transliteration shortcut and rules,
 * autosave and Tab indents (#123). Non-modal, so a rule can be tried in the editor
 * while the panel stays open. Escape or the close button closes it and returns focus.
 */
import { registerEscapeLayer } from './escape-layers';

export function setupSettings(): void {
  const panel = document.querySelector<HTMLElement>('#settings-panel')!;
  const openButton = document.querySelector<HTMLButtonElement>('#settings-open')!;
  const closeButton = document.querySelector<HTMLButtonElement>('#settings-close')!;
  let returnFocus: HTMLElement | null = null;
  function open(): void {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }
  function close(): void {
    panel.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
    const target = returnFocus && returnFocus.isConnected && !panel.contains(returnFocus) ? returnFocus : openButton;
    target.focus();
  }
  openButton.addEventListener('click', () => { if (panel.hidden) open(); else close(); });
  closeButton.addEventListener('click', close);
  const aboutButton = document.querySelector<HTMLButtonElement>('#about-documents-open')!;
  const aboutTitle = document.querySelector<HTMLElement>('#settings-about-title')!;
  aboutButton.addEventListener('click', () => {
    open();
    returnFocus = aboutButton;
    aboutTitle.focus();
    aboutTitle.scrollIntoView({ block: 'start' });
  });
  registerEscapeLayer(panel, 30, close);
}
