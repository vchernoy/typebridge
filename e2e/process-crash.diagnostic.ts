import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { selectDocument, setAutosave } from './settings-helpers';

const original = 'Сохранённый оригинал';
const latest = 'После падения браузера 🙂\nВторая строка';
const title = 'Процесс R2';
const unloadKey = 'typebridge.test.processCrashUnload';

async function journalCount(page: Page): Promise<number> {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('typebridge.recovery.v1.')).length);
}

// Repeats and delays are a diagnostic matrix, not retry-until-success or a durability threshold.
for (const repeat of [1, 2]) for (const autosave of [true, false]) for (const delayMs of [0, 1000, 6000]) {
  test(`process kill: autosave=${autosave}, delay=${delayMs}ms, repeat=${repeat} (#37 R2b)`, async ({ playwright, baseURL }, testInfo) => {
    test.skip(process.platform !== 'linux', 'Requires Linux detached process groups; no claim for other platforms');
    const profile = await mkdtemp(join(tmpdir(), 'typebridge-process-crash-'));
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let exit: Promise<void> | undefined;
    const evidence: Record<string, unknown> = {
      platform: process.platform, node: process.version, repeat, autosave, requestedDelayMs: delayMs,
      phase: autosave ? 'after-save-failure-and-readable-journal' : 'after-private-edit',
      stage: 'launch', outcome: 'incomplete',
    };
    async function killOwnedProcess(): Promise<void> {
      if (!child) return;
      // PID is obtained exclusively from this test's fresh detached spawn. Never kill by name/port.
      if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
      await exit;
      child = undefined;
      browser = undefined;
    }
    async function launch() {
      // Never reconnect to the previous process's stale endpoint.
      await rm(join(profile, 'DevToolsActivePort'), { force: true });
      const owned = spawn(playwright.chromium.executablePath(), [
        '--headless', '--no-sandbox', '--disable-dev-shm-usage',
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
      ], { detached: true, stdio: 'ignore' });
      child = owned;
      // Attach handlers immediately, including startup failures, before any awaits.
      let spawnError: Error | undefined;
      exit = new Promise<void>(resolve => {
        owned.once('exit', () => resolve());
        owned.once('error', error => { spawnError = error; resolve(); });
      });
      let port = '';
      await expect.poll(async () => {
        if (spawnError || owned.exitCode !== null || owned.signalCode !== null) throw new Error('Diagnostic Chromium exited before connection');
        try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!; }
        catch { return false; }
        return /^\d+$/.test(port);
      }, { timeout: 10_000 }).toBe(true);
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      evidence.browserVersion = browser.version();
      return browser.contexts()[0]!;
    }
    try {
      let context = await launch();
      const page = await context.newPage();
      await page.goto(new URL('/editor.html', baseURL!).href);
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(original);
      await expect(page.locator('#status')).toContainText('Saved locally');
      if (!autosave) await setAutosave(page, false);
      evidence.stage = 'inject-document-write-failure';
      await page.evaluate(key => {
        localStorage.removeItem(key);
        window.addEventListener('pagehide', () => localStorage.setItem(key, 'pagehide'));
        window.addEventListener('beforeunload', () => localStorage.setItem(key, 'beforeunload'));
        IDBObjectStore.prototype.put = function () { throw new Error('injected diagnostic save failure'); };
        IDBObjectStore.prototype.add = function () { throw new Error('injected diagnostic save failure'); };
      }, unloadKey);
      await page.locator('#editor').fill(latest);
      await page.locator('#draft-title').fill(title);
      if (autosave) await expect(page.locator('#status')).toContainText('Save failed');
      const before = await journalCount(page);
      evidence.journalsBefore = before;
      expect(before).toBe(autosave ? 1 : 0);
      const observedAt = performance.now();
      // Deliberately sampled elapsed time, never a wait for a successful storage outcome.
      if (delayMs) await page.waitForTimeout(delayMs);
      evidence.actualDelayMs = Math.round(performance.now() - observedAt);
      evidence.stage = 'kill';
      await killOwnedProcess(); // No page/context/browser close or unload before termination.
      evidence.stage = 'restart';
      context = await launch();
      const next = await context.newPage();
      await next.goto(new URL('/editor.html', baseURL!).href);
      await expect(next.locator('#editor')).toBeEnabled();
      await expect(next.locator('#editor')).toHaveValue(original);
      evidence.unloadMarkerAfter = await next.evaluate(key => localStorage.getItem(key), unloadKey);
      expect(evidence.unloadMarkerAfter).toBeNull();
      const after = await journalCount(next);
      evidence.journalsAfter = after;
      evidence.stage = 'verify-recovery';
      if (autosave && after > 0) {
        await next.getByRole('button', { name: /Recover Процесс R2/ }).click();
        await expect(next.locator('#status')).toContainText('Recovered a copy');
        await expect(next.locator('#editor')).toHaveValue(original);
        await selectDocument(next, { label: title + ' (recovered)' });
        await expect(next.locator('#editor')).toHaveValue(latest);
        await expect(next.locator('#draft-title')).toHaveValue(title + ' (recovered)');
        evidence.outcome = 'recovered-exact-copy-original-retained';
      } else {
        expect(after).toBe(0);
        await expect(next.getByRole('button', { name: /^Recover / })).toHaveCount(0);
        evidence.outcome = autosave ? 'journal-lost-original-retained' : 'private-edits-not-journaled-original-retained';
      }
      evidence.stage = 'complete';
    } finally {
      // Kill the restarted test process too, await its exit before removing its unique profile.
      try { await killOwnedProcess(); }
      finally {
        await rm(profile, { recursive: true, force: true });
        await testInfo.attach('process-crash-evidence.json', {
          body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
        });
        // Only counts, versions, phases and enum outcomes; never document text/title/profile paths.
        console.log('PROCESS_CRASH_EVIDENCE', JSON.stringify(evidence));
      }
    }
  });
}
