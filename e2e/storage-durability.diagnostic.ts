import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test, type Page } from '@playwright/test';
import { ownedChromium } from './owned-chromium';

/*
 * #37 R2c step 1: measurement only, no application change. Does a write that reported success
 * survive an abrupt whole-browser kill 0 or 1 s later, and what does a per-change append cost
 * compared with a full copy? Uses its own database (`typebridge-r2c-spike`) and keys on the
 * reading page, which opens no application storage. Text is synthetic; evidence holds only
 * sizes, counts, timings and enum outcomes.
 */
const PAGE = '/read.html';
const DB = 'typebridge-r2c-spike';
const LS_KEY = 'typebridge.r2c.spike';
const APPENDS = 200;

type Mechanism = 'localStorage' | 'idb-default' | 'idb-strict' | 'idb-append';

/** Install the in-page helpers on the reading page. */
async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(({ db, lsKey }) => {
    const w = window as unknown as Record<string, unknown>;
    w.r2cText = (length: number): string => {
      // Varied Cyrillic, Latin, emoji and newlines; deterministic for a given length.
      const parts = ['Привет ', 'мир ', 'Ёлка ', 'line ', '🙂 ', '\n', 'é ', 'Щука '];
      let out = '';
      let seed = 7;
      while (out.length < length) { seed = (seed * 48271) % 2147483647; out += parts[seed % parts.length] + (seed % 1000); }
      return out.slice(0, length);
    };
    w.r2cHash = (text: string): string => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
      return (hash >>> 0).toString(16) + ':' + text.length;
    };
    w.r2cOpen = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
      const request = indexedDB.open(db, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('docs', { keyPath: 'id' });
        request.result.createObjectStore('log', { keyPath: 'seq' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    w.r2cLsKey = lsKey;
  }, { db: DB, lsKey: LS_KEY });
}

/** Write with `mechanism`; resolve only once the browser reported success. Returns the expected hash. */
async function write(page: Page, mechanism: Mechanism, length: number): Promise<string> {
  return page.evaluate(async ({ mechanism, length, appends }) => {
    const w = window as unknown as {
      r2cText: (n: number) => string; r2cHash: (t: string) => string; r2cOpen: () => Promise<IDBDatabase>; r2cLsKey: string;
    };
    if (mechanism === 'localStorage') {
      const text = w.r2cText(length);
      localStorage.setItem(w.r2cLsKey, text);
      return w.r2cHash(text);
    }
    const db = await w.r2cOpen();
    const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    if (mechanism === 'idb-append') {
      // One transaction per change, issued back to back like keystrokes; all must report complete.
      const pending: Promise<void>[] = [];
      for (let seq = 1; seq <= appends; seq++) {
        const tx = db.transaction('log', 'readwrite');
        tx.objectStore('log').put({ seq, delta: [seq, '', 'а'] });
        pending.push(done(tx));
      }
      await Promise.all(pending);
      db.close();
      return 'seq:' + appends;
    }
    const text = w.r2cText(length);
    const tx = db.transaction('docs', 'readwrite', { durability: mechanism === 'idb-strict' ? 'strict' : 'default' });
    tx.objectStore('docs').put({ id: 'doc', text });
    await done(tx);
    db.close();
    return w.r2cHash(text);
  }, { mechanism, length, appends: APPENDS });
}

/** What survived: the same hash, or `missing`; for appends, `seq:<n>` only if 1..n are all present. */
async function readBack(page: Page, mechanism: Mechanism): Promise<string> {
  return page.evaluate(async ({ mechanism }) => {
    const w = window as unknown as { r2cHash: (t: string) => string; r2cOpen: () => Promise<IDBDatabase>; r2cLsKey: string };
    if (mechanism === 'localStorage') {
      const text = localStorage.getItem(w.r2cLsKey);
      return text === null ? 'missing' : w.r2cHash(text);
    }
    const db = await w.r2cOpen();
    const read = <T>(store: string, op: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      const request = op(db.transaction(store, 'readonly').objectStore(store));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      if (mechanism === 'idb-append') {
        const keys = (await read('log', s => s.getAllKeys())) as number[];
        if (!keys.length) return 'missing';
        const contiguous = keys.every((key, i) => key === i + 1);
        return contiguous ? 'seq:' + keys.length : 'gap:' + keys.length;
      }
      const row = await read<{ text: string } | undefined>('docs', s => s.get('doc'));
      return row ? w.r2cHash(row.text) : 'missing';
    } finally { db.close(); }
  }, { mechanism });
}

const durabilityCases: { mechanism: Mechanism; length: number }[] = [
  { mechanism: 'localStorage', length: 2_000 },
  { mechanism: 'localStorage', length: 1_000_000 },
  { mechanism: 'idb-default', length: 2_000 },
  { mechanism: 'idb-default', length: 5_000_000 },
  { mechanism: 'idb-strict', length: 2_000 },
  { mechanism: 'idb-strict', length: 5_000_000 },
  { mechanism: 'idb-append', length: 0 },
];

// Repeats and delays sample browser behavior; they are not retries or a durability threshold.
for (const repeat of [1, 2]) for (const delayMs of [0, 1000]) for (const { mechanism, length } of durabilityCases) {
  test(`kill after reported write: ${mechanism}, ${length} chars, delay=${delayMs}ms, repeat=${repeat} (#37 R2c)`, async ({ playwright, baseURL }, testInfo) => {
    test.skip(process.platform !== 'linux', 'Requires Linux detached process groups; no claim for other platforms');
    const profile = await mkdtemp(join(tmpdir(), 'typebridge-r2c-'));
    const browser = ownedChromium(playwright, profile);
    const evidence: Record<string, unknown> = {
      platform: process.platform, node: process.version, repeat, mechanism, length, requestedDelayMs: delayMs,
      appends: mechanism === 'idb-append' ? APPENDS : undefined, stage: 'launch', outcome: 'incomplete',
    };
    try {
      let page = await (await browser.launch()).newPage();
      evidence.browserVersion = browser.version();
      await page.goto(new URL(PAGE, baseURL!).href);
      await installHelpers(page);
      evidence.stage = 'write';
      const started = performance.now();
      const expected = await write(page, mechanism, length);
      evidence.writeMs = Math.round(performance.now() - started);
      const reportedAt = performance.now();
      if (delayMs) await page.waitForTimeout(delayMs);
      evidence.actualDelayMs = Math.round(performance.now() - reportedAt);
      evidence.stage = 'kill';
      await browser.kill();
      evidence.stage = 'restart';
      page = await (await browser.launch()).newPage();
      await page.goto(new URL(PAGE, baseURL!).href);
      await installHelpers(page);
      const found = await readBack(page, mechanism);
      evidence.outcome = found === expected ? 'survived-exact' : found === 'missing' ? 'lost' : 'partial-or-different';
      evidence.found = found.startsWith('seq:') || found.startsWith('gap:') ? found : undefined;
      evidence.stage = 'complete';
      // Always completes: a lost write is a measured outcome, not a test failure.
      expect(evidence.stage).toBe('complete');
    } finally {
      try { await browser.kill(); }
      finally {
        await rm(profile, { recursive: true, force: true });
        await testInfo.attach('storage-durability-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
        console.log('STORAGE_DURABILITY_EVIDENCE', JSON.stringify(evidence));
      }
    }
  });
}

test('per-change cost: full copy vs append, by document size (#37 R2c)', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto(new URL(PAGE, baseURL!).href);
  await installHelpers(page);
  const results = await page.evaluate(async ({ sizes, runs }) => {
    const w = window as unknown as { r2cText: (n: number) => string; r2cOpen: () => Promise<IDBDatabase>; r2cLsKey: string };
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100; };
    const db = await w.r2cOpen();
    const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const out: Record<string, unknown>[] = [];
    let seq = 0;
    for (const size of sizes) {
      const text = w.r2cText(size);
      const row: Record<string, unknown> = { size };
      // Today's journal: the whole text and title as JSON, synchronously, on every edit.
      const ls: number[] = [];
      try {
        for (let i = 0; i < runs; i++) {
          const t = performance.now();
          localStorage.setItem(w.r2cLsKey, JSON.stringify({ title: 'T', text: text + i }));
          ls.push(performance.now() - t);
        }
        row.localStorageFullMs = median(ls);
      } catch { row.localStorageFullMs = 'quota-exceeded'; }
      localStorage.removeItem(w.r2cLsKey);
      // Today's Autosave: the whole record in one transaction, until it reports complete.
      const full: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        const tx = db.transaction('docs', 'readwrite');
        tx.objectStore('docs').put({ id: 'doc', text: text + i });
        await done(tx);
        full.push(performance.now() - t);
      }
      row.idbFullMs = median(full);
      // Proposed: one small change record, until it reports complete; the document size should not matter.
      const append: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        const tx = db.transaction('log', 'readwrite');
        tx.objectStore('log').put({ seq: ++seq, delta: [size, '', 'а'] });
        await done(tx);
        append.push(performance.now() - t);
      }
      row.idbAppendMs = median(append);
      out.push(row);
    }
    db.close();
    return out;
  }, { sizes: [100_000, 1_000_000, 10_000_000], runs: 7 });
  const evidence = { platform: process.platform, node: process.version, browserVersion: page.context().browser()?.version(), runs: 7, results };
  await testInfo.attach('storage-cost-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  console.log('STORAGE_COST_EVIDENCE', JSON.stringify(evidence));
  expect(results).toHaveLength(3);
});
