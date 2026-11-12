import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test, type Page } from '@playwright/test';
import { ownedChromium } from './owned-chromium';
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
    const owned = ownedChromium(playwright, profile);
    const evidence: Record<string, unknown> = {
      platform: process.platform, node: process.version, repeat, autosave, requestedDelayMs: delayMs,
      phase: autosave ? 'after-save-failure-and-readable-journal' : 'after-private-edit',
      stage: 'launch', outcome: 'incomplete',
    };
    const killOwnedProcess = () => owned.kill();
    async function launch() {
      const context = await owned.launch();
      evidence.browserVersion = owned.version();
      return context;
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

// R2c step 2c: the same kill with only document saves failing, so the change log keeps working.
// Recovery is automatic (a copy is made when the document is opened); no button is clicked.
async function storedTexts(page: Page): Promise<{ texts: string[]; changes: number }> {
  return page.evaluate(() => new Promise<{ texts: string[]; changes: number }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['documents', 'changes'], 'readonly');
      const docs = tx.objectStore('documents').getAll();
      const changes = tx.objectStore('changes').count();
      tx.oncomplete = () => { db.close(); resolve({ texts: (docs.result as { text: string }[]).map(d => d.text), changes: changes.result }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
for (const repeat of [1, 2]) for (const delayMs of [0, 1000, 6000]) {
  test(`process kill, change log: delay=${delayMs}ms, repeat=${repeat} (#37 R2c)`, async ({ playwright, baseURL }, testInfo) => {
    test.skip(process.platform !== 'linux', 'Requires Linux detached process groups; no claim for other platforms');
    const profile = await mkdtemp(join(tmpdir(), 'typebridge-process-crash-log-'));
    const owned = ownedChromium(playwright, profile);
    const evidence: Record<string, unknown> = {
      platform: process.platform, node: process.version, repeat, requestedDelayMs: delayMs,
      phase: 'after-document-save-failure-with-change-log', stage: 'launch', outcome: 'incomplete',
    };
    try {
      let context = await owned.launch();
      evidence.browserVersion = owned.version();
      const page = await context.newPage();
      await page.goto(new URL('/editor.html', baseURL!).href);
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(original);
      await expect(page.locator('#status')).toContainText('Saved locally');
      evidence.stage = 'inject-document-write-failure';
      await page.evaluate(() => {
        // Only the documents store fails; change-log records still reach storage.
        for (const name of ['put', 'add'] as const) {
          const native = IDBObjectStore.prototype[name];
          IDBObjectStore.prototype[name] = function (this: IDBObjectStore, ...args: unknown[]) {
            if (this.name === 'documents') throw new Error('injected diagnostic save failure');
            return (native as (...values: unknown[]) => IDBRequest).apply(this, args);
          } as typeof native;
        }
      });
      await page.locator('#editor').fill(latest);
      await expect(page.locator('#status')).toContainText('Save failed');
      const before = await storedTexts(page);
      evidence.changesBefore = before.changes;
      const observedAt = performance.now();
      // Deliberately sampled elapsed time, never a wait for a successful storage outcome.
      if (delayMs) await page.waitForTimeout(delayMs);
      evidence.actualDelayMs = Math.round(performance.now() - observedAt);
      evidence.stage = 'kill';
      await owned.kill();
      evidence.stage = 'restart';
      context = await owned.launch();
      const next = await context.newPage();
      await next.goto(new URL('/editor.html', baseURL!).href);
      await expect(next.locator('#editor')).toBeEnabled();
      // A tab Chromium restores after the kill may open the document first and make the copy.
      evidence.pagesAfterRestart = context.pages().length;
      evidence.stage = 'verify-recovery';
      let after = await storedTexts(next);
      if (after.changes > 0 || after.texts.includes(latest)) {
        await expect.poll(async () => (after = await storedTexts(next)).texts.includes(latest)).toBe(true);
      }
      evidence.changesAfter = after.changes;
      expect(after.texts).toContain(original);
      const shown = await next.locator('#editor').inputValue();
      evidence.shownAfter = shown === original ? 'original' : shown === latest ? 'recovered-copy' : 'other';
      evidence.outcome = after.texts.includes(latest) ? 'log-recovered-exact-copy-original-retained' : 'log-lost-original-retained';
      evidence.stage = 'complete';
    } finally {
      try { await owned.kill(); }
      finally {
        await rm(profile, { recursive: true, force: true });
        await testInfo.attach('process-crash-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
        console.log('PROCESS_CRASH_EVIDENCE', JSON.stringify(evidence));
      }
    }
  });
}
