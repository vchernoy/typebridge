export type ConfirmChoiceOptions = {
  title: string;
  /** Plain text, or structured content (e.g. a shortcuts `<dl>`). */
  message: string | Node;
  /** Label for the affirmative action (e.g. Delete saved copy). Omit for an information-only dialog with Cancel alone. */
  confirmLabel?: string;
  /** Label for the safe/cancel action (e.g. Keep saved copy). Escape chooses this. */
  cancelLabel: string;
  /**
   * Element that should receive focus after the dialog closes. Prefer this when the
   * opener may be disabled for the modal duration — capture it before disabling.
   * Focus is restored on a following microtask so the caller can re-enable first.
   */
  returnFocus?: HTMLElement | ((accepted: boolean) => HTMLElement);
};

function canReceiveFocus(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    return !element.disabled;
  }
  return true;
}

/**
 * Accessible in-page confirm: focus trap, Escape = cancel, focus returns to the
 * opener (or the element focused when the dialog opened). Resolves true for
 * confirm, false for cancel.
 */
let confirmationQueue: Promise<unknown> = Promise.resolve();

export function askConfirmChoice(options: ConfirmChoiceOptions): Promise<boolean> {
  // Async file reads and saves may finish while another choice is open. Capture
  // inert state only when this request actually owns the modal interaction.
  const choice = confirmationQueue.then(() => showConfirmChoice(options));
  confirmationQueue = choice.then(() => undefined, () => undefined);
  return choice;
}

function showConfirmChoice(options: ConfirmChoiceOptions): Promise<boolean> {
  return new Promise(resolve => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.setAttribute('role', 'presentation');
    // Modal interactions must not close underlying menus or invoke page shortcuts.
    backdrop.addEventListener('pointerdown', event => event.stopPropagation());
    backdrop.addEventListener('keydown', event => event.stopPropagation());

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-message');

    const title = document.createElement('h2');
    title.id = 'confirm-dialog-title';
    title.textContent = options.title;

    const message = document.createElement('div');
    message.id = 'confirm-dialog-message';
    message.className = 'confirm-dialog-message';
    if (typeof options.message === 'string') message.textContent = options.message;
    else message.append(options.message);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = options.cancelLabel;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = options.confirmLabel ?? '';

    if (options.confirmLabel === undefined) actions.append(cancel);
    else actions.append(cancel, confirm);
    dialog.append(title, message, actions);
    backdrop.append(dialog);
    // Native confirm blocked the whole page. Preserve that interaction boundary
    // for pointer, keyboard and assistive technology while the async choice is open.
    const background = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement);
    const inertStates = background.map(element => ({ element, inert: element.inert }));
    for (const { element } of inertStates) element.inert = true;
    document.body.append(backdrop);

    // Long sheets (e.g. Keyboard shortcuts) make the message scrollable; include
    // it in the tab order only then so short confirms keep Cancel↔Confirm wrap.
    // Controls inside structured content (e.g. the Share link field and checkbox) join the
    // cycle in document order, before the actions.
    const messageControls = (): HTMLElement[] => [...message.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href]',
    )].filter(element => !(element as HTMLButtonElement).disabled && !element.hidden);
    const focusables = (): HTMLElement[] =>
      [...(message.tabIndex >= 0 ? [message] : []), ...messageControls(), cancel, ...(options.confirmLabel === undefined ? [] : [confirm])];

    const close = (accepted: boolean): void => {
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
      for (const { element, inert } of inertStates) element.inert = inert;
      // Resolve first so the caller's await/finally can re-enable a temporarily
      // disabled opener; then restore focus on the next microtask (#114 review).
      resolve(accepted);
      queueMicrotask(() => {
        const target = typeof options.returnFocus === 'function' ? options.returnFocus(accepted) : options.returnFocus ?? previouslyFocused;
        if (target && canReceiveFocus(target)) {
          target.focus({ preventScroll: true });
        }
      });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      // Firefox activates the focused button on Enter even with Ctrl/Cmd+Shift
      // (Chromium does not). Swallow modified Enter so it cannot dismiss the
      // choice or fire page shortcuts such as Focus mode behind the modal.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKeyDown, true);
    // Prefer the safer choice so Enter does not delete by default. Focus Cancel
    // synchronously so Tab/Enter work before the next frame (Playwright and fast
    // typists). preventScroll keeps short-viewport sheets at the top.
    cancel.focus({ preventScroll: true });
    // Measure overflow after layout so short confirms are not treated as
    // scrollable prematurely. Do not steal focus if the user already Tabbed away.
    requestAnimationFrame(() => {
      message.tabIndex = message.scrollHeight > message.clientHeight + 1 ? 0 : -1;
      const active = document.activeElement;
      if (active === cancel || !dialog.contains(active)) {
        cancel.focus({ preventScroll: true });
      }
      dialog.scrollTop = 0;
      message.scrollTop = 0;
    });
  });
}
