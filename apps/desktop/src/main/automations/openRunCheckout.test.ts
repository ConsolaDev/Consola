import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../shared/automations';
import { WorktreeService } from '../WorktreeService';
import { NO_CHECKOUT_TO_OPEN, openRunCheckout } from './openRunCheckout';

/*
 * The run page's Open folder (`automations:open-run-checkout`, slice 3-B
 * Task 22) hands a path to the OS, and `shell.openPath` runs a file or an
 * app bundle it is handed (review M5). So only a run's own checkout opens:
 * its record says `run-owned`, the folder is a direct child of the worktree
 * root by real path, and `lstat` says it is a real directory, so a link is
 * not followed.
 */

let base: string;
let root: string;
let worktrees: WorktreeService;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-run-checkout-')));
  root = path.join(base, 'worktrees');
  fs.mkdirSync(root);
  worktrees = new WorktreeService(root);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const runAt = (cwd: string, kind: 'run-owned' | 'item' | 'scope' = 'run-owned') =>
  ({
    checkout: { cwd, kind, repo: 'sprocket/catalog-portal', branch: 'fix/SHOP-42' },
  }) as Pick<RunRecord, 'checkout'>;

function deps() {
  const openPath = vi.fn(async (_dir: string) => '');
  return {
    all: { isManagedPath: (dir: string) => worktrees.isManagedPath(dir), openPath },
    openPath,
  };
}

describe('openRunCheckout', () => {
  it("opens a run's own checkout under the worktree root, once", async () => {
    const dir = path.join(root, 'catalog-portal-run-a1b2c3d4');
    fs.mkdirSync(dir);
    const { all, openPath } = deps();
    await openRunCheckout(runAt(dir), all);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith(dir);
  });

  it('opens only a run-owned checkout under the worktree root, and only a real folder', async () => {
    const owned = path.join(root, 'catalog-portal-run-a1b2c3d4');
    fs.mkdirSync(owned);
    const outside = path.join(base, 'catalog-portal-run-e5f6a7b8');
    fs.mkdirSync(outside);
    const nested = path.join(owned, 'src');
    fs.mkdirSync(nested);
    const file = path.join(root, 'catalog-portal-run-0a0a0a0a');
    fs.writeFileSync(file, '#!/bin/sh\necho ran\n', { mode: 0o755 });
    const link = path.join(root, 'catalog-portal-run-1b1b1b1b');
    fs.symlinkSync(owned, link);
    const { all, openPath } = deps();
    for (const run of [
      null,
      {},
      runAt(owned, 'item'),
      runAt(owned, 'scope'),
      // A record from before 3-B, with no kind, is never a run's own.
      { checkout: { cwd: owned } },
      runAt(outside),
      runAt(nested),
      runAt(file),
      runAt(link),
      runAt(path.join(root, 'catalog-portal-run-gone0000')),
    ]) {
      await expect(openRunCheckout(run, all)).rejects.toThrow(NO_CHECKOUT_TO_OPEN);
    }
    expect(openPath).not.toHaveBeenCalled();
    expect(NO_CHECKOUT_TO_OPEN).toBe('This run has no checkout of its own to open.');
  });

  it('says why the OS could not open it', async () => {
    const dir = path.join(root, 'catalog-portal-run-a1b2c3d4');
    fs.mkdirSync(dir);
    const openPath = vi.fn(async () => 'Failed to open path');
    await expect(
      openRunCheckout(runAt(dir), { isManagedPath: (d) => worktrees.isManagedPath(d), openPath }),
    ).rejects.toThrow('Could not open its folder: Failed to open path');
  });
});
