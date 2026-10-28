import { expect, test } from '@playwright/test';

test('reopens the editor and restores a saved Russian draft after offline refresh', async ({ page, context }) => {
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
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('typebridge.drafts.v1') ?? '[]').some((draft: { text: string }) => draft.text === 'Привет! Это мой длинный пост.\nВторая строка.'))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(field).toHaveValue('Привет! Это мой длинный пост.\nВторая строка.');
  await field.fill('Редактирую без интернета');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('typebridge.drafts.v1') ?? '[]').some((draft: { text: string }) => draft.text === 'Редактирую без интернета'))).toBe(true);
  await page.reload();
  await expect(field).toHaveValue('Редактирую без интернета');
  await context.setOffline(false);
});
