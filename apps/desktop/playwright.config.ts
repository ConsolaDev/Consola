import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  // In CI a stray `test.only` would pass the run on one test.
  forbidOnly: !!process.env.CI,
  // CI annotates each failure on the pull request and keeps the HTML report.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {},
    },
  ],
});
