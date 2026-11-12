import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodeSharePayload, type SharedDocument } from '../src/editor/share-link';

// Share links must decode identically wherever they are opened (#39): each engine has its own
// CompressionStream. A payload made in Node must decode in every browser, and a payload made in
// a browser must decode in Node.
const moduleScript = (): string => {
  const code = ts.transpileModule(readFileSync('src/editor/share-link.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return `{ const exports = {}; ${code} window.TypeBridgeShare = exports; }`;
};
const DOCUMENT: SharedDocument = { title: 'Письмо 🙂', text: 'Привет, мир!\nЁлка — é 👩‍💻\tконец', format: 'plain', view: 'source', edit: true };
/** Made by Node's CompressionStream from DOCUMENT. */
const GOLDEN = '1.HcxBCoJAFAbgq0xvPSfwLG6kXjBgGvasIILRRatcFG1azbpdBIKoeYIW_1zBE3iEqPUH34HESMwUEBwaX_gzegxqcveSNAnv5U_eosELtS-1Qo_G21mYoECHFk812pviT6Emd3mMtprctQsFLQa8UfsTaVqm2Sr6Ves4Mglp2hreUUCbNM_mTJp4YYQCyXI-fgE';

test('share link payloads decode the same in Node and in this browser', async ({ page }) => {
  await page.goto('/editor.html');
  await page.addScriptTag({ content: moduleScript() });
  const result = await page.evaluate(async ({ golden, document }) => {
    const api = (window as unknown as { TypeBridgeShare: typeof import('../src/editor/share-link') }).TypeBridgeShare;
    const fromNode = await api.decodeSharePayload(golden);
    const made = await api.encodeSharePayload(document);
    return { fromNode, made, roundTrip: await api.decodeSharePayload(made) };
  }, { golden: GOLDEN, document: DOCUMENT });
  expect(result.fromNode).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
  expect(result.roundTrip).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
  expect(await decodeSharePayload(result.made)).toEqual({ ok: true, document: DOCUMENT, knownFormat: true });
});
