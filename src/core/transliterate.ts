import { validateLanguagePack, type LanguagePack } from './language-pack';

/** Compile once for repeated conversions. The returned function has no side effects. */
export function createTransliterator(pack: LanguagePack): (text: string) => string {
  const errors = validateLanguagePack(pack);
  if (errors.length) throw new Error(`Invalid language pack: ${errors.map(error => error.message).join('; ')}`);
  const rules = new Map<string, string>();
  let maxLength = 0;
  for (const rule of pack.mappings) {
    const input = rule.input.normalize('NFC');
    const key = pack.casePolicy === 'first-letter' ? input.toLowerCase() : input;
    const output = rule.output.normalize('NFC');
    if (rules.has(key) && rules.get(key) !== output) throw new Error(`Invalid language pack: ambiguous case mapping for ${key}`);
    rules.set(key, output);
    maxLength = Math.max(maxLength, Array.from(input.normalize('NFD')).length);
  }
  const match = (chars: string[], start: number) => {
    let raw = '';
    let best: { end: number; original: string; output: string } | null = null;
    for (let end = start; end < chars.length && end - start < maxLength; end++) {
      raw += chars[end];
      const normalized = raw.normalize('NFC');
      const key = pack.casePolicy === 'first-letter' ? normalized.toLowerCase() : normalized;
      const output = rules.get(key);
      if (output !== undefined) best = { end: end + 1, original: raw, output };
    }
    return best;
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
