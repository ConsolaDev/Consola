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
    probe: vi.fn(async () => ({ available: false, accounts: [] })),
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
import { launchKey, useInboxStore } from './inboxStore';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

const snapshot: InboxSnapshot = {
  workspaceId: 'ws-1',
  items: [item51],
  fetchedAt: Date.now(),
};

beforeEach(() => {
  useInboxStore.setState({
    snapshots: {},
    resolvedRepos: {},
    launchErrors: {},
    launching: {},
    clonePrompt: null,
  });
  // These are real, unmocked stores shared across tests in this file (unlike
  // useInboxStore above, nothing recreates them per test). Both launch tests
  // reuse instanceId 'inst-1' and session id 'session-1', so without this
  // reset the fresh-launch test's pendingPrompts write leaks into the
  // re-attach test that asserts it stays unset.
  useTerminalStore.setState({ pendingPrompts: {} });
  useNavigationStore.setState({ activeSessionId: null });
  vi.clearAllMocks();
});

describe('load', () => {
  it('adopts the snapshot when the bridge resolves one', async () => {
    vi.mocked(inboxBridge.getInbox).mockResolvedValue(snapshot);

    await useInboxStore.getState().load('ws-1');

    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
  });

  it('does not throw when the bridge call rejects', async () => {
    vi.mocked(inboxBridge.getInbox).mockRejectedValue(new Error('main process crashed'));

    // A floating `void load(...)` at the call sites means a rejection here
    // would be an unhandled rejection — this must resolve instead.
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
  it('seeds the prompt and activates the session on a fresh launch', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: false,
      seedPrompt: 'This session is for pull request #51...',
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBe(
      'This session is for pull request #51...'
    );
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('does not re-seed the prompt when re-attaching', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: true,
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBeUndefined();
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('records an error on the item, keyed, when the launch fails', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'fatal: not a valid ref',
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe(
      'fatal: not a valid ref'
    );
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51)]).toBeUndefined();
  });

  it('opens the clone prompt when the repo is not cloned', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'not-cloned',
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().clonePrompt).toEqual({ workspaceId: 'ws-1', item: item51 });
  });

  it('records an error, keyed, when launchWorkItem rejects instead of resolving', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockRejectedValue(new Error('main process crashed'));

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe(
      'main process crashed'
    );
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51)]).toBeUndefined();
  });

  it('records an error when the bridge degrades to null', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue(null);

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe(
      'Could not reach the main process to launch this item.'
    );
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51)]).toBeUndefined();
  });
});

describe('cloneAndLaunch', () => {
  it('clones, then continues the launch', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: true, path: '/repos/x' });
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: false,
      seedPrompt: 'seed',
      session: { id: 'session-2', instanceId: 'inst-2' } as never,
    });
    useInboxStore.setState({ clonePrompt: { workspaceId: 'ws-1', item: item51 } });

    await useInboxStore.getState().cloneAndLaunch('ws-1', item51, '/repos');

    expect(providerBridge.cloneRepo).toHaveBeenCalledWith('ws-1', 'sympower/controller-app', '/repos');
    expect(providerBridge.launchWorkItem).toHaveBeenCalled();
    expect(useInboxStore.getState().clonePrompt).toBeNull();
  });

  it('records the resolved path on a successful clone, even when the launch after it fails', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: true, path: '/repos/controller-app' });
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'fatal: branch already checked out',
    });

    await useInboxStore.getState().cloneAndLaunch('ws-1', item51, '/repos');

    expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
      'sympower/controller-app': '/repos/controller-app',
    });
    // The button reads the failure off launchErrors, not "Clone into
    // scope..." again — the clone itself did succeed.
    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe(
      'fatal: branch already checked out'
    );
  });

  it('surfaces a clone failure on the item and does not launch', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: false, error: 'denied' });

    await useInboxStore.getState().cloneAndLaunch('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe('denied');
    expect(providerBridge.launchWorkItem).not.toHaveBeenCalled();
  });
});
