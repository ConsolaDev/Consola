import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lockKey, PathLock, RECENTLY_PREPARED_MS } from './PathLock';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PathLock', () => {
  it('serialises work on one folder and lets other folders run alongside', async () => {
    const lock = new PathLock();
    const order: string[] = [];
    const gate = deferred();
    const first = lock.run('/wt/a', async () => {
      order.push('a1 start');
      await gate.promise;
      order.push('a1 end');
    });
    const second = lock.run('/wt/a', async () => {
      order.push('a2');
    });
    const other = lock.run('/wt/b', async () => {
      order.push('b');
    });
    await other;
    expect(order).toEqual(['a1 start', 'b']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
  });

  it('is not poisoned by a failure', async () => {
    const lock = new PathLock();
    await expect(
      lock.run('/wt/a', async () => Promise.reject(new Error('git said no'))),
    ).rejects.toThrow('git said no');
    await expect(lock.run('/wt/a', async () => 'next')).resolves.toBe('next');
  });

  it('keys a folder by real path, before and after it exists', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-lock-')));
    const link = `${base}-link`;
    fs.symlinkSync(base, link);
    const before = lockKey(path.join(link, 'app-pr-1'));
    fs.mkdirSync(path.join(base, 'app-pr-1'));
    expect(lockKey(path.join(link, 'app-pr-1'))).toBe(before);
    expect(before).toBe(path.join(base, 'app-pr-1'));
    fs.unlinkSync(link);
    fs.rmSync(base, { recursive: true });
  });

  it('remembers a freshly prepared folder for ten minutes', () => {
    let now = 0;
    const lock = new PathLock(() => now);
    lock.markPrepared('/wt/a');
    expect(lock.recentlyPrepared('/wt/a')).toBe(true);
    expect(lock.recentlyPrepared('/wt/b')).toBe(false);
    now = RECENTLY_PREPARED_MS;
    expect(lock.recentlyPrepared('/wt/a')).toBe(false);
  });
});
