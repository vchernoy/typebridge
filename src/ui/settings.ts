/**
 * Settings: one non-modal side panel for the transliteration shortcut and rules,
 * autosave and Tab indents (#123). Non-modal, so a rule can be tried in the editor
 * while the panel stays open. Escape or the close button closes it and returns focus.
 */
import { registerEscapeLayer } from './escape-layers';

let panel: HTMLElement;
let openButton: HTMLButtonElement;
let closeButton: HTMLButtonElement;
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

/** Open Settings, focus `target`, and restore `restore` when the panel closes. */
export function openSettingsTo(target: HTMLElement, restore: HTMLElement): void {
  if (panel.hidden) open();
  returnFocus = restore;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

export function setupSettings(): void {
  panel = document.querySelector<HTMLElement>('#settings-panel')!;
  openButton = document.querySelector<HTMLButtonElement>('#settings-open')!;
  closeButton = document.querySelector<HTMLButtonElement>('#settings-close')!;
  openButton.addEventListener('click', () => { if (panel.hidden) open(); else close(); });
  closeButton.addEventListener('click', close);
  const aboutButton = document.querySelector<HTMLButtonElement>('#about-documents-open')!;
  const aboutTitle = document.querySelector<HTMLElement>('#settings-about-title')!;
  aboutButton.addEventListener('click', () => {
    openSettingsTo(aboutTitle, aboutButton);
    aboutTitle.scrollIntoView({ block: 'start' });
  });
  registerEscapeLayer(panel, 30, close);
}
