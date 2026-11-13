/** Document-bound Find/Replace values and independent Editor histories (#257 step 2b).
 * Reader/comparison edits live only in this window's memory. Privacy never restores or swaps fields.
 */
import type { Editor } from '../editor/editor';
import type { StoredDraft } from '../editor/indexeddb';

type SearchSnapshot = Pick<StoredDraft, 'find' | 'replace' | 'findHistory' | 'replaceHistory'>;
export function createDocumentSearch(deps: {
  find: Editor;
  replace: Editor;
  shown: () => StoredDraft;
  canEdit: () => boolean;
  ignored: () => boolean;
  changed: () => void;
  refresh: () => void;
}) {
  let restoring = false;
  let shownId: string | undefined;
  const local = new Map<string, SearchSnapshot>();
  const capture = (): SearchSnapshot => ({
    find: deps.find.field.value, replace: deps.replace.field.value,
    findHistory: deps.find.exportHistory(), replaceHistory: deps.replace.exportHistory(),
  });
  function changed(): void {
    if (restoring || deps.ignored()) return;
    if (deps.canEdit()) deps.changed();
    else local.set(deps.shown().id, capture());
  }
  for (const editor of [deps.find, deps.replace]) {
    // Register after Editor, so history/composition state is captured after it records the edit.
    for (const event of ['input', 'historychange', 'compositionend']) editor.field.addEventListener(event, changed);
    editor.field.addEventListener('compositionstart', () => {
      if (!restoring && !deps.ignored() && !deps.canEdit()) local.set(deps.shown().id, capture());
    });
  }
  const binding = {
    capture,
    values: (): Pick<StoredDraft, 'find' | 'replace'> => deps.canEdit()
      ? { find: deps.find.field.value, replace: deps.replace.field.value }
      : { find: deps.shown().find ?? '', replace: deps.shown().replace ?? '' },
    // A late journal/backup callback in a reader must not persist its local-only query.
    snapshot: (): SearchSnapshot => {
      if (deps.canEdit()) return capture();
      const row = deps.shown();
      return { find: row.find ?? '', replace: row.replace ?? '', findHistory: row.findHistory, replaceHistory: row.replaceHistory };
    },
    restore(draft: StoredDraft, force = false): void {
      restoring = true;
      try {
        if (force) local.delete(draft.id);
        // An owner save refreshes the body of a reader, not its local search/IME session.
        if (!deps.canEdit() && !force && shownId === draft.id && local.has(draft.id)) {
          deps.refresh(); return;
        }
        shownId = draft.id;
        const value = (!deps.canEdit() && !force ? local.get(draft.id) : undefined) ?? draft;
        deps.find.load(value.find ?? ''); deps.find.restoreHistory(value.findHistory);
        deps.replace.load(value.replace ?? ''); deps.replace.restoreHistory(value.replaceHistory);
        deps.refresh();
      } finally { restoring = false; }
    },
    /** Explicit Replace intent is replayed only after this window acquires editing. */
    apply(value: SearchSnapshot): void {
      if (!deps.canEdit() || deps.ignored()) return;
      binding.restore({ ...deps.shown(), ...value }, true);
      changed();
    },
    /** A reader's explicit takeover can adopt its local query, now under ownership. */
    owned(intent: 'explicit' | 'automatic'): void {
      if (deps.ignored() || !deps.canEdit() || !local.has(deps.shown().id)) return;
      if (intent === 'automatic') { binding.restore(deps.shown(), true); return; }
      const value = local.get(deps.shown().id)!;
      binding.restore({ ...deps.shown(), ...value }, true);
      changed();
    },
  };
  return binding;
}

/** Saved title metadata uses a fallback, but its history belongs to the exact raw input. */
export function restoreDocumentTitle(editor: Editor, draft: StoredDraft, untitled: string): void {
  const current = draft.titleHistory?.current;
  const raw = typeof current === 'string' && (current.trim() || untitled) === draft.title ? current : draft.title;
  editor.load(raw);
  editor.restoreHistory(draft.titleHistory);
}
