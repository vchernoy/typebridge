import { expect, test, type Locator } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const formula = String.raw`$$\left(1+\frac{r}{100}\right)^n$$`;
const source = formula + '\n\n$$\\sqrt{\\frac{1}{1+x}}$$';

async function assertStretch(root: Locator): Promise<void> {
  const math = root.locator('math').first();
  await expect(math).toBeVisible();
  await math.evaluate(async () => { await document.fonts.ready; });
  const sizes = await math.evaluate(element => {
    const parenthesis = Array.from(element.querySelectorAll('mo')).find(node => node.textContent === '(')!;
    return { parenthesis: parenthesis.getBoundingClientRect().height, fraction: element.querySelector('mfrac')!.getBoundingClientRect().height };
  });
  expect(sizes.fraction).toBeGreaterThan(0);
  expect(sizes.parenthesis).toBeGreaterThanOrEqual(sizes.fraction);
}

for (const surface of ['reader', 'editor'] as const) {
  test(`bundled math font stretches delimiters, loads once and works offline in ${surface}`, async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fonts: string[] = [];
    context.on('request', request => { if (request.resourceType() === 'font') fonts.push(request.url()); });
    // Install the app's worker before the first renderer use so its font is cached on demand.
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    if (surface === 'reader') {
      const encoded = await encodeSharePayload({ title: 'Stretchy math', text: source, format: 'markdown', view: 'rendered', edit: true });
      if (!encoded.ok) throw new Error('Cannot encode fixture');
      await page.goto('/read.html#doc=' + encoded.payload);
    } else {
      await page.reload();
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-choice').selectOption('rendered');
    }
    const root = page.locator(surface === 'reader' ? '#read-text' : '#rendered-document');
    await assertStretch(root);
    expect(fonts).toHaveLength(1);
    const font = new URL(fonts[0]);
    expect(font.origin).toBe(new URL(page.url()).origin);
    expect(font.pathname).toMatch(/^\/assets\/STIX2Math-[\w-]+\.woff2$/);
    // Chromium on this font-free Linux setup reproduces the original defect with a text font.
    // Keep this negative control separate from the production family and restore it immediately.
    if (test.info().project.name === 'chromium') {
      const math = root.locator('math').first();
      const control = await math.evaluate(element => {
        const old = element.getAttribute('style');
        (element as HTMLElement).style.fontFamily = 'serif';
        const parenthesis = Array.from(element.querySelectorAll('mo')).find(node => node.textContent === '(')!;
        const result = parenthesis.getBoundingClientRect().height < element.querySelector('mfrac')!.getBoundingClientRect().height;
        if (old === null) element.removeAttribute('style'); else element.setAttribute('style', old);
        return result;
      });
      expect(control).toBe(true);
      await assertStretch(root);
    }
    if (surface === 'reader') {
      const encoded = await encodeSharePayload({ title: 'Second render', text: source + '\n\nSecond render', format: 'markdown', view: 'rendered', edit: true });
      if (!encoded.ok) throw new Error('Cannot encode fixture');
      await page.evaluate(hash => { location.hash = hash; }, 'doc=' + encoded.payload);
      await expect(root).toContainText('Second render');
      await assertStretch(root);
    } else {
      await page.locator('#document-view-choice').selectOption('edit');
      await page.locator('#document-view-choice').selectOption('rendered');
      await assertStretch(root);
      await expect(page.locator('#save-indicator')).toHaveText('Saved');
    }
    expect(fonts).toHaveLength(1);
    // Wait for the service worker's on-demand response to be durable before cutting connectivity.
    await expect.poll(() => page.evaluate(async url => {
      for (const key of await caches.keys()) {
        if (!key.startsWith('typebridge-')) continue;
        const cache = await caches.open(key);
        for (const request of await cache.keys()) if (request.url === url && await cache.match(request)) return true;
      }
      return false;
    }, fonts[0])).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await assertStretch(root);
  });
}
