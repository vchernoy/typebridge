import { expect, type Locator } from '@playwright/test';

export const polishedMarkdown = `\`\`\`calc
input deposit = 10000 in 0..10000000
input rate = 8
input years = 10 in 1..50
final = deposit * (1 + rate / 100) ^ years
\`\`\`

Deposit :input[deposit] at :input[rate]{widget=slider min=0 max=20 step=1} for :input[years] years.

:value[final]{format=fixed:2}

$$
F={{final | fixed:2}}
$$`;

export async function assertPolishedMarkdown(root: Locator): Promise<void> {
  const sentence = root.locator('p').first();
  const lines = await sentence.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).map(rect => ({ top: rect.top, bottom: rect.bottom }));
  });
  // Every text/control box must overlap a common horizontal band.
  expect(Math.max(...lines.map(rect => rect.top))).toBeLessThan(Math.min(...lines.map(rect => rect.bottom)));
  const value = root.locator('output[data-active-value="final"]');
  await expect(value).toHaveText('21,589.25');
  const math = root.locator('math > semantics > mrow');
  const mathNumber = async () => (await math.textContent())!.replace(/^F=/, '');
  await expect.poll(mathNumber).toBe(await value.textContent());
  await root.locator('input[data-active-input="deposit"]').fill('20000');
  await expect(value).toHaveText('43,178.50');
  await expect.poll(mathNumber).toBe(await value.textContent());
  await expect(root.locator('.active-error, .katex-error')).toHaveCount(0);
}
