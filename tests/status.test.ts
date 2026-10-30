import { expect, test } from 'vitest';
import { renderStatusMessage } from '../src/editor/status';

test('conflict feedback precedes a newer risk and list failure', () => {
  expect(renderStatusMessage({ conflict: false, primary: 'Conflict copy saved.', risk: 'Storage upgraded.', draftListRefreshFailed: true }))
    .toBe('Conflict copy saved. — draft list could not be refreshed. Storage upgraded.');
});

test('a risk-only status has no leading separator when list refresh fails', () => {
  expect(renderStatusMessage({ conflict: false, primary: '', risk: 'Unsaved changes.', draftListRefreshFailed: true }))
    .toBe('Draft list could not be refreshed. Unsaved changes.');
});

test('an action and an authoritative risk keep their separation', () => {
  expect(renderStatusMessage({ conflict: false, primary: 'Text exported', risk: 'Unsaved changes.', draftListRefreshFailed: false }))
    .toBe('Text exported. Unsaved changes.');
});

test('replacing risk state does not retain or parse an old warning', () => {
  const primary = 'Conflict copy saved.';
  expect(renderStatusMessage({ conflict: false, primary, risk: 'Save failed.', draftListRefreshFailed: false }))
    .toBe('Conflict copy saved. Save failed.');
  expect(renderStatusMessage({ conflict: false, primary, risk: 'Storage upgraded.', draftListRefreshFailed: true }))
    .toBe('Conflict copy saved. — draft list could not be refreshed. Storage upgraded.');
});

test('clearing primary and risk clears old feedback', () => {
  expect(renderStatusMessage({ conflict: false, primary: 'Saved locally', risk: '', draftListRefreshFailed: false })).toBe('Saved locally');
});


test('a conflict notice is independent of current save progress', () => {
  expect(renderStatusMessage({ conflict: true, primary: 'Saving…', risk: '', draftListRefreshFailed: false }))
    .toBe('Another tab changed this draft. Your edits were saved as a conflict copy. Saving…');
});
