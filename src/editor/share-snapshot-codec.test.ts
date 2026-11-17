import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { decodeSharePayload, encodeSharePayload, SHARE_DECOMPRESSED_MAX_BYTES, SHARE_PAYLOAD_MAX_CHARS, type SharedDocument } from './share-link';
const options = { inputSnapshots: true };
const base: SharedDocument = { title: 'Snapshot fixture', text: '```calc\ninput x = 2\n```', format: 'markdown', view: 'rendered', edit: true };
const wire = (value: unknown, prefix = '2') => prefix + '.' + deflateRawSync(JSON.stringify(value)).toString('base64url');
describe('opt-in snapshot wire codec', () => {
  it('keeps v1 bytes unchanged and rejects v2 on production defaults', async () => {
    expect(await encodeSharePayload(base, options)).toEqual(await encodeSharePayload(base));
    const snapshot: SharedDocument = { ...base, inputs: { version: 1, values: [['x', 7]] } };
    expect(await encodeSharePayload(snapshot)).toEqual({ ok: false, reason: 'version' });
    const made = await encodeSharePayload(snapshot, options);
    if (!made.ok) throw new Error('Fixture refused');
    expect(made.payload).toMatch(/^2\./);
    expect(await decodeSharePayload(made.payload)).toEqual({ ok: false, reason: 'version' });
    expect(await decodeSharePayload(made.payload, options)).toEqual({ ok: true, document: snapshot, knownFormat: true });
    const legacy = await decodeSharePayload(wire(snapshot, '1'), options);
    expect(legacy).toEqual({ ok: true, document: base, knownFormat: true });
  });
  it('retains explicit empty snapshots and unknown formats without altering source', async () => {
    const snapshot: SharedDocument = { ...base, format: 'future-format', heading: false, edit: false, inputs: { version: 1, values: [] } };
    const made = await encodeSharePayload(snapshot, options); if (!made.ok) throw new Error('Fixture refused');
    expect(await decodeSharePayload(made.payload, options)).toEqual({ ok: true, document: snapshot, knownFormat: false });
  });
  it('refuses malformed/versioned envelopes from independently constructed wire data', async () => {
    for (const inputs of [undefined, null, { version: 1, values: [['x', '7']] }, { version: 1, values: [['x', 1], ['x', 2]] }]) {
      expect(await decodeSharePayload(wire({ ...base, inputs }), options)).toEqual({ ok: false, reason: 'malformed' });
      if (inputs !== undefined) expect(await encodeSharePayload({ ...base, inputs } as unknown as SharedDocument, options)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(await decodeSharePayload(wire({ ...base, inputs: { version: 42, values: [] } }), options)).toEqual({ ok: false, reason: 'version' });
  });
  it('keeps whole-link limits in force before and during inflation', async () => {
    expect(await decodeSharePayload('2.' + 'a'.repeat(SHARE_PAYLOAD_MAX_CHARS + 1), options)).toEqual({ ok: false, reason: 'too-large' });
    const huge = { ...base, text: 'x'.repeat(SHARE_DECOMPRESSED_MAX_BYTES), inputs: { version: 1, values: [] } };
    expect(await decodeSharePayload(wire(huge), options)).toEqual({ ok: false, reason: 'too-large' });
    expect(await encodeSharePayload(huge as SharedDocument, options)).toEqual({ ok: false, reason: 'too-large' });
    expect(await decodeSharePayload('2.not-valid!', options)).toEqual({ ok: false, reason: 'malformed' });
  });
});
