import { expect, test } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

// ActiveMD 0.13.1 (#409): grouped numbers after a binary operator need no parentheses.
const source = [
  '$$1000 + {{200|fixed}}$$', '$$1000 + {{2000}}$$', '$$1000 + {{2000|fixed:0}}$$',
  '$$1000 + {{2000|fixed}}$$', '$$1000 + {{2000|fixed:2}}$$', '$$1000 + {{-5}}$$',
].join('\n\n');

test('formatted numbers in math show without needless parentheses; negatives keep them', async ({ page }) => {
  const encoded = await encodeSharePayload({ title: 'Grouping', text: source, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  const formulas = page.locator('#read-text math');
  await expect(formulas).toHaveCount(6);
  const shown = await formulas.evaluateAll(list => list.map(math => {
    const copy = math.cloneNode(true) as Element;
    copy.querySelectorAll('annotation').forEach(node => node.remove());
    return (copy.textContent ?? '').replace(/\s+/g, '');
  }));
  expect(shown).toEqual(['1000+200', '1000+2000', '1000+2,000', '1000+2,000', '1000+2,000.00', '1000+(−5)']);
});
