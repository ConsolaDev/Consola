const { test, expect } = require('@playwright/test');

const releaseUrl = 'https://github.com/ConsolaDev/Consola/releases';
const releaseApi = 'https://api.github.com/repos/ConsolaDev/Consola/releases/latest';
const installer = (arch) => ({
  name: `Consola-1.0.0-${arch}.dmg`, state: 'uploaded', size: 1024,
  browser_download_url: `${releaseUrl}/download/v1.0.0/Consola-1.0.0-${arch}.dmg`,
});
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(releaseApi, route => route.fulfill({ status: 404, body: '{}' }));
});
async function demo(page, view = 'inbox') {
  await page.goto('/');
  await page.locator('[data-live-demo]').scrollIntoViewIfNeeded();
  const frame = page.frameLocator('[data-live-demo] iframe');
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toBeVisible();
  if (view === 'inbox') {
    await page.getByRole('button', { name: /Review a pull request/ }).click();
    await expect(frame.locator('.inbox-row')).toHaveCount(4);
  }
  return frame;
}
async function settings(frame, name = 'Acme') {
  await frame.getByRole('button', { name: `${name} workspace menu` }).click();
  await frame.getByRole('menuitem', { name: 'Workspace settings…', exact: true }).click();
  return frame.getByRole('dialog');
}

test('real Inbox → saved action → native terminal → approve and commit sample changes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const frame = await demo(page);
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await frame.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(frame.locator('.work-item-strip')).toContainText('#248');
  const terminal = frame.locator('.terminal-panel .xterm-helper-textarea');
  await terminal.fill('fix the retry guard');
  await terminal.press('Enter');
  await expect(frame.locator('.git-review-panel')).toContainText('isRetryable');
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toContainText('PR #248');
  await frame.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await frame.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(frame.getByPlaceholder('Enter commit message...')).toHaveValue('fix: stop retrying non-retryable client errors');
  await frame.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(frame.locator('.demo-notice')).toContainText('Sample commit created');
  await expect(frame.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('workspaces keep separate GitHub accounts, harnesses, and conversation groups', async ({ page }) => {
  const frame = await demo(page);
  let dialog = await settings(frame);
  await expect(dialog).toContainText('gh alex-work');
  await expect(dialog.locator('.ws-manifest')).toContainText('Claude Code · Work');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(frame.locator('.inbox-row')).toHaveCount(1);
  await expect(frame.locator('.inbox-row')).toContainText('Add a reading list');
  dialog = await settings(frame, 'Personal');
  await expect(dialog).toContainText('gh alex-builds');
  await expect(dialog.locator('.ws-manifest')).toContainText('Codex · Personal');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toContainText('weekend-app');
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).not.toContainText('pr-reviews');
});

test('saved custom prompts and destination groups affect launched sessions', async ({ page }) => {
  const frame = await demo(page);
  const dialog = await settings(frame);
  await dialog.getByRole('button', { name: 'Actions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit Review PR', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Action prompt' }).fill('Check retry limits for PR {{number}} and summarize security findings.');
  await dialog.getByRole('combobox', { name: 'Group this action lands sessions in' }).selectOption('research');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await frame.getByRole('button', { name: 'Review PR', exact: true }).click();
  const state = await page.locator('iframe').evaluate(async iframe => {
    const snapshot = await iframe.contentWindow.workspaceAPI.getSnapshot();
    const session = snapshot.workspaces[0].sessions.at(-1);
    const transcript = await iframe.contentWindow.terminalAPI.create({ instanceId: session.instanceId });
    return { group: session.groupId, replay: transcript.replay };
  });
  expect(state.group).toBe('research');
  expect(state.replay).toContain('Check retry limits for PR 248 and summarize security findings.');
});

test('create and rename a group through the actual sidebar', async ({ page }) => {
  const frame = await demo(page);
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await frame.getByRole('button', { name: 'Add group', exact: true }).click();
  const dialog = frame.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Weekend experiments');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toContainText('Weekend experiments');
  await frame.getByRole('button', { name: /^Weekend experiments/ }).hover();
  await frame.getByRole('button', { name: 'Group actions for Weekend experiments' }).click();
  await frame.getByRole('menuitem', { name: /Rename/ }).click();
  await frame.getByRole('dialog').getByRole('textbox').fill('Experiments');
  await frame.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toContainText('Experiments');
});

test('shortcuts work and resetting restores the original mock state', async ({ page }) => {
  const frame = await demo(page, 'home');
  const home = page.getByRole('button', { name: /Explore Home/ });
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByRole('navigation', { name: 'Session groups' })).toContainText('Build onboarding flow');
  await expect(frame.locator('.terminal-panel')).toBeVisible();
  await frame.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(home).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /Review a pull request/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Switch to Personal/ }).click();
  await expect(frame.getByRole('button', { name: 'Personal workspace menu' })).toBeVisible();
  await page.getByRole('button', { name: /Inspect code changes/ }).click();
  await expect(frame.locator('.git-review-panel')).toContainText('isRetryable');
  await page.getByRole('button', { name: /Explore Home/ }).click();
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(frame.locator('.git-review-panel')).toHaveCount(0);
  await page.getByRole('button', { name: /Review a pull request/ }).click();
  await expect(frame.locator('.inbox-row')).toHaveCount(4);
  await page.getByRole('button', { name: /Reset demo/ }).click();
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('.inbox-row')).toHaveCount(0);
  await expect(frame.locator('.git-review-panel')).toHaveCount(0);
});

test('demo interactions stay in the browser and use no persisted state', async ({ page }) => {
  const outgoing = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && request.url() !== releaseApi) outgoing.push(request.url());
  });
  const frame = await demo(page);
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await frame.getByRole('button', { name: 'Custom prompt...', exact: true }).click();
  await frame.locator('.inbox-pane textarea').fill('Check the sample code');
  await frame.locator('.inbox-pane').getByRole('button', { name: /Start/ }).click();
  await expect(frame.locator('.terminal-panel')).toBeVisible();
  expect(outgoing).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('consola')))).toEqual([]);
});

for (const width of [320, 390, 768, 1440]) {
  test(`the real desktop UI stays scrollable without overflowing the page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const frame = await demo(page);
    await expect(frame.getByRole('button', { name: 'Acme workspace menu' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 1100) {
      const scroll = page.locator('.live-demo-viewport');
      expect(await scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
  });
}

test('latest stable installers populate all primary and Intel download links', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  await page.route(releaseApi, route => route.fulfill({ json: {
    tag_name: 'v1.0.0', assets: [installer('arm64'), installer('x64')],
  } }));
  await page.goto('/');
  for (const link of await page.locator('[data-download-link]').all()) {
    await expect(link).toHaveAttribute('href', '/download/?arch=arm64');
  }
  await expect(page.locator('#download-intel')).toBeVisible();
  await expect(page.locator('#download-intel')).toHaveAttribute('href', '/download/?arch=x64');
});

test('release failures leave usable fallback links', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  await page.goto('/');
  await expect(page.locator('#download-status')).toContainText('coming soon');
  for (const link of await page.locator('[data-download-link]').all()) {
    await expect(link).toHaveAttribute('href', releaseUrl);
  }
});

test('touch Macs and other platforms do not request macOS installers', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  let requests = 0;
  page.on('request', request => { if (request.url() === releaseApi) requests++; });
  await page.goto('/');
  await expect(page.locator('#download-status')).toContainText('currently available for macOS');
  expect(requests).toBe(0);
});

test('the screenshot and download links remain usable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://localhost:5174');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('One workspace.');
  await page.locator('.real-app summary').click();
  await expect(page.locator('.real-app img')).toBeVisible();
  await expect(page.locator('[data-download-link]').first()).toHaveAttribute('href', releaseUrl);
  await context.close();
});

test('standalone demo can scroll on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo/index.html');
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => scrollTo({ left: 600, behavior: 'instant' }));
  expect(await page.evaluate(() => scrollX)).toBeGreaterThan(0);
});

for (const arch of ['arm64', 'x64']) {
  test(`download thank-you page starts the ${arch} installer and offers a retry`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'userAgentData', { value: undefined });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
    });
    await page.route(releaseApi, route => route.fulfill({ json: {
      tag_name: 'v1.0.0', assets: [installer('arm64'), installer('x64')],
    } }));
    await page.route(installer(arch).browser_download_url, route => route.fulfill({
      contentType: 'application/octet-stream', headers: { 'Content-Disposition': `attachment; filename="Consola-${arch}.dmg"` }, body: 'test installer',
    }));
    await page.goto('/');
    const download = page.waitForEvent('download');
    await page.locator(arch === 'arm64' ? '.hero [data-download-link]' : '#download-intel').click();
    expect((await download).suggestedFilename()).toBe(`Consola-${arch}.dmg`);
    await expect(page).toHaveURL(`/download/?arch=${arch}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thanks for downloading');
    await expect(page.locator('[data-download-retry]')).toHaveAttribute('href', installer(arch).browser_download_url);
    await expect(page.locator('.download-community a')).toHaveAttribute('href', 'https://github.com/ConsolaDev/Consola');
    const retry = page.waitForEvent('download');
    await page.locator('[data-download-retry]').click();
    await retry;
  });
}

test('download page keeps a release fallback when GitHub is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  await page.route(releaseApi, route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/download/?arch=arm64');
  await expect(page.locator('#download-status')).toContainText('Check GitHub releases');
  await expect(page.locator('[data-download-retry]')).toHaveAttribute('href', releaseUrl);
});

for (const width of [320, 390, 1440]) {
  test(`download page fits at ${width}px without JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto('http://localhost:5174/download/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-download-retry]')).toHaveAttribute('href', releaseUrl);
    await expect(page.locator('.download-community a')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.close();
  });
}
