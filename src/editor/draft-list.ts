/** Label helpers for the Documents picker (pure; no DOM). */

export function draftOptionLabel(params: {
  savedTitle: string;
  /** On-screen title for the open draft (trimmed, or Untitled). */
  displayTitle: string;
  isCurrent: boolean;
  unsaved: boolean;
}): string {
  const title = params.isCurrent ? params.displayTitle : params.savedTitle;
  if (!params.isCurrent) return title;
  return params.unsaved ? `${title} (current, unsaved)` : `${title} (current)`;
}

/** Short single-line preview of document body for the picker (#175 step 8). */
export function draftTextPreview(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Compact relative time for the picker; empty when unknown. */
export function draftEditedLabel(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const delta = Math.max(0, now - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'Just now';
  if (delta < hour) {
    const n = Math.floor(delta / minute);
    return n === 1 ? '1 min ago' : `${n} min ago`;
  }
  if (delta < day) {
    const n = Math.floor(delta / hour);
    return n === 1 ? '1 hour ago' : `${n} hours ago`;
  }
  if (delta < 7 * day) {
    const n = Math.floor(delta / day);
    return n === 1 ? '1 day ago' : `${n} days ago`;
  }
  try {
    return new Date(updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** Full Documents list row label (#175 step 8). */
export function draftPickerLabel(params: {
  savedTitle: string;
  displayTitle: string;
  isCurrent: boolean;
  unsaved: boolean;
  text: string;
  updatedAt: number;
  openElsewhere: boolean;
  now?: number;
}): string {
  const base = draftOptionLabel(params);
  const parts = [base];
  if (params.openElsewhere) parts.push('open in another window');
  const preview = draftTextPreview(params.text);
  if (preview) parts.push(preview);
  const when = draftEditedLabel(params.updatedAt, params.now);
  if (when) parts.push(when);
  return parts.join(' · ');
}

/** Case-insensitive match against title + body preview. */
export function draftMatchesQuery(params: {
  title: string;
  text: string;
  query: string;
}): boolean {
  const q = params.query.trim().toLowerCase();
  if (!q) return true;
  return params.title.toLowerCase().includes(q)
    || params.text.toLowerCase().includes(q);
}
