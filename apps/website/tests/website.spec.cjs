const { test, expect } = require('@playwright/test');

const releaseUrl = 'https://github.com/ConsolaDev/Consola/releases';
const releaseApi = 'https://api.github.com/repos/ConsolaDev/Consola/releases/latest';
const installer = (arch) => ({
  name: `Consola-1.0.0-${arch}.dmg`,
  state: 'uploaded',
  size: 1024,
  browser_download_url: `${releaseUrl}/download/v1.0.0/Consola-1.0.0-${arch}.dmg`,
});
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(releaseApi, (route) => route.fulfill({ status: 404, body: '{}' }));
});
/** The sidebar's list of the sessions in play; Working, Snoozed and Settled have lists of their own. */
const sessionList = (frame) => frame.getByRole('navigation', { name: 'Sessions', exact: true });
async function demo(page, view = 'inbox') {
  await page.goto('/');
  await page.locator('[data-live-demo]').scrollIntoViewIfNeeded();
  const frame = page.frameLocator('[data-live-demo] iframe');
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(sessionList(frame)).toBeVisible();
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

test('real Inbox → saved action → native terminal → approve and commit sample changes', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const frame = await demo(page);
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await expect(frame.locator('.inbox-pane')).toContainText(
    'A 400 fails the same way on every attempt.',
  );
  await frame.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(frame.getByRole('complementary', { name: 'Session info' })).toContainText('#248');
  const terminal = frame.locator('.terminal-panel .xterm-helper-textarea');
  await terminal.fill('fix the retry guard');
  await terminal.press('Enter');
  await expect(frame.locator('.git-review-panel')).toContainText('isRetryable');
  await expect(sessionList(frame)).toContainText('PR #248');
  await frame.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await frame.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(frame.getByPlaceholder('Enter commit message...')).toHaveValue(
    'fix: stop retrying non-retryable client errors',
  );
  await frame.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(frame.locator('.demo-notice')).toContainText('Sample commit created');
  await expect(frame.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('workspaces keep separate GitHub accounts, harnesses, and sessions', async ({ page }) => {
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
  await expect(sessionList(frame)).toContainText('Build the landing page');
  await expect(sessionList(frame)).not.toContainText('Build onboarding flow');
});

test('saved custom prompts and destination groups affect launched sessions', async ({ page }) => {
  const frame = await demo(page);
  const dialog = await settings(frame);
  await dialog.getByRole('button', { name: 'Actions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Edit Review PR', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Action prompt' })
    .fill('Check retry limits for PR {{number}} and summarize security findings.');
  await dialog
    .getByRole('combobox', { name: 'Group this action lands sessions in' })
    .selectOption('research');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await frame.getByRole('button', { name: 'Review PR', exact: true }).click();
  const state = await page.locator('iframe').evaluate(async (iframe) => {
    const snapshot = await iframe.contentWindow.workspaceAPI.getSnapshot();
    const session = snapshot.workspaces[0].sessions.at(-1);
    const transcript = await iframe.contentWindow.terminalAPI.create({
      instanceId: session.instanceId,
    });
    return { group: session.groupId, replay: transcript.replay };
  });
  expect(state.group).toBe('research');
  expect(state.replay).toContain('Check retry limits for PR 248 and summarize security findings.');
});

test('shortcuts work and resetting restores the original mock state', async ({ page }) => {
  const frame = await demo(page, 'home');
  const home = page.getByRole('button', { name: /Explore Home/ });
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(sessionList(frame)).toContainText('Build onboarding flow');
  await expect(frame.locator('.terminal-panel')).toBeVisible();
  await frame.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(home).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /Review a pull request/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /Switch to Personal/ }).click();
  await expect(frame.getByRole('button', { name: 'Personal workspace menu' })).toBeVisible();
  await page.getByRole('button', { name: /Inspect code changes/ }).click();
  await expect(frame.locator('.git-review-panel')).toContainText('isRetryable');
  await page.getByRole('button', { name: /Explore Home/ }).click();
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(frame.locator('.git-review-panel')).toHaveCount(0);
  await page.getByRole('button', { name: /Review a pull request/ }).click();
  await expect(frame.locator('.inbox-row')).toHaveCount(4);
  await page.getByRole('button', { name: /Reset demo/ }).click();
  await expect(frame.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(home).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('.inbox-row')).toHaveCount(0);
  await expect(frame.locator('.git-review-panel')).toHaveCount(0);
});

test('demo interactions stay in the browser and use no persisted state', async ({ page }) => {
  const outgoing = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      request.url() !== releaseApi
    )
      outgoing.push(request.url());
  });
  const frame = await demo(page);
  await frame.getByRole('button', { name: /Add retry logic to the API client/ }).click();
  await frame.getByRole('button', { name: 'Custom prompt…', exact: true }).click();
  await frame
    .getByRole('textbox', { name: 'Custom prompt', exact: true })
    .fill('Check the sample code');
  await frame.locator('.inbox-pane').getByRole('button', { name: /Start/ }).click();
  await expect(frame.locator('.terminal-panel')).toBeVisible();
  expect(outgoing).toEqual([]);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('consola'))),
  ).toEqual([]);
});

// The site hands PostHog to window on init, the way PostHog's own snippet install
// does. Wrapping capture() there measures what this site asks for, without standing
// up a fake of PostHog's ingestion API. It has to be installed before any page
// script runs, because the download event fires while the page is still loading.
// PostHog's own $-prefixed events ($pageview, $pageleave) are left out: they are its
// behaviour to change, not this site's to assert.
const recordCaptures = (page) =>
  page.addInitScript(() => {
    window.__captures = [];
    let instance;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      get: () => instance,
      set(value) {
        instance = value;
        const capture = value.capture.bind(value);
        value.capture = (name, properties) => {
          if (!name.startsWith('$')) window.__captures.push({ name, ...properties });
          return capture(name, properties);
        };
      },
    });
  });

test('analytics reaches PostHog through this origin and persists nothing', async ({ page }) => {
  const offOrigin = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      request.url() !== releaseApi
    )
      offOrigin.push(request.url());
  });
  const proxied = page.waitForRequest((request) =>
    new URL(request.url()).pathname.startsWith('/cnsl/'),
  );
  await page.goto('/');
  // Proves PostHog really started, so the assertions below are not passing by absence.
  await proxied;
  expect(offOrigin).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
  expect(
    await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]),
  ).toEqual([]);
});

for (const width of [320, 390, 768, 1440]) {
  test(`the real desktop UI stays scrollable without overflowing the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const frame = await demo(page);
    await expect(frame.getByRole('button', { name: 'Acme workspace menu' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width < 1100) {
      const scroll = page.locator('.live-demo-viewport');
      expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await scroll.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      expect(await scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
  });
}

test('latest stable installers populate all primary and Intel download links', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  await page.route(releaseApi, (route) =>
    route.fulfill({
      json: {
        tag_name: 'v1.0.0',
        assets: [installer('arm64'), installer('x64')],
      },
    }),
  );
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
  page.on('request', (request) => {
    if (request.url() === releaseApi) requests++;
  });
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
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.evaluate(() => scrollTo({ left: 600, behavior: 'instant' }));
  expect(await page.evaluate(() => scrollX)).toBeGreaterThan(0);
});

// Opens the demo's own page rather than the site around it, so every console
// message is the demo's, and returns what goes wrong there. Console errors count
// as much as uncaught ones: a render that throws is caught by the app's error
// page and only logged. Either is how a bridge member the mock lacks shows up.
async function standaloneDemo(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/demo/index.html');
  await expect(page.getByRole('button', { name: 'Home', exact: true }))
    .toHaveAttribute('aria-current', 'page')
    // An app that never mounts fails with its own error, not with this wait.
    .catch((timeout) => {
      expect(errors).toEqual([]);
      throw timeout;
    });
  return errors;
}

test('create and rename a label through the actual sidebar', async ({ page }) => {
  const errors = await standaloneDemo(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New label', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New label' });
  await create.getByRole('textbox', { name: 'Name' }).fill('Weekend experiments');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toHaveCount(0);

  // The filter bar offers the new label, and filtering by it shows it as a chip.
  const filters = page.getByRole('button', { name: 'Filter sessions', exact: true });
  await filters.click();
  await page.getByRole('menuitem', { name: /^Weekend experiments/ }).click();
  await page.keyboard.press('Escape');
  const active = page.getByLabel('Active filters');
  await expect(active.getByRole('button')).toHaveAccessibleName(
    'Remove filter Weekend experiments',
  );

  await filters.click();
  await page.getByRole('button', { name: 'Edit label Weekend experiments', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit label' });
  await edit.getByRole('textbox', { name: 'Name' }).fill('Experiments');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(active.getByRole('button')).toHaveAccessibleName('Remove filter Experiments');
  await filters.click();
  await expect(page.getByRole('menuitem', { name: /^Experiments/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Weekend experiments/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the browser panel keeps typed tabs in memory and its settings render', async ({ page }) => {
  const errors = await standaloneDemo(page);

  // A fresh demo's side panel is empty: its "+" list offers the browser.
  await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Open in this tab' })
    .getByRole('option', { name: /^Browser/ })
    .click();
  const panel = page.getByTestId('browser-panel');
  const tabs = panel.getByRole('tablist', { name: 'Browser tabs' });
  const address = panel.getByRole('textbox', { name: 'Address' });
  await expect(panel.getByTestId('browser-empty-tab')).toBeVisible();
  await address.fill('localhost:5173');
  await address.press('Enter');
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('localhost:5173');
  await expect(address).toHaveValue('http://localhost:5173/');
  await expect(panel.getByTestId('browser-empty-tab')).toHaveCount(0);
  // The toolbar is one row: a control without a grid column of its own wraps under Back.
  const back = await panel.getByRole('button', { name: 'Back', exact: true }).boundingBox();
  const more = await panel.getByRole('button', { name: 'More', exact: true }).boundingBox();
  expect(back).not.toBeNull();
  expect(more).not.toBeNull();
  expect(more.y).toBeCloseTo(back.y, 0);
  // The address field keeps to its own cell, short of the button after it.
  const field = await address.boundingBox();
  const outward = await panel
    .getByRole('button', { name: 'Open in system browser', exact: true })
    .boundingBox();
  expect(field.x + field.width).toBeLessThanOrEqual(outward.x);

  // A second tab starts empty, with the caret in its address, and offers what
  // the first one visited. Delete on the focused tab closes it.
  await panel.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(address).toBeFocused();
  await expect(panel.getByTestId('browser-recent-page')).toContainText('localhost:5173');
  await tabs.getByRole('tab', { selected: true }).press('Delete');
  await expect(tabs.getByRole('tab')).toHaveCount(1);

  // Hiding the side panel keeps the session's tabs, and showing it shows the Browser tab again.
  await page.getByRole('button', { name: 'Hide side panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('localhost:5173');

  const dialog = await settings(page);
  await dialog.getByRole('button', { name: 'Browser links', exact: true }).click();
  const links = dialog.getByRole('radiogroup', { name: 'Terminal links' });
  await expect(links.getByRole('radio')).toHaveCount(3);
  await links.getByRole('radio', { checked: false }).first().click();
  await dialog.getByRole('button', { name: 'Browser', exact: true }).click();
  const agents = dialog.getByRole('switch', { name: /^Let agents use this workspace's browser/ });
  await expect(agents).toBeChecked();
  await agents.click();
  await expect(agents).not.toBeChecked();
  await dialog.getByRole('button', { name: /^Clear browsing data/ }).click();
  const confirm = page.getByRole('dialog', { name: /^Clear browsing data/ });
  await confirm.getByRole('button', { name: /^Clear browsing data/ }).click();
  await expect(confirm).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Cleared: a new tab has no recent pages to offer.
  await panel.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(panel.getByTestId('browser-empty-tab')).toBeVisible();
  await expect(panel.getByTestId('browser-recent-page')).toHaveCount(0);

  // Everything lives in the page: reloading it, as Reset demo does, forgets it.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show side panel', exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Open in this tab' })
    .getByRole('option', { name: /^Browser/ })
    .click();
  await expect(tabs.getByRole('tab')).toHaveCount(0);
  await expect(panel.getByTestId('browser-empty-tab')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const arch of ['arm64', 'x64']) {
  test(`download thank-you page starts the ${arch} installer and offers a retry`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'userAgentData', { value: undefined });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
    });
    await page.route(releaseApi, (route) =>
      route.fulfill({
        json: {
          tag_name: 'v1.0.0',
          assets: [installer('arm64'), installer('x64')],
        },
      }),
    );
    await recordCaptures(page);
    await page.route(installer(arch).browser_download_url, (route) =>
      route.fulfill({
        contentType: 'application/octet-stream',
        headers: { 'Content-Disposition': `attachment; filename="Consola-${arch}.dmg"` },
        body: 'test installer',
      }),
    );
    await page.goto('/');
    const download = page.waitForEvent('download');
    await page.locator(arch === 'arm64' ? '.hero [data-download-link]' : '#download-intel').click();
    expect((await download).suggestedFilename()).toBe(`Consola-${arch}.dmg`);
    await expect(page).toHaveURL(`/download/?arch=${arch}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Thanks for downloading');
    await expect(page.locator('[data-download-retry]')).toHaveAttribute(
      'href',
      installer(arch).browser_download_url,
    );
    await expect(page.locator('.download-community a')).toHaveAttribute(
      'href',
      'https://github.com/ConsolaDev/Consola',
    );
    const retry = page.waitForEvent('download');
    await page.locator('[data-download-retry]').click();
    await retry;
    // The automatic start is counted once; the retry click just above adds nothing.
    await expect
      .poll(() => page.evaluate(() => window.__captures ?? []))
      .toEqual([{ name: 'download', arch, version: 'v1.0.0' }]);
  });
}

test('download page keeps a release fallback when GitHub is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  await page.route(releaseApi, (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/download/?arch=arm64');
  await expect(page.locator('#download-status')).toContainText('Check GitHub releases');
  await expect(page.locator('[data-download-retry]')).toHaveAttribute('href', releaseUrl);
});

for (const width of [320, 390, 1440]) {
  test(`download page fits at ${width}px without JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await page.goto('http://localhost:5174/download/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-download-retry]')).toHaveAttribute('href', releaseUrl);
    await expect(page.locator('.download-community a')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await context.close();
  });
}
