import { listSharedItems, removeSharedItem, rememberPreference, setRememberPreference } from '../editor/shared-library';
import { decodeSharePayload } from '../editor/share-link';

export function setupRememberSharedPreference(): void {
  const checkbox = document.querySelector<HTMLInputElement>('#remember-shared');
  if (!checkbox) return;
  checkbox.checked = rememberPreference();
  const status = document.createElement('p'); status.setAttribute('role', 'status'); checkbox.closest('label')!.after(status);
  checkbox.addEventListener('change', () => {
    try { setRememberPreference(checkbox.checked); status.textContent = 'Preference saved. Existing items remain until removed; private changes are not saved retroactively.'; }
    catch { checkbox.checked = rememberPreference(); status.textContent = 'Could not save this preference.'; }
  });
  window.addEventListener('storage', () => { checkbox.checked = rememberPreference(); });
}
/** Separate received collection; links never select or mutate an editable document. */
export function setupSharedLibrary(database: () => IDBDatabase | undefined): { refresh: () => Promise<void> } {
  const section = document.createElement('details'); const summary = document.createElement('summary');
  summary.textContent = 'Shared with me'; section.id = 'shared-library';
  const search = document.createElement('input'); search.type = 'search'; search.id = 'shared-search'; search.setAttribute('aria-label', 'Search shared documents');
  const list = document.createElement('ul'); const status = document.createElement('p'); status.setAttribute('role', 'status');
  section.append(summary, search, status, list); document.querySelector('#doc-menu')!.append(section);
  let generation = 0;
  async function refresh(): Promise<void> {
    const started = ++generation;
    try {
      const db = database(); if (!db) throw new Error('Storage unavailable');
      const rows = await listSharedItems(db); const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const decoded = await decodeSharePayload(row.payload);
        if (!decoded.ok) continue;
        if (!(decoded.document.title + '\n' + decoded.document.text).toLowerCase().includes(search.value.toLowerCase())) continue;
        const li = document.createElement('li'); const link = document.createElement('a');
        link.textContent = decoded.document.title.trim() || 'Untitled document'; link.href = '/read.html#doc=' + row.payload;
        link.target = '_blank'; link.rel = 'noopener'; link.setAttribute('aria-label', link.textContent + ' (shared, opens a new tab)');
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove shared document ' + link.textContent);
        remove.addEventListener('click', () => { void (async () => {
          remove.disabled = true;
          try { const db = database(); if (!db) throw new Error('Storage unavailable');
          await removeSharedItem(db, row.id); await refresh(); summary.focus(); }
          catch { remove.disabled = false; status.textContent = 'Could not remove this item.'; }
        })(); });
        li.append(link, document.createTextNode(' '), remove); fragment.append(li);
      }
      if (started !== generation) return;
      list.replaceChildren(fragment); status.textContent = list.childElementCount ? 'Local to this browser/device. Editable copies are separate.' : 'No remembered shared documents.';
    } catch { if (started === generation) status.textContent = 'Shared library unavailable. Shared links still work.'; }
  }
  search.addEventListener('input', () => { void refresh(); });
  section.addEventListener('toggle', () => { if (section.open) void refresh(); });
  return { refresh };
}
