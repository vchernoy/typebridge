import { expect, test } from 'vitest';
import { CONFLICT_COPY, CONFLICT_COPY_LEFT, renderStatusMessage, withDraftListRefreshFailure } from '../src/editor/status';

const CONFLICT_COPY_STEM = CONFLICT_COPY.replace(/\.$/, '');

test('conflict feedback precedes a newer risk and list failure', () => {
  expect(renderStatusMessage({
    conflict: CONFLICT_COPY,
    primary: '',
    risk: 'Storage upgraded.',
    draftListRefreshFailed: true,
  })).toBe(CONFLICT_COPY_STEM + ' — draft list could not be refreshed. Storage upgraded.');
});

test('a risk-only status has no leading separator when list refresh fails', () => {
  expect(renderStatusMessage({ conflict: '', primary: '', risk: 'Unsaved changes.', draftListRefreshFailed: true }))
    .toBe('Draft list could not be refreshed. Unsaved changes.');
});

test('an action and an authoritative risk keep their separation', () => {
  expect(renderStatusMessage({ conflict: '', primary: 'Text exported', risk: 'Unsaved changes.', draftListRefreshFailed: false }))
    .toBe('Text exported. Unsaved changes.');
});

test('replacing risk state does not retain or parse an old warning', () => {
  expect(renderStatusMessage({ conflict: CONFLICT_COPY, primary: '', risk: 'Save failed.', draftListRefreshFailed: false }))
    .toBe(CONFLICT_COPY + ' Save failed.');
  expect(renderStatusMessage({
    conflict: CONFLICT_COPY,
    primary: '',
    risk: 'Storage upgraded.',
    draftListRefreshFailed: true,
  })).toBe(CONFLICT_COPY_STEM + ' — draft list could not be refreshed. Storage upgraded.');
});

test('clearing primary and risk clears old feedback', () => {
  expect(renderStatusMessage({ conflict: '', primary: 'Saved locally', risk: '', draftListRefreshFailed: false })).toBe('Saved locally');
});

test('a conflict notice is independent of current save progress', () => {
  expect(renderStatusMessage({ conflict: CONFLICT_COPY, primary: 'Saving…', risk: '', draftListRefreshFailed: false }))
    .toBe(CONFLICT_COPY + ' Saving…');
});

test('a left-draft conflict notice uses distinct wording', () => {
  expect(renderStatusMessage({
    conflict: CONFLICT_COPY_LEFT,
    primary: '',
    risk: 'Storage upgraded.',
    draftListRefreshFailed: false,
  })).toBe(CONFLICT_COPY_LEFT + ' Storage upgraded.');
});

test('list refresh failure does not duplicate a warning already shown as primary', () => {
  const risk = 'Autosave off — changes are unsaved';
  expect(renderStatusMessage(withDraftListRefreshFailure(
    { conflict: '', primary: risk, risk: '', draftListRefreshFailed: false },
    risk,
  ))).toBe('Draft list could not be refreshed. ' + risk);
});

test('list refresh failure does not leave a period before the em dash', () => {
  expect(renderStatusMessage({
    conflict: CONFLICT_COPY,
    primary: '',
    risk: '',
    draftListRefreshFailed: true,
  })).toBe(CONFLICT_COPY_STEM + ' — draft list could not be refreshed');
});
