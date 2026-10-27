import { describe, expect, it } from 'vitest';
import { validateLanguagePack } from '../src/core/language-pack';
import { russianPack } from '../src/core/russian';

describe('language pack', () => {
  it('defines a valid pack covering all 33 Russian letters', () => {
    expect(validateLanguagePack(russianPack)).toEqual([]);
    expect(new Set(russianPack.mappings.map(rule => rule.output)).size).toBe(33);
  });
  it.each([['e','е'],['je','э'],['sh','ш'],['sch','щ'],['shh','щ'],['shch','щ'],['w','щ'],['q','я'],['x','х'],['h','х']])('maps %s to %s', (input, output) => {
    expect(russianPack.mappings).toContainEqual({ input, output });
  });
  it('keeps unsupported Latin letters unmapped', () => {
    expect(russianPack.mappings.some(rule => rule.input === 'U')).toBe(false);
  });
  it('reports conflicts after Unicode normalization and accepts prefix overlap', () => {
    expect(validateLanguagePack({ ...russianPack, mappings: [{ input: 'e\u0301', output: 'а' }, { input: 'é', output: 'б' }] })).toContainEqual(expect.objectContaining({ code: 'conflict' }));
    expect(validateLanguagePack({ ...russianPack, mappings: [{ input: 's', output: 'с' }, { input: 'sh', output: 'ш' }] })).toEqual([]);
  });
  it('supports non-Russian scripts and another separator', () => {
    expect(validateLanguagePack({ id:'el', version:1, sourceScript:'Latn', targetScript:'Grek', separator:'·', casePolicy:'preserve', mappings:[{input:'th',output:'θ'}] })).toEqual([]);
  });
  it.each([{input:'',output:'а'}, {input:'a+b',output:'а'}, {input:'a'.repeat(17),output:'а'}, {input:'a',output:''}])('rejects invalid rules', rule => {
    expect(validateLanguagePack({ ...russianPack, mappings:[rule] })).toContainEqual(expect.objectContaining({code:'mapping'}));
  });
  it('rejects bad metadata and empty or excessive mappings', () => {
    expect(validateLanguagePack({ ...russianPack, id:'', version:0 })).toContainEqual(expect.objectContaining({code:'metadata'}));
    expect(validateLanguagePack({ ...russianPack, mappings:[] })).toContainEqual(expect.objectContaining({code:'mapping'}));
    expect(validateLanguagePack({ ...russianPack, mappings:Array(513).fill({input:'a',output:'а'}) })).toContainEqual(expect.objectContaining({code:'mapping'}));
  });
});
