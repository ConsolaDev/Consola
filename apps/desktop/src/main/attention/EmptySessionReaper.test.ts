import { beforeEach, describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/attention';
import { NEW_SESSION_NAME } from '../../shared/workspace';
import type { Session, Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { BrowserService } from '../browser/BrowserService';
import { BrowserStateStore } from '../browser/BrowserStateStore';
import { browsedIn, EmptySessionReaper, mayBeEmpty } from './EmptySessionReaper';

const blank = (id: string, extra: Partial<Session> = {}) =>
  makeSession({
    id,
    name: NEW_SESSION_NAME,
    instanceId: `inst-${id}`,
    claudeSessionId: `conv-${id}`,
    kind: 'interactive',
    hasStarted: true,
    ...extra,
  });

let workspaces: Workspace[];
let attention: Map<string, Attention>;
let shown: Set<string>;
/** Conversation ids whose transcript holds a first message; `null` entries cannot be read. */
let transcripts: Map<string, boolean | null>;
let removed: string[];
let reads: string[];
/** Each session's browser tabs; a `null` entry cannot be read. No entry: no tabs. */
let tabs: Map<string, { url: string; openedBy: 'person' | 'agent' }[] | null>;

function reaper(overrides: Partial<ConstructorParameters<typeof EmptySessionReaper>[0]> = {}) {
  return new EmptySessionReaper({
    getWorkspaces: () => workspaces,
    attention: () => attention,
    isShown: (instanceId) => shown.has(instanceId),
    hasFirstMessage: async (session) => {
      reads.push(session.id);
      return transcripts.get(session.claudeSessionId) ?? false;
    },
    remove: async (workspace, session) => {
      workspace.sessions = workspace.sessions.filter((candidate) => candidate.id !== session.id);
      removed.push(session.id);
    },
    browserTabs: (session) => (tabs.has(session.id) ? (tabs.get(session.id) ?? null) : []),
    ...overrides,
  });
}

function given(...sessions: Session[]) {
  workspaces = [makeWorkspace({ id: 'w1', sessions })];
  for (const session of sessions) attention.set(session.id, 'settled');
}

beforeEach(() => {
  workspaces = [];
  attention = new Map();
  shown = new Set();
  transcripts = new Map();
  removed = [];
  reads = [];
  tabs = new Map();
});

describe('mayBeEmpty', () => {
  it('is a session still waiting for the name its first message would give it', () => {
    expect(mayBeEmpty(blank('a'))).toBe(true);
    expect(mayBeEmpty(blank('a', { name: 'new session' }))).toBe(true);
  });

  it('is never a session named from a message, by a person, or at birth', () => {
    expect(mayBeEmpty(blank('a', { name: 'Fix the login flow' }))).toBe(false);
    expect(mayBeEmpty(blank('a', { nameIsUserSet: true }))).toBe(false);
    expect(mayBeEmpty(blank('a', { name: 'New Session (full tools)' }))).toBe(false);
  });

  it('is never a session an earlier conversation was carried into', () => {
    const prior = {
      harnessId: 'other',
      claudeSessionId: 'old',
      continuedAs: 'conv-a',
      endedAt: 1,
      carried: 'native' as const,
    };
    expect(mayBeEmpty(blank('a', { priorConversations: [prior] }))).toBe(false);
  });
});

describe('browsedIn', () => {
  it('is a tab holding an address, whoever opened it', () => {
    expect(browsedIn([{ url: 'https://example.test/' }])).toBe(true);
    expect(browsedIn([{ url: '' }, { url: 'http://localhost:5173/' }])).toBe(true);
  });

  it('is not a browser with no tabs, or only blank ones', () => {
    expect(browsedIn([])).toBe(false);
    expect(browsedIn([{ url: '' }, { url: 'about:blank' }])).toBe(false);
  });

  it('is a tab list that cannot be read, so nothing is thrown away unseen', () => {
    expect(browsedIn(null)).toBe(true);
  });
});

describe('EmptySessionReaper and the browser', () => {
  it('removes an empty session with no browser tabs, as before', async () => {
    given(blank('a'));
    expect(await reaper().sweep()).toEqual(['a']);
  });

  it('keeps an empty session with a tab on an address, whoever opened it, unread', async () => {
    given(blank('mine'), blank('agents'));
    tabs.set('mine', [{ url: 'https://example.test/', openedBy: 'person' }]);
    tabs.set('agents', [
      { url: '', openedBy: 'person' },
      { url: 'http://localhost:3000/', openedBy: 'agent' },
    ]);
    expect(await reaper().sweep()).toEqual([]);
    expect(await reaper().settled(['mine', 'agents'])).toEqual([]);
    expect(removed).toEqual([]);
    // Used, so there is nothing to ask its transcript.
    expect(reads).toEqual([]);
  });

  it('removes an empty session whose only tabs are blank', async () => {
    given(blank('a'));
    tabs.set('a', [
      { url: '', openedBy: 'person' },
      { url: 'about:blank', openedBy: 'agent' },
    ]);
    expect(await reaper().sweep()).toEqual(['a']);
  });

  it('keeps an empty session whose tab list cannot be read, or whose read throws', async () => {
    given(blank('a'), blank('b'));
    tabs.set('a', null);
    const failing = reaper({
      browserTabs: (session) => {
        if (session.id === 'b') throw new Error('no browser');
        return tabs.get(session.id) ?? null;
      },
    });
    expect(await failing.sweep()).toEqual([]);
    expect(removed).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('keeps every empty session when the browser’s state file could not be read', async () => {
    // As main wires it: the stored tabs, through the real store and service.
    const browserOver = (read: () => unknown) => {
      const store = new BrowserStateStore({ read, write: () => {} });
      store.load();
      return new BrowserService({
        store,
        workspaceIdForSession: () => 'w1',
        findWindowForWorkspace: () => undefined,
        send: () => {},
        clearPartition: () => {},
        every: () => () => {},
      });
    };
    const lost = browserOver(() => {
      throw new Error('Could not read browser-state.json or its backup');
    });
    given(blank('a'));
    const afterLoss = reaper({ browserTabs: (session) => lost.storedTabsFor(session.id) });
    expect(await afterLoss.sweep()).toEqual([]);
    expect(reads).toEqual([]);

    // A file that was never written is no loss: nothing was there to keep.
    const none = browserOver(() => null);
    const firstRun = reaper({ browserTabs: (session) => none.storedTabsFor(session.id) });
    expect(await firstRun.sweep()).toEqual(['a']);
  });

  it('keeps a session that got a page while its transcript was read', async () => {
    given(blank('a'));
    const racing = reaper({
      hasFirstMessage: async () => {
        tabs.set('a', [{ url: 'https://example.test/', openedBy: 'person' }]);
        return false;
      },
    });
    expect(await racing.sweep()).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('EmptySessionReaper.sweep', () => {
  it('removes a settled session whose transcript has no first message', async () => {
    given(blank('a'));
    expect(await reaper().sweep()).toEqual(['a']);
    expect(removed).toEqual(['a']);
  });

  it('keeps one whose transcript has a first message', async () => {
    given(blank('a'));
    transcripts.set('conv-a', true);
    expect(await reaper().sweep()).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('keeps one whose CLI cannot say, or whose read fails', async () => {
    given(blank('a'), blank('b'));
    transcripts.set('conv-a', null);
    const failing = reaper({
      hasFirstMessage: async (session) => {
        if (session.id === 'b') throw new Error('EACCES');
        return null;
      },
    });
    expect(await failing.sweep()).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('only looks at settled sessions', async () => {
    given(blank('ready'), blank('exited'), blank('snoozed'), blank('settled'));
    attention.set('ready', 'ready');
    attention.set('exited', 'exited');
    attention.set('snoozed', 'snoozed');
    expect(await reaper().sweep()).toEqual(['settled']);
    expect(reads).toEqual(['settled']);
  });

  it('never asks the transcript about a session that was named', async () => {
    given(blank('a', { name: 'Fix the login flow' }), blank('b', { nameIsUserSet: true }));
    expect(await reaper().sweep()).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('leaves alone a session a window is showing', async () => {
    given(blank('a'));
    shown.add('inst-a');
    expect(await reaper().sweep()).toEqual([]);
  });

  it('keeps a session that stopped being settled while its transcript was read', async () => {
    given(blank('a'));
    const racing = reaper({
      hasFirstMessage: async () => {
        attention.set('a', 'working');
        return false;
      },
    });
    expect(await racing.sweep()).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('keeps a session renamed while its transcript was read', async () => {
    given(blank('a'));
    const racing = reaper({
      hasFirstMessage: async () => {
        workspaces[0].sessions[0] = { ...workspaces[0].sessions[0], name: 'Typed name' };
        return false;
      },
    });
    expect(await racing.sweep()).toEqual([]);
  });

  it('reports only what it removed when a delete fails', async () => {
    given(blank('a'), blank('b'));
    const failing = reaper({
      remove: async (_workspace, session) => {
        if (session.id === 'a') throw new Error('disk full');
        removed.push(session.id);
      },
    });
    expect(await failing.sweep()).toEqual(['b']);
  });

  it('runs one pass at a time, so a session is removed once', async () => {
    given(blank('a'));
    const shared = reaper();
    const [first, second] = await Promise.all([shared.sweep(), shared.settled(['a'])]);
    expect([...first, ...second]).toEqual(['a']);
    expect(removed).toEqual(['a']);
  });
});

describe('EmptySessionReaper.settled', () => {
  it('removes only the sessions it is given', async () => {
    given(blank('a'), blank('b'));
    expect(await reaper().settled(['a'])).toEqual(['a']);
    expect(workspaces[0].sessions.map((session) => session.id)).toEqual(['b']);
  });

  it('removes one a window is showing: settling it was the gesture', async () => {
    given(blank('a'));
    shown.add('inst-a');
    expect(await reaper().settled(['a'])).toEqual(['a']);
  });

  it('keeps one whose settle did not take', async () => {
    given(blank('a'));
    attention.set('a', 'ready');
    expect(await reaper().settled(['a'])).toEqual([]);
  });

  it('does nothing for an empty list', async () => {
    given(blank('a'));
    expect(await reaper().settled([])).toEqual([]);
    expect(reads).toEqual([]);
  });
});
