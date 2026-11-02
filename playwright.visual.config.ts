import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './visual-tests',
  testMatch: '*.visual.ts',
  reporter: 'list',
  snapshotPathTemplate: '{testDir}/expected/{arg}{ext}',
});
