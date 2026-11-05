/**
 * #175 step 6: Settings → Layout (Auto / Free windows / Stacked).
 * Preference is shared via localStorage; the host page applies it.
 */
import {
  HOST_LAYOUT_MODE_KEY,
  layoutModePreference,
  readLayoutModePreference,
  writeLayoutModePreference,
  type LayoutModePreference,
} from '../host/layout-mode';

export function setupWindowLayoutSetting(
  preferenceSaved: (name: string, saved: boolean) => void,
): { reset: () => boolean } {
  const select = document.querySelector<HTMLSelectElement>('#window-layout');
  if (!select) {
    return { reset: () => true };
  }
  const control = select;

  function apply(choice: LayoutModePreference): void {
    control.value = choice;
  }

  function save(choice: LayoutModePreference): boolean {
    apply(choice);
    const saved = writeLayoutModePreference(choice);
    preferenceSaved('window layout', saved);
    // Notify same-tab host listeners (storage events do not fire in the writing document).
    try {
      window.dispatchEvent(new CustomEvent('typebridge-layout-mode', { detail: { preference: choice } }));
      if (window.parent !== window) {
        window.parent.dispatchEvent(new CustomEvent('typebridge-layout-mode', { detail: { preference: choice } }));
      }
    } catch { /* Cross-origin parent is out of scope. */ }
    return saved;
  }

  apply(readLayoutModePreference());
  control.addEventListener('change', () => save(layoutModePreference(control.value)));

  window.addEventListener('storage', event => {
    if (event.key !== HOST_LAYOUT_MODE_KEY && event.key !== null) return;
    apply(readLayoutModePreference());
  });

  return {
    reset: () => save('auto'),
  };
}
