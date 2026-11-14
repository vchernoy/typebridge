import { expect, test, type Locator } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const source = String.raw`\`\`\`calc
input x = 8
\`\`\`

:input[x]

$$
\begin{aligned}
P_n &= P_0(1+r/100)^n \\
    &= 10000(1+{{x}}/100)^{10} \\
    &\approx 21589.25
\end{aligned}
$$

$$
\begin{pmatrix}1 & 12345 \\ 12345 & 1\end{pmatrix}
$$

$$
x = 1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20
$$`.replaceAll('\\`', '`');

async function assertAligned(root: Locator): Promise<void> {
  const signs = root.locator('mtable[columnalign="right left"] > mtr > mtd:nth-child(2) mo').filter({ hasText: /^(=|≈)$/ });
  await expect(signs).toHaveCount(3);
  await expect.poll(async () => {
    const xs = await signs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
    return Math.max(...xs) - Math.min(...xs);
  }).toBeLessThan(1);
  // Unrelated matrix cells retain their centered alignment.
  const matrix = root.locator('mtable[columnalign="center center"]');
  await expect(matrix).toHaveCount(1);
  const centered = await matrix.locator('mtd').first().evaluate(element => {
    const cell = element.getBoundingClientRect();
    const value = element.querySelector('mn')!.getBoundingClientRect();
    return Math.abs((cell.left + cell.right) / 2 - (value.left + value.right) / 2);
  });
  expect(centered).toBeLessThan(1);
  const wide = root.locator('math[display="block"]').last();
  expect(await wide.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await wide.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await wide.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
}

for (const surface of ['reader', 'editor'] as const) {
  test(`multiline math aligns relations on narrow ${surface} and after calc updates`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (surface === 'reader') {
      const encoded = await encodeSharePayload({ title: 'Aligned math', text: source, format: 'markdown', view: 'rendered', edit: true });
      if (!encoded.ok) throw new Error('Cannot encode fixture');
      await page.goto('/read.html#doc=' + encoded.payload);
    } else {
      await page.goto('/editor.html');
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-choice').selectOption('rendered');
    }
    const root = page.locator(surface === 'reader' ? '#read-text' : '#rendered-document');
    await assertAligned(root);
    await root.locator('input').fill('12');
    await expect(root.locator('mtable[columnalign="right left"]')).toContainText('12');
    await assertAligned(root);
  });
}
