import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import {
  type AgentWorkspace,
  afterNote,
  closeAgentWorkspace,
  guestGuarded,
  inPage,
  launchAgentWorkspace,
  openTab,
  plainAnswer,
  refIn,
  showBrowser,
} from './helpers/agentWorkspace';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';
import { type AgentClient, connectAgent } from './helpers/sessionMcp';

/**
 * What an agent's use of the browser may never do to the person, through the
 * session's real MCP endpoint: take their keyboard, act over their own use
 * of a tab, put a dialog box in front of them, or save a file nobody asked
 * for. Nothing reaches the screen: the windows are hidden and unfocusable,
 * Electron's dialog boxes are swapped for a recorder and every download is
 * cancelled after the app has decided (`keepOffScreen`).
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** What has the keyboard in the host document, which is where the person's keys go. */
function hostFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName}.${element.className}` : 'none';
  });
}

/** Waits until the page at `url` has loaded the fixture. */
async function loaded(app: ElectronApplication, url: string): Promise<void> {
  await expect
    .poll(() => inPage<string>(app, url, 'document.title').catch(() => ''))
    .toBe('Act fixture');
}

test.describe('an agent’s input never takes the person’s keyboard', () => {
  let workspace: AgentWorkspace;
  let seen: AgentClient;
  let unseen: AgentClient;

  test.beforeAll(async () => {
    // The window shows "Keys seen"; "Keys unseen" runs behind it.
    workspace = await launchAgentWorkspace('Keys', ['Keys unseen', 'Keys seen']);
    seen = await connectAgent(workspace.app, workspace.sessions['Keys seen']);
    unseen = await connectAgent(workspace.app, workspace.sessions['Keys unseen']);
  });

  test.afterAll(async () => {
    await seen?.close();
    await unseen?.close();
    await closeAgentWorkspace(workspace);
  });

  test('a click, a fill and a press reach the page, on a session nobody is looking at and on the one shown, and the terminal keeps the keyboard', async () => {
    const { app, page } = workspace;
    const seenUrl = fixtures.url('/agent-act.html?t=seen');
    const unseenUrl = fixtures.url('/agent-act.html?t=unseen');
    // The shown session's agent opens its first tab, and the person looks at it.
    const seenTab = await openTab(seen, seenUrl);
    await showBrowser(page);
    await loaded(app, seenUrl);
    const unseenTab = await openTab(unseen, unseenUrl);
    const pageOf = (tabId: string) => page.locator(`.browser-page[data-tab-id="${tabId}"]`);
    await expect(pageOf(seenTab)).toHaveAttribute('data-presence', 'shown');

    // The person's keyboard is on the shown session's terminal.
    await page.locator('.terminal-panel .terminal-surface').click();
    await expect.poll(() => hostFocus(page)).toBe('TEXTAREA.xterm-helper-textarea');
    await page.evaluate(() => {
      const host = window as unknown as { __terminal?: Element | null; __hostKeys?: string[] };
      host.__terminal = document.activeElement;
      host.__hostKeys = [];
      for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste']) {
        window.addEventListener(
          type,
          (event) => {
            const target = event.target as Element | null;
            host.__hostKeys?.push(`${type} on ${target?.tagName}.${target?.className}`);
          },
          true,
        );
      }
    });
    const host = () =>
      page.evaluate(() => {
        const marks = window as unknown as { __terminal?: Element | null; __hostKeys?: string[] };
        return {
          sameElement: document.activeElement === marks.__terminal,
          events: marks.__hostKeys ?? [],
        };
      });

    for (const [agent, tabId, url, name] of [
      [unseen, unseenTab, unseenUrl, 'Ada'],
      [seen, seenTab, seenUrl, 'Grace'],
    ] as const) {
      const read = await agent.call('consola_browser_snapshot', { tabId });
      expect(read.isError, read.text).toBe(false);
      const query = refIn(read.text, 'textbox "Query"');
      await plainAnswer(agent, 'consola_browser_act', {
        tabId,
        action: 'click',
        ref: refIn(read.text, 'button "Count"'),
      });
      await plainAnswer(agent, 'consola_browser_act', {
        tabId,
        action: 'fill',
        ref: query,
        text: name,
      });
      await plainAnswer(agent, 'consola_browser_act', {
        tabId,
        action: 'press',
        ref: query,
        key: 'Enter',
      });

      // The page got all three, and none of it as the browser's own input.
      expect(await inPage(app, url, "document.getElementById('clicks').textContent")).toBe(
        'Clicked 1',
      );
      expect(await inPage(app, url, "document.getElementById('q').value")).toBe(name);
      await expect
        .poll(() => inPage(app, url, "document.getElementById('result').textContent"))
        .toBe(`Found ${name}`);
      expect(await inPage(app, url, 'window.__presses')).toBe(0);
      // The terminal still has the keyboard, and nothing of the agent's reached the host.
      expect(await host()).toEqual({ sameElement: true, events: [] });
      expect(await hostFocus(page)).toBe('TEXTAREA.xterm-helper-textarea');
    }
    // The unseen session's page was never put in front of the person.
    await expect(pageOf(unseenTab)).not.toHaveAttribute('data-presence', 'shown');

    // The recorder hears keys that do reach the terminal: the person's own.
    await page.keyboard.press('KeyZ');
    expect((await host()).events).toContain('keydown on TEXTAREA.xterm-helper-textarea');
  });
});

test.describe('the person comes first', () => {
  let workspace: AgentWorkspace;
  let agent: AgentClient;

  test.beforeAll(async () => {
    workspace = await launchAgentWorkspace('Person', ['Person session']);
    agent = await connectAgent(workspace.app, workspace.sessions['Person session']);
  });

  test.afterAll(async () => {
    await agent?.close();
    await closeAgentWorkspace(workspace);
  });

  test('an act and an evaluate right after the person presses in the tab are refused, and allowed once the guard has passed', async () => {
    const { app, page } = workspace;
    // How long the person's press holds the agent off: main's own constant, read from the module it runs.
    const guardMs = await app.evaluate(
      (_electron, modulePath) => {
        const mainModule = process.mainModule;
        if (!mainModule) throw new Error('main has no module to read the guard from');
        return (mainModule.require(modulePath) as { PERSON_INPUT_GUARD_MS: number })
          .PERSON_INPUT_GUARD_MS;
      },
      path.join(__dirname, '../../dist/main/main/browser/PersonInput.js'),
    );
    expect(guardMs).toBeGreaterThan(0);
    test.setTimeout(30_000 + guardMs);

    const url = fixtures.url('/agent-act.html?t=person');
    const tabId = await openTab(agent, url);
    await showBrowser(page);
    await loaded(app, url);
    const read = await agent.call('consola_browser_snapshot', { tabId });
    const count = refIn(read.text, 'button "Count"');

    // The person presses in the page they are looking at, away from its controls.
    await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      if (!guest) throw new Error(`no page at ${prefix}`);
      guest.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
    }, url);
    // The page has the press, so main heard it before now (`before-mouse-event`
    // comes first): the guard runs out no later than `heard + guardMs`.
    await expect.poll(() => inPage(app, url, 'window.__presses')).toBe(1);
    const heard = Date.now();

    const personUsing = 'The person is using this tab.';
    expect(
      await agent.call('consola_browser_act', { tabId, action: 'click', ref: count }),
    ).toMatchObject({ isError: true, text: personUsing });
    expect(
      await agent.call('consola_browser_evaluate', { tabId, expression: '1 + 1' }),
    ).toMatchObject({ isError: true, text: personUsing });
    expect(await inPage(app, url, "document.getElementById('clicks').textContent")).toBe(
      'Not clicked',
    );

    // The one wait on the guard in these tests.
    await page.waitForTimeout(Math.max(0, heard + guardMs + 150 - Date.now()));
    await plainAnswer(agent, 'consola_browser_act', { tabId, action: 'click', ref: count });
    const counted = await agent.call('consola_browser_evaluate', {
      tabId,
      expression: "document.getElementById('clicks').textContent",
    });
    expect(counted.isError, counted.text).toBe(false);
    expect(afterNote(counted.text)).toBe('Clicked 1');
  });
});

test.describe('a page’s dialog is held for the agent, never shown', () => {
  let workspace: AgentWorkspace;
  let agent: AgentClient;

  test.beforeAll(async () => {
    workspace = await launchAgentWorkspace('Dialogs', ['Dialogs session']);
    agent = await connectAgent(workspace.app, workspace.sessions['Dialogs session']);
  });

  test.afterAll(async () => {
    await agent?.close();
    await closeAgentWorkspace(workspace);
  });

  test('a confirm an agent’s click raises waits for its answer, accepted and then dismissed, with no box', async () => {
    const { app, screen } = workspace;
    const url = fixtures.url('/agent-act.html?t=dialog');
    const tabId = await openTab(agent, url);
    const read = await agent.call('consola_browser_snapshot', { tabId });
    expect(read.isError, read.text).toBe(false);
    // Nothing the page raises can reach the screen before this goes on.
    expect(await guestGuarded(app, url)).toBe(true);
    const dialog = { type: 'confirm', message: 'Delete everything?' };

    const raised = await agent.call('consola_browser_act', {
      tabId,
      action: 'click',
      ref: refIn(read.text, 'button "Delete"'),
    });
    expect(raised.isError, raised.text).toBe(false);
    expect(afterNote(raised.text)).toEqual({
      tabId,
      action: 'click',
      ref: refIn(read.text, 'button "Delete"'),
      summary:
        'While acting, the page opened a confirm dialog and waits for an answer; answer it with consola_browser_dialog, then take a snapshot.',
      pendingDialog: dialog,
    });
    const status = afterNote((await agent.call('consola_browser_status')).text) as {
      tabs: Array<{ tabId: string; pendingDialog?: unknown }>;
    };
    expect(status.tabs.find((tab) => tab.tabId === tabId)?.pendingDialog).toEqual(dialog);
    expect(await agent.call('consola_browser_snapshot', { tabId })).toMatchObject({
      isError: true,
      text: 'The page is showing a confirm dialog and waits for an answer; answer it with consola_browser_dialog first.',
    });

    expect(await plainAnswer(agent, 'consola_browser_dialog', { tabId, action: 'accept' })).toEqual(
      {
        tabId,
        summary: 'Accepted the confirm dialog. Take a snapshot to see what the page did.',
      },
    );
    await plainAnswer(agent, 'consola_browser_wait_for', { tabId, text: 'Answered true' });

    // Again, dismissed this time.
    const again = await agent.call('consola_browser_snapshot', { tabId });
    const raisedAgain = await agent.call('consola_browser_act', {
      tabId,
      action: 'click',
      ref: refIn(again.text, 'button "Delete"'),
    });
    expect((afterNote(raisedAgain.text) as { pendingDialog?: unknown }).pendingDialog).toEqual(
      dialog,
    );
    expect(
      await plainAnswer(agent, 'consola_browser_dialog', { tabId, action: 'dismiss' }),
    ).toEqual({
      tabId,
      summary: 'Dismissed the confirm dialog. Take a snapshot to see what the page did.',
    });
    await plainAnswer(agent, 'consola_browser_wait_for', { tabId, text: 'Answered false' });

    expect(await agent.call('consola_browser_dialog', { tabId, action: 'accept' })).toMatchObject({
      isError: true,
      text: 'There is no dialog open on this tab.',
    });
    // Neither confirm was ever handed to Electron's box.
    expect((await screen.record()).boxes).toEqual([]);
  });
});

test.describe('a download nobody clicked', () => {
  let workspace: AgentWorkspace;
  let agent: AgentClient;

  test.beforeAll(async () => {
    workspace = await launchAgentWorkspace('Downloads', ['Downloads session']);
    agent = await connectAgent(workspace.app, workspace.sessions['Downloads session']);
  });

  test.afterAll(async () => {
    await agent?.close();
    await closeAgentWorkspace(workspace);
  });

  test('an agent’s click on a link to a file in the person’s tab is cancelled before any save dialog', async () => {
    const { app, page, screen } = workspace;
    const url = fixtures.url('/agent-act.html?t=download');
    // The person's own tab, on screen.
    const tab = await page.evaluate(({ id, url }) => window.browserAPI.open(id, url), {
      id: workspace.sessions['Downloads session'],
      url,
    });
    await showBrowser(page);
    await loaded(app, url);
    expect(await guestGuarded(app, url)).toBe(true);

    const read = await agent.call('consola_browser_snapshot', { tabId: tab!.id });
    expect(read.isError, read.text).toBe(false);
    const link = refIn(read.text, 'link "Download report"');
    expect(
      await plainAnswer(agent, 'consola_browser_act', {
        tabId: tab!.id,
        action: 'click',
        ref: link,
      }),
    ).toEqual({
      tabId: tab!.id,
      action: 'click',
      ref: link,
      summary: `Clicked ${link}. Take a snapshot to see what changed.`,
    });

    // The app cancelled it itself, before Electron could ask where to save it.
    await expect
      .poll(async () => (await screen.record()).downloads)
      .toEqual([{ url: fixtures.url('/report.csv'), cancelledByApp: true }]);
    expect((await screen.record()).boxes).toEqual([]);
  });
});
