import { expect, test } from 'vitest';
import { parseWritingPosition } from '../src/editor/writing-position';

const position = { start: 1, end: 3, direction: 'backward', scrollTop: 200, scrollLeft: 0 };
test('restored selection retains direction and scroll and clamps against shorter Unicode text', () => {
  expect(parseWritingPosition(JSON.stringify(position), 'abcd')).toEqual(position);
  expect(parseWritingPosition(JSON.stringify({ ...position, start: 2, end: 99 }), 'a🙂')).toEqual({ ...position, start: 3, end: 3 });
});

test('malformed optional metadata is ignored instead of changing document state', () => {
  for (const raw of [null, '{', 'null', '[]', '{}',
    JSON.stringify({ ...position, start: -1 }), JSON.stringify({ ...position, end: 0 }),
    JSON.stringify({ ...position, start: 1.5 }), JSON.stringify({ ...position, direction: 'invalid' }),
    JSON.stringify({ ...position, scrollTop: -1 }), JSON.stringify({ ...position, scrollLeft: null })]) {
    expect(parseWritingPosition(raw, 'text')).toBeUndefined();
  }
});
