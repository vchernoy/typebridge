import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const source = await readFile(new URL('../docs/examples/trip-budget.md', import.meta.url), 'utf8');
for (const surface of ['editor', 'reader'] as const) {
  test(`trip budget example works in the ${surface} at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    if (surface === 'editor') {
      await page.goto('/editor.html');
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-preview').click();
    } else {
      const encoded = await encodeSharePayload({ title: 'Trip budget', text: source, format: 'markdown', view: 'rendered', edit: false });
      if (!encoded.ok) throw new Error('Share encoding failed');
      await page.goto('/read.html#doc=' + encoded.payload);
    }
    const root = page.locator(surface === 'editor' ? '#rendered-document' : '#read-text');
    const total = root.locator('output[data-active-value="total"]');
    await expect(total).toHaveText('320.00');
    const flight = root.getByRole('radio', { name: 'Flight — 120', exact: true });
    await flight.check();
    await root.getByRole('combobox', { name: 'Room rate per night' }).selectOption('140');
    await expect(root.getByRole('spinbutton', { name: 'Room rate', exact: true })).toHaveValue('140');
    await expect(total).toHaveText('660.00');
    await expect(root.locator('output[data-active-value="perPerson"]')).toHaveText('330.00');
    await root.getByRole('spinbutton', { name: 'Room rate', exact: true }).fill('40');
    await expect(root.getByRole('combobox', { name: 'Room rate per night' })).toHaveValue('40');
    await expect(total).toHaveText('360.00');
    const nights = root.getByRole('slider', { name: 'Nights', exact: true });
    await nights.focus(); await nights.press('ArrowRight');
    await expect(total).toHaveText('400.00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(surface === 'editor' ? '#editable-input-reset' : '#reader-input-reset').click();
    await expect(root.getByRole('radio', { name: 'Train — 40', exact: true })).toBeChecked();
    await expect(total).toHaveText('320.00');
    if (surface === 'editor') {
      await page.locator('#document-view-edit').click();
      await expect(page.locator('#editor')).toHaveValue(source);
    }
  });
}
