import { build } from 'vite';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeSharePayload, encodeSharePayload, type SharedDocument } from '../src/editor/share-link';

// Share links must decode identically wherever they are opened (#39): each engine has its own
// CompressionStream. A payload made in Node must decode in every browser, and a payload made in
// a browser must decode in Node.
let script: string | undefined;
const moduleScript = async (): Promise<string> => {
  if (script) return script;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('src/editor/share-link.ts'), name: 'TypeBridgeShare', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const chunk = (Array.isArray(built) ? built : [built]).flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('No codec fixture');
  return script = chunk.code;
};
const DOCUMENT: SharedDocument = { title: 'Письмо 🙂', text: 'Привет, мир!\nЁлка — é 👩‍💻\tконец', format: 'plain', view: 'source', edit: true };
/** Made by Node's CompressionStream from DOCUMENT. */
const GOLDEN = '1.HcxBCoJAFAbgq0xvPSfwLG6kXjBgGvasIILRRatcFG1azbpdBIKoeYIW_1zBE3iEqPUH34HESMwUEBwaX_gzegxqcveSNAnv5U_eosELtS-1Qo_G21mYoECHFk812pviT6Emd3mMtprctQsFLQa8UfsTaVqm2Sr6Ves4Mglp2hreUUCbNM_mTJp4YYQCyXI-fgE';

test('share link payloads decode the same in Node and in this browser', async ({ page }) => {
  await page.goto('/editor.html');
  await page.addScriptTag({ content: await moduleScript() });
  const result = await page.evaluate(async ({ golden, document }) => {
    const api = (window as unknown as { TypeBridgeShare: typeof import('../src/editor/share-link') }).TypeBridgeShare;
    const fromNode = await api.decodeSharePayload(golden);
    const encoded = await api.encodeSharePayload(document);
    if (!encoded.ok) throw new Error('refused');
    const made = encoded.payload;
    return { fromNode, made, roundTrip: await api.decodeSharePayload(made) };
  }, { golden: GOLDEN, document: DOCUMENT });
  expect(result.fromNode).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
  expect(result.roundTrip).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
  expect(await decodeSharePayload(result.made)).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
});

for (const values of [[], [['x', 7], ['seed', 0], ['__proto__', 5]]] as [string, number][][]) {
  test(`snapshot codec opt-in cross-engine vector with ${values.length} inputs`, async ({ page }) => {
    const document: SharedDocument = { ...DOCUMENT, format: 'markdown', inputs: { version: 1, values } };
    const made = await encodeSharePayload(document, { inputSnapshots: true });
    if (!made.ok) throw new Error('Node fixture refused');
    const requests: string[] = []; page.on('request', request => requests.push(request.url()));
    // The production route must still reject v2 while initialization is not wired.
    await page.goto('/read.html#doc=' + made.payload);
    await expect(page.locator('#read-title')).toHaveText('This shared document cannot be opened');
    await expect(page.locator('#read-text')).toContainText('newer version');
    expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
    expect(requests.filter(url => /active-renderer|\.woff2/.test(url))).toEqual([]);
    await page.addScriptTag({ content: await moduleScript() });
    const result = await page.evaluate(async ({ document, payload }) => {
      const api = (window as unknown as { TypeBridgeShare: typeof import('../src/editor/share-link') }).TypeBridgeShare;
      const refused = await api.decodeSharePayload(payload);
      const fromNode = await api.decodeSharePayload(payload, { inputSnapshots: true });
      const encoded = await api.encodeSharePayload(document, { inputSnapshots: true });
      if (!encoded.ok) throw new Error('Browser fixture refused');
      return { refused, fromNode, payload: encoded.payload };
    }, { document, payload: made.payload });
    expect(result.refused).toEqual({ ok: false, reason: 'version' });
    expect(result.fromNode).toEqual({ ok: true, document, knownFormat: true });
    expect(await decodeSharePayload(result.payload, { inputSnapshots: true })).toEqual({ ok: true, document, knownFormat: true });
  });
}
