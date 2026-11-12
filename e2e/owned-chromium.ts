import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Browser, type BrowserContext, type PlaywrightWorkerArgs } from '@playwright/test';

/**
 * A Chromium process owned by one diagnostic, on its own profile, that can be killed abruptly
 * (#37 R2b/R2c). The PID comes only from this spawn; nothing is ever killed by name or port.
 */
export function ownedChromium(playwright: PlaywrightWorkerArgs['playwright'], profile: string) {
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let exit: Promise<void> | undefined;
  let version: string | undefined;
  return {
    version: () => version,
    /** Start a fresh process on the profile and return its default context. */
    async launch(): Promise<BrowserContext> {
      // Never reconnect to the previous process's stale endpoint.
      await rm(join(profile, 'DevToolsActivePort'), { force: true });
      // DIAGNOSTIC_CHROMIUM points at another installed Chromium when Playwright's own build is absent.
      const owned = spawn(process.env.DIAGNOSTIC_CHROMIUM || playwright.chromium.executablePath(), [
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
      version = browser.version();
      return browser.contexts()[0]!;
    },
    /** SIGKILL the owned process group (no page, context or browser close) and wait for exit. */
    async kill(): Promise<void> {
      if (!child) return;
      if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
      await exit;
      child = undefined;
      browser = undefined;
    },
  };
}
