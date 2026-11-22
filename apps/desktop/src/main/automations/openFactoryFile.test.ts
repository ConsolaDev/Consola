import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFactoryFile, type OpenFactoryFileDeps } from './openFactoryFile';

/*
 * Open on a factory file hands a path to the OS. A file of the folder can be
 * a link (kept with dotfiles), and from slice 6 the folder holds other
 * people's files, so a click must never launch what a link points at: only a
 * regular file inside the folder opens, and on macOS it opens as text.
 */

let base: string;
let folder: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-factory-')));
  folder = path.join(base, 'workspaces', 'ws-1');
  fs.mkdirSync(path.join(folder, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'automations'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function deps(platform: NodeJS.Platform = 'darwin', failure = '') {
  const execFile = vi.fn(async (_file: string, _args: string[]) => {});
  const openPath = vi.fn(async (_path: string) => failure);
  const all: OpenFactoryFileDeps = { platform, execFile, openPath };
  return { all, execFile, openPath };
}

const write = (relative: string, text = 'You review.\n') => {
  const file = path.join(folder, relative);
  fs.writeFileSync(file, text);
  return file;
};

describe('openFactoryFile', () => {
  it('opens a regular file of the folder as text on macOS, never through its default handler', async () => {
    const file = write('agents/reviewer.md');
    const { all, execFile, openPath } = deps('darwin');
    await openFactoryFile(folder, file, 'agents/reviewer.md', all);
    expect(execFile).toHaveBeenCalledWith('open', ['-t', file]);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('elsewhere opens it with the OS opener, and says why that failed', async () => {
    const file = write('automations/catalog-review.yaml', 'on: { cron: "0 7 * * 1-5" }\n');
    const { all, execFile, openPath } = deps('linux');
    await openFactoryFile(folder, file, 'automations/catalog-review.yaml', all);
    expect(openPath).toHaveBeenCalledWith(file);
    expect(execFile).not.toHaveBeenCalled();

    const failing = deps('linux', 'No application knows how to open it.');
    await expect(
      openFactoryFile(folder, file, 'automations/catalog-review.yaml', failing.all),
    ).rejects.toThrow('No application knows how to open it.');
  });

  it('opens the real file a link inside the folder points at', async () => {
    const target = write('agents/reviewer.md');
    const link = path.join(folder, 'agents', 'second.md');
    fs.symlinkSync(target, link);
    const { all, execFile } = deps('darwin');
    await openFactoryFile(folder, link, 'agents/second.md', all);
    expect(execFile).toHaveBeenCalledWith('open', ['-t', target]);
  });

  it('opens a file of a folder that is itself reached through a link', async () => {
    const file = write('agents/reviewer.md');
    const linkedFolder = path.join(base, 'linked-ws');
    fs.symlinkSync(folder, linkedFolder);
    const { all, execFile } = deps('darwin');
    await openFactoryFile(
      linkedFolder,
      path.join(linkedFolder, 'agents', 'reviewer.md'),
      'agents/reviewer.md',
      all,
    );
    expect(execFile).toHaveBeenCalledWith('open', ['-t', file]);
  });

  it.each([
    ['an executable script', 'evil.command', '#!/bin/sh\necho owned\n'],
    ['a text file', 'notes.md', 'Somebody else’s notes.\n'],
  ])('refuses a link to %s outside the folder, and opens nothing', async (_what, name, text) => {
    const outside = path.join(base, name);
    fs.writeFileSync(outside, text, { mode: 0o755 });
    const link = path.join(folder, 'agents', 'reviewer.md');
    fs.symlinkSync(outside, link);
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { all, execFile, openPath } = deps(platform);
      await expect(openFactoryFile(folder, link, 'agents/reviewer.md', all)).rejects.toThrow(
        "Not opened: `agents/reviewer.md` leads outside this factory's folder; Open shows only the folder's own files.",
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
    }
  });

  it('refuses a link to an app bundle outside the folder', async () => {
    const app = path.join(base, 'Evil.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    const link = path.join(folder, 'agents', 'reviewer.md');
    fs.symlinkSync(app, link);
    const { all, execFile, openPath } = deps('darwin');
    await expect(openFactoryFile(folder, link, 'agents/reviewer.md', all)).rejects.toThrow(
      "Not opened: `agents/reviewer.md` leads outside this factory's folder",
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('refuses what is not a regular file, inside the folder too', async () => {
    const dir = path.join(folder, 'agents', 'reviewer.md');
    fs.mkdirSync(dir);
    for (const platform of ['darwin', 'linux'] as const) {
      const { all, execFile, openPath } = deps(platform);
      await expect(openFactoryFile(folder, dir, 'agents/reviewer.md', all)).rejects.toThrow(
        "Not opened: `agents/reviewer.md` is not a regular file; Open shows only the folder's own text files.",
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
    }
  });

  it('says a file that is gone, or a link whose target is gone, is not there', async () => {
    const { all, execFile, openPath } = deps('darwin');
    await expect(
      openFactoryFile(folder, path.join(folder, 'agents', 'gone.md'), 'agents/gone.md', all),
    ).rejects.toThrow('That file is not there any more.');
    const dangling = path.join(folder, 'agents', 'dangling.md');
    fs.symlinkSync(path.join(base, 'nowhere.md'), dangling);
    await expect(openFactoryFile(folder, dangling, 'agents/dangling.md', all)).rejects.toThrow(
      'That file is not there any more.',
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('refuses a path outside the folder that is not a link at all', async () => {
    const outside = path.join(base, 'elsewhere.md');
    fs.writeFileSync(outside, 'x\n');
    const { all, execFile } = deps('darwin');
    await expect(openFactoryFile(folder, outside, 'agents/elsewhere.md', all)).rejects.toThrow(
      "leads outside this factory's folder",
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});
