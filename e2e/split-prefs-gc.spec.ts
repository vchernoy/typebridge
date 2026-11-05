import { expect, test } from '@playwright/test';

test('boot clears obsolete split prefs without touching documents', async ({ page }) => {
  const docId = '11111111-1111-4111-8111-111111111111';
  await page.addInitScript(({ id }) => {
    localStorage.setItem('typebridge.split.v1', JSON.stringify({ open: true, ratio: 0.4 }));
    sessionStorage.setItem('typebridge.pendingDraft.paneB.v1', JSON.stringify({
      id,
      title: 'Pane B leftover',
      text: 'should be recovered',
      revision: 1,
      updatedAt: Date.now(),
    }));
    sessionStorage.setItem(`typebridge.pendingDraft.paneB.v1::w:main`, JSON.stringify({
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Scoped leftover',
      text: 'scoped should be recovered',
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
    recovery: Object.keys(localStorage)
      .filter(key => key.startsWith('typebridge.recovery.v1.'))
      .map(key => {
        try {
          return JSON.parse(localStorage.getItem(key) ?? 'null') as {
            title?: string;
            text?: string;
            tab?: string;
          };
        } catch {
          return null;
        }
      })
      .filter((row): row is { title?: string; text?: string; tab?: string } => !!row),
  }));
  expect(leftovers.split).toBeNull();
  expect(leftovers.pendingB).toBeNull();
  expect(leftovers.pendingBScoped).toBeNull();
  expect(leftovers.translit).toBe('on');
  // Pane-B text backups are migrated into the recovery journal, not discarded.
  expect(leftovers.recovery.some(row => (
    row.tab?.startsWith('split-pane-b-migrate.')
    && row.title === 'Pane B leftover'
    && row.text === 'should be recovered'
  ))).toBe(true);
  expect(leftovers.recovery.some(row => (
    row.tab?.startsWith('split-pane-b-migrate.')
    && row.title === 'Scoped leftover'
    && row.text === 'scoped should be recovered'
  ))).toBe(true);
  await expect(page.locator('#toggle-split')).toHaveCount(0);
  await expect(page.locator('#editor-b')).toHaveCount(0);

  const recovery = page.locator('.recovery-panel');
  await expect(recovery.locator('button').first()).toBeVisible({ timeout: 15_000 });
  const inspect = recovery.getByRole('button', { name: 'Check emergency backups' });
  if (await inspect.isVisible()) await inspect.click();
  await expect(recovery.getByRole('button', { name: /Recover Pane B leftover/ })).toBeVisible({ timeout: 15_000 });
  await expect(recovery.getByRole('button', { name: /Recover Scoped leftover/ })).toBeVisible();
});

test('boot drops empty pane-B leftovers without writing recovery', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('typebridge.pendingDraft.paneB.v1', JSON.stringify({
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Empty leftover',
      text: '',
      revision: 0,
      updatedAt: Date.now(),
    }));
  });

  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();

  const state = await page.evaluate(() => ({
    pendingB: sessionStorage.getItem('typebridge.pendingDraft.paneB.v1'),
    recovery: Object.keys(localStorage).filter(key => key.startsWith('typebridge.recovery.v1.split-pane-b-migrate')),
  }));
  expect(state.pendingB).toBeNull();
  expect(state.recovery).toEqual([]);
});
