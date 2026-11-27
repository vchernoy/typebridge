import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const source = await readFile(new URL('../docs/examples/delivery-choices.md', import.meta.url), 'utf8');

for (const surface of ['editor', 'reader'] as const) {
  test(`numeric choice controls stay synchronized in the ${surface}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    if (surface === 'editor') {
      await page.goto('/editor.html');
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-preview').click();
    } else {
      const encoded = await encodeSharePayload({
        title: 'Delivery calculator', text: source, format: 'markdown', view: 'rendered', edit: false,
      });
      if (!encoded.ok) throw new Error('Share encoding failed');
      await page.goto('/read.html#doc=' + encoded.payload);
    }

    const root = page.locator(surface === 'editor' ? '#rendered-document' : '#read-text');
    const radio = root.getByRole('group', { name: 'Delivery', exact: true });
    const menu = root.getByRole('combobox', { name: 'Delivery menu' });
    const options = menu.locator('option');
    const optionLabels = ['Standard (+10.00)', 'Express (+25.00)', 'Pickup (+0.00)'];
    await expect(options).toHaveText(optionLabels);
    const numeric = root.getByRole('spinbutton', { name: 'Delivery cost' });
    await expect(radio.getByRole('radio', { name: 'Standard (+10.00)', exact: true })).toBeChecked();
    await radio.getByRole('radio', { name: 'Express (+25.00)', exact: true }).check();
    await expect(menu).toHaveValue('25');
    await expect(options).toHaveText(optionLabels);
    await expect(numeric).toHaveValue('25');
    await expect(root.locator('output')).toHaveText('125');
    await menu.selectOption('0');
    await expect(radio.getByRole('radio', { name: 'Pickup (+0.00)', exact: true })).toBeChecked();
    await expect(root.locator('output')).toHaveText('100');

    await page.locator(surface === 'editor' ? '#editable-input-reset' : '#reader-input-reset').click();
    await expect(radio.getByRole('radio', { name: 'Standard (+10.00)', exact: true })).toBeChecked();
    await expect(menu).toHaveValue('10');
    await expect(options).toHaveText(optionLabels);
    await expect(root.locator('output')).toHaveText('110');
    if (surface === 'editor') {
      await page.locator('#document-view-edit').click();
      await expect(page.locator('#editor')).toHaveValue(source);
    }
  });
}
