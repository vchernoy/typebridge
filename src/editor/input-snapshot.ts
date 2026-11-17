import { INPUT_BYTES, inspectNumericInputs } from './numeric-inputs';
export type InputSnapshot = { version: 1; values: readonly (readonly [string, number])[] };
export type SnapshotFailure = 'malformed' | 'too-large' | 'version';
export function inspectInputSnapshot(value: unknown): { ok: true; snapshot: InputSnapshot } | { ok: false; reason: SnapshotFailure } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'malformed' };
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return { ok: false, reason: 'malformed' };
  if (raw.version !== 1) return { ok: false, reason: 'version' };
  const result = inspectNumericInputs(raw.values);
  if (!result.ok) return result;
  const snapshot: InputSnapshot = { version: 1, values: [...result.inputs] };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > INPUT_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, snapshot };
}
