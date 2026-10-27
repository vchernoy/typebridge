import { describe, expect, it } from 'vitest';
import { cyrillicToLatin } from './reverse-russian';
import { createTransliterator } from './transliterate';
import { russianPack } from './russian';
describe('selection conversion mappings', () => {
  it('converts readable Cyrillic including punctuation and mixed scripts', () => {
    expect(cyrillicToLatin('Привет, мир!')).toBe('Privet, mir!');
    expect(cyrillicToLatin('Ёж, щука, ъь')).toBe("Yozh, shchuka, #'");
    expect(cyrillicToLatin('ETF и Roth IRA')).toBe('ETF i Roth IRA');
  });
  it('uses existing Latin to Cyrillic rules', () => {
    const convert = createTransliterator(russianPack);
    expect(convert('privet mir')).toBe('привет мир');
    expect(convert('zhuk')).toBe('жук');
  });
});
