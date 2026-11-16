/**
 * Documents → Share link… (#39): a dialog that makes a share link for the shown title and
 * text, says plainly what sharing means, and copies the link. The link format and its limits
 * are in editor/share-link.ts; links open on the reading page (read.html).
 */
import { documentFormat, type DocumentFormat } from '../editor/document-fields';
import { type ShareView, encodeSharePayload, shareLinkLength, shareUrl } from '../editor/share-link';
import { askConfirmChoice } from './confirm-dialog';

export const SHARE_PRIVACY_TEXT = 'Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it.';
const LONG_LINK_TEXT = 'This link is long. Some messengers, mail apps and social sites cut or refuse long links; if it does not open for the reader, export the document as a file instead.';
const TOO_LARGE_TEXT = 'This document is too large to share as a link. Export it as a file instead (▾ Documents → Export).';
const PREVIEW_CHARS = 280;

export type ShareDialogDeps = {
  /** Title (or the Untitled default) and text currently shown, like Export. */
  surface: () => { title: string; text: string; format?: DocumentFormat };
  /** The site root links point to. */
  base: () => string;
  returnFocus: () => HTMLElement;
};

/** A short preview of what the reader sees first. */
export function sharePreview(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > PREVIEW_CHARS ? trimmed.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '') + '…' : trimmed;
}

export async function openShareDialog(deps: ShareDialogDeps): Promise<void> {
  const surface = deps.surface();
  const { title, text } = surface;
  const format = documentFormat(surface);
  let view: ShareView = format === 'markdown' ? 'rendered' : 'source';
  let showHeading = true;
  const make = async (edit: boolean): Promise<string | undefined> => {
    const encoded = await encodeSharePayload({ title, text, format, view, edit, ...(showHeading ? {} : { heading: false } as const) });
    return encoded.ok ? shareUrl(deps.base(), encoded.payload) : undefined;
  };
  const first = await make(true);
  const content = document.createElement('div');
  content.className = 'share-dialog';
  if (!first) {
    content.textContent = TOO_LARGE_TEXT;
    await askConfirmChoice({ title: 'Share link', message: content, cancelLabel: 'Close', closeInHeader: true, returnFocus: deps.returnFocus() });
    return;
  }

  const privacy = document.createElement('p');
  privacy.textContent = SHARE_PRIVACY_TEXT;

  const preview = document.createElement('div');
  preview.className = 'share-preview';
  preview.setAttribute('aria-label', format === 'markdown' ? 'Document source preview' : 'What the reader sees');
  const previewTitle = document.createElement('strong');
  previewTitle.textContent = title;
  const previewText = document.createElement('div');
  previewText.className = 'share-preview-text';
  previewText.textContent = sharePreview(text) || '(empty)';
  preview.append(previewTitle, previewText);
  // Preview anchors must not navigate away from the editor or replace its fragment.
  previewText.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    event.preventDefault();
    if (!anchor.getAttribute('href')?.startsWith('#')) return;
    let id: string;
    try { id = decodeURIComponent(anchor.hash.slice(1)); } catch { return; }
    [...previewText.querySelectorAll('[id]')].find(element => element.id === id)?.scrollIntoView({ block: 'nearest' });
  });
  let previewGeneration = 0;
  let live: ReturnType<typeof import('../view/active-renderer').renderDocument> | undefined;
  const updatePreview = async (): Promise<void> => {
    const current = ++previewGeneration;
    live?.destroy();
    live = undefined;
    previewText.className = 'share-preview-text';
    previewText.textContent = sharePreview(text) || '(empty)';
    preview.setAttribute('aria-label', format === 'markdown' ? 'Document source preview' : 'What the reader sees');
    if (view !== 'rendered') return;
    try {
      const { renderDocument } = await import('../view/active-renderer');
      if (current !== previewGeneration) return;
      previewText.className = 'share-preview-rendered active-reading';
      live = renderDocument(previewText, text, navigator.language);
      preview.setAttribute('aria-label', 'Rendered document preview');
    } catch {
      if (current !== previewGeneration) return;
      live?.destroy();
      live = undefined;
      previewText.className = 'share-preview-text';
      previewText.textContent = 'Rendered preview unavailable. Source: ' + (sharePreview(text) || '(empty)');
    }
  };
  void updatePreview();

  const editLabel = document.createElement('label');
  editLabel.className = 'share-option';
  const edit = document.createElement('input');
  edit.type = 'checkbox';
  edit.id = 'share-edit';
  edit.checked = true;
  editLabel.append(edit, ' Readers can edit a copy');

  const headingLabel = document.createElement('label');
  headingLabel.className = 'share-option';
  const heading = document.createElement('input');
  heading.type = 'checkbox';
  heading.id = 'share-heading';
  heading.checked = true;
  headingLabel.append(heading, ' Show title on the page');

  const viewLabel = document.createElement('label');
  viewLabel.className = 'share-option'; viewLabel.hidden = format !== 'markdown';
  viewLabel.textContent = 'Readers see: ';
  const viewSelect = document.createElement('select');
  viewSelect.id = 'share-view';
  for (const [value, text] of [['rendered', 'Rendered page'], ['source', 'Source']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; viewSelect.append(option);
  }
  viewSelect.value = view;
  viewLabel.append(viewSelect);

  const linkLabel = document.createElement('label');
  linkLabel.htmlFor = 'share-url';
  linkLabel.textContent = 'Link';
  const link = document.createElement('input');
  link.type = 'text';
  link.id = 'share-url';
  link.readOnly = true;
  link.spellcheck = false;
  link.value = first;
  link.addEventListener('focus', () => { link.select(); });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.id = 'share-copy';
  copy.textContent = 'Copy link';

  const status = document.createElement('p');
  status.className = 'share-status';
  status.setAttribute('aria-live', 'polite');
  const lengthNote = (): string => (shareLinkLength(link.value) === 'long' ? LONG_LINK_TEXT : '');
  status.textContent = lengthNote();

  // Regenerating is async: only the latest request may write the link, and Copy link waits for
  // it, so a copied link always matches the checkbox (#247 review).
  // The field is emptied meanwhile, so no stale link can be copied by hand either.
  let generation = 0;
  const regenerate = (): void => {
    view = format === 'markdown' && viewSelect.value === 'rendered' ? 'rendered' : 'source';
    const current = ++generation;
    copy.disabled = true;
    link.value = '';
    link.placeholder = 'Updating link…';
    void make(edit.checked).then(url => {
      if (current !== generation) return;
      if (!url) {
        link.placeholder = '';
        status.textContent = TOO_LARGE_TEXT;
        return;
      }
      link.value = url;
      copy.disabled = false;
      status.textContent = lengthNote();
    });
  };
  edit.addEventListener('change', regenerate);
  heading.addEventListener('change', () => {
    showHeading = heading.checked;
    previewTitle.hidden = !showHeading;
    regenerate();
  });
  viewSelect.addEventListener('change', () => { regenerate(); void updatePreview(); });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = 'Link copied.';
    } catch {
      link.focus();
      link.select();
      status.textContent = 'Copy unavailable. The link is selected; use your device’s copy command.';
    }
  });

  const row = document.createElement('div');
  row.className = 'share-link-row';
  row.append(link, copy);
  content.append(privacy, linkLabel, row, status, editLabel, headingLabel);
  if (format === 'markdown') content.append(viewLabel);
  content.append(preview);
  try {
    await askConfirmChoice({ title: 'Share link', message: content, cancelLabel: 'Close', closeInHeader: true, returnFocus: deps.returnFocus() });
  } finally {
    ++previewGeneration;
    live?.destroy();
  }
}
