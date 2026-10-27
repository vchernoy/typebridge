import { validateLanguagePack, type LanguagePack } from './language-pack';

/** Compile once for repeated conversions. The returned function has no side effects. */
export function createTransliterator(pack: LanguagePack): (text: string) => string {
  const errors = validateLanguagePack(pack);
  if (errors.length) throw new Error(`Invalid language pack: ${errors.map(error => error.message).join('; ')}`);
  const rules = pack.mappings.map(rule => ({ input: rule.input.normalize('NFC'), output: rule.output.normalize('NFC') }))
    .sort((a, b) => b.input.length - a.input.length);
  const match = (chars: string[], start: number) => {
    for (const rule of rules) {
      // Compare original characters so unmatched Unicode is never normalized or lost.
      const max = Math.min(chars.length, start + 32);
      for (let end = start + 1; end <= max; end++) {
        const part = chars.slice(start, end).join('').normalize('NFC');
        const candidate = pack.casePolicy === 'first-letter' ? part.toLowerCase() : part;
        if (candidate === rule.input) return { end, original: part, output: rule.output };
      }
    }
    return null;
  };
  return (text: string): string => {
    const chars = Array.from(text);
    let result = '';
    let index = 0;
    let previousMatched = false;
    while (index < chars.length) {
      if (pack.separator !== null && chars[index] === pack.separator && previousMatched && match(chars, index + 1)) {
        index++;
        previousMatched = false;
        continue;
      }
      const found = match(chars, index);
      if (found) {
        const first = Array.from(found.original)[0];
        const uppercase = pack.casePolicy === 'first-letter' && first.toUpperCase() !== first.toLowerCase() && first === first.toUpperCase();
        result += uppercase ? found.output.toUpperCase() : found.output;
        index = found.end;
        previousMatched = true;
      } else {
        result += chars[index];
        index++;
        previousMatched = false;
      }
    }
    return result;
  };
}
