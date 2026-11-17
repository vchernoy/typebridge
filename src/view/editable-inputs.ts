import { openEditableInputs } from '../editor/editable-input-state';
import { numericInputs } from '../editor/shared-input-state';
import { AUTOSAVE_PREF_KEY } from '../editor/drafts';
import { onStorageClear } from '../editor/clear-data';
import { PREFS_EVENT } from './prefs-sync';
import type { StoredDraft, WriteFence } from '../editor/indexeddb';
import type { renderDocument } from './active-renderer';
type Live = ReturnType<typeof renderDocument>;
export type EditableInputAccess = { db?: IDBDatabase; draft: StoredDraft; public: boolean; fence?: WriteFence };
/** Memory belongs to document IDs in this editor, never to source strings or DOM controls. */
export function createEditableInputs(access: () => EditableInputAccess, reload: () => void) {
  const cache = new Map<string, { values: Map<string, number>; frozen: boolean; pending: boolean; version: number; base: number; conflict: boolean; reset: boolean }>();
  const panel = document.createElement('div'); panel.hidden = true; panel.id = 'editable-input-state';
  const status = document.createElement('p'); status.id = 'editable-input-status'; status.setAttribute('role', 'status');
  const reset = document.createElement('button'); reset.type = 'button'; reset.id = 'editable-input-reset'; reset.textContent = 'Reset inputs to defaults';
  const load = document.createElement('button'); load.type = 'button'; load.id = 'editable-input-load'; load.textContent = 'Load saved inputs'; load.hidden = true;
  panel.append(status, reset, load); document.querySelector('#rendered-document')!.after(panel);
  let stop: (() => void) | undefined;
  const freeze = () => { for (const entry of cache.values()) entry.frozen = true; stop?.(); };
  window.addEventListener('storage', event => { if (event.key === null || event.key === AUTOSAVE_PREF_KEY) freeze(); });
  window.addEventListener(PREFS_EVENT, event => {
    const name = (event as CustomEvent<{ name?: string }>).detail?.name;
    if (name === 'autosave' || name === 'reset') freeze();
  });
  onStorageClear(detail => { if (!detail.documentId) { freeze(); cache.clear(); } else { cache.delete(detail.documentId); if (access().draft.id === detail.documentId) stop?.(); } });
  return {
    check() { if (!access().public) { const entry = cache.get(access().draft.id); if (entry) { entry.frozen = true; stop?.(); } } },
    async prepare(id: string, current: () => boolean) {
      stop?.(); panel.hidden = true; load.hidden = true;
      let active = true, dirty = false, writing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let live: Live | undefined, unsubscribe: (() => void) | undefined;
      let entry = cache.get(id);
      const hadMemory = !!entry;
      if (!entry) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        entry = { values: new Map(), frozen: !access().public, pending: false, version: 0, base: 0, conflict: false, reset: false }; cache.set(id, entry);
      }
      const memory = entry;
      let store: Awaited<ReturnType<typeof openEditableInputs>>;
      const clearTimer = () => { clearTimeout(timer); timer = undefined; };
      const valid = () => {
        if (!active || !current() || access().draft.id !== id) return false;
        if (!access().public) { temporary(); return false; }
        return !memory.frozen;
      };
      const ownsPanel = () => stop === temporary && active && current() && access().draft.id === id;
      const temporary = () => { memory.frozen = true; memory.conflict = false; clearTimer(); store?.close(); store = undefined; if (ownsPanel()) { load.hidden = true; status.textContent = 'Inputs are temporary in this editor. Reload this editor to enable saving.'; } };
      const showConflict = () => {
        temporary(); memory.conflict = true;
        if (ownsPanel()) { load.hidden = false; status.textContent = 'Saved inputs changed. Load saved inputs to continue saving.'; }
      };
      stop = temporary;
      const initial = access();
      if (valid() && initial.db && initial.draft.revision > 0) {
        let loading = true;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const pending = openEditableInputs(initial.db, id, () => loading && valid(), () => valid() ? access().fence : undefined);
        try {
          store = await Promise.race([pending, new Promise<undefined>(resolve => { deadline = setTimeout(() => { loading = false; resolve(undefined); }, 2000); })]);
          if (!loading) { temporary(); void pending.then(late => late?.close(), () => undefined); }
        } catch { temporary(); }
        finally { clearTimeout(deadline); }
      }
      if (!valid()) { store?.close(); store = undefined; }
      if (store && (!hadMemory || (!memory.pending && memory.base !== store.revision))) {
        memory.values = new Map(store.inputs); memory.base = store.revision;
      }
      // A reopened connection's revision is not proof that cached pending values
      // were based on it. Keep their original CAS base until commit or explicit load.
      if (store && memory.pending && memory.base !== store.revision) showConflict();
      const write = async (values: ReadonlyMap<string, number> = memory.reset ? new Map() : memory.values) => {
        clearTimer(); if (!dirty || !store || !valid() || writing) return;
        writing = true; dirty = false; const version = memory.version;
        try {
          const writer = store;
          const result = await writer.save(values, memory.base);
          if (result === 'saved') {
            memory.base = Math.max(memory.base, writer.revision);
            if (memory.version === version) { memory.pending = false; memory.reset = false; }
          }
          if (!ownsPanel()) return;
          if (result !== 'saved') {
            if (result === 'conflict') showConflict(); else temporary();
          } else status.textContent = dirty ? 'Saving inputs…' : 'Inputs saved on this device.';
        } catch { if (ownsPanel()) temporary(); }
        finally { writing = false; if (dirty && valid() && store) timer = setTimeout(() => { void write(); }, 500); }
      };
      return {
        initialInputs: memory.values,
        bind(value: Live) {
          if (!ownsPanel()) return;
          live = value;
          const accepted = numericInputs([...value.session.inputValues()]);
          if (!accepted) { temporary(); memory.values = new Map(); } else memory.values = accepted;
          panel.hidden = value.session.inputValues().size === 0;
          status.textContent = store && access().fence ? 'Inputs are saved separately from source.' : 'Inputs are temporary in this editor.';
          load.hidden = !memory.conflict;
          if (memory.conflict) status.textContent = 'Saved inputs changed. Load saved inputs to continue saving.';
          let observed = JSON.stringify([...memory.values]);
          unsubscribe = value.session.subscribe(() => {
            if (!active || !current()) return;
            const values = value.session.inputValues(); const next = JSON.stringify([...values]);
            if (next === observed) return; observed = next;
            if (!numericInputs([...values])) { temporary(); return; }
            memory.values = new Map(values); memory.pending = true; memory.reset = false; memory.version++;
            if (valid() && store && access().fence) { dirty = true; status.textContent = 'Saving inputs…'; clearTimer(); timer = setTimeout(() => { void write(); }, 500); }
          });
          if (memory.pending && valid() && store && access().fence) { dirty = true; timer = setTimeout(() => { void write(); }, 500); }
          load.onclick = () => { if (ownsPanel() && !writing && access().public) { cache.delete(id); reload(); } };
          reset.onclick = () => {
            if (!ownsPanel() || writing) return;
            live?.resetInputs();
            const defaults = numericInputs([...value.session.inputValues()]);
            if (!defaults) { temporary(); memory.values = new Map(); return; }
            memory.values = defaults; memory.pending = true; memory.reset = true; memory.version++;
            if (valid() && store && access().fence) { dirty = true; void write(new Map()); }
            else status.textContent = memory.conflict ? 'Saved inputs changed. Load saved inputs to continue saving.' : 'Inputs reset to authored defaults in this editor.';
          };
        },
        destroy() { active = false; clearTimer(); unsubscribe?.(); store?.close(); if (stop === temporary) { stop = undefined; panel.hidden = true; } },
      };
    },
  };
}
