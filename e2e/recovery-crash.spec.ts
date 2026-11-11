import { expect, test } from '@playwright/test';
import { selectDocument, setAutosave } from './settings-helpers';

// A renderer crash leaves the browser/storage process alive. This is intentionally
// Chromium-only (CDP); it is not whole-browser, power-loss or Firefox/WebKit evidence.
for (const autosave of [true, false]) {
  test(`renderer crash skips unload and preserves recovery/privacy; Autosave=${autosave} (#37 R2a)`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Page.crash requires Chromium CDP; other engines retain the portable recovery suite');
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').fill('Сохранённый оригинал');
    await expect(page.locator('#status')).toContainText('Saved locally');
    if (!autosave) await setAutosave(page, false);
    await page.evaluate(() => {
      localStorage.removeItem('typebridge.test.crashUnload');
      window.addEventListener('pagehide', () => localStorage.setItem('typebridge.test.crashUnload', 'pagehide'));
      window.addEventListener('beforeunload', () => localStorage.setItem('typebridge.test.crashUnload', 'beforeunload'));
      IDBObjectStore.prototype.put = function () { throw new Error('injected save failure'); };
      IDBObjectStore.prototype.add = function () { throw new Error('injected save failure'); };
    });
    await page.locator('#editor').fill('Несохранённая фраза 🙂\nВторая строка');
    await page.locator('#draft-title').fill('Аудит R2');
    if (autosave) await expect(page.locator('#status')).toContainText('Save failed');
    const journals = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.')));
    if (autosave) expect(journals.length).toBeGreaterThan(0);
    else expect(journals).toHaveLength(0);
    const crashed = page.waitForEvent('crash');
    const cdp = await context.newCDPSession(page);
    void cdp.send('Page.crash').catch(() => { /* The renderer closes the command; the crash event is required below. */ });
    await crashed;
    const next = await context.newPage();
    await next.goto('/editor.html');
    await expect(next.locator('#editor')).toBeEnabled();
    expect(await next.evaluate(() => localStorage.getItem('typebridge.test.crashUnload'))).toBeNull();
    await expect(next.locator('#editor')).toHaveValue('Сохранённый оригинал');
    if (autosave) {
      await next.getByRole('button', { name: /Recover Аудит R2/ }).click();
      await expect(next.locator('#status')).toContainText('Recovered a copy');
      await expect(next.locator('#editor')).toHaveValue('Сохранённый оригинал');
      await selectDocument(next, { label: 'Аудит R2 (recovered)' });
      await expect(next.locator('#editor')).toHaveValue('Несохранённая фраза 🙂\nВторая строка');
      await expect(next.locator('#draft-title')).toHaveValue('Аудит R2 (recovered)');
    } else {
      expect(await next.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.')))).toHaveLength(0);
      await expect(next.getByRole('button', { name: /^Recover / })).toHaveCount(0);
    }
    await page.close();
  });
}
