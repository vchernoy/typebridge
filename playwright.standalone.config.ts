import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './standalone-tests',
  outputDir: './standalone-test-results',
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { trace: 'retain-on-failure', acceptDownloads: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
