import { expect, it } from 'vitest';
import { sameSharedCopy, sharedCopyFields } from './shared-copy';

it('uses actual imported fields and excludes presentation/search/history from equality', () => {
  const fields = sharedCopyFields({ title: '  Title  ', text: 'x\n', format: 'markdown' });
  expect(fields).toEqual({ title: 'Title', text: 'x\n', format: 'markdown' });
  expect(sameSharedCopy(fields, fields)).toBe(true);
  expect(sameSharedCopy({ ...fields, text: 'x' }, fields)).toBe(false);
  expect(sameSharedCopy({ ...fields, title: 'Title ' }, fields)).toBe(false);
  expect(sameSharedCopy({ ...fields, format: 'plain' }, fields)).toBe(false);
  expect(sharedCopyFields({ title: ' ', text: 'same', format: 'future-format' }))
    .toEqual({ title: 'Untitled document', text: 'same', format: 'plain' });
  expect(sameSharedCopy({ title: 'Untitled document', text: 'same' }, sharedCopyFields({ title: '', text: 'same', format: 'plain' }))).toBe(true);
});
