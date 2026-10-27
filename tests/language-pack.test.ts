import { describe, expect, it } from 'vitest';
import { validateLanguagePack, type LanguagePack } from '../src/core/language-pack';
import { russianPack } from '../src/core/russian';

describe('language pack contract', () => {
  it('accepts the default pack and overlapping prefixes', () => {
    expect(validateLanguagePack(russianPack)).toEqual([]);
    expect(russianPack.mappings).toContainEqual({ input: 'sh', output: 'ш' });
    expect(russianPack.mappings).toContainEqual({ input: 'shch', output: 'щ' });
  });
  it('reports conflicting identical inputs but allows aliases', () => {
    const pack = { ...russianPack, mappings: [{ input: 'a', output: 'а' }, { input: 'a', output: 'б' }] };
    expect(validateLanguagePack(pack)).toEqual([expect.objectContaining({ code: 'conflict' })]);
    expect(validateLanguagePack({ ...pack, mappings: [{ input: 'a', output: 'а' }, { input: 'aa', output: 'а' }] })).toEqual([]);
  });
  it.each(['', 'A', 'a+b', 'a'.repeat(17)])('rejects invalid input %s', (input) => {
    expect(validateLanguagePack({ ...russianPack, mappings: [{ input, output: 'а' }] }).some(e => e.code === 'mapping')).toBe(true);
  });
  it.each(['', 'A', 'а'.repeat(17)])('rejects invalid output %s', (output) => {
    expect(validateLanguagePack({ ...russianPack, mappings: [{ input: 'a', output }] }).some(e => e.code === 'mapping')).toBe(true);
  });
  it('rejects invalid metadata and unbounded or empty mappings', () => {
    expect(validateLanguagePack({ ...russianPack, id: '', version: 0 }).some(e => e.code === 'metadata')).toBe(true);
    expect(validateLanguagePack({ ...russianPack, mappings: [] })).toHaveLength(1);
    expect(validateLanguagePack({ ...russianPack, mappings: Array(513).fill({ input: 'a', output: 'а' }) })).toHaveLength(1);
    expect(validateLanguagePack({ ...russianPack, separator: '-' } as LanguagePack).some(e => e.code === 'metadata')).toBe(true);
  });
});
