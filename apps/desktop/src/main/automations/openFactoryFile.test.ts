import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFactoryFile } from './openFactoryFile';
import type { OpenFactoryFileDeps } from './openFactoryFile';

/*
 * Open on a factory file hands a path to the OS. A file of the folder can be
 * a link (kept with dotfiles), and from slice 6 the folder holds other
 * people's files, so a click must never launch anything: only one of the
 * factory's own files (what its reader reads), a regular file inside the
 * folder once every link is resolved, opens, and only as text, on macOS.
 * Nothing ever goes to the OS default handler.
 */

let base: string;
let folder: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-factory-')));
  folder = path.join(base, 'workspaces', 'ws-1');
  for (const sub of ['agents', 'automations', 'skills/triage', 'environments', 'runs/r1', '.git'])
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function deps(platform: NodeJS.Platform = 'darwin') {
  const execFile = vi.fn(async (_file: string, _args: string[]) => {});
  const reveal = vi.fn((_file: string) => {});
  const all: OpenFactoryFileDeps = { platform, execFile, reveal };
  return { all, execFile, reveal };
}

const write = (relative: string, text = 'You review.\n', mode = 0o644) => {
  const file = path.join(folder, relative);
  fs.writeFileSync(file, text, { mode });
  return file;
};

const OUTSIDE =
  "leads outside this factory's folder; Open shows only the factory's own files: factory.yml, automations/<name>.yaml, agents/<name>.md, skills/<name>/SKILL.md and environments/<name>.yaml.";
const NOT_OWN =
  "Open shows only the factory's own files: factory.yml, automations/<name>.yaml, agents/<name>.md, skills/<name>/SKILL.md and environments/<name>.yaml.";

describe('openFactoryFile', () => {
  it.each([
    'factory.yml',
    'automations/catalog-review.yaml',
    'agents/reviewer.md',
    'skills/triage/SKILL.md',
    'environments/sandboxed.yaml',
  ])('opens %s as text on macOS: `open -t`, through execFile', async (relative) => {
    const file = write(relative);
    const { all, execFile, reveal } = deps('darwin');
    await openFactoryFile(folder, file, relative, all);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', ['-t', file]);
    expect(reveal).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'] as const)(
    'on %s launches nothing: it shows the file in its folder (review M2)',
    async (platform) => {
      const file = write('agents/reviewer.md');
      const { all, execFile, reveal } = deps(platform);
      await openFactoryFile(folder, file, 'agents/reviewer.md', all);
      expect(reveal).toHaveBeenCalledWith(file);
      expect(execFile).not.toHaveBeenCalled();
      // A link is shown as the real file it leads to, never the link.
      const link = path.join(folder, 'agents', 'second.md');
      fs.symlinkSync(file, link);
      const second = deps(platform);
      await openFactoryFile(folder, link, 'agents/second.md', second.all);
      expect(second.reveal).toHaveBeenCalledWith(file);
    },
  );

  it("opens the real file a link points at when that is one of the factory's own", async () => {
    const target = write('agents/reviewer.md');
    const link = path.join(folder, 'agents', 'second.md');
    fs.symlinkSync(target, link);
    const { all, execFile, reveal } = deps('darwin');
    await openFactoryFile(folder, link, 'agents/second.md', all);
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', ['-t', target]);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('opens a file of a folder that is itself reached through a link', async () => {
    const file = write('agents/reviewer.md');
    const linkedFolder = path.join(base, 'linked-ws');
    fs.symlinkSync(folder, linkedFolder);
    const { all, execFile, reveal } = deps('darwin');
    await openFactoryFile(
      linkedFolder,
      path.join(linkedFolder, 'agents', 'reviewer.md'),
      'agents/reviewer.md',
      all,
    );
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', ['-t', file]);
    expect(reveal).not.toHaveBeenCalled();
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
      const { all, execFile, reveal } = deps(platform);
      await expect(openFactoryFile(folder, link, 'agents/reviewer.md', all)).rejects.toThrow(
        `Not opened: \`agents/reviewer.md\` ${OUTSIDE}`,
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
    }
  });

  it('refuses a link to an app bundle outside the folder', async () => {
    const app = path.join(base, 'Evil.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    const link = path.join(folder, 'agents', 'reviewer.md');
    fs.symlinkSync(app, link);
    const { all, execFile, reveal } = deps('darwin');
    await expect(openFactoryFile(folder, link, 'agents/reviewer.md', all)).rejects.toThrow(
      `Not opened: \`agents/reviewer.md\` ${OUTSIDE}`,
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it.each([
    ['a script in the run folders', 'runs/r1/evil.command'],
    ['a terminal file in agents/', 'agents/evil.terminal'],
    ['a web location', 'automations/evil.webloc'],
    ['a dotfile', 'agents/.reviewer.md'],
    ["git's own files", '.git/config'],
    ['a yml automation file the reader does not read', 'automations/catalog-review.yml'],
    ["a skill's other file", 'skills/triage/run.sh'],
  ])(
    "refuses a link inside the folder to %s, which is not one of the factory's own",
    async (_what, relative) => {
      const target = write(relative, '#!/bin/sh\necho owned\n', 0o755);
      const link = path.join(folder, 'agents', 'reviewer.md');
      fs.symlinkSync(target, link);
      const { all, execFile, reveal } = deps('darwin');
      await expect(openFactoryFile(folder, link, 'agents/reviewer.md', all)).rejects.toThrow(
        `Not opened: \`agents/reviewer.md\` leads to \`${relative}\`. ${NOT_OWN}`,
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
    },
  );

  it("refuses a file in the folder named as none of the factory's own, link or not", async () => {
    const file = write('agents/evil.command', '#!/bin/sh\necho owned\n', 0o755);
    const { all, execFile, reveal } = deps('darwin');
    await expect(openFactoryFile(folder, file, 'agents/evil.command', all)).rejects.toThrow(
      `Not opened: \`agents/evil.command\` leads to \`agents/evil.command\`. ${NOT_OWN}`,
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('refuses what is not a regular file, at one of the factory paths too', async () => {
    const dir = path.join(folder, 'agents', 'reviewer.md');
    fs.mkdirSync(dir);
    const { all, execFile, reveal } = deps('darwin');
    await expect(openFactoryFile(folder, dir, 'agents/reviewer.md', all)).rejects.toThrow(
      "Not opened: `agents/reviewer.md` is not a regular file; Open shows only the folder's own text files.",
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('says a file that is gone, or a link whose target is gone, is not there', async () => {
    const { all, execFile, reveal } = deps('darwin');
    await expect(
      openFactoryFile(folder, path.join(folder, 'agents', 'gone.md'), 'agents/gone.md', all),
    ).rejects.toThrow('That file is not there any more.');
    const dangling = path.join(folder, 'agents', 'dangling.md');
    fs.symlinkSync(path.join(base, 'nowhere.md'), dangling);
    await expect(openFactoryFile(folder, dangling, 'agents/dangling.md', all)).rejects.toThrow(
      'That file is not there any more.',
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('refuses a path outside the folder that is not a link at all', async () => {
    const outside = path.join(base, 'elsewhere.md');
    fs.writeFileSync(outside, 'x\n');
    const { all, execFile, reveal } = deps('darwin');
    await expect(openFactoryFile(folder, outside, 'agents/elsewhere.md', all)).rejects.toThrow(
      `Not opened: \`agents/elsewhere.md\` ${OUTSIDE}`,
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it.each(['environments/x.yml', 'environments/.x.yaml'])(
    'refuses %s: not one of the factory files an environment is (slice 3-B)',
    async (relative) => {
      const file = write(relative, 'isolation: host\n');
      const { all, execFile, reveal } = deps('darwin');
      await expect(openFactoryFile(folder, file, relative, all)).rejects.toThrow(
        `Not opened: \`${relative}\` leads to \`${relative}\`. ${NOT_OWN}`,
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
    },
  );
});
