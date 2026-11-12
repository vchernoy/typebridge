/**
 * Emergency recovery (#53 / #37 R2c 2d-2): while Autosave is on, the localStorage journal holds the
 * full text and title only when the IndexedDB change log cannot protect the latest edit (no run
 * yet, a failed or held write, or IndexedDB unusable). A synchronous localStorage write does not
 * guarantee durability after whole-browser termination. Journals whose owner is gone are offered
 * in a recovery panel: recover as a copy, or discard. Exact-version cleanup is unchanged.
 */
import { UNTITLED_TITLE } from '../editor/drafts';
import { commitDraft, getStoredDraft } from '../editor/indexeddb';
import { clearRecovery, listRecovery, RECOVERY_PREFIX, writeRecovery, type RecoverySnapshot } from '../editor/recovery';
import { askConfirmChoice } from '../ui/confirm-dialog';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import type { DocumentSignal } from './signals';

export type RecoveryDeps = {
  viewMode: boolean;
  autosave: HTMLInputElement;
  field: HTMLTextAreaElement;
  draftTitle: HTMLInputElement;
  /** The journal warning and recovery panel are inserted before this element. */
  anchor: Element;
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
  refreshDrafts: () => Promise<void>;
  /**
   * True when the change log covers the latest edit (#37 R2c 2d-2). When true and IndexedDB is
   * usable, journalEdit writes nothing; existing entries stay until exact-version cleanup.
   */
  changeLogProtects: () => boolean;
  /** False when IndexedDB cannot take change records or saves (`!db` or a storage problem). */
  indexedDbUsable: () => boolean;
};

export function createRecovery(state: EditorState, status: StatusLine, deps: RecoveryDeps) {
  const journalTab = crypto.randomUUID();
  const OWNER_LOCK = 'typebridge-recovery-owner:';
  let ownershipAvailable = false;
  const ownerReady = new Promise<void>(resolve => {
    // Viewers write no recovery journals, so they never take recovery ownership.
    if (!navigator.locks || deps.viewMode) { resolve(); return; }
    void navigator.locks.request(OWNER_LOCK + journalTab, async () => {
      ownershipAvailable = true; resolve();
      await new Promise<void>(() => { /* The browser releases this lock with the page. */ });
    }).catch(() => { resolve(); });
  });
  let currentJournal: RecoverySnapshot | undefined;
  const journalWarning = document.createElement('p');
  journalWarning.setAttribute('role', 'alert');
  journalWarning.hidden = true;
  deps.anchor.before(journalWarning);
  const recoveryPanel = document.createElement('section');
  recoveryPanel.setAttribute('aria-label', 'Recover unsaved documents');
  recoveryPanel.className = 'recovery-panel'; // Hidden by CSS while empty (#118).
  deps.anchor.before(recoveryPanel);
  function journalEdit(): void {
    if (deps.viewMode || !deps.autosave.checked) return;
    // Change log covers this edit and IndexedDB can take it: leave the journal alone (#37 R2c 2d-2).
    if (deps.changeLogProtects() && deps.indexedDbUsable()) return;
    const entry: RecoverySnapshot = { token: crypto.randomUUID(), tab: journalTab, documentId: state.active.id, revision: state.active.revision, timestamp: Date.now(), title: deps.draftTitle.value.trim() || UNTITLED_TITLE, text: deps.field.value };
    try { writeRecovery(localStorage, entry); currentJournal = entry; journalWarning.hidden = true; }
    catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
  }
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryRenderVersion = 0;
  let panelSignature = '';
  let inspectUnknownOwners = false;
  async function ownerIsActive(tab: string): Promise<boolean | undefined> {
    if (!ownershipAvailable) return undefined;
    try { return (await navigator.locks.query()).held?.some(lock => lock.name === OWNER_LOCK + tab) ?? false; }
    catch { return undefined; }
  }
  function queueRecovery(): void {
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void renderRecovery(); }, 1200);
  }
  async function renderRecovery(): Promise<void> {
    const version = ++recoveryRenderVersion;
    let entries: RecoverySnapshot[];
    try { entries = listRecovery(localStorage).filter(item => item.tab !== journalTab); }
    catch { journalWarning.textContent = 'Emergency backups cannot be read. Copy or export unsaved text.'; journalWarning.hidden = false; return; }
    const candidates: { item: RecoverySnapshot; unknown: boolean }[] = [];
    for (const item of entries) {
      const activeOwner = await ownerIsActive(item.tab);
      if (activeOwner === true) continue;
      // A committed exact document or idempotent recovery copy makes only this
      // precise journal version redundant; newer revisions are never overwritten.
      try {
        if (state.db) {
          const original = await getStoredDraft(state.db, item.documentId);
          const recovered = await getStoredDraft(state.db, 'recovery-' + item.token);
          if ((original?.title === item.title && original.text === item.text) ||
              (recovered?.title === item.title + ' (recovered)' && recovered.text === item.text)) {
            clearRecovery(localStorage, item);
            continue;
          }
        }
      } catch { /* A failed check must never discard a potentially unsaved snapshot. */ }
      candidates.push({ item, unknown: activeOwner === undefined });
    }
    if (version !== recoveryRenderVersion) return;
    const signature = JSON.stringify({ candidates, inspectUnknownOwners });
    if (signature === panelSignature) return;
    panelSignature = signature;
    recoveryPanel.replaceChildren();
    if (!ownershipAvailable && !inspectUnknownOwners) {
      const inspect = document.createElement('button');
      inspect.type = 'button'; inspect.textContent = 'Check emergency backups';
      inspect.addEventListener('click', () => { inspectUnknownOwners = true; panelSignature = ''; void renderRecovery(); });
      recoveryPanel.append(inspect); return;
    }
    if (!candidates.length) return;
    const heading = document.createElement('p');
    heading.textContent = ownershipAvailable ? 'Emergency backups found. Recover a copy without changing your current document:' : 'Ownership cannot be verified; these backups may belong to open tabs. Recover a copy without changing your current document:';
    recoveryPanel.append(heading);
    for (const { item, unknown } of candidates) {
      const group = document.createElement('div');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Recover ${item.title} (${new Date(item.timestamp).toLocaleString()})`;
      if (unknown) button.title = 'Tab ownership could not be verified; the original tab may still be open.';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          if (await ownerIsActive(item.tab) === true) throw new Error('The original tab is still open');
          if (!state.db) throw new Error('Storage unavailable');
          const copy = { id: 'recovery-' + item.token, title: item.title + ' (recovered)', text: item.text, updatedAt: item.timestamp };
          const result = await commitDraft(state.db, copy, 0);
          if (!result.ok && (!result.current || result.current.title !== copy.title || result.current.text !== copy.text)) throw new Error('Recovery copy already changed');
          if (result.ok) deps.postSignal('saved', result.draft.id, result.draft.revision);
          clearRecovery(localStorage, item);
          await deps.refreshDrafts();
          status.announceAction('Recovered a copy in Documents. Your current document was kept.');
          panelSignature = ''; await renderRecovery();
        } catch { status.announceAction('Recovery failed. The emergency backup was kept; retry or copy your text.'); button.disabled = false; }
      });
      const discard = document.createElement('button');
      discard.type = 'button'; discard.textContent = `Discard backup for ${item.title}`;
      discard.addEventListener('click', async () => {
        if (await ownerIsActive(item.tab) === true) { status.announceAction('The original tab is still open; backup kept.'); queueRecovery(); return; }
        if (!await askConfirmChoice({ title: 'Discard emergency backup?', message: 'Unsaved text in this backup will be lost.', confirmLabel: 'Discard backup', cancelLabel: 'Keep backup', returnFocus: accepted => accepted ? deps.field : discard })) return;
        try { clearRecovery(localStorage, item); panelSignature = ''; await renderRecovery(); }
        catch { status.announceAction('Could not discard backup; it was kept.'); }
      });
      group.append(button, discard); recoveryPanel.append(group);
    }
  }
  if (!deps.viewMode) {
    window.addEventListener('storage', event => { if (event.key?.startsWith(RECOVERY_PREFIX)) queueRecovery(); });
    setInterval(queueRecovery, 5000);
  }
  return {
    /** Resolves once this tab holds (or cannot hold) its recovery-owner lock. */
    ownerReady,
    /** Journal the current text when the change log cannot protect it (Autosave on only). */
    journalEdit,
    /** The journal entry for the current unsaved text, if any. */
    currentJournal: (): RecoverySnapshot | undefined => currentJournal,
    /** Forget (and return) the current journal entry, e.g. when the user discards this window. */
    takeCurrentJournal(): RecoverySnapshot | undefined {
      const entry = currentJournal;
      currentJournal = undefined;
      return entry;
    },
    renderRecovery,
  };
}
