import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxSnapshot } from '../../shared/github';
import type { Workspace } from '../../shared/workspace';
import { GitHubService, INBOX_REFRESH_INTERVAL_MS, type GitHubServiceDeps } from './GitHubService';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

// v6 shape from Phase 0's contract; cast keeps the fixture honest but short.
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [],
    groups: [],
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

function makeService(overrides: Partial<GitHubServiceDeps> = {}) {
  const broadcasts: InboxSnapshot[] = [];
  const workspace = makeWorkspace();
  const service = new GitHubService({
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getGitHubWorkspaceIds: () => [workspace.id],
    token: async () => 'gho_test_token',
    ghBinary: async () => STUB,
    baseEnv: () => ({ ...process.env }),
    broadcast: (snapshot) => broadcasts.push(snapshot),
    ...overrides,
  });
  return { service, broadcasts, workspace };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GitHubService.refresh', () => {
  it('fetches through gh, parses, caches, and broadcasts', async () => {
    const { service, broadcasts } = makeService();

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.items.length).toBe(4);
    expect(snapshot!.fetchedAt).toBeGreaterThan(0);
    expect(snapshot!.error).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].workspaceId).toBe('ws-1');
  });

  it('keeps the last good items and stamps the error when gh fails', async () => {
    let fail = false;
    const { service } = makeService({
      baseEnv: () => ({ ...process.env, ...(fail ? { STUB_GH_FAIL: '1' } : {}) }),
    });

    await service.refresh('ws-1');
    const good = service.getSnapshot('ws-1')!;

    fail = true;
    await service.refresh('ws-1');
    const degraded = service.getSnapshot('ws-1')!;

    expect(degraded.items).toEqual(good.items);
    expect(degraded.fetchedAt).toBe(good.fetchedAt);
    expect(degraded.error).toContain('canned failure');
  });

  it('degrades the same way when the token cannot be borrowed', async () => {
    const { service } = makeService({
      token: async () => {
        throw new Error('gh: no accounts logged in');
      },
    });

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1')!;
    expect(snapshot.items).toEqual([]);
    expect(snapshot.error).toContain('no accounts logged in');
  });

  it('does nothing for a workspace without a github binding', async () => {
    const { service, broadcasts } = makeService({
      getWorkspace: () => makeWorkspace({ github: undefined }),
    });

    await service.refresh('ws-1');

    expect(service.getSnapshot('ws-1')).toBeNull();
    expect(broadcasts).toHaveLength(0);
  });

  it('coalesces concurrent refreshes of one workspace', async () => {
    const { service, broadcasts } = makeService();

    await Promise.all([service.refresh('ws-1'), service.refresh('ws-1')]);

    expect(broadcasts).toHaveLength(1);
  });
});

describe('GitHubService.findItem', () => {
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

describe('GitHubService cadence', () => {
  it('polls every workspace on the 3-minute timer', () => {
    vi.useFakeTimers();
    const getGitHubWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getGitHubWorkspaceIds });

    service.start();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
    service.stop();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
  });

  it('debounces window-focus refreshes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
    const getGitHubWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getGitHubWorkspaceIds });

    service.onWindowFocus();
    service.onWindowFocus();
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-20T09:01:00Z'));
    service.onWindowFocus();
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
  });
});
