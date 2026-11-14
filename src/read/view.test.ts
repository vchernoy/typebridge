import { expect, it } from 'vitest';
import { readingView } from './view';
it('renders Markdown only when the link asks for rendered view', () => {
  expect(readingView({ format: 'markdown', view: 'rendered' })).toBe('rendered');
  expect(readingView({ format: 'markdown', view: 'source' })).toBe('source');
  expect(readingView({ format: 'plain', view: 'rendered' })).toBe('source');
  expect(readingView({ format: 'unknown', view: 'rendered' })).toBe('source');
});
