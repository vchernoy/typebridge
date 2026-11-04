import { expect, test, type Page } from '@playwright/test';
import { documentAction, selectDocument, setAutosave } from './settings-helpers';
import { claimFenceElsewhere, readOwnership, readStoredDocs } from './storage-helpers';

const role = (page: Page) => page.locator('html');
const instanceOf = (page: Page) => page.locator('html').getAttribute('data-instance-id');

async function saveAs(page: Page, text: string): Promise<string> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === text)).toBe(true);
  return (await readStoredDocs(page)).find(row => row.text === text)!.id;
}

async function openOrdinary(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
}

test('Edit here promotes a comparison viewer when the lock is free', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'For handoff');
  await page.close();

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('For handoff');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await expect(viewer.locator('#edit-here')).toBeVisible();
  await viewer.locator('#edit-here').click();
  await expect.poll(async () => role(viewer).getAttribute('data-role')).toBe('editor');
  await expect(viewer.locator('#viewer-badge')).toBeHidden();
  await expect(viewer.locator('#edit-here-row')).toBeHidden();
  await viewer.locator('#editor').fill('Edited after handoff');
  await expect(viewer.locator('#save-indicator')).toHaveText('Saved');
  expect((await readOwnership(viewer, id))?.ownerInstanceId).toBe(await instanceOf(viewer));
});

test('Edit here asks the owner and transfers when accepted', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Shared document');
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#edit-here')).toBeVisible();

  await viewer.locator('#edit-here').click();
  const dialog = page.getByRole('dialog', { name: 'Transfer editing?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Transfer editing' }).click();
  await expect.poll(async () => role(viewer).getAttribute('data-role')).toBe('editor');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toBeVisible();
  await viewer.locator('#editor').fill('Now owned by viewer');
  await expect(viewer.locator('#save-indicator')).toHaveText('Saved');
  expect((await readOwnership(viewer, id))?.ownerInstanceId).toBe(await instanceOf(viewer));
});

test('Edit here is refused while the owner has private unsaved text', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Private source');
  await setAutosave(page, false, 'keep');
  await page.locator('#editor').pressSequentially(' private');
  await expect(page.locator('#status')).toContainText('Autosave off');

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await viewer.locator('#edit-here').click();
  const dialog = viewer.getByRole('dialog', { name: 'Cannot edit here yet' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('unsaved or private');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
});

test('Edit here is refused when the owner keeps editing', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Keep editing');
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await viewer.locator('#edit-here').click();
  const ownerDialog = page.getByRole('dialog', { name: 'Transfer editing?' });
  await expect(ownerDialog).toBeVisible();
  await ownerDialog.getByRole('button', { name: 'Keep editing' }).click();
  const refused = viewer.getByRole('dialog', { name: 'Cannot edit here yet' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('still editing');
  await refused.getByRole('button', { name: 'OK' }).click();
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
});

test('a busy ordinary reader can use Edit here after the owner closes', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Reader waits');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#edit-here')).toBeVisible();
  await page.close();
  await other.locator('#edit-here').click();
  await expect.poll(async () => role(other).getAttribute('data-role')).toBe('editor');
  await other.locator('#editor').fill('Reader became editor');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
});

test('Edit here keeps unsaved reader text instead of replacing it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await openOrdinary(page);
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await field.fill('Shared base');
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = (await readStoredDocs(page)).find(row => row.text === 'Shared base')!.id;

  // Stale fence + failed save → dirty ordinary reader with Edit here available.
  await claimFenceElsewhere(page, id);
  await field.fill('Shared base — kept private 🙂');
  await page.clock.runFor(400);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(field).toHaveValue('Shared base — kept private 🙂');
  await expect(page.locator('#edit-here')).toBeVisible();

  await page.locator('#edit-here').click();
  await expect.poll(async () => role(page).getAttribute('data-role')).toBe('editor');
  await expect(field).toHaveValue('Shared base — kept private 🙂');
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Shared base']);
});

test('promoting a viewer re-enables New document and Open in comparison window', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Promote chrome');
  await page.close();
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#new-draft')).toBeDisabled();
  await expect(viewer.locator('#open-comparison')).toBeDisabled();
  await viewer.locator('#edit-here').click();
  await expect.poll(async () => role(viewer).getAttribute('data-role')).toBe('editor');
  await expect(viewer.locator('#new-draft')).toBeEnabled();
  await expect(viewer.locator('#import-draft')).toBeEnabled();
  await expect(viewer.locator('#open-comparison')).toBeEnabled();
});

test('navigating away cancels a pending handoff so a late release cannot promote', async ({ page, context }) => {
  await openOrdinary(page);
  const idA = await saveAs(page, 'Document A for handoff');
  await documentAction(page, '#new-draft');
  const idB = await saveAs(page, 'Document B stays put');
  await selectDocument(page, idA);

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${idA}&mode=view`);
  await expect(viewer.locator('#edit-here')).toBeVisible();
  await viewer.locator('#edit-here').click();
  const dialog = page.getByRole('dialog', { name: 'Transfer editing?' });
  await expect(dialog).toBeVisible();

  await selectDocument(viewer, idB);
  await expect(viewer.locator('#editor')).toHaveValue('Document B stays put');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');

  await dialog.getByRole('button', { name: 'Transfer editing' }).click();
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  // Late release must not yank the viewer onto A or steal B's view.
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await expect(viewer.locator('#editor')).toHaveValue('Document B stays put');
  await expect(viewer.locator('#viewer-badge')).toBeVisible();
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(idB);
});

test('an ordinary reader that switches documents keeps dirty text after a late transfer', async ({ page, context }) => {
  await openOrdinary(page);
  const idA = await saveAs(page, 'Owned document A');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#edit-here')).toBeVisible();
  await other.locator('#edit-here').click();
  const dialog = page.getByRole('dialog', { name: 'Transfer editing?' });
  await expect(dialog).toBeVisible();

  await documentAction(other, '#new-draft');
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  await other.locator('#editor').fill('Private draft B');
  await expect(other.locator('#status')).toContainText('Saved');

  await dialog.getByRole('button', { name: 'Transfer editing' }).click();
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('Private draft B');
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  const otherId = (await readStoredDocs(other)).find(row => row.text === 'Private draft B')?.id;
  expect(otherId).toBeTruthy();
  expect(otherId).not.toBe(idA);
  expect((await readOwnership(other, otherId!))?.ownerInstanceId).toBe(await instanceOf(other));
});

test('navigating during a delayed acquire does not install stale ownership', async ({ page, context }) => {
  await openOrdinary(page);
  const idA = await saveAs(page, 'Acquire then leave');
  await documentAction(page, '#new-draft');
  const idB = await saveAs(page, 'Stay on B');
  await page.close();

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${idA}&mode=view`);
  await viewer.evaluate(() => {
    (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 1500;
  });
  await viewer.locator('#edit-here').click();
  await selectDocument(viewer, idB);
  await expect(viewer.locator('#editor')).toHaveValue('Stay on B');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await viewer.waitForTimeout(2000);
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  await expect(viewer.locator('#editor')).toHaveValue('Stay on B');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(idB);
});

test('an expired transfer prompt keeps the owner editing', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Expire transfer');
  await page.evaluate(() => {
    (window as Window & { __typebridgeHandoffTtlMs?: number }).__typebridgeHandoffTtlMs = 400;
  });
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await viewer.evaluate(() => {
    (window as Window & { __typebridgeHandoffTtlMs?: number }).__typebridgeHandoffTtlMs = 400;
  });
  await viewer.locator('#edit-here').click();
  const dialog = page.getByRole('dialog', { name: 'Transfer editing?' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(600);
  await dialog.getByRole('button', { name: 'Transfer editing' }).click();
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#status')).toContainText('expired');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  expect((await readOwnership(page, id))?.ownerInstanceId).toBe(await instanceOf(page));
});

test('a promoted viewer stores writing position under the editor namespace', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Position after promote');
  await page.close();
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await viewer.locator('#edit-here').click();
  await expect.poll(async () => role(viewer).getAttribute('data-role')).toBe('editor');
  await viewer.locator('#editor').fill('Position after promote!');
  await viewer.locator('#editor').evaluate(node => {
    const field = node as HTMLTextAreaElement;
    field.setSelectionRange(3, 5, 'forward');
    field.dispatchEvent(new Event('select'));
  });
  await expect.poll(async () => viewer.evaluate(docId => {
    const keys = Object.keys(sessionStorage).filter(key => key.includes('writingPosition'));
    return {
      viewerKey: keys.some(key => key.includes(`view:${docId}`)),
      editorKey: keys.includes(`typebridge.writingPosition.v1.${docId}`),
    };
  }, id)).toEqual({ viewerKey: false, editorKey: true });
});

test('a promoted viewer holds recovery ownership while it is still open', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Recovery promote');
  await page.close();
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await viewer.locator('#edit-here').click();
  await expect.poll(async () => role(viewer).getAttribute('data-role')).toBe('editor');

  const sibling = await context.newPage();
  await sibling.goto('/');
  await expect(sibling.locator('#editor')).toBeEnabled();
  await sibling.evaluate(() => {
    const observed = document.querySelector('[aria-label="Recover unsaved documents"]')!;
    (window as unknown as { recoveryMutations: number }).recoveryMutations = 0;
    new MutationObserver(() => { (window as unknown as { recoveryMutations: number }).recoveryMutations++; })
      .observe(observed, { childList: true, subtree: true });
  });

  await viewer.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); };
    IDBObjectStore.prototype.add = function () { throw new Error('interrupted'); };
  });
  await viewer.locator('#editor').fill('Promoted private text');
  await expect(viewer.locator('#status')).toContainText('Save failed');
  await sibling.waitForTimeout(1600);
  await expect(sibling.getByRole('button', { name: /Recover / })).toHaveCount(0);
  expect(await sibling.evaluate(() => (window as unknown as { recoveryMutations: number }).recoveryMutations)).toBe(0);

  await viewer.close();
  const check = sibling.getByRole('button', { name: 'Check emergency backups' });
  await expect.poll(
    async () => await check.isVisible() || await sibling.getByRole('button', { name: /Recover / }).isVisible(),
    { timeout: 10000 },
  ).toBe(true);
  if (await check.isVisible()) await check.click();
  await expect(sibling.getByRole('button', { name: /Recover / })).toBeVisible();
});
