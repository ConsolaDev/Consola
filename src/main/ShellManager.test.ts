import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn }));
vi.mock('./LoginEnvironment', () => ({ getLoginEnv: () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin' }) }));
import { ShellManager } from './ShellManager';

function fakePty() {
  let data: (text: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const child = {
    onData: vi.fn(callback => { data = callback; return { dispose: vi.fn() }; }),
    onExit: vi.fn(callback => { exit = callback; return { dispose: vi.fn() }; }),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  };
  spawn.mockReturnValueOnce(child);
  return { child, feed: (text: string) => data(text), exit: () => exit({ exitCode: 0 }) };
}
const owner = () => ({ send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents;
const options = { instanceId: 'session-a', cols: 80, rows: 24 };
beforeEach(() => spawn.mockReset());

describe('session shells', () => {
  it('spawns once, preserves shell state on reattach, and replays background output with its sequence', async () => {
    const manager = new ShellManager();
    const pty = fakePty();
    const first = owner();
    try {
      await manager.attach(options, '/checkout/a', first);
      manager.input(options.instanceId, 'export TEST=kept\r', first);
      pty.feed('background output\r\n');
      const second = owner();
      const snapshot = await manager.attach(options, '/different/path', second);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-il'], expect.objectContaining({ cwd: '/checkout/a' }));
      expect(snapshot.replay).toContain('background output');
      expect(snapshot.sequence).toBe(1);
      expect(snapshot.cwd).toBe('/checkout/a');
      expect(pty.child.write).toHaveBeenCalledWith('export TEST=kept\r');
      manager.input(options.instanceId, 'wrong owner', first);
      expect(pty.child.write).toHaveBeenCalledTimes(1);
      manager.resize(options.instanceId, 100, 30, second);
      expect(pty.child.resize).toHaveBeenCalledWith(100, 30);
    } finally { manager.destroyAll(); }
  });

  it('isolates sessions and kills only the removed shell', async () => {
    const manager = new ShellManager();
    const a = fakePty();
    const b = fakePty();
    const view = owner();
    await manager.attach(options, '/a', view);
    await manager.attach({ ...options, instanceId: 'b' }, '/b', view);
    manager.destroy(options.instanceId);
    expect(a.child.kill).toHaveBeenCalledTimes(1);
    expect(b.child.kill).not.toHaveBeenCalled();
    manager.input('b', 'pwd\r', view);
    expect(b.child.write).toHaveBeenCalledWith('pwd\r');
    manager.destroyAll();
    expect(b.child.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps exited output until explicit restart and does not restart a running shell', async () => {
    const manager = new ShellManager();
    const a = fakePty();
    const view = owner();
    await manager.attach(options, '/a', view);
    await manager.restart(options, '/a', view);
    expect(spawn).toHaveBeenCalledTimes(1);
    a.feed('goodbye');
    a.exit();
    const snapshot = await manager.attach(options, '/a', view);
    expect(snapshot.exited).toBe(true);
    expect(snapshot.replay).toContain('goodbye');
    fakePty();
    expect((await manager.restart(options, '/a', view)).exited).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
    manager.destroyAll();
  });

  it('allows retry after spawn failure and rejects invalid dimensions', async () => {
    const manager = new ShellManager();
    spawn.mockImplementationOnce(() => { throw new Error('missing shell'); });
    await expect(manager.attach(options, '/a', owner())).rejects.toThrow('missing shell');
    fakePty();
    await manager.attach(options, '/a', owner());
    await expect(manager.attach({ ...options, cols: -1 }, '/a', owner())).rejects.toThrow('dimensions');
    manager.destroyAll();
  });
});
