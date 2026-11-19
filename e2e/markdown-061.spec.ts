import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const plans = await readFile(new URL('../docs/examples/phone-plans.md', import.meta.url), 'utf8');

async function openShared(page: import('@playwright/test').Page, title: string, text: string) {
  const encoded = await encodeSharePayload({ title, text, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  return page.locator('#read-text');
}

test('a shared phone-plan form updates both bills and the verdict', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const root = await openShared(page, 'Which phone plan is cheaper?', plans);
  const verdict = (title: string) => root.locator('.callout-title', { hasText: title });
  const slider = root.getByRole('slider').first();
  await expect(verdict('Basic is cheaper')).toBeVisible();
  for (const [gb, shown] of [['10', "It's a tie"], ['20', 'Unlimited is cheaper'], ['3', 'Basic is cheaper']] as const) {
    await slider.fill(gb);
    await expect(verdict(shown)).toBeVisible();
    await expect(root.locator('.callout-title:visible')).toHaveCount(1);
  }
  await expect(root.locator('.active-error')).toHaveCount(0);
});

test('choice and control labels keep colon-number text (ActiveMD 0.6.1)', async ({ page }) => {
  const source = '```calc\ninput r = 3 in 0..10\n```\n\n:::radio[Aspect 16:10 or 3:1]{input=r}\n::option[Assume 3:1 DSC]{value=3}\n::option[16:10 at 10:30]{value=2}\n:::\n\n:slider[Ratio 3:1]{input=r}\n';
  const root = await openShared(page, 'Ratios', source);
  const group = root.getByRole('group', { name: 'Aspect 16:10 or 3:1', exact: true });
  await expect(group.getByRole('radio', { name: 'Assume 3:1 DSC', exact: true })).toBeChecked();
  await expect(group.getByRole('radio', { name: '16:10 at 10:30', exact: true })).toBeVisible();
  await expect(root.getByRole('slider', { name: 'Ratio 3:1', exact: true })).toHaveValue('3');
});
