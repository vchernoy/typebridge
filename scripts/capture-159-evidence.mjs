/**
 * Capture #159 S6 layout screenshots (Playwright desktop + narrow, light/dark).
 * Not a substitute for real-device or AT evidence.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/evidence/159');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const shots = [
  { name: 'desktop-light-split', width: 1280, height: 800, colorScheme: 'light' },
  { name: 'desktop-dark-split', width: 1280, height: 800, colorScheme: 'dark' },
  { name: 'phone-light-stacked', width: 390, height: 844, colorScheme: 'light' },
  { name: 'phone-dark-stacked', width: 390, height: 844, colorScheme: 'dark' },
];

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    colorScheme: shot.colorScheme,
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  await page.locator('#editor').waitFor({ state: 'visible' });
  await page.getByRole('switch', { name: 'Кириллица' }).uncheck();
  await page.locator('#editor').fill('S6 evidence — pane A\nLive companion mirrors this text.');
  await page.locator('#doc-menu-open').click();
  await page.locator('#toggle-split').click();
  await page.locator('#editor-b').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.screenshot({
    path: path.join(outDir, `${shot.name}.png`),
    fullPage: false,
  });
  await context.close();
  console.log(`wrote ${shot.name}.png`);
}

await browser.close();
console.log(`Wrote screenshots under ${outDir}`);
