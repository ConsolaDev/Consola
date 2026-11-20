import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WebContents } from 'electron';
import type { Browser, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSessionSnapshot, BrowserTab } from '../../shared/browser';
import type { Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { buildSessionServer } from '../mcp/buildSessionServer';
import { ToolRegistry } from '../tools/Tool';
import type { AgentCall } from './AgentPages';
import { ANOTHER_SESSION_MESSAGE } from './browserToolAccess';
import { browserTools, type BrowserToolsBrowser } from './browserTools';
import type { CdpRelayOptions } from './CdpRelay';
import { type DriverRelay, PageDriver } from './PageDriver';
import { PERSON_USING_TAB_MESSAGE, PersonInput } from './PersonInput';

const T0 = 1_700_000_000_000;

/** Everything the page and the relay were asked, in order. */
let log: string[];

/** Playwright's page, as the acting tools use it: each step is logged, and answers as told. */
class FakePage {
  /** How many elements a selector finds; 1 unless set. */
  counts: Record<string, number> = {};
  /** What `evaluate` answers, by the in-page function's name. */
  answers: Record<string, unknown> = {};
  failures: Record<string, Error> = {};
  readonly args: Record<string, unknown> = {};

  locator(selector: string) {
    return {
      count: async () => {
        log.push(`count ${selector}`);
        return this.counts[selector] ?? 1;
      },
      evaluate: async (fn: (...args: never[]) => unknown, arg?: unknown) => {
        log.push(`${fn.name} ${selector}`);
        this.args[fn.name] = arg;
        if (this.failures[fn.name]) throw this.failures[fn.name];
        return this.answers[fn.name];
      },
      hover: async (options?: unknown) => {
        log.push(`hover ${selector}`);
        this.args.hover = options;
      },
      selectOption: async (value: string) => {
        log.push(`selectOption ${selector}`);
        this.args.selectOption = value;
        return [value];
      },
    };
  }

  asPage() {
    return this as unknown as Page;
  }
}

class FakeGuest extends EventEmitter {
  readonly debugger = new EventEmitter();
  getTitle() {
    return 'Fixture';
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

class FakeRelay implements DriverRelay {
  isClosed = false;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  constructor(private readonly options: CdpRelayOptions) {}
  send() {}
  close(reason = 'closed') {
    if (this.isClosed) return;
    this.isClosed = true;
    this.options.onClose?.(reason);
  }
  async setFocusEmulation(enabled: boolean) {
    log.push(`focus emulation ${enabled ? 'on' : 'off'}`);
  }
}

/** The tabs: one of the caller's, one of another session's. */
class FakeBrowser implements BrowserToolsBrowser {
  readonly tabs: Record<string, BrowserTab[]> = {
    'w-1': [{ id: 'mine', url: 'http://localhost:5173/', title: 'Mine', openedBy: 'agent' }],
    'w-2': [{ id: 'theirs', url: 'http://localhost:5173/', title: 'Theirs', openedBy: 'agent' }],
  };
  snapshotFor(sessionId: string): BrowserSessionSnapshot {
    return {
      activeTabId: null,
      tabs: (this.tabs[sessionId] ?? []).map((tab) => ({
        ...tab,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        live: true,
        loadId: 1,
        agentActive: false,
      })),
    };
  }
  atTabCap = () => false;
  openTab = () => null;
  closeTab = () => {};
  navigate = () => true;
  goBack = () => {};
  goForward = () => {};
  reload = () => {};
}

let workspaces: Workspace[];
let now: number;
let person: PersonInput;
let fakePage: FakePage;
let driver: PageDriver;
let begun: string[];
const clients: Client[] = [];

beforeEach(() => {
  log = [];
  now = T0;
  person = new PersonInput(() => now);
  fakePage = new FakePage();
  begun = [];
  workspaces = [
    makeWorkspace({
      sessions: [
        makeSession({ id: 'w-1', kind: 'interactive', instanceId: 'inst-w1' }),
        makeSession({ id: 'w-2', kind: 'interactive', instanceId: 'inst-w2' }),
      ],
    }),
  ];
  const guest = new FakeGuest();
  driver = new PageDriver({
    calls: {
      async beginToolCall(tabId: string): Promise<AgentCall> {
        begun.push(tabId);
        return { guest: guest.asWebContents(), end: () => {} };
      },
    },
    openRelay: (_guest, options) => new FakeRelay(options),
    connect: async () => {
      const context = { pages: () => [fakePage.asPage()], setDefaultTimeout: () => {} };
      return { contexts: () => [context] } as unknown as Browser;
    },
    startTimer: () => () => {},
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function call(name: string, args: Record<string, unknown>, sessionId = 'w-1') {
  const server = buildSessionServer(sessionId, {
    registry: new ToolRegistry(),
    approvals: { request: vi.fn() },
    conductorTools: { addTo: vi.fn() },
    browserTools: browserTools({
      getWorkspaces: () => workspaces,
      browser: new FakeBrowser(),
      driver,
      person,
      localServers: async () => [],
    }),
    getWorkspaces: () => workspaces,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: 'text'; text: string }>;
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

const act = (args: Record<string, unknown>) =>
  call('consola_browser_act', { tabId: 'mine', ...args });

describe('consola_browser_act', () => {
  it('clicks by ref inside the page, with focus emulation on only for the act', async () => {
    const result = await act({ action: 'click', ref: 'e5' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      tabId: 'mine',
      action: 'click',
      ref: 'e5',
      summary: expect.stringContaining('Clicked e5'),
    });
    expect(log).toEqual([
      'count aria-ref=e5',
      'focus emulation on',
      'clickInPage aria-ref=e5',
      'focus emulation off',
    ]);
  });

  it('turns focus emulation off even when the act fails in the page', async () => {
    fakePage.failures.clickInPage = new Error('locator.evaluate: Error: consola-act:covered');
    const result = await act({ action: 'click', ref: 'e5' });
    expect(result).toEqual({
      isError: true,
      text: 'Something else on the page covers e5, so a click would land on that instead; take a new snapshot.',
    });
    expect(log.at(-1)).toBe('focus emulation off');
  });

  it('fills, presses, selects, hovers and scrolls through the page', async () => {
    fakePage.answers.fillInPage = 'typed';
    expect(JSON.parse((await act({ action: 'fill', ref: 'e4', text: 'Ada' })).text).summary).toBe(
      'Typed 3 characters into e4. Take a snapshot to see what changed.',
    );
    expect(fakePage.args.fillInPage).toBe('Ada');

    fakePage.answers.pressInPage = 'submitted';
    const pressed = JSON.parse((await act({ action: 'press', ref: 'e4', key: 'Enter' })).text);
    expect(pressed.summary).toBe(
      'Pressed Enter on e4; the page then submitted its form. Take a snapshot to see what changed.',
    );
    expect(fakePage.args.pressInPage).toMatchObject({
      key: 'Enter',
      keyCode: 13,
      toFocused: false,
    });

    fakePage.answers.pressInPage = 'none';
    await act({ action: 'press', key: 'Escape' });
    expect(log).toContain('pressInPage :root');
    expect(fakePage.args.pressInPage).toMatchObject({ key: 'Escape', toFocused: true });

    await act({ action: 'select', ref: 'e6', value: 'Banana' });
    expect(fakePage.args.selectOption).toBe('Banana');

    await act({ action: 'hover', ref: 'e7' });
    expect(fakePage.args.hover).toMatchObject({ force: true });

    fakePage.answers.scrollInPage = { moved: 480, at: 480, extent: 2400 };
    expect(JSON.parse((await act({ action: 'scroll' })).text).summary).toBe(
      'Scrolled the page down 480 px, to 480 of 2400. Take a snapshot to see what changed.',
    );
    expect(fakePage.args.scrollInPage).toEqual({ intoView: false, direction: 'down' });
    fakePage.answers.scrollInPage = { moved: 0, at: 0, extent: 0 };
    await act({ action: 'scroll', ref: 'e9' });
    expect(fakePage.args.scrollInPage).toEqual({ intoView: true, direction: 'down' });
  });

  it('says a ref the page no longer has, without acting', async () => {
    fakePage.counts['aria-ref=e5'] = 0;
    const result = await act({ action: 'click', ref: 'e5' });
    expect(result).toEqual({
      isError: true,
      text: 'There is no element e5 on the page now; take a new snapshot (consola_browser_snapshot) for current refs.',
    });
    expect(log).toEqual(['count aria-ref=e5']);
  });

  it('refuses within 3 s of the person’s input on the tab, touching nothing', async () => {
    person.noteInput('mine');
    now = T0 + 2_900;
    expect(await act({ action: 'click', ref: 'e5' })).toEqual({
      isError: true,
      text: PERSON_USING_TAB_MESSAGE,
    });
    expect(begun).toEqual([]);
    expect(log).toEqual([]);
    now = T0 + 3_100;
    expect((await act({ action: 'click', ref: 'e5' })).isError).toBe(false);
  });

  it('marks the act in flight on the tab while it runs, and just done after', async () => {
    let during: unknown;
    fakePage.answers.clickInPage = 'clicked';
    const original = fakePage.locator.bind(fakePage);
    fakePage.locator = (selector: string) => {
      const locator = original(selector);
      return {
        ...locator,
        evaluate: async (fn: (...args: never[]) => unknown, arg?: unknown) => {
          during = person.downloadFacts('mine');
          return locator.evaluate(fn, arg);
        },
      };
    };
    now = T0 + 10;
    await act({ action: 'click', ref: 'e5' });
    expect(during).toMatchObject({ actInFlight: true });
    expect(person.downloadFacts('mine')).toEqual({
      actInFlight: false,
      actEndedAt: T0 + 10,
      now: T0 + 10,
    });
  });

  it.each([
    [{ action: 'click' }, 'click needs a ref: the [ref=…] of an element in your latest snapshot.'],
    [
      { action: 'fill', ref: 'e4' },
      'fill needs text: what the field should hold (an empty string empties it).',
    ],
    [{ action: 'select', ref: 'e6' }, "select needs value: the option's value or its label."],
    [{ action: 'press' }, 'press needs key: a key such as Enter or a chord such as Shift+Tab.'],
  ])('refuses %j, saying what it needs', async (args, message) => {
    expect(await act(args)).toEqual({ isError: true, text: message });
    expect(begun).toEqual([]);
  });

  it('refuses an unknown key before reaching the page', async () => {
    const result = await act({ action: 'press', key: 'Hyper+q' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Unknown key "Hyper\+q"/);
    expect(begun).toEqual([]);
  });

  it('takes only a ref as a ref, never a selector of its own', async () => {
    const result = await act({ action: 'click', ref: 'e5 >> css=body' });
    expect(result.isError).toBe(true);
    expect(begun).toEqual([]);
  });

  it('refuses another session’s tab', async () => {
    expect(await act({ tabId: 'theirs', action: 'click', ref: 'e5' })).toEqual({
      isError: true,
      text: ANOTHER_SESSION_MESSAGE,
    });
    expect(begun).toEqual([]);
  });

  it.each([
    ['not-visible', 'e5 is not visible on the page; take a new snapshot.'],
    ['disabled', 'e5 is disabled.'],
    [
      'not-editable',
      'e5 is not a text field; fill types into inputs, text areas and editable text.',
    ],
    ['read-only', 'e5 is read-only.'],
    [
      'not-text',
      'e5 is not a text field (it is a checkbox, a radio button or a button); click it instead.',
    ],
    ['file-input', 'e5 takes a file, and the agent cannot hand files to a page.'],
    ['is-select', 'e5 is a list of options; use select with its value or label.'],
  ])('words the page’s %s refusal', async (reason, message) => {
    fakePage.failures.fillInPage = new Error(
      `locator.evaluate: Error: consola-act:${reason}\n    at eval`,
    );
    expect(await act({ action: 'fill', ref: 'e5', text: 'x' })).toEqual({
      isError: true,
      text: message,
    });
  });

  it('passes on only the first line of anything else that fails, without its call log', async () => {
    fakePage.failures.clickInPage = new Error(
      'locator.evaluate: Execution context was destroyed\nCall log:\n  - <div class="x">page text</div>',
    );
    expect(await act({ action: 'click', ref: 'e5' })).toEqual({
      isError: true,
      text: 'Execution context was destroyed',
    });
  });
});
