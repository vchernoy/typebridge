import { createEditableInputs, type EditableInputAccess } from './editable-inputs';
import { documentFormat } from '../editor/document-fields';
import type { StoredDraft } from '../editor/indexeddb';

export function setupMarkdownView(deps: {
  key: string;
  inputAccess: () => EditableInputAccess;
  shown: () => StoredDraft;
  text: () => string;
  changedView: (rendered: boolean) => void;
  canChangeView: () => boolean;
}) {
  const switcher = document.querySelector<HTMLElement>('#document-view')!;
  const editButton = document.querySelector<HTMLButtonElement>('#document-view-edit')!;
  const previewButton = document.querySelector<HTMLButtonElement>('#document-view-preview')!;
  const source = document.querySelector<HTMLElement>('.editor-shell')!;
  const root = document.querySelector<HTMLElement>('#rendered-document')!;
  const problems = document.querySelector<HTMLElement>('#render-problems')!;
  const list = document.querySelector<HTMLElement>('#render-problem-list')!;
  const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
  let focusInputs: string | undefined;
  const inputState = createEditableInputs(deps.inputAccess, () => { focusInputs = deps.shown().id; previous = ''; sync(); });
  let attachment: Awaited<ReturnType<typeof inputState.prepare>> | undefined;
  let preferred = 'edit';
  try { if (sessionStorage.getItem(deps.key) === 'rendered') preferred = 'rendered'; } catch { /* Edit fallback. */ }
  let generation = 0;
  let previous = '';
  let live: ReturnType<typeof import('./active-renderer').renderDocument> | undefined;
  let acceptedSource: { id: string; text: string } | undefined;
  let pageActive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => { generation++; clearTimeout(timer); attachment?.destroy(); attachment = undefined; live?.destroy(); live = undefined; };
  function edit(): void {
    preferred = 'edit';
    try { sessionStorage.setItem(deps.key, preferred); } catch { /* Per-window preference is optional. */ }
    sync();
  }
  async function render(text: string): Promise<void> {
    const started = generation;
    root.textContent = 'Rendering…';
    problems.hidden = true; problems.replaceChildren(list); list.replaceChildren();
    try {
      const { renderDocument } = await import('./active-renderer');
      if (generation !== started) return;
      const documentId = deps.shown().id;
      const prepared = await inputState.prepare(documentId, () => generation === started);
      if (generation !== started) { prepared.destroy(); return; }
      attachment = prepared;
      const stage = document.createElement('div'); stage.style.visibility = 'hidden'; root.replaceChildren(stage);
      live = renderDocument(stage, text, navigator.language, prepared.initialInputs);
      await live.settled();
      if (generation !== started) return;
      prepared.bind(live); acceptedSource = { id: documentId, text }; stage.style.removeProperty('visibility');
      if (focusInputs === deps.shown().id && document.activeElement === document.body) document.querySelector<HTMLButtonElement>('#editable-input-reset')?.focus({ preventScroll: true });
      focusInputs = undefined;
      for (const message of live.messages) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${message.line ?? 1}:${message.column ?? 1} — ${message.message}`;
        button.addEventListener('click', () => {
          edit();
          const lines = text.split('\n');
          const line = Math.max(0, Math.min(lines.length - 1, (message.line ?? 1) - 1));
          const offset = lines.slice(0, line).reduce((n, s) => n + s.length + 1, 0) + Math.min(lines[line].length, Math.max(0, (message.column ?? 1) - 1));
          field.focus(); field.setSelectionRange(offset, offset);
        });
        li.append(button); list.append(li);
      }
      if (live.messages.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Rendering problems';
        details.append(summary, list); problems.replaceChildren(details);
      }
      problems.hidden = !live.messages.length;
    } catch {
      if (generation === started) { acceptedSource = undefined; attachment?.destroy(); attachment = undefined; live?.destroy(); live = undefined; root.textContent = 'Could not render this document. Switch to Edit to read the source.'; }
    }
  }
  function sync(): void {
    inputState.check();
    const draft = deps.shown();
    const markdown = documentFormat(draft) === 'markdown';
    const rendered = markdown && preferred === 'rendered';
    switcher.hidden = !markdown;
    editButton.setAttribute('aria-pressed', String(!rendered));
    previewButton.setAttribute('aria-pressed', String(rendered));
    source.hidden = rendered; root.hidden = !rendered;
    deps.changedView(rendered);
    const text = deps.text();
    const key = JSON.stringify([draft.id, rendered, text]);
    if (key === previous) return;
    previous = key; stop(); problems.hidden = true;
    if (rendered) timer = setTimeout(() => { void render(text); }, 120);
    else { root.replaceChildren(); problems.replaceChildren(list); list.replaceChildren(); }
  }
  for (const [button, view] of [[editButton, 'edit'], [previewButton, 'rendered']] as const) {
    button.addEventListener('click', () => {
      if (!deps.canChangeView()) return;
      preferred = view;
      try { sessionStorage.setItem(deps.key, preferred); } catch { /* Optional. */ }
      sync();
    });
  }
  for (const event of ['input', 'historychange']) field.addEventListener(event, sync);
  window.addEventListener('pagehide', () => { pageActive = false; stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { pageActive = true; previous = ''; sync(); } });
  return { sync, edit,
    /** Preparation for explicit parameter sharing. Product Share routes still omit inputs. */
    captureInputs() {
      const draft = deps.shown();
      if (!pageActive || documentFormat(draft) !== 'markdown' || acceptedSource?.id !== draft.id || acceptedSource.text !== deps.text()) return;
      return inputState.capture();
    },
  };
}
