import { test, expect } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = '# Offline fixture\n\n```calc\ninput x = 2 in 0..10\ny = x * 3\n```\n\n:slider[Amount]{input=x step=1}\n\nResult: :value[y]\n\n$y={{y}}$\n\nUnicode: café 日本語 🖥️\n\n```text\n</script><script>window.pwned=1</script>\n```\n\n[Unsafe](javascript:alert(1))';

test('two documents exported by the same offline template open as one reactive local HTML file', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 390, height: 844 } });
  const network: string[] = [], errors: string[] = [], storage: string[] = [];
  context.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    const w = window as unknown as { storageAttempts: string[] }; w.storageAttempts = [];
    IDBFactory.prototype.open = () => { w.storageAttempts.push('indexedDB'); throw new Error('No storage in standalone'); };
    Storage.prototype.setItem = () => { w.storageAttempts.push('storage'); throw new Error('No storage in standalone'); };
  });
  const demo = await context.newPage(); demo.on('pageerror', error => errors.push(error.message));
  await demo.goto(pathToFileURL(resolve('dist-standalone/export-demo.html')).href);
  const timings: { format: string; bytes: number; readyMs: number; heapBytes: number | null }[] = [];
  for (const format of ['markdown', 'plain'] as const) {
    const title = 'Exported ' + format + ' </title><script>window.pwned=2</script>';
    await demo.locator('#title').fill(title);
    await demo.locator('#source').fill(source + '\n\nOnly ' + format);
    await demo.locator('#format').selectOption(format);
    const downloadPromise = demo.waitForEvent('download'); await demo.locator('#download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('document.html');
    const file = testInfo.outputPath(format + '.html'); await download.saveAs(file);
    const html = await readFile(file, 'utf8');
    const match = html.match(/<script id="standalone-data" type="application\/octet-stream">([^<]+)<\/script>/)!;
    expect(JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))).toEqual({ title, text: source + '\n\nOnly ' + format, format });
    expect(html).toMatch(/data:font\/woff2;base64,/);
    expect(html).not.toContain('src="http'); expect(html).not.toContain('TYPEBRIDGE_STANDALONE_DATA_V1');
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const start = Date.now(); await page.goto(pathToFileURL(file).href);
    await expect(page.locator('#title')).toHaveText(title);
    await expect(page.locator('#document')).toContainText('Only ' + format);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    let readyMs = Date.now() - start;
    if (format === 'markdown') {
      await expect(page.getByRole('slider', { name: 'Amount' })).toHaveValue('2');
      await expect(page.locator('output[data-active-value="y"]')).toHaveText('6');
      await expect(page.locator('math mn')).toHaveText('6');
      readyMs = Date.now() - start;
      await page.getByRole('slider', { name: 'Amount' }).fill('7');
      await expect(page.locator('output[data-active-value="y"]')).toHaveText('21');
      await expect(page.locator('math mn')).toHaveText('21');
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await page.getByRole('button', { name: 'Reset inputs' }).click();
      await expect(page.getByRole('slider', { name: 'Amount' })).toHaveValue('2');
      await expect(page.locator('math mn')).toHaveText('6');
      expect(await page.evaluate(async () => (await document.fonts.load('16px "Fira Math"')).length)).toBeGreaterThan(0);
      await expect(page.locator('#document script, #document a[href^="javascript:"]')).toHaveCount(0);
    } else {
      await expect(page.locator('#document pre')).toHaveText(source + '\n\nOnly plain');
      await expect(page.locator('#reset')).toBeHidden();
    }
    timings.push({ format, bytes: (await stat(file)).size, readyMs, heapBytes: await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null) });
    storage.push(...await page.evaluate(() => (window as unknown as { storageAttempts: string[] }).storageAttempts));
    await page.close();
  }
  storage.push(...await demo.evaluate(() => (window as unknown as { storageAttempts: string[] }).storageAttempts));
  expect(network).toEqual([]); expect(storage).toEqual([]); expect(errors).toEqual([]);
  const metrics = testInfo.outputPath('standalone-metrics.json');
  await writeFile(metrics, JSON.stringify({ timings, networkAttempts: network.length, storageAttempts: storage.length, browser: testInfo.project.name }, null, 2));
  await testInfo.attach('standalone-metrics', { path: metrics, contentType: 'application/json' });
  await context.close();
});
