import { test, expect, type Locator } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
import { polishedMarkdown } from './markdown-polish-helpers';

const kinds = ['note', 'tip', 'warning', 'danger', 'important', 'exercise'];
const source = polishedMarkdown + '\n\n$$\nx=1\n$$\n\n$$\n' + Array(30).fill('123456789').join('+') + '\n$$\n\n' + kinds.map(kind => `:::${kind}\nBody text.\n:::`).join('\n\n') + '\n\n:::details\nNeutral details.\n:::';

async function contrast(root: Locator) {
  return root.evaluate(element => {
    const rgb = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (c: number[]) => c.map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((n, x, i) => n + x * [.2126, .7152, .0722][i], 0);
    const ratio = (a: number[], b: number[]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const surface = rgb(getComputedStyle(element.closest('.active-reading')!).backgroundColor);
    return Array.from(element.querySelectorAll('.callout')).map(callout => {
      const style = getComputedStyle(callout), title = getComputedStyle(callout.querySelector('.callout-title')!);
      // Package tint is 8% of the kind colour over the app surface.
      const border = rgb(style.borderLeftColor);
      const background = surface.map((x, i) => x * .92 + border[i] * .08);
      return { border: style.borderLeftColor, background: style.backgroundColor, bodyContrast: ratio(rgb(style.color), background), titleContrast: ratio(rgb(title.color), background) };
    });
  });
}

for (const surface of ['editor', 'reader']) for (const theme of ['light', 'dark']) {
  test(`${surface} 0.2.0 typography, callouts and overflow in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    if (surface === 'reader') {
      const payload = await encodeSharePayload({ title: 'Polish', text: source, format: 'markdown', view: 'rendered', edit: true });
      if (!payload.ok) throw new Error('Share encoding failed');
      await page.goto('/read.html#doc=' + payload.payload);
    } else {
      await page.goto('/editor.html');
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-preview').click();
    }
    await page.evaluate(theme => document.documentElement.dataset.colorScheme = theme, theme);
    const root = page.locator(surface === 'reader' ? '#read-text' : '#rendered-document');
    await expect(root.locator('.active-doc')).toBeVisible();
    // This helper targets the first math expression when this fixture has several.
    const sentence = root.locator('p').first();
    const input = root.locator('input[type=number]').first();
    expect(await input.evaluate(el => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight })))
      .toEqual(await sentence.evaluate(el => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight })));
    expect(await root.locator('input[data-active-input=years]').evaluate(el => el.getBoundingClientRect().width))
      .toBeLessThan(await input.evaluate(el => el.getBoundingClientRect().width));
    const font = await root.locator('math').first().evaluate(el => getComputedStyle(el).fontFamily);
    expect(font).toContain('STIX Two Math');
    const palette = await contrast(root);
    expect(new Set(palette.map(x => x.border)).size).toBe(6);
    for (const colors of palette) { expect(colors.bodyContrast).toBeGreaterThanOrEqual(4.5); expect(colors.titleContrast).toBeGreaterThanOrEqual(4.5); }
    await page.setViewportSize({ width: 390, height: 700 });
    const short = root.locator('.active-math-display').nth(1), long = root.locator('.active-math-display').nth(2);
    await expect(short).not.toHaveAttribute('data-overflow-end');
    await expect(short).toHaveCSS('mask-image', 'none');
    await expect(long).toHaveAttribute('data-overflow-end');
    expect(await long.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await long.evaluate(el => getComputedStyle(el).maskImage)).not.toBe('none');
    await long.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect(long).toHaveAttribute('data-overflow-start');
    await expect(long).not.toHaveAttribute('data-overflow-end');
    if (surface === 'reader') {
      for (const selector of ['.read-edit', '.read-footer a']) {
        const link = page.locator(selector);
        expect(await link.evaluate(el => getComputedStyle(el).color)).toBe(await root.evaluate(el => {
          const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; el.append(probe);
          const color = getComputedStyle(probe).color; probe.remove(); return color;
        }));
        const linkContrast = await link.evaluate(el => {
          const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(x => {
            x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
          }).reduce((n, x, i) => n + x * [.2126, .7152, .0722][i], 0);
          const text = luminance(getComputedStyle(el).color);
          const background = luminance(getComputedStyle(document.body).backgroundColor);
          return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
        });
        expect(linkContrast).toBeGreaterThanOrEqual(4.5);
        await link.hover();
        await expect(link).toHaveCSS('text-decoration-thickness', '2px');
        await link.focus();
        await expect(link).toHaveCSS('outline-style', 'solid');
      }
    }
  });
}
