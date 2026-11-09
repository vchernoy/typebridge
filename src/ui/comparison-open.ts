/**
 * Documents → Open in another window (#159 W2): a read-only companion showing the last saved
 * copy. Text never travels in the URL, postMessage or sessionStorage; the companion reads the
 * saved row itself. Embedded host windows hide this control (the host manages windows).
 */
import { askConfirmChoice } from './confirm-dialog';
import { comparisonViewerHref } from '../view/route';

type ComparisonOpenResult =
  | { ok: true; window: Window }
  | { ok: false; reason: 'blocked' | 'cleanup' };

/**
 * Open a same-origin companion without inheriting the source tab's sessionStorage.
 * Some browsers (notably Firefox) clone sessionStorage into window.open targets when an
 * opener relationship exists, which would copy private pending text. Opening about:blank,
 * stripping TypeBridge session keys, then navigating preserves popup-blocked detection
 * (unlike noopener, which returns null even on success) without clearing the source.
 * If inherited-session cleanup throws, fail closed: close the blank window and do not
 * navigate (private keys may still be present).
 */
export function openComparisonWindow(href: string): ComparisonOpenResult {
  const opened = window.open('about:blank', '_blank');
  if (!opened) return { ok: false, reason: 'blocked' };
  try {
    const doomed: string[] = [];
    for (let i = 0; i < opened.sessionStorage.length; i++) {
      const key = opened.sessionStorage.key(i);
      if (key?.startsWith('typebridge.')) doomed.push(key);
    }
    for (const key of doomed) opened.sessionStorage.removeItem(key);
  } catch {
    try { opened.close(); } catch { /* Ignore. */ }
    return { ok: false, reason: 'cleanup' };
  }
  try { opened.opener = null; } catch { /* Optional severance. */ }
  try {
    opened.location.replace(new URL(href, window.location.href).href);
  } catch {
    try { opened.close(); } catch { /* Ignore. */ }
    return { ok: false, reason: 'blocked' };
  }
  return { ok: true, window: opened };
}

export type ComparisonOpenDeps = {
  embedded: boolean;
  /** True when this window cannot open a companion right now (viewer, loading, switching, deleting). */
  isBusy: () => boolean;
  hasStorage: () => boolean;
  /** The shown document's id and saved revision (0 = never saved). */
  activeDocument: () => { id: string; revision: number };
  isDirty: () => boolean;
  announce: (text: string, options?: { kind?: 'failure' }) => void;
};

async function explainNoComparison(message: string): Promise<void> {
  await askConfirmChoice({
    title: 'Cannot open comparison window',
    message,
    cancelLabel: 'Cancel',
    returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')!,
  });
}

export function setupComparisonOpen(deps: ComparisonOpenDeps): void {
  const openComparison = document.querySelector<HTMLButtonElement>('#open-comparison')!;
  // window.open must run inside this click, so eligibility uses the in-memory IndexedDB revision
  // rather than an async read; the companion verifies the row itself on load. Document text is
  // never part of the URL, postMessage or sessionStorage.
  if (deps.embedded) {
    openComparison.hidden = true;
    openComparison.disabled = true;
  }
  openComparison.addEventListener('click', () => {
    if (deps.embedded || deps.isBusy()) return;
    const active = deps.activeDocument();
    if (!deps.hasStorage() || active.revision < 1) {
      void explainNoComparison(!deps.hasStorage()
        ? 'Browser storage is unavailable, so there is no saved copy to open. Copy or export your text instead. Nothing was changed.'
        : 'There is no saved copy of this document to open. Save or export it first if you want a second window; your text stays in this window. Opening a comparison window never turns on Autosave or saves your text.');
      return;
    }
    const href = comparisonViewerHref(import.meta.env.BASE_URL || '/', active.id);
    if (!href) {
      void explainNoComparison('This document cannot be opened in a comparison window yet. Export it and import it as a regular document first. Your text stays in this window.');
      return;
    }
    const opened = openComparisonWindow(href);
    if (!opened.ok) {
      if (opened.reason === 'cleanup') {
        deps.announce('Could not open a private comparison window safely. Your text is still only in this window; try again or export a copy.', { kind: 'failure' });
      } else {
        deps.announce('The comparison window was blocked. Allow pop-ups for TypeBridge and try again. Your text is still here.', { kind: 'failure' });
      }
      return;
    }
    deps.announce(deps.isDirty()
      ? 'Opened the last saved version in another window. Unsaved typing was not sent.'
      : 'Opened the last saved version in another window.');
  });
}
