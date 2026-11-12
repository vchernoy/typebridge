/**
 * Documents → Share link… (#39): a dialog that makes a share link for the shown title and
 * text, says plainly what sharing means, and copies the link. The link format and its limits
 * are in editor/share-link.ts; links open on the reading page (read.html).
 */
import { encodeSharePayload, shareLinkLength, shareUrl } from '../editor/share-link';
import { askConfirmChoice } from './confirm-dialog';

export const SHARE_PRIVACY_TEXT = 'Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it.';
const LONG_LINK_TEXT = 'This link is long. Some messengers, mail apps and social sites cut or refuse long links; if it does not open for the reader, export the document as a file instead.';
const TOO_LARGE_TEXT = 'This document is too large to share as a link. Export it as a file instead (▾ Documents → Export).';
const PREVIEW_CHARS = 280;

export type ShareDialogDeps = {
  /** Title (or the Untitled default) and text currently shown, like Export. */
  surface: () => { title: string; text: string };
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
  const { title, text } = deps.surface();
  const make = async (edit: boolean): Promise<string | undefined> => {
    const encoded = await encodeSharePayload({ title, text, format: 'plain', view: 'source', edit });
    return encoded.ok ? shareUrl(deps.base(), encoded.payload) : undefined;
  };
  const first = await make(true);
  const content = document.createElement('div');
  content.className = 'share-dialog';
  if (!first) {
    content.textContent = TOO_LARGE_TEXT;
    await askConfirmChoice({ title: 'Share link', message: content, cancelLabel: 'Close', returnFocus: deps.returnFocus() });
    return;
  }

  const privacy = document.createElement('p');
  privacy.textContent = SHARE_PRIVACY_TEXT;

  const preview = document.createElement('div');
  preview.className = 'share-preview';
  preview.setAttribute('aria-label', 'What the reader sees');
  const previewTitle = document.createElement('strong');
  previewTitle.textContent = title;
  const previewText = document.createElement('p');
  previewText.className = 'share-preview-text';
  previewText.textContent = sharePreview(text) || '(empty)';
  preview.append(previewTitle, previewText);

  const editLabel = document.createElement('label');
  editLabel.className = 'share-option';
  const edit = document.createElement('input');
  edit.type = 'checkbox';
  edit.id = 'share-edit';
  edit.checked = true;
  editLabel.append(edit, ' Readers can edit a copy');

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
  edit.addEventListener('change', () => {
    const current = ++generation;
    copy.disabled = true;
    link.value = '';
    link.placeholder = 'Updating link…';
    void make(edit.checked).then(url => {
      if (current !== generation) return;
      if (!url) {
        status.textContent = TOO_LARGE_TEXT;
        return;
      }
      link.value = url;
      copy.disabled = false;
      status.textContent = lengthNote();
    });
  });
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
  content.append(privacy, preview, editLabel, linkLabel, row, status);
  await askConfirmChoice({ title: 'Share link', message: content, cancelLabel: 'Close', returnFocus: deps.returnFocus() });
}
