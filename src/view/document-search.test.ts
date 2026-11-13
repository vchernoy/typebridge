import { describe, expect, it, vi } from 'vitest';
import { createDocumentSearch, restoreDocumentTitle } from './document-search';
import type { Editor } from '../editor/editor';
import type { StoredDraft } from '../editor/indexeddb';

function inputEditor() {
  const field = Object.assign(new EventTarget(), { value: '' });
  let history: unknown;
  return {
    field,
    load(value: string) { field.value = value; field.dispatchEvent(new Event('input')); },
    exportHistory: () => history ?? { current: field.value, undo: [], redo: [] },
    restoreHistory(value: unknown) { history = value; field.dispatchEvent(new Event('historychange')); },
  };
}
function harness() {
  const find = inputEditor(), replace = inputEditor();
  const state = { row: { id: 'a', text: 'body', title: 'A', revision: 1, updatedAt: 1, find: 'A find', replace: 'A replace' } as StoredDraft, owner: true, ignored: false };
  const changed = vi.fn();
  const search = createDocumentSearch({ find: find as unknown as Editor, replace: replace as unknown as Editor,
    shown: () => state.row, canEdit: () => state.owner, ignored: () => state.ignored, changed, refresh: () => {} });
  return { state, find, replace, changed, search };
}

describe('document search binding (#257 2b)', () => {
  it('loads target values and independent histories without marking restore as an edit', () => {
    const { state, find, replace, changed, search } = harness();
    const history = { v: 1 as const, current: 'A find', undo: [], redo: [] };
    state.row.findHistory = history;
    search.restore(state.row);
    expect(search.snapshot()).toMatchObject({ find: 'A find', replace: 'A replace', findHistory: history });
    state.row = { ...state.row, id: 'b', find: 'B', replace: '', findHistory: undefined };
    search.restore(state.row);
    expect(find.field.value).toBe('B'); expect(replace.field.value).toBe('');
    expect(changed).not.toHaveBeenCalled();
  });
  it('owner edits, Undo/Redo and completed composition go through the same change callback', () => {
    const { state, find, changed, search } = harness();
    search.restore(state.row);
    for (const event of ['input', 'historychange', 'compositionend']) find.field.dispatchEvent(new Event(event));
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it('reader search remains local across saved-version refresh and document switches', () => {
    const { state, find, changed, search } = harness();
    state.owner = false;
    search.restore(state.row);
    find.field.value = 'reader only'; find.field.dispatchEvent(new Event('input'));
    search.restore({ ...state.row, find: 'owner update' });
    expect(find.field.value).toBe('reader only');
    search.restore({ ...state.row, id: 'b', find: 'B' });
    search.restore(state.row);
    expect(find.field.value).toBe('reader only');
    expect(search.snapshot().find).toBe('A find');
    expect(changed).not.toHaveBeenCalled();
    state.owner = true; search.owned('explicit');
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('a transferred canonical snapshot replaces local search and histories', () => {
    const { state, find, search } = harness(); state.owner = false;
    search.restore(state.row);
    find.field.value = 'reader'; find.field.dispatchEvent(new Event('input'));
    search.restore({ ...state.row, find: 'transferred private search' }, true);
    expect(find.field.value).toBe('transferred private search');
    search.restore(state.row);
    expect(find.field.value).toBe('A find');
  });
  it('loading and frozen transfer events cannot dirty the document', () => {
    const { state, find, changed } = harness(); state.ignored = true;
    find.field.dispatchEvent(new Event('input'));
    expect(changed).not.toHaveBeenCalled();
  });
});

it('restores the raw empty title covered by normalized stored metadata, retaining its history', () => {
  const title = inputEditor();
  const history = { v: 1 as const, current: '', undo: [], redo: [] };
  restoreDocumentTitle(title as unknown as Editor, { id: 'a', title: 'Untitled document', text: '', updatedAt: 1, revision: 1, titleHistory: history }, 'Untitled document');
  expect(title.field.value).toBe(''); expect(title.exportHistory()).toBe(history);
});

it('held Replace intent is applied only after editing ownership arrives', () => {
  const { state, find, replace, changed, search } = harness();
  search.restore(state.row); state.owner = false;
  find.field.value = 'local query'; replace.field.value = 'local replacement';
  const intent = search.capture(); search.apply(intent);
  expect(changed).not.toHaveBeenCalled();
  state.owner = true;
  search.restore({ ...state.row, find: 'incoming query' }, true);
  search.apply(intent);
  expect(search.snapshot()).toMatchObject({ find: 'local query', replace: 'local replacement' });
  expect(changed).toHaveBeenCalledTimes(1);
});

it('same-document reader refresh does not reload a composing search field', () => {
  const { state, find, search } = harness(); state.owner = false;
  search.restore(state.row);
  const load = vi.spyOn(find, 'load');
  find.field.dispatchEvent(new Event('compositionstart'));
  search.restore({ ...state.row, text: 'new owner body' });
  expect(load).not.toHaveBeenCalled();
});

it('malformed title history cannot break document loading', () => {
  const title = inputEditor();
  restoreDocumentTitle(title as unknown as Editor, { id: 'a', title: 'Safe title', text: '', updatedAt: 1, revision: 1, titleHistory: { current: 42 } as unknown as import('../editor/editor').EditorHistory }, 'Untitled document');
  expect(title.field.value).toBe('Safe title');
});

it('automatic ownership drops reader search without scheduling a save', () => {
  const { state, find, replace, changed, search } = harness();
  state.owner = false; search.restore(state.row);
  find.field.value = 'reader only'; find.field.dispatchEvent(new Event('input'));
  replace.field.value = 'reader replacement'; replace.field.dispatchEvent(new Event('input'));
  state.owner = true; search.owned('automatic');
  expect(find.field.value).toBe('A find'); expect(replace.field.value).toBe('A replace');
  expect(search.snapshot()).toMatchObject({ find: 'A find', replace: 'A replace' });
  expect(state.row.find).toBe('A find');
  expect(changed).not.toHaveBeenCalled();
});
