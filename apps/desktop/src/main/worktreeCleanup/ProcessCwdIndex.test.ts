import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLsof, ProcessCwdIndex } from './ProcessCwdIndex';

vi.setConfig({ testTimeout: 20_000 });

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function folder(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-procs-')));
}

describe('ProcessCwdIndex', () => {
  it.skipIf(process.platform === 'win32')(
    'sees a process working in the tree, and nothing in an empty one',
    async () => {
      const busy = folder();
      const idle = folder();
      fs.mkdirSync(path.join(busy, 'src'));
      const child = spawn('sleep', ['30'], { cwd: path.join(busy, 'src') });
      children.push(child);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const index = new ProcessCwdIndex();
      const snapshot = await index.snapshot();
      const found = ProcessCwdIndex.inTree(snapshot, busy);
      expect(found).toMatchObject({ kind: 'present' });
      if (found.kind === 'present') {
        expect(found.processes.map((entry) => entry.pid)).toContain(child.pid);
      }
      expect(ProcessCwdIndex.inTree(snapshot, idle)).toEqual({ kind: 'none' });
      // Excusing a process excuses it alone.
      expect(ProcessCwdIndex.inTree(snapshot, busy, new Set([child.pid!]))).toEqual({
        kind: 'none',
      });
    },
  );

  it('excuses a process’s descendants with it', () => {
    const snapshot = {
      kind: 'ok' as const,
      entries: [
        { pid: 10, ppid: 1, command: 'claude', cwd: '/wt/a' },
        { pid: 11, ppid: 10, command: 'node', cwd: '/wt/a/web' },
        { pid: 20, ppid: 1, command: 'vim', cwd: '/wt/a' },
      ],
    };
    expect(ProcessCwdIndex.inTree(snapshot, '/wt/a', new Set([10]))).toEqual({
      kind: 'present',
      processes: [{ pid: 20, command: 'vim' }],
    });
  });

  it('excuses a shell alone: a job started in it still counts', () => {
    const snapshot = {
      kind: 'ok' as const,
      entries: [
        { pid: 30, ppid: 1, command: 'zsh', cwd: '/wt/a' },
        { pid: 31, ppid: 30, command: 'vite', cwd: '/wt/a' },
      ],
    };
    expect(ProcessCwdIndex.inTree(snapshot, '/wt/a', new Set(), new Set([30]))).toEqual({
      kind: 'present',
      processes: [{ pid: 31, command: 'vite' }],
    });
  });

  it('answers unknown when lsof fails, is missing, or on Windows', async () => {
    const failing = new ProcessCwdIndex(async () => ({ code: -1, stdout: '', stderr: 'ENOENT' }));
    expect(await failing.snapshot()).toEqual({ kind: 'unknown' });
    const windows = new ProcessCwdIndex(
      async () => ({ code: 0, stdout: 'p1\nn/\n', stderr: '' }),
      'win32',
    );
    expect(await windows.snapshot()).toEqual({ kind: 'unknown' });
    expect(ProcessCwdIndex.inTree({ kind: 'unknown' }, '/wt/a')).toEqual({ kind: 'unknown' });
  });

  it('parses lsof’s field output', () => {
    expect(parseLsof('p12\ncnode\nfcwd\nn/wt/a\np13\nczsh\nfcwd\nn/\n')).toEqual([
      { pid: 12, command: 'node', cwd: '/wt/a' },
      { pid: 13, command: 'zsh', cwd: '/' },
    ]);
  });
});
