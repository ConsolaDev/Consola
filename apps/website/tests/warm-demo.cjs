const { chromium } = require('@playwright/test');

/**
 * The suite runs against Vite's dev server, which compiles the demo's four
 * hundred or so modules the first time a page asks for them. On a two-core CI
 * runner that first load takes longer than an assertion's 5 s, so the first
 * test in each worker failed before the demo had drawn anything, on `main` as
 * on any branch. Playwright runs this once the server answers and before any
 * test, so every test meets a server that has already compiled the demo.
 *
 * Only a warm-up: a demo that never draws is left to the tests to report, in
 * their own words, rather than failing here.
 */
module.exports = async function warmDemo(config) {
  const { baseURL, channel } = config.projects[0].use;
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    await page.goto(new URL('demo/index.html', baseURL).href);
    await page.getByRole('button', { name: 'Home', exact: true }).waitFor({ timeout: 120_000 });
  } catch (error) {
    console.warn(`The demo did not draw while warming up: ${error.message}`);
  } finally {
    await browser.close();
  }
};
