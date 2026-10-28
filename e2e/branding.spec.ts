import { expect, test } from '@playwright/test';

const files = ['favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png'];
test('branding metadata points to the PNG assets and the canonical site', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page).toHaveTitle('TypeBridge');
  await expect(page.locator('link[rel="icon"][sizes="16x16"]')).toHaveAttribute('href', '/typebridge/favicon-16x16.png');
  await expect(page.locator('link[rel="icon"][sizes="32x32"]')).toHaveAttribute('href', '/typebridge/favicon-32x32.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/typebridge/apple-touch-icon.png');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://vchernoy.github.io/typebridge/');
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    await expect(page.locator(selector)).toHaveAttribute('content', 'https://vchernoy.github.io/typebridge/og-image.png');
  }
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  for (const file of files) {
    const response = await page.request.get('/typebridge/' + file);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
    expect([...((await response.body()).subarray(0, 8))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

test('approved branding images are precached for offline use', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Worker did not activate');
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  const cached = await page.evaluate(async names => {
    const matches = await Promise.all(names.map(name => caches.match('/typebridge/' + name)));
    return matches.map(response => !!response);
  }, files);
  expect(cached).toEqual(files.map(() => true));
  await context.setOffline(true);
  for (const file of files) {
    expect(await page.evaluate(async url => (await fetch(url)).ok, '/typebridge/' + file)).toBe(true);
  }
  await context.setOffline(false);
});
