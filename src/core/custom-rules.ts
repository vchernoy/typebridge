import { russianPack } from './russian';
import { createTransliterator } from './transliterate';
import { validateLanguagePack } from './language-pack';

export const RULES_KEY = 'typebridge-rules-v1';
export type Overrides = Record<string, string>;
const defaults = new Map(russianPack.mappings.map(rule => [rule.input, rule.output]));
export function effectivePack(overrides: Overrides) {
  const mappings = russianPack.mappings.map(rule => ({ ...rule, output: overrides[rule.input] ?? rule.output }));
  for (const [input, output] of Object.entries(overrides)) {
    if (!defaults.has(input)) mappings.push({ input, output });
  }
  return { ...russianPack, mappings };
}
export function validateOverrides(value: unknown): Overrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a rules object');
  const entries = Object.entries(value);
  if (entries.length > 512) throw new Error('Too many custom rules');
  const overrides: Overrides = Object.create(null) as Overrides;
  for (const [input, output] of entries) {
    if (!/^[a-zA-Z']{1,16}$/.test(input) || typeof output !== 'string' || !/^[а-яА-ЯёЁъЪьЬ]{1,16}$/.test(output))
      throw new Error('Rules must map 1–16 Latin letters to 1–16 Cyrillic letters');
    if (input !== input.toLowerCase()) throw new Error('Use lowercase Latin inputs');
    overrides[input] = output;
  }
  const pack = effectivePack(overrides);
  const errors = validateLanguagePack(pack);
  if (errors.length) throw new Error(errors[0].message);
  createTransliterator(pack);
  return overrides;
}
export function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1)
      throw new Error('Unsupported settings version');
    return validateOverrides((parsed as { overrides?: unknown }).overrides);
  } catch { return {}; }
}
export function saveOverrides(overrides: Overrides): void {
  const validated = validateOverrides(overrides);
  localStorage.setItem(RULES_KEY, JSON.stringify({ version: 1, overrides: validated }));
}
export function exportRules(overrides: Overrides): string {
  return JSON.stringify({ version: 1, overrides: validateOverrides(overrides) }, null, 2);
}
export function importRules(raw: string): Overrides {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1)
    throw new Error('Unsupported rules file version');
  return validateOverrides((parsed as { overrides?: unknown }).overrides);
}
