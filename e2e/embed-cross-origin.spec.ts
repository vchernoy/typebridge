import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

test('an actual cross-origin iframe stays interactive without storage or host access', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('Production preview origin is required');
  const appOrigin = new URL(baseURL).origin;
  const encoded = await encodeSharePayload({
    title: 'Cross-origin calculator', format: 'markdown', view: 'rendered', edit: false,
    text: '```calc\ninput x = 3 in 1..10\ny = x * 2\n```\n\n:slider[Amount]{input=x step=1}\n\nResult: :value[y]\n\nA note[^1].\n\n' + 'Frame-local filler.\n\n'.repeat(30) + '[^1]: Inside the frame.\n\n![No remote fetch](https://example.invalid/image.png)',
  });
  if (!encoded.ok) throw new Error('Share encoding failed');
  const embedURL = new URL('/embed.html#doc=' + encoded.payload, baseURL).href;
  // A real second HTTP origin, not page.setContent or an intercepted same-origin route.
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>External host</title><h1>External host</h1>' +
      `<iframe id="embed" title="Interactive document" src="${embedURL}" width="100%" height="450" style="border:0" referrerpolicy="no-referrer"></iframe>`);
  });
  await new Promise<void>(resolve => parent.listen(0, '127.0.0.1', resolve));
  const address = parent.address();
  if (!address || typeof address === 'string') throw new Error('Missing parent address');
  const parentOrigin = `http://127.0.0.1:${address.port}`;
  expect(parentOrigin).not.toBe(appOrigin);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const unexpectedRequests: string[] = [], errors: string[] = [];
  try {
    await context.addInitScript(() => {
      const state = window as unknown as { embedStorageAttempts: string[] };
      state.embedStorageAttempts = [];
      const denied = (kind: string): never => {
        state.embedStorageAttempts.push(kind);
        throw new Error('Embed must not access ' + kind);
      };
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { configurable: true, get: () => denied(name) });
      }
      IDBFactory.prototype.open = () => denied('indexedDB');
      if ('ServiceWorkerContainer' in window) {
        ServiceWorkerContainer.prototype.register = () => denied('serviceWorker');
      }
    });
    await context.route(/^https?:/, route => {
      const url = new URL(route.request().url());
      if (url.origin === appOrigin || url.origin === parentOrigin) return route.continue();
      unexpectedRequests.push(url.origin);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(parentOrigin + '/');
    const frame = page.frameLocator('#embed');
    await expect(frame.locator('#embed-title')).toHaveText('Cross-origin calculator');
    await expect(frame.locator('#embed-content output[data-active-value="y"]')).toHaveText('6');
    // Confirm the parent really cannot inspect the child through the same-origin policy.
    expect(await page.evaluate(() => {
      try {
        void document.querySelector<HTMLIFrameElement>('#embed')!.contentWindow!.document;
        return false;
      } catch (error) { return error instanceof DOMException && error.name === 'SecurityError'; }
    })).toBe(true);
    await frame.getByRole('slider', { name: 'Amount', exact: true }).focus();
    await frame.getByRole('slider', { name: 'Amount', exact: true }).press('ArrowRight');
    await expect(frame.locator('#embed-content output[data-active-value="y"]')).toHaveText('8');
    await expect(frame.getByText('Inside the frame.')).not.toBeInViewport();
    await frame.locator('#embed-content a[data-footnote-ref]').click();
    await expect(frame.getByText('Inside the frame.')).toBeInViewport();
    const child = page.frames().find(item => item.url() === embedURL);
    expect(child).toBeDefined();
    expect(await child!.evaluate(() => location.hash)).toBe(new URL(embedURL).hash);
    expect(await child!.evaluate(() => document.referrer)).toBe('');
    expect(await child!.evaluate(() => (window as unknown as { embedStorageAttempts: string[] }).embedStorageAttempts)).toEqual([]);
    await expect(frame.locator('#editor, #read-share, #edit-copy')).toHaveCount(0);
    await expect(page).toHaveURL(parentOrigin + '/');
    expect(unexpectedRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    parent.closeAllConnections();
    await new Promise<void>((resolve, reject) => parent.close(error => error ? reject(error) : resolve()));
  }
});
