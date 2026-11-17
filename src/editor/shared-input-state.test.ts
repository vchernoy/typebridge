import { describe, expect, it } from 'vitest';
import { numericInputs, INPUT_LIMIT, INPUT_BYTES } from './shared-input-state';
describe('bounded numeric reader envelope', () => {
  it('accepts finite numeric pairs as a Map, without object/prototype semantics', () => {
    expect(numericInputs([['x', 5], ['seed', 0], ['__proto__', -2]] )).toEqual(new Map([['x', 5], ['seed', 0], ['__proto__', -2]]));
  });
  it.each([undefined, null, {}, [['x', NaN]], [['x', Infinity]], [['x', '5']], [['x', {}]], [['x', 1], ['x', 2]], [['', 1]], [['x'.repeat(129), 1]], [['x', 1, 2]]].map(value => [value]))('rejects malformed snapshots %j', value => {
    expect(numericInputs(value)).toBeUndefined();
  });
  it('bounds count and UTF-8 bytes independently without traversing arbitrary graphs', () => {
    expect(numericInputs(Array.from({ length: INPUT_LIMIT + 1 }, (_, i) => ['v' + i, i]))).toBeUndefined();
    const pairs = Array.from({ length: INPUT_LIMIT }, (_, i) => ['界'.repeat(120) + i, i]);
    expect(new TextEncoder().encode(JSON.stringify(pairs)).byteLength).toBeGreaterThan(INPUT_BYTES);
    expect(numericInputs(pairs)).toBeUndefined();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(numericInputs(cyclic)).toBeUndefined();
    expect(numericInputs([['x', -0], ['y', 1e300]])).toEqual(new Map([['x', -0], ['y', 1e300]]));
  });
});
