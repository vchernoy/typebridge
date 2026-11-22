import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

// ActiveMD 0.7.0 quizzes on a shared page: answer, Check, Retry.
const source = await readFile(new URL('../docs/examples/quick-quiz.md', import.meta.url), 'utf8');

test('a reader checks the quick quiz on a shared page, sees the score, and retries', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const encoded = await encodeSharePayload({ title: 'Quick quiz', text: source, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  const root = page.locator('#read-text');
  await expect(root.getByRole('button', { name: 'Check' })).toBeEnabled();
  // The expected expression is not in the rendered page.
  expect(await root.innerHTML()).not.toContain('3 * price');
  await root.getByRole('textbox', { name: 'Your answer' }).fill('120');
  await root.getByRole('group', { name: 'Question 2' }).getByRole('radio').first().check();
  const evens = root.getByRole('group', { name: 'Question 3' }).getByRole('checkbox');
  await evens.nth(0).check();
  await root.getByRole('button', { name: 'Check' }).click();
  await expect(root.locator('.active-quiz-status')).toHaveText('Score: 3 of 4');
  await expect(root.getByRole('group', { name: 'Question 3' })).toContainText('Not correct (0 of 1)');
  await expect(root.getByRole('textbox', { name: 'Your answer' })).toBeDisabled();
  await root.getByRole('button', { name: 'Retry' }).click();
  await expect(root.getByRole('textbox', { name: 'Your answer' })).toHaveValue('');
  // The expected answer follows the live calculator value.
  await root.getByRole('spinbutton', { name: 'Shirt price' }).fill('50');
  await root.getByRole('textbox', { name: 'Your answer' }).fill('150');
  await root.getByRole('button', { name: 'Check' }).click();
  await expect(root.getByRole('group', { name: 'Question 1' })).toContainText('Correct (1 of 1)');
});

test('a seeded quiz on a shared page draws a fresh variant on Retry (ActiveMD 0.8.0)', async ({ page }) => {
  const seeded = '```calc\ninput variant = 1 in 1..1000\na = randInt(variant, 2, 9)\nb = randInt(variant, 2, 9, 1)\n```\n\n' +
    'Variant :value[variant]: what is :value[a] × :value[b]?\n\n:::question{type=number}\nYour product:\n\n:answer[a * b]\n:::\n\n::quiz-submit[Check]{seed=variant}\n';
  const encoded = await encodeSharePayload({ title: 'Seeded quiz', text: seeded, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) throw new Error('Share encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  const root = page.locator('#read-text');
  await expect(root.getByRole('button', { name: 'Check' })).toBeEnabled();
  const read = async () => (await root.locator('output').allTextContents()).map(Number);
  const [variant, a, b] = await read();
  await root.getByRole('textbox', { name: 'Your answer' }).fill(String(a! * b!));
  await root.getByRole('button', { name: 'Check' }).click();
  await expect(root.locator('.active-quiz-status')).toHaveText('Score: 1 of 1');
  expect((await read())[0]).toBe(variant);
  await root.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(async () => (await read())[0]).not.toBe(variant);
  const [, a2, b2] = await read();
  await root.getByRole('textbox', { name: 'Your answer' }).fill(String(a2! * b2!));
  await root.getByRole('button', { name: 'Check' }).click();
  await expect(root.locator('.active-quiz-status')).toHaveText('Score: 1 of 1');
});
