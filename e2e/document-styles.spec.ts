import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
import { openSettings } from './settings-helpers';

// Settings → Appearance → Style (ActiveMD 0.13.0 styles.css): the app and rendered documents.
const source = '```calc\ninput x = 2 in 0..10\n```\n\n:slider[Amount]{input=x step=1}\n\n:::question{type=single}\nPick\n\n::choice[A]{correct}\n::choice[B]\n:::\n\n::quiz-submit[Check]';

async function writeMarkdown(page: Page): Promise<void> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(source);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-view-preview').click();
}

const html = (page: Page) => page.locator('html');
const radio = (page: Page) => page.locator('.active-doc input[type="radio"]').first();
const styleSelect = (page: Page) => page.getByRole('combobox', { name: 'Style', exact: true });

test('Style restyles the app and rendered documents, persists, reaches shared pages, and resets', async ({ page }) => {
  await page.goto('/editor.html');
  await writeMarkdown(page);
  await expect(radio(page)).toBeVisible();
  const settingsButton = page.locator('#settings-open');
  const plainBorder = await settingsButton.evaluate(el => getComputedStyle(el).borderTopWidth);
  await expect(radio(page)).not.toHaveCSS('appearance', 'none');
  await expect(html(page)).not.toHaveAttribute('data-active-style');

  await openSettings(page);
  await expect(styleSelect(page).locator('option')).toHaveText(['Plain', 'Hand-drawn', 'Bold (neo-brutalism)', 'Notebook', 'Chalkboard']);
  await expect(styleSelect(page)).toHaveValue('plain');
  await styleSelect(page).selectOption('brutal');
  await expect(html(page)).toHaveAttribute('data-active-style', 'brutal');
  // The document and the app around it change together.
  await expect(radio(page)).toHaveCSS('appearance', 'none');
  await expect(settingsButton).toHaveCSS('border-top-width', '3px');
  expect(plainBorder).not.toBe('3px');
  await expect(page.locator('#tab-indent')).toHaveCSS('appearance', 'none');
  // The typing-mode switch keeps its own drawing.
  await expect(page.locator('#enabled')).toHaveCSS('border-radius', '999px');
  await radio(page).check();
  await expect(radio(page)).toBeChecked();

  // Notebook brings its own light paper even in the dark scheme.
  await page.getByRole('combobox', { name: 'Color scheme', exact: true }).selectOption('dark');
  await styleSelect(page).selectOption('notebook');
  await expect(page.locator('body')).toHaveCSS('color-scheme', 'light');

  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(html(page)).toHaveAttribute('data-active-style', 'notebook');
  await expect(radio(page)).toHaveCSS('appearance', 'none');

  // The reader's own choice also applies on a shared reading page, app included.
  const encoded = await encodeSharePayload({ title: 'Styles', text: source, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  const reader = await page.context().newPage();
  await reader.goto('/read.html#doc=' + encoded.payload);
  await expect(reader.locator('#read-text').getByRole('button', { name: 'Check' })).toBeEnabled();
  await expect(reader.locator('html')).toHaveAttribute('data-active-style', 'notebook');
  await expect(reader.locator('#read-text input[type="radio"]').first()).toHaveCSS('appearance', 'none');
  await reader.close();

  await openSettings(page);
  await page.locator('#reset-settings').click();
  await page.getByRole('dialog', { name: 'Reset settings to defaults?', exact: true }).getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(html(page)).not.toHaveAttribute('data-active-style');
  await expect(styleSelect(page)).toHaveValue('plain');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.style.v1'))).toBeNull();
});

test('a saved style applies before the application bundle loads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('typebridge.style.v1', 'chalkboard'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/*.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/editor.html', { waitUntil: 'commit' });
    await expect(html(page)).toHaveAttribute('data-active-style', 'chalkboard');
  } finally { release(); }
  await page.waitForLoadState('load');
  await expect(page.locator('#editor')).toBeEnabled();
});

test('the previous Hand-drawn checkbox carries over as the Hand-drawn style', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('typebridge.sketch.v1', 'on');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(html(page)).toHaveAttribute('data-active-style', 'sketch');
  await openSettings(page);
  await expect(styleSelect(page)).toHaveValue('sketch');
  // Choosing Plain is final: the old key does not bring the sketch style back.
  await styleSelect(page).selectOption('plain');
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(html(page)).not.toHaveAttribute('data-active-style');
});

test('an unknown stored style stays plain', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('typebridge.style.v1', 'url(evil)'));
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(html(page)).not.toHaveAttribute('data-active-style');
});

test('host Settings changes the style in every window', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
  await styleSelect(page).selectOption('sketch');
  await expect(html(page)).toHaveAttribute('data-active-style', 'sketch');
  await expect(frame.locator('html')).toHaveAttribute('data-active-style', 'sketch');
});
