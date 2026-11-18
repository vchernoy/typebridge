import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type * as Fixture from './fixtures/accepted-input-capture';
let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('e2e/fixtures/accepted-input-capture.ts'), name: 'AcceptedInputFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
type BrowserFixture = typeof Fixture;
async function setup(page: Page, publicMemory = false, empty = false, stored = false) {
  await page.addInitScript(stored => {
    (window as unknown as { captureDatabaseOpens: number }).captureDatabaseOpens = 0;
    (window as unknown as { captureDatabaseTransactions: number }).captureDatabaseTransactions = 0;
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      (window as unknown as { captureDatabaseOpens: number }).captureDatabaseOpens++;
      if (!stored) throw new Error('Capture must not open storage');
      return open.apply(this, args);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      (window as unknown as { captureDatabaseTransactions: number }).captureDatabaseTransactions++;
      return transaction.apply(this, args);
    };
  }, stored);
  await page.goto('/read.html'); await page.addScriptTag({ content: await fixtureCode() });
  await page.evaluate(async ({ publicMemory, empty, stored }) => {
    const fixture = (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture;
    await fixture.setup(publicMemory, empty ? 'Ordinary Markdown with no numeric inputs.' : fixture.source, stored);
  }, { publicMemory, empty, stored });
}
const capture = (page: Page) => page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.capture());
const expected = (x: number) => ({ version: 1, values: [['x', x], ['seed', 3]] });
for (const publicMemory of [false, true]) {
  test(`accepted capture is independent, model-only aware and ignores invalid control text: public=${publicMemory}`, async ({ page }) => {
    await setup(page, publicMemory); expect(await capture(page)).toBeUndefined();
    expect(await page.evaluate(() => { const fixture = (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture; fixture.render(); return fixture.capture(); })).toBeUndefined();
    const input = page.locator('#rendered-document input'); await expect(input).toHaveValue('2');
    await input.fill('7'); await expect(page.locator('#rendered-document output')).toHaveText('10');
    expect(await capture(page)).toEqual(expected(7));
    await input.fill('0'); await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(await capture(page)).toEqual(expected(7));
    expect(await page.evaluate(() => {
      const fixture = (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture;
      const snapshot = fixture.capture()!;
      (snapshot.values as [string, number][])[0][1] = 99;
      return fixture.capture();
    })).toEqual(expected(7));
    await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.edit());
    await expect(page.locator('#rendered-document input')).toHaveCount(0);
    expect(await capture(page)).toEqual(expected(7));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    expect(await capture(page)).toBeUndefined();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(await capture(page)).toEqual(expected(7));
    expect(await page.evaluate(() => (window as unknown as { captureDatabaseOpens: number }).captureDatabaseOpens)).toBe(0);
  });
}
test('source/document/epoch changes and clear invalidate capture without guessing or storage lookups', async ({ page }) => {
  await setup(page); await page.locator('#document-view-preview').click();
  await expect(page.locator('#rendered-document input')).toHaveValue('2');
  await page.locator('#rendered-document input').fill('7');
  await page.locator('#document-view-edit').click(); const original = await page.locator('#editor').inputValue();
  await page.locator('#editor').fill(original + '\nNew source context'); expect(await capture(page)).toBeUndefined();
  await page.locator('#editor').fill(original); expect(await capture(page)).toEqual(expected(7));
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.switchDocument('capture-b'));
  expect(await capture(page)).toBeUndefined();
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.switchDocument('capture-a'));
  expect(await capture(page)).toEqual(expected(7));
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.changeEpoch());
  expect(await capture(page)).toBeUndefined();
  await page.locator('#document-view-preview').click(); await expect(page.locator('#rendered-document input')).toHaveValue('7');
  expect(await capture(page)).toEqual(expected(7));
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.clearDocument());
  expect(await capture(page)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as { captureDatabaseOpens: number }).captureDatabaseOpens)).toBe(0);
});
test('accepted empty input state is distinct from unavailable state, and plain format is never captured', async ({ page }) => {
  await setup(page, false, true); expect(await capture(page)).toBeUndefined();
  await page.locator('#document-view-preview').click(); await expect(page.locator('#rendered-document')).toHaveText('Ordinary Markdown with no numeric inputs.');
  await expect.poll(() => capture(page)).toEqual({ version: 1, values: [] });
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.plain());
  expect(await capture(page)).toBeUndefined();
});
test('an observed storage-policy retirement cannot be relabeled with the stale UI epoch', async ({ page }) => {
  await setup(page, true, false, true); await page.locator('#document-view-preview').click();
  const operations = () => page.evaluate(() => ({
    opens: (window as unknown as { captureDatabaseOpens: number }).captureDatabaseOpens,
    transactions: (window as unknown as { captureDatabaseTransactions: number }).captureDatabaseTransactions,
  }));
  await expect(page.locator('#rendered-document input')).toHaveValue('8'); await expect(page.locator('#rendered-document input')).toBeVisible();
  const initialOperations = await operations(); expect(await capture(page)).toEqual(expected(8)); expect(await operations()).toEqual(initialOperations);
  await page.locator('#document-view-edit').click();
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.retireStoredEpoch());
  await page.locator('#document-view-preview').click(); await expect(page.locator('#rendered-document input')).toHaveValue('8');
  await expect(page.locator('#editable-input-status')).toContainText('temporary');
  expect(await capture(page)).toBeUndefined();
  for (let round = 0; round < 3; round++) {
    await page.locator('#document-view-edit').click(); await page.locator('#document-view-preview').click();
    await expect(page.locator('#rendered-document input')).toHaveValue('8'); await expect(page.locator('#rendered-document input')).toBeVisible();
    await expect(page.locator('#editable-input-status')).toContainText('temporary');
    expect(await capture(page)).toBeUndefined();
  }
  const before = await operations();
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.changeEpoch());
  expect(await capture(page)).toEqual(expected(8));
  expect(await operations()).toEqual(before);
});
test('capture observing denied policy cancels a queued write and never saves private values after recovery', async ({ page }) => {
  await setup(page, true, false, true); await page.locator('#document-view-preview').click();
  const input = page.locator('#rendered-document input'); await expect(input).toHaveValue('8'); await expect(input).toBeVisible();
  await page.clock.install(); await input.fill('7'); await page.clock.runFor(50);
  expect(await page.evaluate(() => {
    const fixture = (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture;
    fixture.policy(false); return fixture.capture();
  })).toEqual(expected(7));
  await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.policy(true));
  await page.clock.fastForward(1000);
  expect(await page.evaluate(() => (window as unknown as { AcceptedInputFixture: BrowserFixture }).AcceptedInputFixture.storedInput()))
    .toMatchObject({ revision: 1, inputs: [['x', 8], ['seed', 3]] });
  expect(await capture(page)).toEqual(expected(7));
});
