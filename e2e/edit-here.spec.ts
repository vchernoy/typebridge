import { expect, test, type Page } from '@playwright/test';
import { setAutosave } from './settings-helpers';
import { readOwnership, readStoredDocs } from './storage-helpers';

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
