import { expect, test } from 'vitest';
import { CONFLICT_COPY, CONFLICT_COPY_LEFT, renderStatusBody, renderStatusMessage, statusLineParts, withDraftListRefreshFailure } from '../src/editor/status';

test('conflict feedback precedes a newer risk and list failure', () => {
  expect(renderStatusMessage({
    conflict: CONFLICT_COPY,
    primary: '',
    risk: 'Storage upgraded.',
    draftListRefreshFailed: true,
  })).toBe(CONFLICT_COPY + ' Draft list could not be refreshed. Storage upgraded.');
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
  })).toBe(CONFLICT_COPY + ' Draft list could not be refreshed. Storage upgraded.');
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

test('list refresh failure strips a trailing period but keeps an ellipsis', () => {
  expect(renderStatusBody({
    conflict: '',
    primary: 'Saved locally.',
    risk: '',
    draftListRefreshFailed: true,
  })).toBe('Saved locally — draft list could not be refreshed');
  expect(renderStatusBody({
    conflict: '',
    primary: 'Saving…',
    risk: '',
    draftListRefreshFailed: true,
  })).toBe('Saving… — draft list could not be refreshed');
});

test('conflict text is omitted from the body live region', () => {
  expect(renderStatusBody({
    conflict: CONFLICT_COPY,
    primary: 'Saved locally',
    risk: '',
    draftListRefreshFailed: false,
  })).toBe('Saved locally');
});

test('status line parts match the conflict / separator / body DOM split', () => {
  expect(statusLineParts({
    conflict: CONFLICT_COPY,
    primary: 'Saved locally',
    risk: '',
    draftListRefreshFailed: false,
  })).toEqual({ conflict: CONFLICT_COPY, sep: ' ', body: 'Saved locally' });
  expect(statusLineParts({
    conflict: '',
    primary: 'Saved locally',
    risk: '',
    draftListRefreshFailed: false,
  })).toEqual({ conflict: '', sep: '', body: 'Saved locally' });
  expect(statusLineParts({
    conflict: CONFLICT_COPY,
    primary: '',
    risk: '',
    draftListRefreshFailed: false,
  })).toEqual({ conflict: CONFLICT_COPY, sep: '', body: '' });
  // During a deferred re-announce the live region is briefly empty.
  expect(statusLineParts({
    conflict: CONFLICT_COPY,
    primary: 'Saving…',
    risk: '',
    draftListRefreshFailed: false,
  }, '')).toEqual({ conflict: CONFLICT_COPY, sep: '', body: 'Saving…' });
});
