import { expect, test } from '@playwright/test';

test('boot clears obsolete split prefs without touching documents', async ({ page }) => {
  const docId = '11111111-1111-4111-8111-111111111111';
  await page.addInitScript(({ id }) => {
    localStorage.setItem('typebridge.split.v1', JSON.stringify({ open: true, ratio: 0.4 }));
    sessionStorage.setItem('typebridge.pendingDraft.paneB.v1', JSON.stringify({
      id,
      title: 'Pane B leftover',
      text: 'should be cleared',
      revision: 1,
      updatedAt: Date.now(),
    }));
    sessionStorage.setItem(`typebridge.pendingDraft.paneB.v1::w:main`, JSON.stringify({
      id,
      title: 'Scoped leftover',
      text: 'should be cleared',
      revision: 1,
      updatedAt: Date.now(),
    }));
    // Sentinel that must survive — proves we do not wipe unrelated storage.
    localStorage.setItem('typebridge.transliteration.enabled.v1', 'on');
  }, { id: docId });

  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();

  const leftovers = await page.evaluate(() => ({
    split: localStorage.getItem('typebridge.split.v1'),
    pendingB: sessionStorage.getItem('typebridge.pendingDraft.paneB.v1'),
    pendingBScoped: sessionStorage.getItem('typebridge.pendingDraft.paneB.v1::w:main'),
    translit: localStorage.getItem('typebridge.transliteration.enabled.v1'),
  }));
  expect(leftovers.split).toBeNull();
  expect(leftovers.pendingB).toBeNull();
  expect(leftovers.pendingBScoped).toBeNull();
  expect(leftovers.translit).toBe('on');
  await expect(page.locator('#toggle-split')).toHaveCount(0);
  await expect(page.locator('#editor-b')).toHaveCount(0);
});
