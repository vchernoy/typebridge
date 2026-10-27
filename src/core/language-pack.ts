export interface Mapping { readonly input: string; readonly output: string }
export interface LanguagePack {
  readonly id: string;
  readonly version: number;
  readonly direction: 'latin-to-cyrillic';
  readonly separator: string;
  readonly casePolicy: 'first-letter';
  readonly mappings: readonly Mapping[];
}
export interface ValidationError { readonly code: 'metadata' | 'mapping' | 'conflict'; readonly message: string }

export function validateLanguagePack(pack: LanguagePack): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(pack.id) || !Number.isSafeInteger(pack.version) || pack.version < 1 || pack.direction !== 'latin-to-cyrillic' || pack.casePolicy !== 'first-letter' || pack.separator !== '+') errors.push({ code: 'metadata', message: 'Invalid pack metadata or unsupported policy' });
  if (!Array.isArray(pack.mappings) || pack.mappings.length === 0 || pack.mappings.length > 512) return [...errors, { code: 'mapping', message: 'Mappings must contain 1–512 rules' }];
  const seen = new Map<string, string>();
  for (const rule of pack.mappings) {
    if (typeof rule.input !== 'string' || typeof rule.output !== 'string' || !/^(?:[a-z]{1,16}|'|#)$/.test(rule.input) || !/^[а-яё]{1,16}$/u.test(rule.output)) { errors.push({ code: 'mapping', message: 'Mappings require lowercase Latin inputs or reserved signs and lowercase Cyrillic outputs (1–16 characters)' }); continue; }
    const previous = seen.get(rule.input);
    if (previous !== undefined && previous !== rule.output) errors.push({ code: 'conflict', message: `Conflicting mapping for ${rule.input}` });
    seen.set(rule.input, rule.output);
  }
  return errors;
}
