// Baseline probe for #349; run from main 081353a before snapshot support lands.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { decodeSharePayload } from '../../../src/editor/share-link.ts';

const json = {
  title: 'Synthetic compatibility fixture',
  text: '```calc\ninput x = 2\n```\n\n:input[x]',
  format: 'markdown', view: 'rendered', edit: true,
  inputs: { version: 1, values: [['x', 7]] },
};
const bytes = deflateRawSync(Buffer.from(JSON.stringify(json))).toString('base64url');
const legacy = await decodeSharePayload('1.' + bytes);
const future = await decodeSharePayload('2.' + bytes);
assert.equal(legacy.ok, true);
assert.equal(Object.hasOwn(legacy.document, 'inputs'), false);
assert.deepEqual(future, { ok: false, reason: 'version' });
globalThis.console.log(JSON.stringify({
  baseline: '081353a',
  v1_with_extra_inputs: { accepted: legacy.ok, retained_input_envelope: false },
  v2_prefix: future,
}, null, 2));
