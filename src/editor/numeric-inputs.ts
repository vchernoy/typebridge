/** Pure bounded numeric state validation; no browser, storage or renderer dependencies. */
export const INPUT_LIMIT = 256;
export const INPUT_BYTES = 64 * 1024;
export type NumericInputFailure = 'malformed' | 'too-large';
export function inspectNumericInputs(value: unknown): { ok: true; inputs: Map<string, number> } | { ok: false; reason: NumericInputFailure } {
  if (!Array.isArray(value)) return { ok: false, reason: 'malformed' };
  if (value.length > INPUT_LIMIT) return { ok: false, reason: 'too-large' };
  const inputs = new Map<string, number>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0]
      || typeof entry[1] !== 'number' || !Number.isFinite(entry[1]) || inputs.has(entry[0])) return { ok: false, reason: 'malformed' };
    if (entry[0].length > 128) return { ok: false, reason: 'too-large' };
    inputs.set(entry[0], entry[1]);
  }
  if (new TextEncoder().encode(JSON.stringify([...inputs])).byteLength > INPUT_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, inputs };
}
export function numericInputs(value: unknown): Map<string, number> | undefined {
  const result = inspectNumericInputs(value);
  return result.ok ? result.inputs : undefined;
}
