/**
 * Settings: one non-modal side panel for the transliteration shortcut and rules,
 * autosave and Tab indents (#123). Non-modal, so a rule can be tried in the editor
 * while the panel stays open. Escape or the close button closes it and returns focus.
 * #175 step 7: on the host page this is the only Settings panel; embedded editors
 * open the parent host panel instead.
 */
import { registerEscapeLayer } from './escape-layers';

let panel: HTMLElement;
let openButton: HTMLButtonElement;
let closeButton: HTMLButtonElement;
let returnFocus: HTMLElement | null = null;
let embedded = false;

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

/** Ensure the local Settings panel is open (no-op when embedded). */
export function ensureSettingsOpen(restore?: HTMLElement | null): void {
  if (embedded || !panel) return;
  if (panel.hidden) open();
  if (restore) returnFocus = restore;
}

/** Open Settings, focus `target`, and restore `restore` when the panel closes. */
export function openSettingsTo(target: HTMLElement, restore: HTMLElement): void {
  if (panel.hidden) open();
  returnFocus = restore;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

/** Open host Settings from an embedded editor (focus a control by id when provided). */
export function openHostSettings(focusId?: string, restore?: HTMLElement | null): boolean {
  if (window.parent === window) return false;
  try {
    const host = window.parent as Window & {
      __typebridgeOpenSettings?: (opts?: { focus?: string; returnFocus?: HTMLElement | null }) => void;
    };
    if (!host.__typebridgeOpenSettings) return false;
    host.__typebridgeOpenSettings({
      focus: focusId,
      returnFocus: restore ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    });
    return true;
  } catch {
    return false;
  }
}

export function setupSettings(options?: { embedded?: boolean }): void {
  embedded = !!options?.embedded;
  panel = document.querySelector<HTMLElement>('#settings-panel')!;
  openButton = document.querySelector<HTMLButtonElement>('#settings-open')!;
  closeButton = document.querySelector<HTMLButtonElement>('#settings-close')!;

  if (embedded) {
    openButton.addEventListener('click', event => {
      event.preventDefault();
      openHostSettings(undefined, openButton);
    });
    const aboutButton = document.querySelector<HTMLButtonElement>('#about-documents-open');
    aboutButton?.addEventListener('click', event => {
      event.preventDefault();
      openHostSettings('settings-about-title', aboutButton);
    });
    return;
  }

  openButton.addEventListener('click', () => { if (panel.hidden) open(); else close(); });
  closeButton.addEventListener('click', close);
  const aboutButton = document.querySelector<HTMLButtonElement>('#about-documents-open');
  const aboutTitle = document.querySelector<HTMLElement>('#settings-about-title');
  if (aboutButton && aboutTitle) {
    aboutButton.addEventListener('click', () => {
      openSettingsTo(aboutTitle, aboutButton);
      aboutTitle.scrollIntoView({ block: 'start' });
    });
  }
  registerEscapeLayer(panel, 30, close);
}
