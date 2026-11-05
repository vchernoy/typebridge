/**
 * Same-tab live mirror for #159 S3. Copies text without BroadcastChannel or URLs.
 * Preserves the target's selection and scroll so the companion stays independently viewable.
 */

import { snapToCodePointBoundary } from '../editor/goto-line';

export function mirrorTextarea(source: HTMLTextAreaElement, target: HTMLTextAreaElement): void {
  if (target.value === source.value) return;
  const { selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft } = target;
  target.value = source.value;
  const length = target.value.length;
  const start = snapToCodePointBoundary(target.value, Math.min(selectionStart, length));
  const end = snapToCodePointBoundary(target.value, Math.min(selectionEnd, length));
  try { target.setSelectionRange(start, Math.max(start, end), selectionDirection); }
  catch { /* Selection restore is best-effort on odd platforms. */ }
  target.scrollTop = scrollTop;
  target.scrollLeft = scrollLeft;
}
