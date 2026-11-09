/**
 * The editor's status line (#52): one live line for save state and action feedback, plus a
 * separate conflict live region. This module is the single writer of both; the rules for which
 * warning must stay visible are pure functions in editor/status.ts.
 */
import {
  AUTOSAVE_OFF,
  RETRYING,
  readOnlyStatus,
  riskText,
  statusKindForRisk,
  statusLineParts,
  withDraftListRefreshFailure,
  type RiskInputs,
  type StatusKind,
  type StatusMessage,
} from '../editor/status';
import type { EditBlock } from '../view/ownership';

export type StatusLineDeps = {
  conflictNotice: HTMLElement;
  statusSep: HTMLElement;
  status: HTMLElement;
  /** Runs after every render (the compact top-bar save indicator follows the status). */
  afterRender: () => void;
  /** Current inputs for the at-risk warning. */
  risk: () => RiskInputs;
  editBlock: () => EditBlock;
  quietReader: () => boolean;
};

/** Routine save progress that the top-bar indicator already shows (#156). */
function isRoutineSaveAnnouncement(body: string): boolean {
  return body === 'Saved locally' || body === 'Saving…';
}

export function createStatusLine(deps: StatusLineDeps) {
  const { conflictNotice, statusSep, status } = deps;
  let kind: StatusKind = 'progress';
  let message: StatusMessage = { conflict: '', primary: '', risk: '', draftListRefreshFailed: false };
  /** Cancels a pending deferred conflict write so a newer setConflict/clear wins. */
  let conflictAnnounceToken = 0;
  /** True between clearing the live region and the rewrite for an identical conflict. */
  let conflictReannouncePending = false;

  const currentRisk = (): string => riskText(deps.risk());

  /** Body/separator only — the conflict live region is owned by setConflict. */
  function renderStatus(): void {
    const { sep, body } = statusLineParts(message, conflictNotice.textContent ?? '');
    if (statusSep.textContent !== sep) statusSep.textContent = sep;
    if (status.textContent !== body) status.textContent = body;
    // Keep announcing save progress, but show it once in the top bar (#156).
    status.classList.toggle('status--announced-only', isRoutineSaveAnnouncement(body));
    deps.afterRender();
  }
  /** Single writer for status fields so clears/resets cannot skip a part. */
  function updateStatus(patch: Partial<StatusMessage>, nextKind?: StatusKind): void {
    message = { ...message, ...patch };
    if (nextKind !== undefined) kind = nextKind;
    renderStatus();
  }
  /**
   * Write the conflict live region. Identical wording re-announces on a later turn
   * so assistive tech sees a clear change. Switch flushes that defer announcement
   * leave the model empty until switchDraft calls this.
   */
  function setConflict(text: string, reannounce = false): void {
    message = { ...message, conflict: text };
    if (text) kind = 'conflict';
    if (!text) {
      conflictAnnounceToken++;
      conflictReannouncePending = false;
      if (conflictNotice.textContent) conflictNotice.textContent = '';
      renderStatus();
      return;
    }
    if (reannounce && conflictNotice.textContent === text) {
      const token = ++conflictAnnounceToken;
      conflictReannouncePending = true;
      conflictNotice.textContent = '';
      renderStatus();
      // Microtask: a later turn than this clear (so live regions observe a change), and
      // not a timer — Playwright's paused fake clock would otherwise leave the notice blank.
      queueMicrotask(() => {
        if (token !== conflictAnnounceToken) return;
        conflictReannouncePending = false;
        if (message.conflict !== text) return;
        conflictNotice.textContent = text;
        renderStatus();
      });
      return;
    }
    conflictAnnounceToken++;
    conflictReannouncePending = false;
    if (conflictNotice.textContent !== text) conflictNotice.textContent = text;
    renderStatus();
  }
  function clearNotices(): void {
    conflictAnnounceToken++;
    conflictReannouncePending = false;
    if (conflictNotice.textContent) conflictNotice.textContent = '';
    updateStatus({ conflict: '', draftListRefreshFailed: false });
  }
  function setSaveStatus(text: string, nextKind: Exclude<StatusKind, 'action'> = 'progress'): void {
    // Save-state updates drop a stale list-refresh suffix; conflict is preserved.
    updateStatus({ primary: text, risk: '', draftListRefreshFailed: false }, nextKind);
  }
  function setRiskStatus(primary: string, nextKind: StatusKind, risk = currentRisk()): void {
    updateStatus({ primary, risk }, nextKind);
  }
  /** Explicit action/failure feedback: one place for conflict reset, risk join and kind. */
  function announceAction(text: string, options: {
    kind?: StatusKind;
    /** Keep the current conflict string. */
    keepConflict?: boolean;
    /** Messages that already describe save state must not also append the risk warning. */
    omitRisk?: boolean;
  } = {}): void {
    const nextKind = options.kind ?? 'action';
    if (!options.keepConflict) setConflict('');
    else if (message.conflict && !conflictReannouncePending && conflictNotice.textContent !== message.conflict) {
      // Sync a deferred model-only write without cancelling a pending re-announce.
      setConflict(message.conflict);
    }
    const risk = options.omitRisk ? '' : currentRisk();
    if (risk) updateStatus({ draftListRefreshFailed: false, primary: text.replace(/[.…]$/, ''), risk }, statusKindForRisk(risk));
    else updateStatus({ draftListRefreshFailed: false, primary: text, risk: '' }, nextKind);
  }
  /** Save progress that never hides a known failure (#52 review of 6a5d4c5). */
  function showSaving(): void {
    const { storageProblem, saveFailed } = deps.risk();
    if (storageProblem) setSaveStatus(currentRisk(), 'failure'); // No save can succeed.
    else if (saveFailed) setSaveStatus(RETRYING, 'failure');      // Cleared only by a commit.
    else setSaveStatus('Saving…');
  }
  /** Show the save state alone, e.g. after loading a draft. */
  function showSaveState(): void {
    const risk = currentRisk();
    const { autosaveOn } = deps.risk();
    if (risk) setSaveStatus(risk, statusKindForRisk(risk));
    else if (deps.editBlock()) setSaveStatus(readOnlyStatusNow());
    else setSaveStatus(autosaveOn ? 'Saved locally' : AUTOSAVE_OFF);
  }
  function readOnlyStatusNow(): string {
    return readOnlyStatus(deps.editBlock(), deps.quietReader(), deps.risk().autosaveOn);
  }
  function markDraftListRefreshFailed(): void {
    updateStatus(withDraftListRefreshFailure(message, currentRisk()));
  }
  /** Same gate for persist and switch refresh failures — never attach to newer action feedback. */
  function shouldAttachDraftListRefreshFailure(): boolean {
    return !deps.risk().dirty && (kind === 'progress' || kind === 'failure' || kind === 'conflict');
  }

  return {
    /** The current status model (read-only snapshot). */
    message: (): StatusMessage => message,
    kind: (): StatusKind => kind,
    renderStatus,
    updateStatus,
    setConflict,
    clearNotices,
    setSaveStatus,
    riskText: currentRisk,
    setRiskStatus,
    statusKindForRisk,
    announceAction,
    showSaving,
    showSaveState,
    readOnlyStatus: readOnlyStatusNow,
    markDraftListRefreshFailed,
    shouldAttachDraftListRefreshFailure,
  };
}

export type StatusLine = ReturnType<typeof createStatusLine>;
