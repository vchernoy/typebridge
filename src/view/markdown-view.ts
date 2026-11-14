import { documentFormat } from '../editor/document-fields';
import type { StoredDraft } from '../editor/indexeddb';

export function setupMarkdownView(deps: {
  key: string;
  shown: () => StoredDraft;
  text: () => string;
  changedView: (rendered: boolean) => void;
  canChangeView: () => boolean;
}) {
  const switcher = document.querySelector<HTMLElement>('#document-view')!;
  const select = document.querySelector<HTMLSelectElement>('#document-view-choice')!;
  const source = document.querySelector<HTMLElement>('.editor-shell')!;
  const root = document.querySelector<HTMLElement>('#rendered-document')!;
  const problems = document.querySelector<HTMLElement>('#render-problems')!;
  const list = document.querySelector<HTMLElement>('#render-problem-list')!;
  const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
  let preferred = 'edit';
  try { if (sessionStorage.getItem(deps.key) === 'rendered') preferred = 'rendered'; } catch { /* Edit fallback. */ }
  let generation = 0;
  let previous = '';
  let live: ReturnType<typeof import('./active-renderer').renderDocument> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => { generation++; clearTimeout(timer); live?.destroy(); live = undefined; };
  function edit(): void {
    preferred = 'edit'; select.value = preferred;
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
      live = renderDocument(root, text, navigator.language);
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
      if (generation === started) root.textContent = 'Could not render this document. Switch to Edit to read the source.';
    }
  }
  function sync(): void {
    const draft = deps.shown();
    const markdown = documentFormat(draft) === 'markdown';
    const rendered = markdown && preferred === 'rendered';
    switcher.hidden = !markdown; select.value = preferred;
    source.hidden = rendered; root.hidden = !rendered;
    deps.changedView(rendered);
    const text = deps.text();
    const key = JSON.stringify([draft.id, rendered, text]);
    if (key === previous) return;
    previous = key; stop(); problems.hidden = true;
    if (rendered) timer = setTimeout(() => { void render(text); }, 120);
    else { root.replaceChildren(); problems.replaceChildren(list); list.replaceChildren(); }
  }
  select.addEventListener('change', () => {
    if (!deps.canChangeView()) { select.value = preferred; return; }
    preferred = select.value;
    try { sessionStorage.setItem(deps.key, preferred); } catch { /* Optional. */ }
    sync();
  });
  for (const event of ['input', 'historychange']) field.addEventListener(event, sync);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', event => { if (event.persisted) { previous = ''; sync(); } });
  return { sync, edit };
}
