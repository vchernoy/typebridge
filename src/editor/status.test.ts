import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_OFF, NOT_OWNER_UNSAVED, READ_ONLY_ERROR, READ_ONLY_HERE, READ_ONLY_UNSUPPORTED, SAVE_FAILED,
  SAVE_FAILED_NO_STORAGE, STORAGE_UNAVAILABLE, readOnlyStatus, renderStatusMessage, riskText, statusKindForRisk,
  withDraftListRefreshFailure,
} from './status';

const calm = { storageProblem: '', dirty: false, blocked: false, saveFailed: false, autosaveOn: true };

describe('status rules', () => {
  it('names the warning that must stay visible, most serious first', () => {
    expect(riskText(calm)).toBe('');
    expect(riskText({ ...calm, storageProblem: STORAGE_UNAVAILABLE })).toBe(STORAGE_UNAVAILABLE);
    expect(riskText({ ...calm, storageProblem: STORAGE_UNAVAILABLE, dirty: true })).toBe(SAVE_FAILED_NO_STORAGE);
    expect(riskText({ ...calm, storageProblem: 'Upgraded elsewhere.', dirty: true })).toBe('Changes are unsaved. Upgraded elsewhere.');
    expect(riskText({ ...calm, blocked: true, dirty: true, saveFailed: true })).toBe(NOT_OWNER_UNSAVED);
    expect(riskText({ ...calm, blocked: true })).toBe('');
    expect(riskText({ ...calm, saveFailed: true })).toBe(SAVE_FAILED);
    expect(riskText({ ...calm, saveFailed: true, autosaveOn: false })).toBe('');
    expect(riskText({ ...calm, dirty: true, autosaveOn: false })).toBe(AUTOSAVE_OFF);
  });

  it('treats Autosave off as progress and every other warning as failure', () => {
    expect(statusKindForRisk(AUTOSAVE_OFF)).toBe('progress');
    expect(statusKindForRisk(SAVE_FAILED)).toBe('failure');
  });

  it('shows a quiet reader like a normal editor and explains other read-only states', () => {
    expect(readOnlyStatus('busy', true, true)).toBe('Saved locally');
    expect(readOnlyStatus('busy', true, false)).toBe(AUTOSAVE_OFF);
    expect(readOnlyStatus('busy', false, true)).toBe(READ_ONLY_HERE);
    expect(readOnlyStatus('unsupported', false, true)).toBe(READ_ONLY_UNSUPPORTED);
    expect(readOnlyStatus('error', false, true)).toBe(READ_ONLY_ERROR);
  });

  it('joins list-refresh failures and risk without repeating a warning', () => {
    const message = { conflict: '', primary: SAVE_FAILED, risk: '', draftListRefreshFailed: false };
    expect(withDraftListRefreshFailure(message, SAVE_FAILED)).toEqual({ conflict: '', primary: '', risk: SAVE_FAILED, draftListRefreshFailed: true });
    expect(renderStatusMessage({ conflict: 'C.', primary: 'Saving…', risk: '', draftListRefreshFailed: true })).toBe('C. Saving… — document list could not be refreshed');
  });
});
