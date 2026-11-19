import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureStore } from './CaptureStore';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'consola-captures-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('CaptureStore', () => {
  it('names a capture <root>/<session id>/<timestamp>.png', () => {
    const store = new CaptureStore(root);
    const file = store.pathFor('s-1', new Date('2026-11-19T10:20:30.456Z'));
    expect(file).toBe(path.join(root, 's-1', '2026-11-19T10-20-30-456Z.png'));
  });

  it('refuses a session id that could leave its folder', () => {
    const store = new CaptureStore(root);
    expect(() => store.pathFor('../x')).toThrow();
    expect(() => store.pathFor('a/b')).toThrow();
    expect(() => store.pathFor('')).toThrow();
  });

  it('writes the image and answers its path', async () => {
    const store = new CaptureStore(root);
    const file = await store.write('s-1', Buffer.from([1, 2, 3]));
    expect(path.dirname(file)).toBe(path.join(root, 's-1'));
    expect([...(await fs.readFile(file))]).toEqual([1, 2, 3]);
  });

  it("removes a session's folder, and nothing else", async () => {
    const store = new CaptureStore(root);
    const mine = await store.write('s-1', Buffer.from([1]));
    const other = await store.write('s-2', Buffer.from([2]));
    await store.removeAll('s-1');
    await expect(fs.stat(path.dirname(mine))).rejects.toThrow();
    await expect(fs.stat(other)).resolves.toBeTruthy();
  });

  it('never overwrites a capture taken in the same millisecond', async () => {
    const store = new CaptureStore(root);
    const at = new Date('2026-11-19T10:20:30.456Z');
    const first = await store.write('s-1', Buffer.from([1]), at);
    const second = await store.write('s-1', Buffer.from([2]), at);
    expect(second).not.toBe(first);
    expect([...(await fs.readFile(first))]).toEqual([1]);
    expect([...(await fs.readFile(second))]).toEqual([2]);
  });

  it('has nothing to remove without error, and ignores an unsafe id', async () => {
    const store = new CaptureStore(root);
    await expect(store.removeAll('never')).resolves.toBeUndefined();
    await expect(store.removeAll('../')).resolves.toBeUndefined();
    await expect(fs.stat(root)).resolves.toBeTruthy();
  });
});
