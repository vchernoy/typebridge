import { setupMarkdownView } from '../../src/view/markdown-view';
import { STORAGE_CLEAR_EVENT } from '../../src/editor/clear-data';
import type { StoredDraft } from '../../src/editor/indexeddb';
import { openDraftDatabase } from '../../src/editor/indexeddb';
export const source = '```calc\ninput x = 2 in 1..10\ninput seed = 3 in 0..20\ny = x + seed\n```\n\n:input[x] :value[y]\n\n$y={{y}}$';
let draft: StoredDraft;
let view: ReturnType<typeof setupMarkdownView>;
let field: HTMLTextAreaElement;
let db: IDBDatabase | undefined;
let publicState = false;
export async function setup(publicMemory = false, text = source, stored = false) {
  publicState = publicMemory;
  const section = document.createElement('div');
  // Static fixture chrome only. Document text is assigned through textarea.value.
  section.innerHTML = '<div id="document-view"><button id="document-view-edit">Edit</button><button id="document-view-preview">Rendered</button></div><div class="editor-shell"><textarea id="editor"></textarea></div><div id="rendered-document"></div><div id="render-problems"><ul id="render-problem-list"></ul></div>';
  document.body.append(section); field = section.querySelector('textarea')!; field.value = text;
  draft = { id: 'capture-a', title: 'Capture fixture', text, format: 'markdown', updatedAt: 0, revision: stored ? 1 : 0, inputEpoch: 'epoch-a' };
  if (stored) {
    db = await openDraftDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(['documents', 'readerStates'], 'readwrite');
      tx.objectStore('documents').put(draft);
      tx.objectStore('readerStates').put({ id: 'editable:' + draft.id, version: 1, revision: 1, inputs: [['x', 8], ['seed', 3]] });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
  }
  view = setupMarkdownView({ key: 'typebridge.capture-fixture', shown: () => draft, text: () => field.value,
    inputAccess: () => ({ db, draft, public: publicState, canEditInputs: true }), changedView: () => {}, canChangeView: () => true });
  view.sync();
}
export const capture = () => view.captureInputs();
export const render = () => document.querySelector<HTMLButtonElement>('#document-view-preview')!.click();
export const edit = () => view.edit();
export function switchDocument(id: string) { draft = { ...draft, id }; view.sync(); }
export function changeEpoch() { draft = { ...draft, inputEpoch: 'epoch-b' }; view.sync(); }
export function policy(allowed: boolean) { publicState = allowed; }
export async function storedInput() {
  return new Promise<{ revision: number; inputs: [string, number][] }>((resolve, reject) => {
    const tx = db!.transaction('readerStates'), q = tx.objectStore('readerStates').get('editable:' + draft.id);
    tx.oncomplete = () => resolve(q.result); tx.onabort = () => reject(tx.error);
  });
}
export async function retireStoredEpoch() {
  await new Promise<void>((resolve, reject) => {
    const tx = db!.transaction('documents', 'readwrite'), q = tx.objectStore('documents').get(draft.id);
    q.onsuccess = () => tx.objectStore('documents').put({ ...q.result, inputEpoch: 'epoch-b' });
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
export function plain() { draft = { ...draft, format: 'plain' }; view.sync(); }
export function clearDocument() {
  window.dispatchEvent(new CustomEvent(STORAGE_CLEAR_EVENT, { detail: { documentId: draft.id, nonce: crypto.randomUUID(), local: true } }));
}
