const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5174',
    // Set PLAYWRIGHT_CHANNEL=chrome to use a locally installed Chrome.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
  },
});
