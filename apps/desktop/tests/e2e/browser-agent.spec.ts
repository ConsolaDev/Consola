import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentWorkspace,
  closeAgentWorkspace,
  closingOnFailure,
  inPage,
  launchAgentWorkspace,
  launchGuarded,
  openSession,
  seedWorkspace,
} from './helpers/agentWorkspace';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';
import { type AgentClient, connectAgent } from './helpers/sessionMcp';
import { afterNote, openTab, refIn, UNTRUSTED_NOTE } from './helpers/toolAnswers';

/**
 * A session's agent and its browser, through the session's real MCP
 * endpoint: the test connects to the socket and token main wrote for the
 * session, as the CLI does, so what it may do is decided by which session's
 * socket the call arrived on (a tool's authority comes from its endpoint,
 * never from an argument) and by `buildSessionServer`'s gating, not by
 * anything the test passes.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

const BROWSER_TOOLS = [
  'consola_browser_act',
  'consola_browser_close',
  'consola_browser_dialog',
  'consola_browser_evaluate',
  'consola_browser_navigate',
  'consola_browser_open',
  'consola_browser_snapshot',
  'consola_browser_status',
  'consola_browser_wait_for',
];

const browserToolsIn = (names: string[]) =>
  names.filter((name) => name.startsWith('consola_browser_'));

test.describe('an agent on its own session’s tabs', () => {
  let workspace: AgentWorkspace;
  let own: AgentClient;
  let other: AgentClient;

  test.beforeAll(async () => {
    workspace = await launchAgentWorkspace('Reach', ['Reach other', 'Reach own']);
    own = await connectAgent(workspace.app, workspace.sessions['Reach own']);
    other = await connectAgent(workspace.app, workspace.sessions['Reach other']);
  });

  test.afterAll(async () => {
    await own?.close();
    await other?.close();
    await closeAgentWorkspace(workspace);
  });

  test('opens a page, reads it, clicks, types and presses in it, and evaluates and waits on it', async () => {
    const url = fixtures.url('/agent-act.html?t=read');
    const tabId = await openTab(own, url);

    const read = await own.call('consola_browser_snapshot', { tabId });
    expect(read.isError, read.text).toBe(false);
    expect(read.text.startsWith(`${UNTRUSTED_NOTE}\n\n`)).toBe(true);
    expect(read.text).toContain(`Tab: ${tabId}`);
    expect(read.text).toContain('Title: "Act fixture"');
    expect(read.text).toMatch(/heading "Act fixture" \[level=1\] \[ref=e\d+\]/);
    expect(read.text).toContain('Not clicked');
    const count = refIn(read.text, 'button "Count"');
    const query = refIn(read.text, 'textbox "Query"');

    const clicked = await own.call('consola_browser_act', { tabId, action: 'click', ref: count });
    expect(clicked.isError, clicked.text).toBe(false);
    expect(JSON.parse(clicked.text)).toEqual({
      tabId,
      action: 'click',
      ref: count,
      summary: `Clicked ${count}. Take a snapshot to see what changed.`,
    });
    const afterClick = await own.call('consola_browser_snapshot', { tabId });
    expect(afterClick.text).toContain('Clicked 1');
    expect(afterClick.text).not.toContain('Not clicked');

    const filled = await own.call('consola_browser_act', {
      tabId,
      action: 'fill',
      ref: query,
      text: 'Ada',
    });
    expect(JSON.parse(filled.text)).toEqual({
      tabId,
      action: 'fill',
      ref: query,
      summary: `Typed 3 characters into ${query}. Take a snapshot to see what changed.`,
    });
    const pressed = await own.call('consola_browser_act', {
      tabId,
      action: 'press',
      ref: query,
      key: 'Enter',
    });
    expect(JSON.parse(pressed.text)).toEqual({
      tabId,
      action: 'press',
      ref: query,
      summary: `Pressed Enter on ${query}; the page then submitted its form. Take a snapshot to see what changed.`,
    });

    // The form answers a moment after it is sent.
    const waited = await own.call('consola_browser_wait_for', { tabId, text: 'Found Ada' });
    expect(JSON.parse(waited.text)).toEqual({
      tabId,
      summary: 'The text "Found Ada" is on the page.',
    });
    const answer = await own.call('consola_browser_evaluate', {
      tabId,
      expression: "document.getElementById('result').textContent",
    });
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toBe(`${UNTRUSTED_NOTE}\n\n"Found Ada"`);
    // An agent's script carries no user gesture.
    const activation = await own.call('consola_browser_evaluate', {
      tabId,
      expression: 'navigator.userActivation.isActive',
    });
    expect(activation.text).toBe(`${UNTRUSTED_NOTE}\n\nfalse`);

    // A file input would open a chooser over the person's window: refused, and nothing reached it.
    const file = refIn(afterClick.text, 'button "Attachment"');
    const chooser = await own.call('consola_browser_act', { tabId, action: 'click', ref: file });
    expect(chooser).toMatchObject({
      isError: true,
      text: `${file} takes a file, and the agent cannot hand files to a page.`,
    });
    expect(await inPage(workspace.app, url, 'window.__fileClicks')).toBe(0);
  });

  test('is refused another session’s tab, which it neither lists nor loads', async () => {
    // The other session's agent opens a page of its own.
    const theirs = await openTab(other, fixtures.url('/agent-act.html?t=theirs'));
    const anotherSession = 'That tab belongs to another session.';

    const read = await own.call('consola_browser_snapshot', { tabId: theirs });
    expect(read).toMatchObject({ isError: true, text: anotherSession });
    const clicked = await own.call('consola_browser_act', {
      tabId: theirs,
      action: 'click',
      ref: 'e1',
    });
    expect(clicked).toMatchObject({ isError: true, text: anotherSession });

    // Its own status lists only its own tabs, and the other tab was never loaded.
    const status = afterNote((await own.call('consola_browser_status')).text) as {
      tabs: Array<{ tabId: string }>;
    };
    expect(status.tabs.map((tab) => tab.tabId)).not.toContain(theirs);
    const otherTabs = await workspace.page.evaluate(
      (id) => window.browserAPI.get(id),
      workspace.sessions['Reach other'],
    );
    expect(otherTabs.tabs).toEqual([
      expect.objectContaining({ id: theirs, live: false, agentActive: false }),
    ]);
  });
});

test.describe('who is offered the browser tools', () => {
  let workspace: AgentWorkspace;

  test.beforeAll(async () => {
    // Two launches, a close and two panes: room for a machine other runs are loading.
    test.setTimeout(90_000);
    // A session's tool policy is main's to set (an automation's sessions are
    // read-only), never a window's: so the records are made in one launch,
    // the policy written into the profile, and the app launched on it again.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-agent-'));
    const first = await launchGuarded();
    const { seeded, userData } = await closingOnFailure(first.app, async () => ({
      seeded: await seedWorkspace(first.page, root, 'Gate', ['Gate reader', 'Gate agent']),
      userData: await first.app.evaluate(({ app }) => app.getPath('userData')),
    }));
    await first.app.close();
    const stateFile = path.join(userData, 'workspaces.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      workspaces: Array<{ sessions: Array<{ id: string; toolPolicy?: string }> }>;
    };
    for (const session of state.workspaces.flatMap((candidate) => candidate.sessions)) {
      if (session.id === seeded.sessions['Gate reader']) session.toolPolicy = 'read-only';
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    // From here `afterAll` closes the app, whatever fails.
    const second = await launchGuarded(first.userDataDir);
    workspace = { ...second, root, ...seeded };
    for (const name of ['Gate reader', 'Gate agent']) {
      await openSession(second.app, second.page, 'Gate', { name, id: seeded.sessions[name] });
    }
  });

  test.afterAll(async () => {
    await closeAgentWorkspace(workspace);
  });

  test('a read-only session gets none, and with access off neither does a new connection, while an open one is refused', async () => {
    const { app, page, workspaceId } = workspace;
    const readerId = workspace.sessions['Gate reader'];
    const agentId = workspace.sessions['Gate agent'];
    const recorded = await page.evaluate(async () => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      return workspaces.flatMap((candidate) =>
        candidate.sessions.map((session) => ({ id: session.id, toolPolicy: session.toolPolicy })),
      );
    });
    expect(recorded).toEqual(
      expect.arrayContaining([
        { id: readerId, toolPolicy: 'read-only' },
        { id: agentId, toolPolicy: undefined },
      ]),
    );

    // The read-only session's endpoint answers, with its read-only tools and no browser.
    const reader = await connectAgent(app, readerId);
    const readerTools = await reader.toolNames();
    expect(readerTools).toContain('consola_list_sessions');
    expect(browserToolsIn(readerTools)).toEqual([]);
    await reader.close();

    // An ordinary session's connection has all of them, and uses them; it stays open.
    const before = await connectAgent(app, agentId);
    expect(browserToolsIn(await before.toolNames())).toEqual(BROWSER_TOOLS);
    const url = fixtures.url('/agent-act.html?t=gate');
    const tabId = await openTab(before, url);
    expect((await before.call('consola_browser_snapshot', { tabId })).isError).toBe(false);
    const debuggerAttached = () =>
      app.evaluate(
        ({ webContents }, prefix) =>
          webContents
            .getAllWebContents()
            .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix))
            ?.debugger.isAttached(),
        url,
      );
    // The agent's connection holds the page between calls.
    expect(await debuggerAttached()).toBe(true);

    await page.evaluate(
      (id) => window.workspaceAPI.updateWorkspace(id, { browserAgentAccess: 'off' }),
      workspaceId,
    );
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const { workspaces } = await window.workspaceAPI.getSnapshot();
          return workspaces.find((candidate) => candidate.id === id)?.browserAgentAccess;
        }, workspaceId),
      )
      .toBe('off');

    // A connection made now is offered no browser tool.
    const after = await connectAgent(app, agentId);
    const afterTools = await after.toolNames();
    expect(afterTools).toContain('consola_list_sessions');
    expect(browserToolsIn(afterTools)).toEqual([]);
    await after.close();

    // The one already open still lists them, but its next call is refused, and does nothing.
    expect(browserToolsIn(await before.toolNames())).toEqual(BROWSER_TOOLS);
    const accessOff =
      "Agents may not use this workspace's browser; the person turned that off in its settings.";
    expect(await before.call('consola_browser_snapshot', { tabId })).toMatchObject({
      isError: true,
      text: accessOff,
    });
    expect(await before.call('consola_browser_open', { url })).toMatchObject({
      isError: true,
      text: accessOff,
    });
    const tabs = await page.evaluate((id) => window.browserAPI.get(id), agentId);
    expect(tabs.tabs.map((tab) => tab.id)).toEqual([tabId]);
    // Its hold on the page went with its access: the debugger is free for the person.
    await expect.poll(debuggerAttached).toBe(false);
    await before.close();
  });
});
