import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

/** #175 step 4: same-document focus handoff between two same-tab windows. */

async function waitReady(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
}

async function openDocMenu(frame: FrameLocator): Promise<void> {
  const panel = frame.locator('#doc-menu');
  if (await panel.isHidden()) await frame.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

async function reloadFrame(page: Page, iframeSelector: string): Promise<void> {
  await page.locator(iframeSelector).evaluate((el: HTMLIFrameElement) => {
    el.contentWindow!.location.reload();
  });
}

async function openSharedDocument(page: Page): Promise<{ alpha: FrameLocator; beta: FrameLocator; docId: string }> {
  await page.goto('/window-identity-harness.html');
  const alpha = page.frameLocator('#win-alpha');
  const beta = page.frameLocator('#win-beta');
  await waitReady(alpha);
  await waitReady(beta);

  await alpha.locator('#editor').fill('Shared handoff text');
  await expect(alpha.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Shared handoff text')).toBe(true);
  const docId = (await readStoredDocs(page)).find(row => row.text === 'Shared handoff text')!.id;

  await reloadFrame(page, '#win-beta');
  await waitReady(beta);
  await openDocMenu(beta);
  await beta.locator('#drafts').selectOption(docId);
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(beta.locator('#editor')).toHaveJSProperty('readOnly', true);
  return { alpha, beta, docId };
}

test('same-tab click into read-only window takes editing without dropping keys', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta } = await openSharedDocument(page);

  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'editor');
  await beta.locator('#editor').click();
  // Type immediately during handoff — buffered keys must apply.
  await beta.locator('#editor').pressSequentially('!');
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveJSProperty('readOnly', false);
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text!');
  await expect(alpha.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(alpha.locator('#editor')).toHaveJSProperty('readOnly', true);
  // Owner shows last saved text (pre-handoff save), not the new keystroke.
  await expect(alpha.locator('#editor')).toHaveValue('Shared handoff text');
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');
  // No conflict copy — still one document row for this text family.
  const docs = await readStoredDocs(page);
  expect(docs.filter(row => row.text.startsWith('Shared handoff text')).length).toBe(1);
});

test('same-tab Autosave-off handoff carries unsaved text in memory', async ({ page }) => {
  test.setTimeout(90_000);
  const { alpha, beta, docId } = await openSharedDocument(page);

  await setAutosave(alpha as unknown as Page, false);
  // Beta is read-only so its Autosave control is disabled; reload so it reads the shared preference.
  await reloadFrame(page, '#win-beta');
  await waitReady(beta);
  await openDocMenu(beta);
  await beta.locator('#drafts').selectOption(docId);
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');

  await alpha.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value} private`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(alpha.locator('#save-indicator')).toHaveText('Not saved');

  await beta.locator('#editor').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(beta.locator('#editor')).toHaveValue('Shared handoff text private');
  await expect(beta.locator('#save-indicator')).toHaveText('Not saved');
  // Transfer must not write the private text for the handoff itself.
  const after = await readStoredDocs(page);
  expect(after.find(row => row.id === docId)?.text).toBe('Shared handoff text');
});
