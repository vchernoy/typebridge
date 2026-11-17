/** One mounted shared reader: accepted model snapshots, never DOM scraping or source edits. */
import { openSharedInputs, type SharedInputs } from '../editor/shared-input-state';
import { readerStorageAllowed, REMEMBER_SHARED_KEY, REMEMBER_SHARED_EVENT } from '../editor/shared-library';
import { SHARED_REMOVAL_KEY } from '../editor/shared-invalidation';
import { AUTOSAVE_PREF_KEY } from '../editor/drafts';
import { PREFS_EVENT } from '../view/prefs-sync';
import type { renderDocument } from '../view/active-renderer';
import type { InputSnapshot } from '../editor/input-snapshot';
type Live = ReturnType<typeof renderDocument>;
type UI = { panel: HTMLElement; status: HTMLElement; reset: HTMLButtonElement; load: HTMLButtonElement; keep: HTMLButtonElement };
const CHANNEL = 'typebridge-reader-inputs.v1';
export async function prepareSharedInputs(payload: string, remembered: Promise<void> | undefined,
  current: () => boolean, canStore: () => boolean, ui: UI, reload: () => void, incoming?: InputSnapshot) {
  let active = true, frozen = false, conflict = false, saving = false, dirty = false, muted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let store: SharedInputs | undefined, live: Live | undefined, unsubscribe: (() => void) | undefined;
  let channel: BroadcastChannel | undefined;
  let storageFailed = false;
  const valid = (): boolean => {
    if (!active || !current() || frozen) return false;
    if (!readerStorageAllowed()) { memory(); return false; }
    return true;
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const actions = (show: boolean) => { ui.load.hidden = !show; ui.keep.hidden = !show; };
  const memory = () => {
    frozen = true; clearTimer(); store?.close(); store = undefined;
    if (active && current()) { actions(false); ui.status.textContent = 'Inputs are temporary in this page. Reopen the link to enable local saving.'; }
  };
  const changedElsewhere = () => {
    conflict = true; clearTimer(); actions(true);
    ui.status.textContent = 'Inputs changed in another tab. Your current values are kept here. Load saved values or keep these values explicitly.';
  };
  const privacy = (event: Event) => {
    const name = (event as CustomEvent<{ name?: string }>).detail?.name;
    if (event.type === REMEMBER_SHARED_EVENT || name === 'autosave' || name === 'reset') memory();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || [AUTOSAVE_PREF_KEY, REMEMBER_SHARED_KEY, SHARED_REMOVAL_KEY].includes(event.key)) memory();
  };
  window.addEventListener('storage', storage); window.addEventListener(PREFS_EVENT, privacy); window.addEventListener(REMEMBER_SHARED_EVENT, privacy);
  // Never hold the readable page indefinitely on blocked storage. A late connection
  // observes loadCurrent=false and closes; it cannot install state after fallback.
  let loadCurrent = true;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  if (readerStorageAllowed()) {
    const pending = (async () => {
      await remembered;
      if (!loadCurrent || !valid()) return;
      return openSharedInputs(payload, () => loadCurrent && valid(), memory);
    })();
    try {
      store = await Promise.race([pending, new Promise<undefined>(resolve => {
        deadline = setTimeout(() => { loadCurrent = false; storageFailed = true; resolve(undefined); }, 2000);
      })]);
    } catch { storageFailed = true; /* Reading stays usable; no persistent write proof. */ }
    finally { if (deadline !== undefined) clearTimeout(deadline); }
  }
  if (!current() || frozen) { store?.close(); store = undefined; }
  // An empty saved reset is a real snapshot, not permission to reapply link values.
  // Only a validated codec snapshot may be supplied; current product routes omit it.
  const initialInputs = store?.hasSnapshot ? store.inputs : incoming ? new Map(incoming.values) : store?.inputs;
  // A restored history page may read a saved baseline without rearming writes
  // disabled by its prior lifecycle/privacy transition.
  if (!canStore()) { store?.close(); store = undefined; }
  let observed = '';
  let resolving = false;
  let returnFocus: HTMLButtonElement | undefined;
  const controls = (busy: boolean) => {
    const focused = document.activeElement;
    if (busy && [ui.reset, ui.load, ui.keep].includes(focused as HTMLButtonElement)) returnFocus = focused as HTMLButtonElement;
    ui.reset.disabled = busy; ui.load.disabled = busy; ui.keep.disabled = busy;
    if (!busy && returnFocus) {
      const target = returnFocus.hidden ? ui.reset : returnFocus; returnFocus = undefined;
      if (active && current() && !ui.panel.hidden && document.activeElement === document.body) target.focus({ preventScroll: true });
    }
  };
  const write = async (values: ReadonlyMap<string, number>) => {
    if (!store || !valid() || saving) return;
    saving = true; controls(true);
    try {
      const result = await store.save(values);
      if (!valid()) return;
      if (result === 'conflict') changedElsewhere();
      else if (result === 'cancelled') memory();
      else {
        ui.status.textContent = dirty ? 'Saving inputs…' : 'Inputs saved on this device.';
        try { channel?.postMessage({ id: store.id, revision: store.revision }); } catch { /* CAS remains authoritative. */ }
      }
    } catch { if (active && current()) { memory(); ui.status.textContent = 'Could not save inputs. Current values remain usable in this page.'; } }
    finally { saving = false; if (active && current()) controls(false); if (dirty && !conflict && store && valid()) schedule(); }
  };
  const flush = () => {
    clearTimer();
    if (!dirty || !live || !store || conflict || saving || !valid()) return;
    dirty = false; void write(live.session.inputValues());
  };
  function schedule() { clearTimer(); timer = setTimeout(flush, 500); }
  const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', visibility);
  const pagehide = () => flush(); window.addEventListener('pagehide', pagehide);
  return {
    initialInputs,
    bind(value: Live) {
      live = value; ui.panel.hidden = value.session.inputValues().size === 0;
      actions(false); controls(false);
      ui.status.textContent = store ? 'Inputs are saved locally for this shared document.'
        : incoming && storageFailed ? 'Saved inputs are unavailable. Link parameters are temporary in this page.' : 'Inputs are temporary in this page.';
      observed = JSON.stringify([...value.session.inputValues()]);
      unsubscribe = value.session.subscribe(() => {
        if (muted || !active || !current()) return;
        const next = JSON.stringify([...value.session.inputValues()]);
        if (next === observed) return; observed = next;
        if (store && valid() && !conflict) { dirty = true; ui.status.textContent = 'Saving inputs…'; schedule(); }
      });
      try {
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = event => {
          const data = event.data;
          if (valid() && store && data?.id === store.id && Number.isSafeInteger(data.revision) && data.revision > store.revision) changedElsewhere();
        };
      } catch { /* Conflicts are still detected transactionally on save. */ }
      ui.load.onclick = () => { if (store && conflict && valid() && !saving && !resolving) reload(); };
      ui.keep.onclick = async () => {
        if (!store || !conflict || !valid() || saving || resolving) return;
        resolving = true; controls(true);
        try { await store.read(); if (!valid()) return; conflict = false; dirty = false; actions(false); await write(value.session.inputValues()); }
        catch { memory(); }
        finally { resolving = false; if (active && current()) controls(false); }
      };
      ui.reset.onclick = async () => {
        if (!active || !current() || saving || resolving) return;
        resolving = true; controls(true); clearTimer(); dirty = false;
        try {
          if (store && valid()) { try { await store.read(); } catch { memory(); } }
          if (!active || !current()) return;
          muted = true; value.resetInputs(); muted = false;
          observed = JSON.stringify([...value.session.inputValues()]); conflict = false; actions(false);
          if (store && valid()) await write(new Map());
          else ui.status.textContent = 'Inputs reset to authored defaults in this page.';
        } catch { muted = false; memory(); }
        finally { resolving = false; if (active && current()) controls(false); }
      };
    },
    destroy() {
      active = false; loadCurrent = false; clearTimer(); unsubscribe?.(); store?.close(); channel?.close();
      window.removeEventListener('storage', storage); window.removeEventListener(PREFS_EVENT, privacy); window.removeEventListener(REMEMBER_SHARED_EVENT, privacy);
      window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', visibility);
    },
  };
}
