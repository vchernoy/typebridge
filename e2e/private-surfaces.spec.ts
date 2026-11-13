import { expect, test } from '@playwright/test';
import { confirmPrivateSavedCopy, fillHostEditor, setHostAutosave } from './settings-helpers';

for (const session of [false, true]) {
  test(`private ${session ? 'session' : 'document'} keeps title/search text out of storage across reload (#257 step 2)`, async ({ page }) => {
    await page.goto('/');
    const frame = page.frameLocator('.host-window[data-window-id="main"] iframe');
    await expect(frame.locator('html')).toHaveAttribute('data-role', 'editor');
    await expect(frame.locator('#editor')).toBeEnabled();
    await fillHostEditor(frame, 'Public body');
    await fillHostEditor(frame, 'Public title', '#draft-title');
    await expect(frame.locator('#save-indicator')).toHaveText('Saved');
    await frame.locator('#editor').press('Control+f');
    await frame.locator('#find-text').fill('public query');
    await frame.locator('#replace-text').fill('public replacement');
    const before = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('typebridge.find.'))));
    expect(Object.values(before)).toContain('public query');
    expect(Object.values(before)).toContain('public replacement');
    if (session) await setHostAutosave(page, false);
    else {
      await frame.locator('#autosave').uncheck();
      await confirmPrivateSavedCopy(frame, 'keep');
    }
    await fillHostEditor(frame, 'SECRET BODY');
    await fillHostEditor(frame, 'SECRET TITLE', '#draft-title');
    await frame.locator('#find-text').fill('SECRET FIND');
    await frame.locator('#replace-text').fill('SECRET REPLACE');
    // IME's final persistence path must obey the same gate.
    await frame.locator('#find-text').dispatchEvent('compositionend');
    await frame.locator('#replace-text').dispatchEvent('compositionend');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const stored = await page.evaluate(() => ({
      session: Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('typebridge.find.'))),
      layout: localStorage.getItem('typebridge.host.windows.v1'),
    }));
    expect(stored.session).toEqual(before);
    expect(stored.layout).not.toContain('SECRET');
    await page.reload();
    await expect(frame.locator('#editor')).toHaveValue('Public body');
    await expect(frame.locator('#draft-title')).toHaveValue('Public title');
    await frame.locator('#editor').press('Control+f');
    await expect(frame.locator('#find-text')).toHaveValue('public query');
    await expect(frame.locator('#replace-text')).toHaveValue('public replacement');
    // Normal saving resumes without persisting the private search values.
    if (session) await setHostAutosave(page, true);
    else await frame.locator('#autosave').check();
    await frame.locator('#find-text').fill('resumed query');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1'))).toBe('resumed query');
  });
}

test('a missing comparison viewer follows same-id revision-one recreation (#261)', async ({ page, context }) => {
  await page.goto('/editor.html');
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Original');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = await page.locator('#drafts').inputValue();
  const viewer = await context.newPage();
  await viewer.goto(`/editor.html?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('Original');
  const { setAutosave } = await import('./settings-helpers');
  await setAutosave(page, false, 'delete');
  await expect(viewer.locator('#viewer-notice')).toContainText('no longer available');
  await page.locator('#editor').fill('Recreated');
  await setAutosave(page, true);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(viewer.locator('#editor')).toHaveValue('Recreated');
  await expect(viewer.locator('#editor')).toHaveAttribute('readonly', '');
});
