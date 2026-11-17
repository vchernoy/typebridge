import { describe, expect, it } from 'vitest';
import { inspectInputSnapshot } from './input-snapshot';
import { INPUT_BYTES, INPUT_LIMIT } from './numeric-inputs';
describe('untrusted numeric input snapshot', () => {
  it('copies finite model-only/visible pairs without object-key semantics', () => {
    const values: [string, number][] = [['x', 7], ['seed', 0], ['__proto__', -2]];
    const checked = inspectInputSnapshot({ version: 1, values, history: 'excluded' });
    expect(checked).toEqual({ ok: true, snapshot: { version: 1, values } });
    values[0][1] = 99;
    expect(checked.ok && checked.snapshot.values[0][1]).toBe(7);
    expect(inspectInputSnapshot({ version: 1, values: [] })).toEqual({ ok: true, snapshot: { version: 1, values: [] } });
  });
  it.each([null, [], {}, { version: '1', values: [] }, { version: 0, values: [] },
    { version: 1, values: [['x', '7']] }, { version: 1, values: [['x', null]] },
    { version: 1, values: [['x', NaN]] }, { version: 1, values: [['x', Infinity]] },
    { version: 1, values: [['x', {}]] }, { version: 1, values: [['', 7]] },
    { version: 1, values: [['x', 1], ['x', 2]] }, { version: 1, values: [['x', 1, 2]] },
  ].map(value => [value]))('refuses malformed schema %j', value => {
    expect(inspectInputSnapshot(value)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('distinguishes future versions and count/name/UTF-8 bounds', () => {
    expect(inspectInputSnapshot({ version: 2, values: [] })).toEqual({ ok: false, reason: 'version' });
    for (const values of [Array.from({ length: INPUT_LIMIT + 1 }, (_, i) => ['v' + i, i]), [['x'.repeat(129), 1]],
      Array.from({ length: INPUT_LIMIT }, (_, i) => ['界'.repeat(120) + i, i])]) {
      expect(inspectInputSnapshot({ version: 1, values })).toEqual({ ok: false, reason: 'too-large' });
    }
    const values = Array.from({ length: INPUT_LIMIT }, (_, i): [string, number] => ['v' + i, i]);
    expect(inspectInputSnapshot({ version: 1, values }).ok).toBe(true);
    // A multibyte envelope can fit the pair-only budget but exceed it once wrapped.
    const near = Array.from({ length: INPUT_LIMIT }, (_, i): [string, number] => ['界'.repeat(80) + i, i]);
    for (let n = 0; new TextEncoder().encode(JSON.stringify({ version: 1, values: near })).byteLength <= INPUT_BYTES; n++) near[n % near.length][0] += 'a';
    expect(new TextEncoder().encode(JSON.stringify(near)).byteLength).toBeLessThanOrEqual(INPUT_BYTES);
    expect(inspectInputSnapshot({ version: 1, values: near })).toEqual({ ok: false, reason: 'too-large' });
  });
});
