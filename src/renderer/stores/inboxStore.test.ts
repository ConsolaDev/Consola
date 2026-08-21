import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/github';

vi.mock('../services/githubBridge', () => ({
  githubBridge: {
    getInbox: vi.fn(async () => null),
    refreshInbox: vi.fn(async () => undefined),
    resolveRepos: vi.fn(async () => ({})),
    launchWorkItem: vi.fn(),
    onInboxChanged: vi.fn(() => () => {}),
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

import { githubBridge } from '../services/githubBridge';
import { useNavigationStore } from './navigationStore';
import { useTerminalStore } from './terminalStore';
import { launchKey, useInboxStore } from './inboxStore';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  state: 'open',
  role: 'review-requested',
  ciStatus: 'failing',
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

describe('adoptSnapshot', () => {
  it('stores the snapshot by workspace and asks main which repos are cloned', async () => {
    vi.mocked(githubBridge.resolveRepos).mockResolvedValue({
      'sympower/controller-app': '/repos/controller-app',
    });

    useInboxStore.getState().adoptSnapshot(snapshot);
    await vi.waitFor(() => {
      expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
        'sympower/controller-app': '/repos/controller-app',
      });
    });

    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
    expect(githubBridge.resolveRepos).toHaveBeenCalledWith('ws-1', ['sympower/controller-app']);
  });
});

describe('launch', () => {
  it('seeds the prompt and activates the session on a fresh launch', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
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
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: true,
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBeUndefined();
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('records an error on the item, keyed, when the launch fails', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
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
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'not-cloned',
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().clonePrompt).toEqual({ workspaceId: 'ws-1', item: item51 });
  });
});
