import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import { WorkItemDetailService } from './WorkItemDetailService';
import { createStubDriver } from './stubDriver.test-helpers';

const ref = { provider: 'github', repo: 'org/repo', type: 'pr', number: 7 } as const;
function setup() {
  const workspace = { provider: { id: 'github', accountLogin: 'workspace-account', org: 'org' } } as Workspace;
  const driver = createStubDriver({ fetchDetails: vi.fn(), mutateItem: vi.fn() });
  const composeEnv = vi.fn(async () => ({ GH_TOKEN: 'workspace-only' }));
  const service = new WorkItemDetailService({ getWorkspace: (id) => id === 'ws' ? workspace : undefined, resolveDriver: () => driver, composeEnv });
  return { service, driver, composeEnv };
}

describe('WorkItemDetailService', () => {
  it('uses the workspace account and strips extra ref fields', async () => {
    const { service, driver, composeEnv } = setup();
    await service.get('ws', { ...ref, accountLogin: 'attacker' });
    expect(composeEnv).toHaveBeenCalledWith(driver, 'workspace-account');
    expect(driver.fetchDetails).toHaveBeenCalledWith(ref, { GH_TOKEN: 'workspace-only' });
  });
  it('rejects invalid and out-of-scope targets before borrowing credentials', async () => {
    const { service, composeEnv } = setup();
    for (const input of [null, { ...ref, repo: 'org/repo?x=y' }, { ...ref, repo: 'other/repo' }, { ...ref, number: -1 }, { ...ref, provider: 'unknown' }]) {
      await expect(service.get('ws', input)).rejects.toThrow();
    }
    await expect(service.get('missing', ref)).rejects.toThrow();
    expect(composeEnv).not.toHaveBeenCalled();
  });
  it('rejects unsupported mutations and blank comments without invoking the driver', async () => {
    const { service, driver } = setup();
    for (const action of [{ kind: 'delete' }, { kind: 'comment', body: ' ' }, { kind: 'merge', method: 'admin', headOid: 'x', auto: false }]) {
      await expect(service.mutate('ws', ref, action)).rejects.toThrow();
    }
    expect(driver.mutateItem).not.toHaveBeenCalled();
  });
  it('prevents concurrent writes and releases the lock after failure', async () => {
    const { service, driver } = setup();
    let reject!: (reason: Error) => void;
    vi.mocked(driver.mutateItem!).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const first = service.mutate('ws', ref, { kind: 'close' });
    await expect(service.mutate('ws', { ...ref, repo: 'ORG/REPO' }, { kind: 'close' })).rejects.toThrow('already in progress');
    reject(new Error('permission denied'));
    await expect(first).rejects.toThrow('permission denied');
    await service.mutate('ws', ref, { kind: 'reopen' });
    expect(driver.mutateItem).toHaveBeenCalledTimes(2);
  });
});
