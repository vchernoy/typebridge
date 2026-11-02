// Opt-in PR visual evidence: build the exact base and capture both revisions.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.VISUAL_BASE_SHA;
if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('VISUAL_BASE_SHA must be a commit SHA');
const workspace = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), 'typebridge-visual-'));
const before = path.join(temporary, 'before');
const evidence = path.join(workspace, 'visual-evidence');
let browser;
try {
  execFileSync('git', ['fetch', '--depth=1', 'origin', base], { stdio: 'inherit' });
  execFileSync('git', ['worktree', 'add', '--detach', before, base], { stdio: 'inherit' });
  execFileSync('npm', ['ci'], { cwd: before, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: before, stdio: 'inherit' });
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch();
  for (const [revision, root] of [['before', path.join(before, 'dist')], ['after', path.join(workspace, 'dist')]]) {
    for (const colorScheme of ['light', 'dark']) for (const width of [390, 1400]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme, serviceWorkers: 'block' });
      await context.route('https://typebridge.test/**', async route => {
        const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
        try {
          const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
          await route.fulfill({ body: await readFile(file), contentType });
        } catch { await route.fulfill({ status: 404, body: '' }); }
      });
      const page = await context.newPage();
      await page.goto('https://typebridge.test/');
      await page.locator('#editor').fill('Example text. More example text.');
      await page.locator('#draft-title').fill('Example document');
      await page.locator('#save-indicator').filter({ hasText: /^Saved$/ }).waitFor();
      await page.locator('#find-open').click();
      await page.locator('#find-text').fill('text');
      await page.locator('#find-next').click();
      await page.locator('html').evaluate(element => element.ownerDocument.fonts.ready);
      await page.screenshot({ path: path.join(evidence, `${revision}-${colorScheme}-${width}.png`), fullPage: true, animations: 'disabled' });
      await context.close();
    }
  }
  await writeFile(path.join(evidence, 'provenance.json'), JSON.stringify({ base, head: process.env.GITHUB_SHA, widths: [390, 1400], themes: ['light', 'dark'], browser: 'chromium', sample: 'Synthetic document; Find open after navigation' }, null, 2));
} finally {
  await browser?.close();
  try { execFileSync('git', ['worktree', 'remove', '--force', before], { stdio: 'inherit' }); } finally { await rm(temporary, { recursive: true, force: true }); }
}
