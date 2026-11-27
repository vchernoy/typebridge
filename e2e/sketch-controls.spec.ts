import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
import { openSettings } from './settings-helpers';

// Settings → Appearance → Hand-drawn controls (ActiveMD 0.12.0 sketch.css).
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

const radio = (page: Page) => page.locator('.active-doc input[type="radio"]').first();

test('hand-drawn controls restyle rendered documents, persist, and reset (ActiveMD 0.12.0)', async ({ page }) => {
  await page.goto('/editor.html');
  await writeMarkdown(page);
  await expect(radio(page)).toBeVisible();
  await expect(radio(page)).not.toHaveCSS('appearance', 'none');
  await expect(page.locator('html')).not.toHaveClass(/active-sketch/);

  await openSettings(page);
  const box = page.getByRole('checkbox', { name: 'Hand-drawn controls', exact: true });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.locator('html')).toHaveClass(/active-sketch/);
  await expect(radio(page)).toHaveCSS('appearance', 'none');
  // Still a native control.
  await radio(page).check();
  await expect(radio(page)).toBeChecked();

  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('html')).toHaveClass(/active-sketch/);
  await expect(radio(page)).toHaveCSS('appearance', 'none');

  // The reader's own choice also applies on a shared reading page.
  const encoded = await encodeSharePayload({ title: 'Sketch', text: source, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  const reader = await page.context().newPage();
  await reader.goto('/read.html#doc=' + encoded.payload);
  await expect(reader.locator('#read-text').getByRole('button', { name: 'Check' })).toBeEnabled();
  await expect(reader.locator('html')).toHaveClass(/active-sketch/);
  await expect(reader.locator('#read-text input[type="radio"]').first()).toHaveCSS('appearance', 'none');
  await reader.close();

  await openSettings(page);
  await page.locator('#reset-settings').click();
  await page.getByRole('dialog', { name: 'Reset settings to defaults?', exact: true }).getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/active-sketch/);
  await expect(page.getByRole('checkbox', { name: 'Hand-drawn controls', exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('typebridge.sketch.v1'))).toBeNull();
});

test('a saved hand-drawn choice applies before the application bundle loads', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('typebridge.sketch.v1', 'on'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/*.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/editor.html', { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveClass(/active-sketch/);
  } finally { release(); }
  await page.waitForLoadState('load');
  await expect(page.locator('#editor')).toBeEnabled();
});

test('host Settings turns hand-drawn controls on in every window', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
  await page.getByRole('checkbox', { name: 'Hand-drawn controls', exact: true }).check();
  await expect(page.locator('html')).toHaveClass(/active-sketch/);
  await expect(frame.locator('html')).toHaveClass(/active-sketch/);
});
