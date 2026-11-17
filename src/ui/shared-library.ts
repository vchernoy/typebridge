import { listSharedItems, removeSharedItem, removeSharedGroup, rememberPreference, setRememberPreference } from '../editor/shared-library';
import { decodeSharePayload } from '../editor/share-link';
import { groupSharedDocuments, searchSharedGroups, sharedVariantHints, type ReceivedDocument, type SharedGroup, type SharedVariant } from '../editor/shared-groups';
import type { SharedItem } from '../editor/shared-library';
import { askConfirmChoice } from './confirm-dialog';

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
  const search = document.createElement('input'); search.type = 'search'; search.id = 'shared-search';
  search.placeholder = 'Search shared documents'; search.setAttribute('aria-label', 'Search shared documents and link parameters');
  const list = document.createElement('ul'); const status = document.createElement('p'); status.setAttribute('role', 'status');
  section.append(summary, search, status, list); document.querySelector('#doc-menu')!.append(section);
  let generation = 0, filtering = false;
  let expanded: SharedGroup[] = [];
  let disclosures = new Map<HTMLDetailsElement, SharedGroup>();
  const owners = new WeakMap<HTMLElement, SharedGroup>();
  const same = (a: SharedGroup, b: SharedGroup) => a.title === b.title && a.text === b.text && a.format === b.format;
  const heading = (title: string) => title.trim() || 'Untitled document';
  const focus = (element: HTMLElement | undefined) => { if (section.open && element?.checkVisibility()) element.focus({ preventScroll: true }); };
  const visibleLinks = () => [...list.querySelectorAll('a')].filter(a => a.checkVisibility());
  const fallback = (group: SharedGroup | undefined, index: number) => {
    const entry = group && [...disclosures].find(([, value]) => same(value, group));
    const links = visibleLinks();
    focus(entry?.[0].querySelector<HTMLElement>(':scope > summary') ?? links[Math.min(Math.max(index, 0), links.length - 1)]
      ?? [...list.querySelectorAll<HTMLElement>('summary')].find(el => el.checkVisibility()) ?? search);
  };
  const tagged = <T extends HTMLElement>(element: T, key: string, group?: SharedGroup): T => {
    element.dataset.sharedFocus = key; if (group) owners.set(element, group); return element;
  };
  function actions(row: Readonly<SharedItem>, title: string, group?: SharedGroup, ordinal?: number): HTMLDetailsElement {
    const details = document.createElement('details'); details.className = 'shared-actions'; details.dataset.sharedActions = row.id;
    const toggle = tagged(document.createElement('summary'), row.id + ':actions', group); toggle.textContent = 'Actions';
    toggle.setAttribute('aria-label', 'Actions for ' + title + (ordinal ? ', received link ' + ordinal : ''));
    details.append(toggle);
    if (group) {
      const copy = tagged(document.createElement('button'), row.id + ':copy', group); copy.type = 'button'; copy.textContent = 'Copy original link';
      copy.setAttribute('aria-label', 'Copy original link for ' + title + (ordinal ? ', received link ' + ordinal : ''));
      const manual = tagged(document.createElement('input'), row.id + ':manual', group); manual.type = 'text'; manual.readOnly = true; manual.hidden = true;
      manual.className = 'shared-original-link'; manual.setAttribute('aria-label', 'Original link for ' + title + (ordinal ? ', received link ' + ordinal : ''));
      let copying = false;
      copy.addEventListener('click', () => { void (async () => {
        if (copying) return; copying = true; manual.hidden = true;
        const original = new URL('/read.html#doc=' + row.payload, location.origin).href;
        const focused = document.activeElement; status.textContent = 'Copying original link…';
        try {
          await navigator.clipboard.writeText(original);
          if (copy.isConnected) status.textContent = 'Original link copied.';
        } catch {
          if (!copy.isConnected) return;
          manual.value = original; manual.hidden = false;
          status.textContent = 'Could not copy automatically. Select and copy the original link below.';
          if (document.activeElement === focused || document.activeElement === document.body) { focus(manual); if (manual === document.activeElement) manual.select(); }
        } finally { copying = false; }
      })(); });
      details.append(copy, manual);
    }
    const remove = tagged(document.createElement('button'), row.id + ':remove', group); remove.type = 'button'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove shared document ' + title + (ordinal ? ', received link ' + ordinal : ''));
    let pending = false;
    remove.addEventListener('click', () => { void (async () => {
      if (pending) return; pending = true;
      const expected = { id: row.id, payload: row.payload };
      const index = visibleLinks().indexOf(details.closest('li')!.querySelector('a')!);
      try {
        const accepted = await askConfirmChoice({ title: 'Remove received link?',
          message: `Remove this received link for ${title} from this browser? Its saved reader inputs will also be removed. Other received links and editable copies stay unchanged.`,
          confirmLabel: 'Remove link', cancelLabel: 'Cancel', returnFocus: remove });
        if (!accepted) return;
        remove.disabled = true;
        const db = database(); if (!db) throw new Error('Storage unavailable');
        const result = await removeSharedItem(db, expected.id, expected.payload); await refresh();
        if (result === 'changed') status.textContent = 'This received link changed. Review it before removing it again.';
        if (document.activeElement === document.body) fallback(group, index);
      } catch { status.textContent = 'Could not remove this item.'; }
      finally { pending = false; remove.disabled = false; if (document.activeElement === document.body && remove.isConnected) focus(remove); }
    })(); });
    details.append(remove); return details;
  }
  function variantRow(variant: SharedVariant, group: SharedGroup): HTMLLIElement {
    const { item, document: doc, ordinal } = variant; const singleton = group.variants.length === 1;
    const title = heading(group.title); const li = document.createElement('li');
    const link = tagged(document.createElement('a'), item.id + ':link', group);
    link.textContent = singleton ? title : 'Received link ' + ordinal; link.href = '/read.html#doc=' + item.payload;
    link.target = '_blank'; link.rel = 'noopener';
    link.setAttribute('aria-label', title + (singleton ? '' : ', received link ' + ordinal) + ' (shared, opens a new tab)');
    const description = document.createElement('p'); description.className = 'shared-description';
    // Production decoders still reject v2. No sidecar values are read for summaries.
    description.textContent = 'Authored defaults · ' + sharedVariantHints(doc);
    if (singleton) description.textContent += ' · ' + format(group.format);
    li.append(link, description, actions(item, title, group, singleton ? undefined : ordinal)); return li;
  }
  function format(value: string): string {
    return value === 'plain' ? 'Plain text' : value === 'markdown' ? 'Markdown' : value + ' (source only)';
  }
  function groupActions(group: SharedGroup, key: string): HTMLDetailsElement {
    const details = document.createElement('details'); details.className = 'shared-actions'; details.dataset.sharedActions = key + ':group';
    const title = heading(group.title), count = group.variants.length;
    const toggle = tagged(document.createElement('summary'), key + ':group-actions', group); toggle.textContent = 'Group actions';
    toggle.setAttribute('aria-label', 'Group actions for ' + title);
    const remove = tagged(document.createElement('button'), key + ':group-remove', group); remove.type = 'button';
    remove.textContent = 'Remove all ' + count + ' received links'; let pending = false;
    remove.addEventListener('click', () => { void (async () => {
      if (pending) return; pending = true;
      const expected = group.variants.map(({ item }) => ({ id: item.id, payload: item.payload }));
      const index = visibleLinks().indexOf(details.closest('li')!.querySelector('a')!);
      try {
        const accepted = await askConfirmChoice({ title: 'Remove received links?',
          message: `Remove all ${count} received links for ${title} from this browser? Their saved reader inputs will also be removed. Editable copies stay unchanged.`,
          confirmLabel: `Remove ${count} links`, cancelLabel: 'Cancel', returnFocus: remove });
        if (!accepted) return;
        remove.disabled = true;
        const db = database(); if (!db) throw new Error('Storage unavailable');
        const result = await removeSharedGroup(db, group, expected); await refresh();
        if (result === 'changed') status.textContent = 'The shared library changed. Review the group before removing it again.';
        if (document.activeElement === document.body) fallback(group, index);
      } catch { status.textContent = 'Could not remove this group. No partial removal was committed.'; }
      finally { pending = false; remove.disabled = false; if (document.activeElement === document.body && remove.isConnected) focus(remove); }
    })(); });
    details.append(toggle, remove); return details;
  }
  async function refresh(): Promise<void> {
    const started = ++generation;
    try {
      const db = database(); if (!db) throw new Error('Storage unavailable');
      const rows = await listSharedItems(db); const decodedRows: ReceivedDocument[] = [], unavailable: SharedItem[] = [];
      for (const row of rows) {
        const decoded = await decodeSharePayload(row.payload);
        if (started !== generation) return;
        if (decoded.ok) decodedRows.push({ item: row, document: decoded.document }); else unavailable.push(row);
      }
      if (started !== generation) return;
      const groups = groupSharedDocuments(decodedRows);
      // Capture native disclosure state synchronously: toggle events may still be queued.
      if (!filtering) expanded = [...disclosures].filter(([details]) => details.open).map(([, group]) => group);
      expanded = expanded.filter(old => groups.some(group => same(group, old)));
      const openActions = new Set([...list.querySelectorAll<HTMLDetailsElement>('[data-shared-actions]')].filter(el => el.open).map(el => el.dataset.sharedActions));
      const active = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
      const focusKey = active?.dataset.sharedFocus, focusGroup = active && owners.get(active);
      const focusIndex = active ? visibleLinks().indexOf(active.closest('li')?.querySelector('a') as HTMLAnchorElement) : -1;
      filtering = !!search.value;
      const found = searchSharedGroups(groups, search.value); const fragment = document.createDocumentFragment();
      disclosures = new Map();
      for (const { group, variants } of found) {
        if (group.variants.length === 1) { fragment.append(variantRow(variants[0], group)); continue; }
        const li = document.createElement('li'), details = document.createElement('details'); details.className = 'shared-group';
        details.open = filtering || expanded.some(old => same(group, old)); disclosures.set(details, group);
        const key = group.variants.map(v => v.item.id).sort()[0];
        const toggle = tagged(document.createElement('summary'), key + ':group', group);
        toggle.textContent = heading(group.title) + ' · ' + (variants.length === group.variants.length ? variants.length : variants.length + ' of ' + group.variants.length) + ' received links';
        const label = document.createElement('small'); label.textContent = format(group.format); toggle.append(label);
        const children = document.createElement('ul'); children.className = 'shared-variants';
        for (const variant of variants) children.append(variantRow(variant, group));
        details.append(toggle, children, groupActions(group, key)); li.append(details); fragment.append(li);
      }
      for (const row of unavailable) {
        if (search.value && !'Unavailable received link'.toLowerCase().includes(search.value.toLowerCase())) continue;
        const li = document.createElement('li'); const label = document.createElement('p');
        label.textContent = 'Unavailable received link. This version cannot open it.';
        li.append(label, actions(row, 'Unavailable received link')); fragment.append(li);
      }
      list.replaceChildren(fragment);
      for (const details of list.querySelectorAll<HTMLDetailsElement>('[data-shared-actions]')) details.open = openActions.has(details.dataset.sharedActions);
      if (active && document.activeElement === document.body) {
        const replacement = [...list.querySelectorAll<HTMLElement>('[data-shared-focus]')].find(el => el.dataset.sharedFocus === focusKey && el.checkVisibility());
        if (replacement) focus(replacement); else fallback(focusGroup, focusIndex);
      }
      status.textContent = rows.length === 0 ? 'No remembered shared documents.' : list.childElementCount === 0 ? 'No matching shared documents.'
        : 'Local to this browser/device. Editable copies are separate.' + (unavailable.length ? ' Some received links are unavailable in this version.' : '');
    } catch { if (started === generation) status.textContent = 'Shared library unavailable. Shared links still work.'; }
  }
  search.addEventListener('input', () => { void refresh(); });
  section.addEventListener('toggle', event => { if (event.target === section && section.open) void refresh(); });
  return { refresh };
}
