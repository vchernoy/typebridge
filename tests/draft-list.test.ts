import { expect, test } from 'vitest';
import { draftOptionLabel } from '../src/editor/draft-list';

test('current saved draft shows the on-screen title with a current marker', () => {
  expect(draftOptionLabel({
    savedTitle: 'Saved',
    displayTitle: 'Saved',
    isCurrent: true,
    unsaved: false,
  })).toBe('Saved (current)');
});

test('current unsaved draft shows the on-screen title, not the stale saved title', () => {
  expect(draftOptionLabel({
    savedTitle: 'My title',
    displayTitle: 'New title',
    isCurrent: true,
    unsaved: true,
  })).toBe('New title (current, unsaved)');
});

test('other drafts keep their saved titles', () => {
  expect(draftOptionLabel({
    savedTitle: 'Other',
    displayTitle: 'New title',
    isCurrent: false,
    unsaved: true,
  })).toBe('Other');
});
