import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { InboxService, INBOX_REFRESH_INTERVAL_MS, type InboxServiceDeps } from './InboxService';
import { createStubDriver } from './stubDriver.test-helpers';

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

const issue87: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 },
  title: 'Rate limit returns 500',
  author: 'mira',
  roles: ['assignee'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'none',
  commentCount: 4,
  updatedAt: '2026-08-20T07:12:00Z',
  url: 'https://github.com/sympower/msa-resource-bff/issues/87',
};

/**
 * This file's flavour of the shared stub: a token tied to the login (so a
 * refresh's composed env proves which account it borrowed for) and an
 * inbox with something in it by default.
 */
function makeStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return createStubDriver({
    tokenEnvVar: 'STUB_TOKEN',
    token: vi.fn(async (login: string) => `tok-${login}`),
    fetchInbox: vi.fn(async () => [item51, issue87]),
    ...overrides,
  });
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [],
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeService(overrides: Partial<InboxServiceDeps> = {}, driver = makeStubDriver()) {
  const broadcasts: InboxSnapshot[] = [];
  const workspace = makeWorkspace();
  const service = new InboxService({
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getBoundWorkspaceIds: () => [workspace.id],
    resolveDriver: () => driver,
    // What composeProviderEnv does, minus the login shell: the token under
    // the driver's own variable.
    composeEnv: async (resolved, login) => ({ [resolved.tokenEnvVar]: await resolved.token(login) }),
    broadcast: (snapshot) => broadcasts.push(snapshot),
    ...overrides,
  });
  return { service, broadcasts, workspace, driver };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InboxService.refresh', () => {
  it('fetches through the driver with the binding and the composed env, caches, and broadcasts', async () => {
    const { service, broadcasts, driver } = makeService();

    await service.refresh('ws-1');

    expect(driver.fetchInbox).toHaveBeenCalledWith(
      { accountLogin: 'SymJavi', org: 'sympower' },
      { STUB_TOKEN: 'tok-SymJavi' }
    );
    const snapshot = service.getSnapshot('ws-1');
    expect(snapshot?.items).toEqual([item51, issue87]);
    expect(snapshot?.fetchedAt).toBeGreaterThan(0);
    expect(snapshot?.error).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].workspaceId).toBe('ws-1');
  });

  it('keeps the last good items and stamps the error when the driver throws', async () => {
    const { service, driver } = makeService();

    await service.refresh('ws-1');
    const good = service.getSnapshot('ws-1')!;

    vi.mocked(driver.fetchInbox).mockRejectedValueOnce(new Error('gh: canned failure (STUB_GH_FAIL=1)'));
    await service.refresh('ws-1');
    const degraded = service.getSnapshot('ws-1')!;

    expect(degraded.items).toEqual(good.items);
    expect(degraded.fetchedAt).toBe(good.fetchedAt);
    expect(degraded.error).toContain('canned failure');
  });

  it('degrades the same way when the token cannot be borrowed', async () => {
    const { service } = makeService({
      composeEnv: async () => {
        throw new Error('gh: no accounts logged in');
      },
    });

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1')!;
    expect(snapshot.items).toEqual([]);
    expect(snapshot.error).toContain('no accounts logged in');
  });

  it('degrades — never throws — when the workspace names a provider this build lacks', async () => {
    const { service, driver } = makeService({
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    await expect(service.refresh('ws-1')).resolves.toBeUndefined();

    expect(service.getSnapshot('ws-1')?.error).toContain('Unknown git provider');
    expect(driver.fetchInbox).not.toHaveBeenCalled();
  });

  it('does nothing for a workspace without a provider binding', async () => {
    const { service, broadcasts, driver } = makeService({
      getWorkspace: () => makeWorkspace({ provider: undefined }),
    });

    await service.refresh('ws-1');

    expect(service.getSnapshot('ws-1')).toBeNull();
    expect(broadcasts).toHaveLength(0);
    expect(driver.fetchInbox).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes of one workspace', async () => {
    const { service, broadcasts, driver } = makeService();

    await Promise.all([service.refresh('ws-1'), service.refresh('ws-1')]);

    expect(driver.fetchInbox).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
  });
});

describe('InboxService.findItem', () => {
  it('finds a cached item by work-item ref, case-insensitively', async () => {
    const { service } = makeService();
    await service.refresh('ws-1');

    const item = service.findItem('ws-1', {
      provider: 'github',
      repo: 'Sympower/Controller-App',
      type: 'pr',
      number: 51,
    });
    expect(item?.title).toBe('Extract billing client');
  });
});

describe('InboxService cadence', () => {
  it('polls every bound workspace on the 3-minute timer', () => {
    vi.useFakeTimers();
    const getBoundWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getBoundWorkspaceIds });

    service.start();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
    service.stop();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
  });

  it('debounces window-focus refreshes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
    const getBoundWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getBoundWorkspaceIds });

    service.onWindowFocus();
    service.onWindowFocus();
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-20T09:01:00Z'));
    service.onWindowFocus();
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
  });
});
