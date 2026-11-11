import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Explicitly invoked research, never a replacement for the required three-engine suite.
export default defineConfig({
  ...base,
  testMatch: '**/*.diagnostic.ts',
  projects: [{ name: 'chromium-process', use: { browserName: 'chromium' } }],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { ...base.use, trace: 'off', screenshot: 'off', video: 'off' },
});
