export interface Mapping { readonly input: string; readonly output: string }
export interface LanguagePack {
  readonly id: string;
  readonly version: number;
  readonly sourceScript: string;
  readonly targetScript: string;
  readonly separator: string | null;
  readonly casePolicy: 'first-letter' | 'preserve';
  readonly mappings: readonly Mapping[];
}
export interface ValidationError { readonly code: 'metadata' | 'mapping' | 'conflict'; readonly message: string }

export function validateLanguagePack(pack: LanguagePack): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(pack.id) || !Number.isSafeInteger(pack.version) || pack.version < 1 || !pack.sourceScript?.trim() || !pack.targetScript?.trim() || !['first-letter', 'preserve'].includes(pack.casePolicy) || (pack.separator !== null && (typeof pack.separator !== 'string' || Array.from(pack.separator).length !== 1))) errors.push({ code: 'metadata', message: 'Invalid pack metadata' });
  if (!Array.isArray(pack.mappings) || pack.mappings.length === 0 || pack.mappings.length > 512) return [...errors, { code: 'mapping', message: 'Mappings must contain 1–512 rules' }];
  const seen = new Map<string, string>();
  for (const rule of pack.mappings) {
    if (!rule || typeof rule.input !== 'string' || typeof rule.output !== 'string' || !rule.input || !rule.output || Array.from(rule.input).length > 16 || Array.from(rule.output).length > 16 || (pack.separator !== null && rule.input.includes(pack.separator))) { errors.push({ code: 'mapping', message: 'Rules require bounded non-empty strings and may not contain the separator' }); continue; }
    const input = rule.input.normalize('NFC');
    const output = rule.output.normalize('NFC');
    const previous = seen.get(input);
    if (previous !== undefined && previous !== output) errors.push({ code: 'conflict', message: `Conflicting mapping for ${input}` });
    seen.set(input, output);
  }
  return errors;
}
