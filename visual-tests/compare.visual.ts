import { expect, test } from '@playwright/test';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Expected images are generated from the exact PR base, never updated from head.
test('color refactor preserves base pixels in every scene and theme', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const files = (await readdir('visual-evidence')).filter(file => file.startsWith('before-') && file.endsWith('.png'));
  expect(files).toHaveLength(16);
  for (const before of files) {
    const name = before.replace(/^before-/, '');
    const expected = testInfo.snapshotPath(name);
    await mkdir(path.dirname(expected), { recursive: true });
    await copyFile(path.join('visual-evidence', before), expected);
    const actual = await readFile(path.join('visual-evidence', before.replace(/^before-/, 'after-')));
    // Decode image pixels; tolerate only the comparator's antialiasing treatment.
    expect(actual).toMatchSnapshot({ name, maxDiffPixels: 0, threshold: 0.1 });
  }
});
