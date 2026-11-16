/** Shared Edit lifecycle/UI for #330. Protocol outcomes never rewrite the shared source. */
import { AUTOSAVE_PREF_KEY, newDraft } from '../editor/drafts';
import { onStorageClear } from '../editor/clear-data';
import { inspectOwnedSharedCopy, listOwnedSharedCopies, openDraftDatabase, reuseOrCreateSharedCopy } from '../editor/indexeddb';
import { sameSharedCopy, sharedCopyFields } from '../editor/shared-copy';
import type { SharedDocument } from '../editor/share-link';
import { askConfirmChoice } from '../ui/confirm-dialog';
import { PREFS_EVENT } from '../view/prefs-sync';
import { createDocumentSignal, DOCUMENT_SIGNAL_CHANNEL } from '../view/signals';
import { ReaderOwnerReuse, type OwnerReuseResult } from './owner-reuse';
import { sharedCopyRecoveryExclusions } from './shared-copy-recovery';

type Action = {
  version: number; hash: string; publicAtStart: boolean; shared: SharedDocument; abort: AbortController;
  attempt?: ReaderOwnerReuse; latest?: OwnerReuseResult; keepReading: boolean; initialDone: boolean; fallbackStarted: boolean;
};
type Elements = { edit: HTMLAnchorElement; status: HTMLElement; actions: HTMLElement; check: HTMLButtonElement; copy: HTMLButtonElement };
const publicNow = (): boolean => {
  try { return localStorage.getItem(AUTOSAVE_PREF_KEY) !== 'off'; } catch { return false; }
};

export function setupSharedEdit(ui: Elements) {
  let shared: SharedDocument | undefined;
  let hash = '';
  let version = 0;
  let action: Action | undefined;
  let busy = false;
  let confirming = false;
  // In-memory only: preserve an unresolved action's warning across same-page
  // history/bfcache restore. No protocol identity/source is written to storage.
  const uncertainHashes = new Set<string>();
  let uncertaintyOverflow = false;
  const uncertain = (key: string): boolean => uncertaintyOverflow || uncertainHashes.has(key);
  const markUncertain = (key: string): void => {
    if (uncertainHashes.size < 16 || uncertainHashes.has(key)) uncertainHashes.add(key);
    else uncertaintyOverflow = true; // Never evict a warning and silently permit fallback.
  };
  const current = (a: Action): boolean => {
    const valid = a.version === version && action === a && shared === a.shared
      && location.hash === a.hash && !a.abort.signal.aborted;
    if (valid && publicNow() !== a.publicAtStart) { pause(); return false; }
    return valid;
  };
  const disableEdit = (disabled: boolean): void => {
    if (disabled) ui.edit.setAttribute('aria-disabled', 'true'); else ui.edit.removeAttribute('aria-disabled');
  };
  function unknown(): void {
    busy = true; disableEdit(true); ui.actions.hidden = !shared?.edit;
    ui.check.disabled = action?.attempt?.canCheckStatus !== true;
    ui.copy.disabled = false;
    ui.status.textContent = 'Activation status is unknown. The document may already be open in another TypeBridge window. '
      + (ui.check.disabled ? 'Its status can no longer be checked on this page. A new copy may duplicate it.' : 'Check its status or create a new copy, which may duplicate it.');
  }
  function abandon(): void {
    const previous = action;
    version++; action = undefined;
    if (previous?.attempt?.hasCommitted && previous.attempt.result !== 'activated' && previous.attempt.result !== 'fallback') markUncertain(previous.hash);
    previous?.abort.abort(); previous?.attempt?.cancel();
    busy = false;
  }
  function hideActions(): void {
    const refocus = ui.actions.contains(document.activeElement);
    ui.actions.hidden = true;
    if (refocus && !ui.edit.hidden) ui.edit.focus();
  }
  function stayReading(): void {
    abandon(); disableEdit(false); hideActions();
    ui.status.textContent = 'You can keep reading or choose Edit again.';
  }
  function pause(): void {
    const wasBusy = busy;
    abandon();
    if (shared && uncertain(hash)) unknown();
    else { ui.actions.hidden = true; disableEdit(false); if (wasBusy) ui.status.textContent = 'Edit was cancelled. You can try again.'; }
  }
  function failure(a: Action): void {
    if (!current(a)) return;
    if (uncertain(hash)) {
      unknown(); ui.status.textContent += ' Could not save the new copy because browser storage is unavailable.';
    } else {
      busy = false; disableEdit(false); ui.actions.hidden = true;
      ui.status.textContent = 'Could not save a copy: browser storage is unavailable here. You can still select and copy the text.';
    }
  }
  async function copy(a: Action, force: boolean): Promise<void> {
    if (!current(a) || a.fallbackStarted) return;
    a.fallbackStarted = true;
    busy = true; disableEdit(true); ui.actions.hidden = true; ui.status.textContent = 'Saving a copy…';
    try {
      const db = await openDraftDatabase(() => pause());
      try {
        if (!current(a)) return;
        const fields = sharedCopyFields(a.shared);
        // Undefined exclusions deliberately disable reuse for a separately
        // confirmed Create new copy action after an ambiguous old activation.
        const result = await reuseOrCreateSharedCopy(db, { ...newDraft(fields.text), ...fields },
          force ? undefined : sharedCopyRecoveryExclusions(), a.abort.signal, () => current(a));
        if (!current(a)) return;
        try {
          const channel = new BroadcastChannel(DOCUMENT_SIGNAL_CHANNEL);
          if (!result.reused) channel.postMessage(createDocumentSignal('saved', result.draft.id, result.draft.revision, Date.now()));
          channel.close();
        } catch { /* Other windows reread on focus. */ }
        location.assign('/?open=' + encodeURIComponent(result.draft.id) + (result.reused ? '&reused=1' : ''));
      } finally { db.close(); }
    } catch { failure(a); }
  }
  function result(a: Action, value: OwnerReuseResult): void {
    if (!current(a)) return;
    a.latest = value;
    if (value === 'activated') {
      uncertainHashes.delete(hash);
      busy = false; disableEdit(false); hideActions();
      ui.status.textContent = 'Opened the existing document in another TypeBridge window. Switch to that window if your browser did not bring it forward.';
    } else if (value === 'unknown') {
      markUncertain(hash); unknown();
    } else if (value === 'fallback') {
      uncertainHashes.delete(hash);
      if (a.keepReading) stayReading();
      else if (a.initialDone && !confirming) void copy(a, false);
    }
  }
  async function begin(force = false): Promise<void> {
    if (!shared?.edit || (!force && busy)) return;
    const document = shared;
    abandon();
    const a: Action = { version, hash, publicAtStart: publicNow(), shared: document, abort: new AbortController(), keepReading: false, initialDone: false, fallbackStarted: false };
    action = a; busy = true; disableEdit(true); ui.actions.hidden = true;
    if (force) { await copy(a, true); return; }
    const deadline = Date.now() + 2000;
    ui.status.textContent = 'Looking for an existing document…';
    try {
      const db = await openDraftDatabase(() => pause());
      try {
        if (!current(a)) return;
        const fields = sharedCopyFields(document);
        const candidates = publicNow() ? await listOwnedSharedCopies(db, fields, sharedCopyRecoveryExclusions()) : [];
        if (!current(a)) return;
        const ready = (): boolean => current(a) && publicNow();
        a.attempt = new ReaderOwnerReuse(candidates, {
          deadline, canCommit: ready,
          verify: async (offer, signal) => {
            if (!ready()) return false;
            const excluded = sharedCopyRecoveryExclusions();
            if (!excluded || excluded.has(offer.documentId)) return false;
            const snapshot = await inspectOwnedSharedCopy(db, offer, signal);
            const freshExcluded = sharedCopyRecoveryExclusions();
            return ready() && !!snapshot && sameSharedCopy(snapshot, fields) && !!freshExcluded && !freshExcluded.has(offer.documentId);
          },
          onResult: value => result(a, value),
        });
        await a.attempt.first;
        a.initialDone = true;
        if (current(a) && a.latest === 'fallback' && !confirming) await copy(a, false);
      } finally { db.close(); }
    } catch { failure(a); }
  }
  ui.edit.onclick = event => { event.preventDefault(); void begin(); };
  ui.check.onclick = async () => {
    const a = action;
    if (!a?.attempt?.canCheckStatus || !current(a) || a.latest !== 'unknown') return;
    ui.check.disabled = true;
    await a.attempt.checkStatus();
    if (current(a) && a.latest === 'unknown') unknown();
  };
  ui.copy.onclick = async () => {
    if (confirming || !shared?.edit || !uncertain(hash)) return;
    const previous = action;
    if (previous && !current(previous)) return;
    const atVersion = version; const atHash = hash;
    if (previous) previous.keepReading = false;
    confirming = true;
    const accepted = await askConfirmChoice({ title: 'Create another copy?',
      message: 'The earlier activation may already have opened an existing document. A new copy may duplicate it. The existing document will be kept.',
      confirmLabel: 'Create new copy', cancelLabel: 'Keep reading', returnFocus: () => ui.actions.hidden ? ui.edit : ui.copy });
    confirming = false;
    if (atVersion !== version || atHash !== location.hash || !shared?.edit) return;
    ui.copy.disabled = false;
    if (accepted) await begin(true);
    else if (action && current(action)) {
      // Keep reading also wins over a refusal delivered after this dialog closes.
      action.keepReading = true;
      if (action.latest === 'fallback') stayReading();
    }
  };
  window.addEventListener('storage', event => { if (event.key === null || event.key === AUTOSAVE_PREF_KEY) pause(); });
  window.addEventListener(PREFS_EVENT, pause);
  window.addEventListener('pagehide', pause);
  onStorageClear(() => pause());
  return {
    pause,
    show(value: SharedDocument | undefined, key = location.hash): void {
      abandon(); shared = value; hash = key; ui.edit.hidden = !value?.edit;
      if (value && uncertain(hash)) unknown();
      else { ui.actions.hidden = true; disableEdit(false); ui.status.textContent = ''; }
    },
  };
}
