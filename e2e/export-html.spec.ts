import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { documentAction } from './settings-helpers';

// Documents → Export as interactive HTML (#386): one self-contained file that works offline.
const source = '# Offline quote\n\n```calc\ninput x = 2 in 0..10\ny = x * 3\n```\n\n:slider[Amount]{input=x step=1}\n\nResult: :value[y]\n\n$y={{y}}$\n\n```text\n</script><script>window.pwned=1</script>\n```';

async function writeMarkdown(page: Page, title: string, text: string): Promise<void> {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#draft-title').fill(title);
  await field.fill(text);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#doc-menu-open').click();
}

test('exports the current document as one HTML file that works offline from disk', async ({ page, browser }, testInfo) => {
  await writeMarkdown(page, 'Offline quote', source);
  const downloading = page.waitForEvent('download');
  await documentAction(page, '#export-html');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Offline quote.html');
  await expect(page.locator('#status-line')).toContainText('Interactive HTML exported');
  const file = testInfo.outputPath('export.html');
  await download.saveAs(file);
  const html = await readFile(file, 'utf8');
  const data = html.match(/<script id="standalone-data" type="application\/octet-stream">([^<]+)<\/script>/)![1]!;
  expect(JSON.parse(Buffer.from(data, 'base64').toString('utf8'))).toEqual({ title: 'Offline quote', text: source, format: 'markdown' });
  expect(html).not.toContain('TYPEBRIDGE_STANDALONE_DATA_V1');

  // Open the downloaded file with networking off: the controls and math still work.
  const offline = await browser.newContext({ offline: true });
  const requests: string[] = [];
  offline.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const opened = await offline.newPage();
  await opened.goto(pathToFileURL(file).href);
  await expect(opened.locator('#title')).toHaveText('Offline quote');
  await expect(opened.locator('output[data-active-value="y"]')).toHaveText('6');
  await opened.getByRole('slider', { name: 'Amount' }).fill('7');
  await expect(opened.locator('output[data-active-value="y"]')).toHaveText('21');
  await expect(opened.locator('math mn')).toHaveText('21');
  expect(await opened.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  expect(requests).toEqual([]);
  await offline.close();
});

test.describe('without the viewer', () => {
  // The offline service worker would fetch the template itself, outside page.route.
  test.use({ serviceWorkers: 'block' });
  test('a missing viewer explains itself and downloads nothing', async ({ page }) => {
    await writeMarkdown(page, 'No viewer', '# No viewer');
    await page.route('**/standalone-template.html', route => route.abort());
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await documentAction(page, '#export-html');
    await expect(page.locator('#status-line')).toContainText('Could not export interactive HTML: the viewer could not be loaded.');
    await expect(page.locator('#export-html')).toBeEnabled();
    expect(downloads).toBe(0);
  });
});
