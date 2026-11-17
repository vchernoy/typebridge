import { openEditableInputs } from '../editor/editable-input-state';
import { numericInputs } from '../editor/shared-input-state';
import { AUTOSAVE_PREF_KEY } from '../editor/drafts';
import { onStorageClear } from '../editor/clear-data';
import { PREFS_EVENT } from './prefs-sync';
import type { StoredDraft } from '../editor/indexeddb';
import type { renderDocument } from './active-renderer';
import { inspectInputSnapshot, type InputSnapshot } from '../editor/input-snapshot';
type Live = ReturnType<typeof renderDocument>;
export type EditableInputAccess = { db?: IDBDatabase; draft: StoredDraft; public: boolean; canEditInputs: boolean };
/** Memory belongs to document IDs in this editor, never to source strings or DOM controls. */
export function createEditableInputs(access: () => EditableInputAccess, reload: () => void) {
  const cache = new Map<string, { values: Map<string, number>; frozen: boolean; pending: boolean; version: number; base: number; conflict: boolean; reset: boolean; epoch?: string; ready: boolean; acceptedEpoch?: string }>();
  const panel = document.createElement('div'); panel.hidden = true; panel.id = 'editable-input-state';
  const status = document.createElement('p'); status.id = 'editable-input-status'; status.setAttribute('role', 'status');
  const reset = document.createElement('button'); reset.type = 'button'; reset.id = 'editable-input-reset'; reset.textContent = 'Reset inputs to defaults';
  const load = document.createElement('button'); load.type = 'button'; load.id = 'editable-input-load'; load.textContent = 'Load saved inputs'; load.hidden = true;
  panel.append(status, reset, load); document.querySelector('#rendered-document')!.after(panel);
  let stop: (() => void) | undefined;
  let freezeCurrent: (() => void) | undefined;
  const freeze = () => { for (const entry of cache.values()) entry.frozen = true; freezeCurrent?.(); };
  window.addEventListener('storage', event => { if (event.key === null || event.key === AUTOSAVE_PREF_KEY) freeze(); });
  window.addEventListener(PREFS_EVENT, event => {
    const name = (event as CustomEvent<{ name?: string }>).detail?.name;
    if (name === 'autosave' || name === 'reset') freeze();
  });
  onStorageClear(detail => { if (!detail.documentId) { freeze(); cache.clear(); } else { cache.delete(detail.documentId); if (access().draft.id === detail.documentId) freezeCurrent?.(); } });
  return {
    /** Accepted memory only; callers must also validate its source context. No sidecar lookup. */
    capture(): InputSnapshot | undefined {
      const state = access(), memory = cache.get(state.draft.id);
      // Observing private/failed policy proof must not leave a queued public write
      // alive. The accepted in-memory values remain available for explicit sharing.
      if (!state.public && memory) { memory.frozen = true; freezeCurrent?.(); }
      if (!memory?.ready || memory.acceptedEpoch !== (state.draft.inputEpoch ?? '')) return;
      const snapshot = inspectInputSnapshot({ version: 1, values: [...memory.values] });
      return snapshot.ok ? snapshot.snapshot : undefined;
    },
    check() { if (!access().public) { const entry = cache.get(access().draft.id); if (entry) { entry.frozen = true; freezeCurrent?.(); } } },
    async prepare(id: string, current: () => boolean) {
      stop?.(); panel.hidden = true; load.hidden = true;
      let active = true, dirty = false, writing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let loading = true;
      let finishLoading!: () => void;
      const cancelled = new Promise<undefined>(resolve => { finishLoading = () => resolve(undefined); });
      let live: Live | undefined, unsubscribe: (() => void) | undefined;
      let entry = cache.get(id);
      const hadMemory = !!entry;
      if (!entry) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        entry = { values: new Map(), frozen: !access().public, pending: false, version: 0, base: 0, conflict: false, reset: false, ready: false }; cache.set(id, entry);
      }
      const memory = entry;
      memory.ready = false;
      let store: Awaited<ReturnType<typeof openEditableInputs>>;
      const clearTimer = () => { clearTimeout(timer); timer = undefined; };
      const valid = () => {
        if (!active || !current() || access().draft.id !== id) return false;
        if (!access().public) { temporary(); return false; }
        return !memory.frozen;
      };
      const ownsPanel = () => stop === cancel && active && current() && access().draft.id === id;
      const endLoading = () => { loading = false; clearTimeout(deadline); finishLoading(); };
      // Cancellation retires this attachment, not the document's cached permission.
      function cancel() {
        active = false; endLoading(); clearTimer(); unsubscribe?.(); store?.close(); store = undefined;
        if (stop === cancel) { stop = undefined; freezeCurrent = undefined; panel.hidden = true; }
      }
      const temporary = () => {
        // A late cancelled read/timeout must not freeze a replacement that shares memory.
        if (!ownsPanel()) return;
        memory.frozen = true; memory.conflict = false; endLoading(); clearTimer(); store?.close(); store = undefined;
        load.hidden = true; status.textContent = 'Inputs are temporary in this editor. Reload this editor to enable saving.';
      };
      const showConflict = () => {
        temporary(); memory.conflict = true;
        if (ownsPanel()) { load.hidden = false; status.textContent = 'Saved inputs changed. Load saved inputs to continue saving.'; }
      };
      stop = cancel; freezeCurrent = temporary;
      const initial = access();
      const initialEpoch = initial.draft.inputEpoch ?? '';
      if (valid() && initial.db && initial.draft.revision > 0) {
        const pending = openEditableInputs(initial.db, id, () => loading && valid(), () => valid() && access().canEditInputs);
        try {
          store = await Promise.race([pending, cancelled, new Promise<undefined>(resolve => { deadline = setTimeout(() => { loading = false; resolve(undefined); }, 2000); })]);
          if (!loading) { temporary(); void pending.then(late => late?.close(), () => undefined); }
        } catch { temporary(); }
        finally { clearTimeout(deadline); }
      }
      // Keep the observed policy even when a retirement/conflict freezes the writer.
      // Falling back to an older UI epoch would make retired memory look current.
      const acceptedEpoch = store?.epoch ?? initialEpoch;
      if (!valid()) { store?.close(); store = undefined; }
      // A privacy cycle or delete/recreate retires every cached input snapshot,
      // even when its numeric CAS revision did not change while this view was away.
      if (store && memory.epoch !== undefined && memory.epoch !== store.epoch) temporary();
      if (store) memory.epoch = store.epoch;
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
          memory.ready = !!accepted; memory.acceptedEpoch = acceptedEpoch;
          if (!accepted) { temporary(); memory.values = new Map(); } else memory.values = accepted;
          panel.hidden = value.session.inputValues().size === 0;
          status.textContent = store && access().canEditInputs ? 'Inputs are saved separately from source.' : 'Inputs are temporary in this editor.';
          load.hidden = !memory.conflict;
          if (memory.conflict) status.textContent = 'Saved inputs changed. Load saved inputs to continue saving.';
          let observed = JSON.stringify([...memory.values]);
          unsubscribe = value.session.subscribe(() => {
            if (!active || !current()) return;
            const values = value.session.inputValues(); const next = JSON.stringify([...values]);
            if (next === observed) return; observed = next;
            if (!numericInputs([...values])) { memory.ready = false; temporary(); return; }
            memory.values = new Map(values); memory.pending = true; memory.reset = false; memory.version++;
            memory.ready = true; memory.acceptedEpoch = acceptedEpoch;
            if (valid() && store && access().canEditInputs) { dirty = true; status.textContent = 'Saving inputs…'; clearTimer(); timer = setTimeout(() => { void write(); }, 500); }
          });
          if (memory.pending && valid() && store && access().canEditInputs) { dirty = true; timer = setTimeout(() => { void write(); }, 500); }
          load.onclick = () => { if (ownsPanel() && !writing && access().public) { cache.delete(id); reload(); } };
          reset.onclick = () => {
            if (!ownsPanel() || writing) return;
            live?.resetInputs();
            const defaults = numericInputs([...value.session.inputValues()]);
            if (!defaults) { memory.ready = false; temporary(); memory.values = new Map(); return; }
            memory.values = defaults; memory.pending = true; memory.reset = true; memory.version++;
            memory.ready = true; memory.acceptedEpoch = acceptedEpoch;
            if (valid() && store && access().canEditInputs) { dirty = true; void write(new Map()); }
            else status.textContent = memory.conflict ? 'Saved inputs changed. Load saved inputs to continue saving.' : 'Inputs reset to authored defaults in this editor.';
          };
        },
        destroy: cancel,
      };
    },
  };
}
