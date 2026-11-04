import { expect, test, type Page } from '@playwright/test';
import { documentAction, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

async function openSplit(page: Page): Promise<void> {
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');
}

test('Split editor shows a live same-document companion without a second save stream', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, false);
  await openSplit(page);
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-id', 'pane-b');
  await expect(page.locator('#editor-b')).toHaveAttribute('data-pane-role', 'readonly');
  await expect(page.locator('#companion-badge')).toHaveText('Live view · Read-only');

  const field = page.locator('#editor');
  await field.fill('привет из панели');
  await expect(page.locator('#editor-b')).toHaveValue('привет из панели');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');

  // Companion stays independently selectable while mirroring.
  await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.setSelectionRange(0, 6);
  });
  await field.focus();
  await field.pressSequentially('!');
  await expect(page.locator('#editor-b')).toHaveValue('привет из панели!');
  const companionSel = await page.locator('#editor-b').evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  expect(companionSel.start).toBe(0);
  expect(companionSel.end).toBe(6);

  // Closing split keeps the text and returns to a single pane.
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeHidden();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'off');
  await expect(field).toHaveValue('привет из панели!');
});

test('split divider is keyboard-adjustable and reset restores the midpoint', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSplit(page);
  const divider = page.locator('#split-divider');
  await expect(divider).toBeVisible();
  await divider.focus();
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await page.keyboard.press('ArrowRight');
  await expect(divider).not.toHaveAttribute('aria-valuenow', '50');
  const moved = await divider.getAttribute('aria-valuenow');
  await page.locator('#split-reset').click();
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  expect(moved).not.toBe('50');
});

test('comparison viewers cannot open the in-tab split', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('saved for companion');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'saved for companion')).toBe(true);
  const id = (await readStoredDocs(page)).find(row => row.text === 'saved for companion')!.id;
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#viewer-badge')).toBeVisible();
  await expect(viewer.locator('#toggle-split')).toBeDisabled();
  await expect(viewer.locator('#editor-b')).toBeHidden();
  await expect(viewer.locator('main.workspace')).toHaveAttribute('data-split', 'off');
});

test('conflict-copy creation syncs workspace document identity', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('base for conflict');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'base for conflict')).toBe(true);
  const beforeId = await page.locator('main.workspace').getAttribute('data-document-id');
  expect(beforeId).toBeTruthy();

  // Simulate another tab advancing the revision so the next save becomes a conflict copy.
  await page.evaluate(async id => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('documents', 'readwrite');
        const store = tx.objectStore('documents');
        const get = store.get(id);
        get.onsuccess = () => {
          const row = get.result as { id: string; revision: number; text: string; title: string; updatedAt: number };
          store.put({ ...row, text: 'foreign rewrite', revision: row.revision + 1, updatedAt: Date.now() });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, beforeId);

  await openSplit(page);
  await page.locator('#editor').fill('local conflict edit');
  await expect(page.locator('#editor-b')).toHaveValue('local conflict edit');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#conflict-notice')).toContainText('saved as a conflict copy');
  const afterId = await page.locator('main.workspace').getAttribute('data-document-id');
  expect(afterId).toBeTruthy();
  expect(afterId).not.toBe(beforeId);
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.id === afterId && row.text === 'local conflict edit')).toBe(true);
});
