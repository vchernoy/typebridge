export type ConfirmChoiceOptions = {
  title: string;
  message: string;
  /** Label for the affirmative action (e.g. Delete saved copy). */
  confirmLabel: string;
  /** Label for the safe/cancel action (e.g. Keep saved copy). Escape chooses this. */
  cancelLabel: string;
  /**
   * Element that should receive focus after the dialog closes. Prefer this when the
   * opener may be disabled for the modal duration — capture it before disabling.
   * Focus is restored on a following microtask so the caller can re-enable first.
   */
  returnFocus?: HTMLElement;
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
export function askConfirmChoice(options: ConfirmChoiceOptions): Promise<boolean> {
  return new Promise(resolve => {
    const previouslyFocused = options.returnFocus
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-message');

    const title = document.createElement('h2');
    title.id = 'confirm-dialog-title';
    title.textContent = options.title;

    const message = document.createElement('p');
    message.id = 'confirm-dialog-message';
    message.textContent = options.message;

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = options.cancelLabel;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = options.confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(title, message, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const focusables = (): HTMLElement[] => [cancel, confirm];

    const close = (accepted: boolean): void => {
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
      // Resolve first so the caller's await/finally can re-enable a temporarily
      // disabled opener; then restore focus on the next microtask (#114 review).
      resolve(accepted);
      queueMicrotask(() => {
        if (previouslyFocused && canReceiveFocus(previouslyFocused)) {
          previouslyFocused.focus({ preventScroll: true });
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
    // Prefer the safer choice so Enter does not delete by default.
    cancel.focus();
  });
}
