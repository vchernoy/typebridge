import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload, type SharedDocument } from '../src/editor/share-link';
import { readStoredDocs } from './storage-helpers';

// Share links open as a plain read-only page (#39). Nothing is stored until Edit a copy.
const shared = (overrides: Partial<SharedDocument> = {}): SharedDocument => ({
  title: 'Письмо другу 🙂',
  text: 'Привет!\n\n  Вторая строка с отступом.\nЁлка — é 👩‍💻',
  format: 'plain',
  view: 'source',
  edit: true,
  ...overrides,
});
const linkFor = async (document: SharedDocument): Promise<string> => {
  const encoded = await encodeSharePayload(document);
  if (!encoded.ok) throw new Error('refused: ' + encoded.reason);
  return `/#doc=${encoded.payload}`;
};
const databases = (page: Page) => page.evaluate(async () =>
  'databases' in indexedDB ? (await indexedDB.databases()).map(db => db.name) : undefined);

test('a share link opens as a read-only page and stores nothing', async ({ page }) => {
  const document = shared();
  await page.goto(await linkFor(document));
  await expect(page).toHaveURL(/\/read\.html#doc=1\./);
  await expect(page.locator('#read-title')).toHaveText(document.title);
  await expect(page.locator('#read-text')).toHaveText(document.text, { useInnerText: false });
  await expect(page.locator('.read-label')).toHaveText('Shared document · read-only');
  await expect(page.getByRole('button', { name: 'Edit a copy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'TypeBridge' })).toHaveAttribute('href', '/');
  await expect(page).toHaveTitle(`${document.title} · TypeBridge`);
  // No editor chrome, and no storage opened just by reading.
  await expect(page.locator('#editor, .host-window')).toHaveCount(0);
  const names = await databases(page);
  if (names) expect(names).not.toContain('typebridge');
});

test('shared text is shown as text, never as HTML', async ({ page }) => {
  await page.goto(await linkFor(shared({ title: '<b>T</b>', text: '<img src=x onerror="window.pwned=1"> <script>window.pwned=2</script>' })));
  await expect(page.locator('#read-text')).toHaveText('<img src=x onerror="window.pwned=1"> <script>window.pwned=2</script>');
  await expect(page.locator('#read-title')).toHaveText('<b>T</b>');
  await expect(page.locator('#read-text img, #read-text script, #read-title b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('the sender can hide Edit a copy; an unknown format shows its raw text with a notice', async ({ page }) => {
  await page.goto(await linkFor(shared({ edit: false })));
  await expect(page.locator('#read-title')).toHaveText('Письмо другу 🙂');
  await expect(page.locator('#edit-copy')).toBeHidden();
  await page.goto(await linkFor(shared({ format: 'markdown', text: '# Заголовок\n**жирный**' })));
  await expect(page.locator('#read-notice')).toContainText('cannot show yet (“markdown”)');
  await expect(page.locator('#read-text')).toHaveText('# Заголовок\n**жирный**', { useInnerText: false });
});

test('a damaged or cut link explains itself', async ({ page }) => {
  const link = await linkFor(shared({ text: 'Длинный текст. '.repeat(50) }));
  await page.goto(link.slice(0, link.length - 20));
  await expect(page.locator('#read-title')).toHaveText('This shared document cannot be opened');
  await expect(page.locator('#read-text')).toContainText('incomplete or damaged');
  await expect(page.locator('#edit-copy')).toBeHidden();
  await page.goto('/read.html#doc=9.abc');
  await expect(page.locator('#read-text')).toContainText('newer version of TypeBridge');
});

test('Edit a copy saves a new document and opens it in an editor window', async ({ page }) => {
  // An existing document must stay untouched.
  await page.goto('/editor.html');
  const own = page.locator('#editor');
  await expect(own).toBeEnabled();
  await own.fill('Мой документ');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const before = await readStoredDocs(page);
  const document = shared();
  await page.goto(await linkFor(document));
  await page.getByRole('button', { name: 'Edit a copy' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
  const copyId = (await readStoredDocs(page)).find(row => row.text === document.text)?.id;
  expect(copyId).toBeDefined();
  const window = page.locator(`.host-window iframe[src*="doc=${copyId}"]`);
  await expect(window).toHaveCount(1);
  await expect(page.frameLocator(`.host-window iframe[src*="doc=${copyId}"]`).locator('#editor')).toHaveValue(document.text);
  const after = await readStoredDocs(page);
  expect(after).toHaveLength(before.length + 1);
  for (const row of before) expect(after.find(saved => saved.id === row.id)?.text).toBe(row.text);
});

test('with every window open, Edit a copy still saves and says how to open it', async ({ page }) => {
  await page.goto('/');
  const add = page.locator('[data-host-action="new-window"]');
  for (let count = 1; count < 4; count++) {
    await add.click();
    await expect(page.locator('.host-window')).toHaveCount(count + 1);
  }
  const document = shared({ text: 'Копия при полном наборе окон' });
  await page.goto(await linkFor(document));
  await page.getByRole('button', { name: 'Edit a copy' }).click();
  await expect(page.locator('.host-status')).toContainText('Close a window, then open it from ▾ Documents.');
  await expect(page.locator('.host-window')).toHaveCount(4);
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === document.text)).toBe(true);
});

test('a share link opens offline once the site has been visited', async ({ page, context }) => {
  await page.goto('/editor.html');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Offline worker did not activate');
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  const document = shared({ text: 'Без интернета 🙂' });
  await context.setOffline(true);
  try {
    await page.goto(await linkFor(document));
    await expect(page.locator('#read-title')).toHaveText(document.title);
    await expect(page.locator('#read-text')).toHaveText(document.text);
  } finally {
    await context.setOffline(false);
  }
});
