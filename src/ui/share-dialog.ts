/**
 * Documents → Share link… (#39): a dialog that makes a share link for the shown title and
 * text, says plainly what sharing means, and copies the link. The link format and its limits
 * are in editor/share-link.ts; links open on the reading page (read.html).
 */
import { type ShareView, encodeSharePayload, shareLinkLength, shareUrl } from '../editor/share-link';
import { inspectInputSnapshot, type InputSnapshot } from '../editor/input-snapshot';
import { askConfirmChoice } from './confirm-dialog';

export const SHARE_PRIVACY_TEXT = 'Anyone with the link can read this document. The text travels inside the link itself; nothing is uploaded. The link also stays in your browser history and wherever you paste it.';
const LONG_LINK_TEXT = 'This link is long. Some messengers, mail apps and social sites cut or refuse long links; if it does not open for the reader, export the document as a file instead.';
const TOO_LARGE_TEXT = 'This document is too large to share as a link. Export it as a file instead (▾ Documents → Export).';
const PREVIEW_CHARS = 280;

export type ShareDialogDeps = {
  /** Title (or the Untitled default) and text currently shown, like Export. */
  surface: () => { title: string; text: string; format?: string; view?: ShareView; edit?: boolean; heading?: false; inputs?: InputSnapshot };
  /** The site root links point to. */
  base: () => string;
  returnFocus: () => HTMLElement;
  /** Optional page lifecycle guard for asynchronous opening. */
  current?: () => boolean;
  /** Received links may retain a disabled Edit hint that recipients cannot enable. */
  editLocked?: boolean;
};

/** A short preview of what the reader sees first. */
export function sharePreview(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > PREVIEW_CHARS ? trimmed.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '') + '…' : trimmed;
}

export async function openShareDialog(deps: ShareDialogDeps): Promise<void> {
  const surface = deps.surface();
  const { title, text } = surface;
  const format = surface.format ?? 'plain';
  let view: ShareView = surface.view ?? (format === 'markdown' ? 'rendered' : 'source');
  let showHeading = surface.heading !== false;
  const checked = surface.inputs && inspectInputSnapshot(surface.inputs);
  const snapshot = checked && checked.ok ? checked.snapshot : undefined;
  const include = document.createElement('input'); include.type = 'checkbox'; include.id = 'share-inputs';
  const inputLabel = document.createElement('label'); inputLabel.className = 'share-option';
  inputLabel.append(include, ' Include current parameters');
  const inputSummary = document.createElement('p');
  inputSummary.textContent = snapshot ? `${snapshot.values.length} accepted parameters available. Unchecked uses authored defaults.` : '';
  const initialEdit = surface.edit !== false;
  const make = async (edit: boolean): Promise<string | undefined> => {
    const encoded = await encodeSharePayload({ title, text, format, view, edit: deps.editLocked ? initialEdit : edit, ...(showHeading ? {} : { heading: false } as const), ...(include.checked && snapshot ? { inputs: snapshot } : {}) }, { inputSnapshots: true });
    return encoded.ok ? shareUrl(deps.base(), encoded.payload) : undefined;
  };
  const first = await make(initialEdit);
  if (deps.current && !deps.current()) return;
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
  previewTitle.hidden = !showHeading;
  const previewText = document.createElement('div');
  previewText.className = 'share-preview-text';
  previewText.textContent = sharePreview(text) || '(empty)';
  preview.append(previewTitle, previewText);
  const previewDisclosure = document.createElement('details');
  previewDisclosure.className = 'share-preview-disclosure';
  const previewSummary = document.createElement('summary');
  previewSummary.id = 'share-preview-toggle';
  previewSummary.textContent = 'Document preview';
  previewDisclosure.append(previewSummary, preview);
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
    if (!previewDisclosure.open || view !== 'rendered' || format !== 'markdown') return;
    try {
      const { renderDocument } = await import('../view/active-renderer');
      if (current !== previewGeneration) return;
      previewText.className = 'share-preview-rendered active-reading';
      live = renderDocument(previewText, text, navigator.language, include.checked && snapshot ? new Map(snapshot.values) : undefined);
      preview.setAttribute('aria-label', 'Rendered document preview');
    } catch {
      if (current !== previewGeneration) return;
      live?.destroy();
      live = undefined;
      previewText.className = 'share-preview-text';
      previewText.textContent = 'Rendered preview unavailable. Source: ' + (sharePreview(text) || '(empty)');
    }
  };
  previewDisclosure.addEventListener('toggle', () => { void updatePreview(); });

  const editLabel = document.createElement('label');
  editLabel.className = 'share-option';
  const edit = document.createElement('input');
  edit.type = 'checkbox';
  edit.id = 'share-edit';
  edit.checked = initialEdit;
  edit.disabled = deps.editLocked === true;
  editLabel.append(edit, ' Readers can edit a copy');

  const headingLabel = document.createElement('label');
  headingLabel.className = 'share-option';
  const heading = document.createElement('input');
  heading.type = 'checkbox';
  heading.id = 'share-heading';
  heading.checked = showHeading;
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
  const readerOptions = document.createElement('details');
  readerOptions.className = 'share-reader-options';
  const optionsSummary = document.createElement('summary');
  optionsSummary.id = 'share-options-toggle';
  const optionValues = document.createElement('span');
  optionValues.className = 'share-option-values';
  optionsSummary.append('Reader options', optionValues);
  readerOptions.append(optionsSummary, editLabel, headingLabel);
  if (format === 'markdown') readerOptions.append(viewLabel);
  const describeOptions = (): void => {
    optionValues.textContent = `${view === 'rendered' ? 'Rendered page' : 'Source'} · ${showHeading ? 'Title shown' : 'Title hidden'} · ${edit.checked ? 'Edit a copy shown' : 'Edit a copy hidden'}`;
  };
  describeOptions();

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

  const embedLabel = document.createElement('label');
  embedLabel.htmlFor = 'share-embed-code';
  embedLabel.textContent = 'Embed on another website';
  const embedCode = document.createElement('textarea');
  embedCode.id = 'share-embed-code';
  embedCode.readOnly = true;
  embedCode.rows = 3;
  embedCode.spellcheck = false;
  embedCode.addEventListener('focus', () => embedCode.select());
  const copyEmbed = document.createElement('button');
  copyEmbed.type = 'button';
  copyEmbed.id = 'share-copy-embed';
  copyEmbed.textContent = 'Copy embed code';
  const makeEmbed = (url: string): string => {
    const target = new URL(url);
    target.pathname = '/embed.html';
    // Attribute-escape the entire URL before putting it in generated HTML.
    const safeUrl = target.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    return '<iframe src="' + safeUrl + '" width="100%" height="450" style="border:0" loading="lazy" title="Interactive document"></iframe>';
  };
  const updateEmbed = (): void => {
    embedCode.value = link.value ? makeEmbed(link.value) : '';
    copyEmbed.disabled = !embedCode.value;
  };
  updateEmbed();

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
    describeOptions();
    const current = ++generation;
    copy.disabled = true;
    link.value = '';
    updateEmbed();
    link.placeholder = 'Updating link…';
    void make(edit.checked).then(url => {
      if (current !== generation) return;
      if (!url) {
        link.placeholder = '';
        status.textContent = TOO_LARGE_TEXT;
        return;
      }
      link.value = url;
      updateEmbed();
      copy.disabled = false;
      status.textContent = lengthNote();
    });
  };
  include.addEventListener('change', () => { regenerate(); void updatePreview(); });
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

  copyEmbed.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(embedCode.value);
      status.textContent = 'Embed code copied.';
    } catch {
      embedCode.focus();
      embedCode.select();
      status.textContent = 'Copy unavailable. The embed code is selected; use your device’s copy command.';
    }
  });

  const row = document.createElement('div');
  row.className = 'share-link-row';
  row.append(link, copy);
  content.append(privacy, linkLabel, row, status, embedLabel, embedCode, copyEmbed);
  if (snapshot) content.append(inputLabel, inputSummary);
  content.append(readerOptions);
  content.append(previewDisclosure);
  try {
    await askConfirmChoice({ title: 'Share link', message: content, cancelLabel: 'Close', closeInHeader: true, returnFocus: deps.returnFocus() });
  } finally {
    ++generation;
    ++previewGeneration;
    live?.destroy();
  }
}
