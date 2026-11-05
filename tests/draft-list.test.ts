import { expect, test } from 'vitest';
import {
  draftEditedLabel,
  draftMatchesQuery,
  draftOptionLabel,
  draftPickerLabel,
  draftTextPreview,
} from '../src/editor/draft-list';

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

test('picker rows add preview, edited time and open-elsewhere mark (#175 step 8)', () => {
  expect(draftPickerLabel({
    savedTitle: 'Notes',
    displayTitle: 'Notes',
    isCurrent: false,
    unsaved: false,
    text: 'Hello   world from the body',
    updatedAt: Date.now() - 120_000,
    openElsewhere: true,
  })).toMatch(/^Notes · open in another window · Hello world from the body · 2 min ago$/);

  expect(draftTextPreview('')).toBe('');
  expect(draftTextPreview('a'.repeat(60)).endsWith('…')).toBe(true);
  expect(draftEditedLabel(Date.now())).toBe('Just now');
  expect(draftMatchesQuery({ title: 'Letter', text: 'privet', query: 'PRI' })).toBe(true);
  expect(draftMatchesQuery({ title: 'Letter', text: 'privet', query: 'xyz' })).toBe(false);
});
