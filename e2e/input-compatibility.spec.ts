import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('e2e/fixtures/input-compatibility.ts'), name: 'CompatibilityFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
async function compatible(page: Page, source: string, values: unknown) {
  await page.goto('/read.html');
  await page.addScriptTag({ content: await fixtureCode() });
  return page.evaluate(({ source, values }) => {
    const before = document.body.innerHTML;
    let opens = 0, writes = 0;
    const open = IDBFactory.prototype.open, set = Storage.prototype.setItem;
    IDBFactory.prototype.open = function (...args) { opens++; return open.apply(this, args); };
    Storage.prototype.setItem = function (...args) { writes++; return set.apply(this, args); };
    try {
      const fixture = (window as unknown as { CompatibilityFixture: { compatibleInputSnapshot: (source: string, locale: string, value: unknown) => unknown } }).CompatibilityFixture;
      const result = fixture.compatibleInputSnapshot(source, 'en', values);
      return { result, opens, writes, unchanged: document.body.innerHTML === before };
    } finally { IDBFactory.prototype.open = open; Storage.prototype.setItem = set; }
  }, { source, values });
}
const snapshot = (values: [string, number][]) => ({ version: 1, values });
const source = '```calc\ninput x = 2 in 1..10\ninput seed = 3 in 0..20\ny = x + seed\n```\n\n:input[x] :value[y]\n\n$y={{y}}$';

test('compatibility uses accepted runtime inputs including model-only values, without visible or stored changes', async ({ page }) => {
  expect(await compatible(page, source, snapshot([['x', 7], ['seed', 8], ['y', 99], ['removed', 4]]))).toEqual({ result: snapshot([['x', 7], ['seed', 8]]), opens: 0, writes: 0, unchanged: true });
});

test('changed source skips incompatible names and values and fills current authored defaults', async ({ page }) => {
  const changed = source.replace('input x = 2 in 1..10', 'input renamed = 4 in 1..6').replace('y = x + seed', 'y = renamed + seed').replace(':input[x]', ':input[renamed]');
  expect(await compatible(page, changed, snapshot([['x', 7], ['seed', 30]]))).toEqual({ result: snapshot([['renamed', 4], ['seed', 3]]), opens: 0, writes: 0, unchanged: true });
});

test('invalid envelopes and invalid source are unavailable, while no-input source has accepted empty state', async ({ page }) => {
  for (const invalid of [undefined, { version: 2, values: [] }, snapshot([['x', 4], ['x', 5]]), snapshot([['x', Infinity]])]) {
    expect((await compatible(page, source, invalid)).result).toBeUndefined();
  }
  expect((await compatible(page, '```calc\ninput x =\n```', snapshot([]))).result).toBeUndefined();
  expect(await compatible(page, 'Plain Markdown without inputs', snapshot([['x', 7]]))).toEqual({ result: snapshot([]), opens: 0, writes: 0, unchanged: true });
});

test('all rendered controls can narrow a numeric input beyond its model range', async ({ page }) => {
  const narrowed = source.replace(':input[x]', ':input[x]{min=1 max=6} :input[x]{widget=slider min=1 max=6}');
  expect(await compatible(page, narrowed, snapshot([['x', 7], ['seed', 8]]))).toEqual({ result: snapshot([['x', 2], ['seed', 8]]), opens: 0, writes: 0, unchanged: true });
});
