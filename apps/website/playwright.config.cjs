const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // In CI a stray `test.only` would pass the run on one test.
  forbidOnly: !!process.env.CI,
  // CI annotates each failure on the pull request and keeps the HTML report.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    // Set PLAYWRIGHT_CHANNEL=chrome to use a locally installed Chrome.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1',
    // The site compiles PostHog out entirely without a key, so the suite supplies a
    // throwaway one to exercise the real analytics path. Nothing reaches PostHog:
    // api_host is '/cnsl' on this origin, which only Vercel's rewrites forward on.
    env: { ...process.env, VITE_POSTHOG_KEY: 'phc_consola_test_key' },
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
  },
});
