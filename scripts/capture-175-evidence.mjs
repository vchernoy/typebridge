/**
 * Capture #175 step 11 host-window layout screenshots (Playwright Chromium).
 * Synthetic viewports only — not a substitute for real-device or AT evidence.
 *
 * Prerequisites: `npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort`
 * (or any server already serving the built app at http://127.0.0.1:4173/).
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/evidence/175');
const baseURL = process.env.TYPEBRIDGE_EVIDENCE_URL ?? 'http://127.0.0.1:4173';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const shots = [
  { name: 'desktop-light-tiled', width: 1280, height: 800, colorScheme: 'light', layout: 'free' },
  { name: 'desktop-dark-tiled', width: 1280, height: 800, colorScheme: 'dark', layout: 'free' },
  { name: 'phone-light-stacked', width: 390, height: 844, colorScheme: 'light', layout: 'stacked' },
  { name: 'phone-dark-stacked', width: 390, height: 844, colorScheme: 'dark', layout: 'stacked' },
];

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    colorScheme: shot.colorScheme,
  });
  const page = await context.newPage();
  // String form keeps Node ESLint from flagging browser globals in the payload.
  await page.addInitScript(`(() => {
    try {
      localStorage.setItem('typebridge.host.layoutMode.v1', ${JSON.stringify(shot.layout)});
      localStorage.setItem('typebridge.appearance.v1', ${JSON.stringify(shot.colorScheme)});
    } catch { /* private mode — defaults still render */ }
  })()`);
  await page.goto(`${baseURL}/host.html`, { waitUntil: 'networkidle' });
  const main = page.frameLocator('.host-window iframe.host-editor').first();
  await main.locator('#editor').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: 'New window' }).click();
  await page.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor')
    .waitFor({ state: 'visible', timeout: 30_000 });
  if (shot.layout === 'free') {
    await page.getByRole('button', { name: 'Tile side by side' }).click();
  }
  // Distinct titles for the region aria-labels (never log entered text elsewhere).
  const mainTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  const secondTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await mainTitle.waitFor({ state: 'visible' });
  await waitEditable(mainTitle);
  await mainTitle.fill('Evidence A');
  await waitEditable(secondTitle);
  await secondTitle.fill('Evidence B');
  await page.screenshot({
    path: path.join(outDir, `${shot.name}.png`),
    fullPage: false,
  });
  await context.close();
  process.stdout.write(`wrote ${shot.name}.png\n`);
}

await browser.close();
process.stdout.write(`Wrote screenshots under ${outDir}\n`);

/** Wait until the host title input is writable (iframe title hooks ready). */
async function waitEditable(locator) {
  await locator.evaluate(async el => {
    const input = /** @type {HTMLInputElement} */ (el);
    for (let i = 0; i < 60; i++) {
      if (!input.readOnly && !input.disabled) return;
      await new Promise(resolve => {
        globalThis.setTimeout(resolve, 50);
      });
    }
    throw new Error('Host title never became editable');
  });
}
