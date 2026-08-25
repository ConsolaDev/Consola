import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';

vi.mock('../services/inboxBridge', () => ({
  inboxBridge: {
    getInbox: vi.fn(async () => null),
    refreshInbox: vi.fn(async () => undefined),
    onInboxChanged: vi.fn(() => () => {}),
  },
}));

vi.mock('../services/providerBridge', () => ({
  providerBridge: {
    probe: vi.fn(),
    resolveRepos: vi.fn(async () => ({})),
    launchWorkItem: vi.fn(),
    cloneRepo: vi.fn(),
  },
}));

// navigationStore reads windowBridge.context at store-creation time, and
// sessionActions.activateSession calls windowBridge.setActiveSession — both
// reach through `window.windowAPI`, a global this suite's node environment
// doesn't have. Same workaround as navigationStore.test.ts: mock the module
// (hoisted above the import below) so the real stores load without a DOM.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setActiveSession: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
  },
}));

import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
import { useNavigationStore } from './navigationStore';
import { useTerminalStore } from './terminalStore';
import { itemKey, launchKey, useInboxStore } from './inboxStore';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  author: 'steve-sympower',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 0,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

const review = { id: 'a-review' };
const snapshot: InboxSnapshot = { workspaceId: 'ws-1', items: [item51], fetchedAt: Date.now() };

beforeEach(() => {
  useInboxStore.setState({
    snapshots: {},
    resolvedRepos: {},
    launchErrors: {},
    launching: {},
    clonePrompt: null,
  });
  useTerminalStore.setState({ pendingPrompts: {} });
  useNavigationStore.setState({ activeSessionId: null });
  vi.clearAllMocks();
});

describe('keys', () => {
  it('scopes a launch key by workspace, item and action; an item key by workspace and item', () => {
    expect(itemKey('ws-1', item51)).toBe('ws-1:github:sympower/controller-app:pr:51');
    expect(launchKey('ws-1', item51, review)).toBe(
      'ws-1:github:sympower/controller-app:pr:51:action:a-review'
    );
    expect(launchKey('ws-1', item51, { customPrompt: ' /x ' })).toBe(
      'ws-1:github:sympower/controller-app:pr:51:custom:/x'
    );
  });
});

describe('load', () => {
  it('adopts the snapshot when the bridge resolves one', async () => {
    vi.mocked(inboxBridge.getInbox).mockResolvedValue(snapshot);
    await useInboxStore.getState().load('ws-1');
    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
  });

  it('does not throw when the bridge call rejects', async () => {
    vi.mocked(inboxBridge.getInbox).mockRejectedValue(new Error('main process crashed'));
    await expect(useInboxStore.getState().load('ws-1')).resolves.toBeUndefined();
  });
});

describe('refresh', () => {
  it('does not throw when the bridge call rejects', async () => {
    vi.mocked(inboxBridge.refreshInbox).mockRejectedValue(new Error('main process crashed'));
    await expect(useInboxStore.getState().refresh('ws-1')).resolves.toBeUndefined();
  });
});

describe('adoptSnapshot', () => {
  it('stores the snapshot by workspace and asks main which repos are cloned', async () => {
    vi.mocked(providerBridge.resolveRepos).mockResolvedValue({
      'sympower/controller-app': '/repos/controller-app',
    });

    useInboxStore.getState().adoptSnapshot(snapshot);
    await vi.waitFor(() => {
      expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
        'sympower/controller-app': '/repos/controller-app',
      });
    });

    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
    expect(providerBridge.resolveRepos).toHaveBeenCalledWith('ws-1', ['sympower/controller-app']);
  });
});

describe('launch', () => {
  it('passes the action through, seeds the prompt and activates the new session', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      seedPrompt: 'HEADER\n\nReview it.',
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(providerBridge.launchWorkItem).toHaveBeenCalledWith('ws-1', item51.workItem, review);
    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBe('HEADER\n\nReview it.');
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51, review)]).toBeUndefined();
  });

  it('marks only that action as in flight while the launch runs', async () => {
    let resolveLaunch!: (value: never) => void;
    vi.mocked(providerBridge.launchWorkItem).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve as never;
      })
    );

    const pending = useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launching[launchKey('ws-1', item51, review)]).toBe(true);
    expect(
      useInboxStore.getState().launching[launchKey('ws-1', item51, { id: 'a-fixci' })]
    ).toBeUndefined();

    resolveLaunch({ ok: false, reason: 'error', message: 'x' } as never);
    await pending;
  });

  it('records an error on the item+action key when the launch fails', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'fatal: not a valid ref',
    });

    await useInboxStore.getState().launch('ws-1', item51, review);

    const key = launchKey('ws-1', item51, review);
    expect(useInboxStore.getState().launchErrors[key]).toBe('fatal: not a valid ref');
    expect(useInboxStore.getState().launching[key]).toBeUndefined();
  });

  it('opens the clone prompt when the repo is not cloned', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({ ok: false, reason: 'not-cloned' });

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().clonePrompt).toEqual({ workspaceId: 'ws-1', item: item51 });
  });

  it('records an error, keyed, when launchWorkItem rejects instead of resolving', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockRejectedValue(new Error('main process crashed'));

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51, review)]).toBe(
      'main process crashed'
    );
  });

  it('records an error when the bridge degrades to null', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue(null);

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51, review)]).toBe(
      'Could not reach the main process to launch this item.'
    );
  });
});

describe('cloneRepo', () => {
  it('clones, records the resolved path, closes the prompt, and does not launch', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: true, path: '/repos/controller-app' });
    useInboxStore.setState({ clonePrompt: { workspaceId: 'ws-1', item: item51 } });

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(providerBridge.cloneRepo).toHaveBeenCalledWith('ws-1', 'sympower/controller-app', '/repos');
    expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
      'sympower/controller-app': '/repos/controller-app',
    });
    expect(useInboxStore.getState().clonePrompt).toBeNull();
    // No auto-continue: the pane now offers the actions and the user picks one.
    expect(providerBridge.launchWorkItem).not.toHaveBeenCalled();
    expect(useInboxStore.getState().launching[itemKey('ws-1', item51)]).toBeUndefined();
  });

  it('surfaces a clone failure on the item key and leaves the repo unresolved', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: false, error: 'denied' });

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[itemKey('ws-1', item51)]).toBe('denied');
    expect(useInboxStore.getState().resolvedRepos['ws-1']).toBeUndefined();
  });

  it('records an error when the bridge rejects', async () => {
    vi.mocked(providerBridge.cloneRepo).mockRejectedValue(new Error('main process crashed'));

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[itemKey('ws-1', item51)]).toBe('main process crashed');
  });
});
