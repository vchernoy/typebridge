import { describe, expect, it } from 'vitest';
import { createTransliterator } from '../src/core/transliterate';
import { russianPack } from '../src/core/russian';

const transliterate = createTransliterator(russianPack);
describe('transliteration', () => {
  it.each([['privet','привет'],['Privet','Привет'],['schuka','щука'],['shchuka','щука'],['s+h','сх'],['yozh','ёж'],['Sh SH sH','Ш Ш ш'],['hello мир!','хелло мир!'],['privet\nyozh','привет\nёж'],['',''],['🙂 + — 42','🙂 + — 42'],['s++h','с++х'],['+s+','+с+']])('%s → %s', (input, expected) => expect(transliterate(input)).toBe(expected));
  it('preserves unsupported Unicode and combining marks', () => expect(transliterate('🙂 漢字 e\u0301')).toBe('🙂 漢字 е\u0301'));
  it('rejects invalid packs', () => expect(() => createTransliterator({ ...russianPack, mappings: [] })).toThrow('Invalid language pack'));
  it('supports another pack and exact case policy', () => {
    const convert = createTransliterator({ id:'el',version:1,sourceScript:'Latn',targetScript:'Grek',separator:'·',casePolicy:'preserve',mappings:[{input:'th',output:'θ'},{input:'t',output:'τ'},{input:'h',output:'η'}] });
    expect(convert('th t·h TH')).toBe('θ τη TH');
  });
});
