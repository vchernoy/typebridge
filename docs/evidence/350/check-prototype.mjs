/** Static proposal checks; no production library, storage or link-behavior claims. */
/* global process, URL, document, innerWidth, console */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const name = process.env.PROTOTYPE_BROWSER ?? 'chromium';
const browsers = { chromium, firefox, webkit };
if (!browsers[name]) throw new Error('Unknown prototype browser');
const browser = await browsers[name].launch(name === 'webkit' && process.env.PROTOTYPE_WEBKIT_EXECUTABLE
  ? { executablePath: process.env.PROTOTYPE_WEBKIT_EXECUTABLE } : {});
const measurements = [];
const output = process.env.PROTOTYPE_OUTPUT ?? '/tmp/typebridge-350-prototype';
await mkdir(output, { recursive: true });
try {
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests = []; page.on('request', request => requests.push(request.url()));
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('./prototype.html', import.meta.url).href);
    const search = page.getByRole('searchbox');
    const group = page.locator('[data-group="loan"]');
    const summary = group.locator(':scope > summary');
    await summary.waitFor();
    assert.equal(await group.getAttribute('open'), null);
    assert.equal(await page.getByRole('button', { name: /Remove/ }).count(), 0);
    const collapsed = await page.evaluate(() => ({
      rowTargets: [...document.querySelectorAll('#groups summary, #groups a')].filter(el => el.checkVisibility()).length,
      height: Math.round(document.querySelector('#groups').getBoundingClientRect().height),
    }));
    assert.equal(collapsed.rowTargets, 3, 'One group disclosure, one singleton link and its Actions');
    await page.screenshot({ path: join(output, `${name}-${width}-collapsed.png`), fullPage: true });
    // A collapsed group is not an extra sequence of hidden keyboard targets.
    await search.focus(); await page.keyboard.press('Tab'); assert.equal(await summary.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Space'); assert.equal(await group.getAttribute('open'), '');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Received link 1');
    await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
      actions: [...document.querySelectorAll('summary, a')].filter(el => el.checkVisibility()).map(el => Math.round(el.getBoundingClientRect().height)) }));
    assert.ok(geometry.scroll <= width, 'No horizontal overflow');
    assert.ok(geometry.actions.every(height => height >= 44), 'Visible interaction targets at least 44px');
    // A parameter query shows only its incoming variant; source/title finds all.
    await search.fill('seed = 11');
    assert.equal(await page.locator('[data-variant]').count(), 1);
    assert.match(await summary.textContent(), /1 of 3/);
    await search.fill('Loan calculator'); assert.equal(await page.locator('[data-variant]').count(), 3);
    await search.fill('no such incoming parameter'); assert.equal(await page.locator('#status').textContent(), 'No matching shared documents.');
    await search.fill(''); assert.equal(await group.getAttribute('open'), '');
    // Clearing a search also restores a previously collapsed group.
    await summary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[data-group="loan"]').open);
    await search.fill('seed'); await search.fill('');
    assert.equal(await group.getAttribute('open'), null);
    await summary.click();
    // Native details exposes its summary as a button across browser accessibility trees.
    const actionSummary = page.locator('[data-variant="one"] summary');
    await actionSummary.click();
    const remove = page.locator('[data-variant="one"]').getByRole('button', { name: 'Remove received link' });
    await remove.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await remove.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('[data-variant]').count(), 4);
    await remove.click(); await page.locator('#confirm').click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-variant]').count(), 3);
    assert.equal(await summary.evaluate(el => el === document.activeElement), true);
    assert.match(await summary.textContent(), /2 received links/);
    // Verify group-level wording and safe cancellation, not persistence/atomicity.
    await group.locator(':scope > details > summary').click();
    await group.getByRole('button', { name: 'Remove all 2 received links' }).click();
    assert.match(await page.locator('#confirm-description').textContent(), /saved reader inputs.*Editable copies stay unchanged/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.addStyleTag({ content: 'body { font-size: 32px; }' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% text stays within viewport');
    assert.deepEqual(errors, []);
    assert.ok(requests.every(url => url.startsWith('file:')), 'Prototype makes no network requests');
    measurements.push({ browser: name, width, collapsed, ...geometry, checks: ['keyboard expansion', 'collapsed tab order', 'incoming-only search', 'search expansion restore', 'cancel focus', 'single removal focus', 'group cancel wording', '200% text', 'no network'], passed: true });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(join(output, `${name}.json`), JSON.stringify(measurements, null, 2) + '\n');
console.log(JSON.stringify(measurements));
