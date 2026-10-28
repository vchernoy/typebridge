import { expect, test } from '@playwright/test';

test('reopens the editor and restores a saved Russian draft after offline refresh', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto('/typebridge/');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Offline worker did not activate');
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Привет! Это мой длинный пост.\nВторая строка.');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await context.setOffline(true);
  await page.reload();
  try {
    await expect(field).toHaveValue('Привет! Это мой длинный пост.\nВторая строка.');
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      controller: !!navigator.serviceWorker.controller,
      activeDraft: sessionStorage.getItem('typebridge.activeDraft.v1'),
      draftCount: document.querySelectorAll('#drafts option').length,
      resources: performance.getEntriesByType('resource').map(entry => entry.name),
      cacheNames: await caches.keys(),
      entries: await Promise.all((await caches.keys()).map(async name => ({ name, requests: (await (await caches.open(name)).keys()).map(request => request.url) }))),
    }));
    throw new Error(`Offline restoration failed: ${JSON.stringify({ diagnostics, errors })}`, { cause: error });
  }
  await field.fill('Редактирую без интернета');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('Редактирую без интернета');
  await context.setOffline(false);
});
