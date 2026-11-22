import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MAX_FACTORY_TEXT_BYTES, MAX_SKILL_BYTES, parseFactorySpec } from '@consola/factory-spec';
import { ASSIGNED_REVIEWS_NAME, assignedReviewsEntry } from '../factoryTemplates';
import { FactoryFolder } from './factoryFolder';

/** A fresh temporary folder, removed when the test ends. */
function tmp(prefix = 'factory-folder-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => {
    // A test may leave a file unreadable; make it removable again.
    try {
      execFileSync('chmod', ['-R', 'u+rwx', dir]);
    } catch {
      // Nothing to restore.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write `files` (relative path → text or bytes) under `dir`, creating folders as needed. */
function layout(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const AGENT = '---\nmodel: opus\n---\nYou investigate alerts.\n';
const ENTRY = 'on: { cron: "0 9 * * 1-5" }\nscope: api\nsteps:\n  - agent: investigator\n';
const SKILL = '---\nname: incident-triage\ndescription: Triage an incident.\n---\nLook first.\n';
const FACTORY = 'version: 1\nautomations: []\n';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const bytesOf = (entry: { path: string; bytes?: Uint8Array; kind?: string }) =>
  entry.bytes?.length ?? 0;

/** Resolves once `check` holds, polling; rejects after `ms`. */
async function eventually(check: () => boolean, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('It did not happen in time.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FactoryFolder.read', () => {
  it('reads the four kinds and nothing else', async () => {
    const dir = tmp();
    layout(dir, {
      'factory.yml': FACTORY,
      'automations/investigate-alerts.yaml': ENTRY,
      'agents/investigator.md': AGENT,
      'skills/incident-triage/SKILL.md': SKILL,
      'skills/incident-triage/refs/queries.md': 'service:catalog\n',
      'runs/r1/x': 'run state',
      'checks/c/stdout.log': 'a log',
      'alerts.sh': 'echo hi',
      'orchestrator.md': 'not read',
      '.DS_Store': 'finder',
      'agents/.hidden.md': 'a dotfile',
      'automations/.investigate-alerts.yaml.swp': 'an editor',
      'skills/incident-triage/.DS_Store': 'finder',
    });
    const { exists, files } = await new FactoryFolder(dir).read();
    expect(exists).toBe(true);
    expect(files.factoryYml).toBe(FACTORY);
    expect(files.automations).toEqual({ 'investigate-alerts': ENTRY });
    expect(files.agents).toEqual({ investigator: AGENT });
    expect(Object.keys(files.skills)).toEqual(['incident-triage']);
    expect(
      files.skills['incident-triage'].map((entry) => ({
        path: entry.path,
        text: 'bytes' in entry ? text(entry.bytes) : entry.kind,
      })),
    ).toEqual([
      { path: 'SKILL.md', text: SKILL },
      { path: 'refs/queries.md', text: 'service:catalog\n' },
    ]);
    expect(files.stray).toEqual([]);
    expect(files.laterFolders).toEqual([]);
    expect(files.unread).toEqual([]);
  });

  it('strays and later folders', async () => {
    const dir = tmp();
    layout(dir, {
      'agents/notes.txt': 'notes',
      'automations/x.yml': ENTRY,
      'automations/drafts/y.yaml': ENTRY,
      'skills/readme.md': 'a file at the skills root',
      'environments/dev.yml': 'later',
      'evals/e.yml': 'later',
      'scripts/check.sh': 'not a later folder',
    });
    const { exists, files } = await new FactoryFolder(dir).read();
    expect(exists).toBe(false);
    expect(files.factoryYml).toBeNull();
    // `environments/` is the factory's own since slice 3-B: its `dev.yml` is a stray, not a later file.
    expect(files.stray).toEqual([
      'agents/notes.txt',
      'automations/drafts',
      'automations/x.yml',
      'environments/dev.yml',
      'skills/readme.md',
    ]);
    expect(files.laterFolders).toEqual(['evals']);
    expect(files.automations).toEqual({});
    expect(files.agents).toEqual({});
    expect(files.skills).toEqual({});
  });

  it("passes over an editor's or the OS's leftovers beside a file, as it does dotfiles; other strays stay (review S5)", async () => {
    const dir = tmp();
    layout(dir, {
      'factory.yml': FACTORY,
      'agents/investigator.md': AGENT,
      'agents/investigator.md~': AGENT,
      'agents/#investigator.md#': AGENT,
      'agents/.#investigator.md': AGENT,
      'agents/.investigator.md.swp': 'swap',
      'agents/.DS_Store': 'finder',
      'automations/investigate-alerts.yaml': ENTRY,
      'automations/investigate-alerts.yaml.orig': ENTRY,
      'automations/investigate-alerts.yaml.rej': ENTRY,
      'automations/investigate-alerts.yaml.bak': ENTRY,
      'skills/incident-triage/SKILL.md': SKILL,
      'skills/incident-triage/SKILL.md~': SKILL,
      'skills/Thumbs.db': 'explorer',
      'agents/notes.txt': 'notes',
    });
    const { files } = await new FactoryFolder(dir).read();
    expect(files.agents).toEqual({ investigator: AGENT });
    expect(files.automations).toEqual({ 'investigate-alerts': ENTRY });
    expect(files.skills['incident-triage'].map((entry) => entry.path)).toEqual(['SKILL.md']);
    expect(files.stray).toEqual(['agents/notes.txt']);
  });

  it('a folder that is not there reads as empty', async () => {
    const dir = path.join(tmp(), 'never-made');
    expect(await new FactoryFolder(dir).read()).toEqual({
      exists: false,
      files: {
        factoryYml: null,
        automations: {},
        agents: {},
        skills: {},
        environments: {},
        stray: [],
        laterFolders: [],
        unread: [],
        outside: [],
      },
    });
  });

  it('what it does not read', async () => {
    const dir = tmp();
    layout(dir, {
      'agents/huge.md': 'x'.repeat(MAX_FACTORY_TEXT_BYTES + 1),
      'agents/exact.md': 'y'.repeat(MAX_FACTORY_TEXT_BYTES),
      'agents/locked.md': AGENT,
      'automations/huge.yaml': 'z'.repeat(MAX_FACTORY_TEXT_BYTES + 1),
    });
    fs.mkdirSync(path.join(dir, 'agents', 'folder.md'));
    // A FIFO named like an agent file: opened without blocking, so the read never hangs on it.
    execFileSync('mkfifo', [path.join(dir, 'agents', 'pipe.md')]);
    const locked = path.join(dir, 'agents', 'locked.md');
    fs.chmodSync(locked, 0o000);
    const root = process.getuid?.() === 0;
    const { files } = await new FactoryFolder(dir).read();
    expect(Object.keys(files.agents)).toEqual(root ? ['exact', 'locked'] : ['exact']);
    expect(files.agents.exact).toHaveLength(MAX_FACTORY_TEXT_BYTES);
    expect(files.automations).toEqual({});
    const unread = Object.fromEntries(files.unread.map((entry) => [entry.path, entry.reason]));
    expect(unread['agents/huge.md']).toBe('it is over 1 MB');
    expect(unread['automations/huge.yaml']).toBe('it is over 1 MB');
    expect(unread['agents/folder.md']).toBe('it is not a regular file');
    expect(unread['agents/pipe.md']).toBe('it is not a regular file');
    if (!root) expect(unread['agents/locked.md']).toMatch(/EACCES|permission denied/);
    expect(files.stray).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a folder it cannot list is unread, never read as empty',
    async () => {
      const dir = tmp();
      layout(dir, {
        'agents/investigator.md': AGENT,
        'skills/incident-triage/SKILL.md': SKILL,
        'skills/incident-triage/refs/queries.md': 'service:catalog\n',
        'skills/locked/SKILL.md': SKILL,
      });
      fs.chmodSync(path.join(dir, 'agents'), 0o000);
      fs.chmodSync(path.join(dir, 'skills/incident-triage/refs'), 0o000);
      fs.chmodSync(path.join(dir, 'skills/locked'), 0o000);
      const { files } = await new FactoryFolder(dir).read();
      expect(files.agents).toEqual({});
      expect(Object.keys(files.skills)).toEqual(['incident-triage']);
      expect(files.unread.map((entry) => entry.path).sort()).toEqual([
        'agents/',
        'skills/incident-triage/refs/',
        'skills/locked/',
      ]);
      for (const entry of files.unread) expect(entry.reason).toMatch(/EACCES|permission denied/);
    },
  );

  it('a skill file swapped for a link between its look and its read is not followed (O_NOFOLLOW)', async () => {
    const dir = tmp();
    const outside = tmp('factory-outside-');
    layout(outside, { 'secret.md': 'not for the skill' });
    layout(dir, { 'skills/raced/SKILL.md': SKILL, 'skills/raced/notes.md': 'a regular file' });
    const raced = path.join(dir, 'skills/raced/notes.md');
    // The look sees a regular file; by the read, it is a link out of the folder.
    const regular = fs.lstatSync(raced);
    fs.rmSync(raced);
    fs.symlinkSync(path.join(outside, 'secret.md'), raced);
    const realLstat = fs.promises.lstat.bind(fs.promises);
    const lstat = vi
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (file, ...rest) =>
        String(file) === raced ? regular : realLstat(file, ...(rest as [])),
      );
    try {
      const { files } = await new FactoryFolder(dir).read();
      const entry = files.skills.raced.find((candidate) => candidate.path === 'notes.md');
      expect(entry).toEqual({ path: 'notes.md', kind: 'symlink' });
    } finally {
      lstat.mockRestore();
    }
  });

  it('skills: never through a symlink, and no further than the limits', async () => {
    const dir = tmp();
    const outside = tmp('factory-outside-');
    layout(outside, { 'secret.md': 'not for the skill' });
    layout(dir, { 'skills/linked/SKILL.md': SKILL });
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'skills/linked/secret.md'));
    fs.symlinkSync(outside, path.join(dir, 'skills/linked/refs'));
    execFileSync('mkfifo', [path.join(dir, 'skills/linked/pipe')]);
    const many: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1)
      many[`skills/many/f${String(index).padStart(3, '0')}.md`] = 'x';
    layout(dir, many);
    const mebibyte = new Uint8Array(1024 * 1024).fill(0x61);
    layout(dir, {
      'skills/large/SKILL.md': SKILL,
      'skills/large/a.bin': mebibyte,
      'skills/large/b.bin': mebibyte,
      'skills/large/c.bin': mebibyte,
      'skills/large/d.bin': mebibyte,
    });
    // A socket: neither a file nor a link, and never opened.
    const socket = net.createServer();
    await new Promise<void>((resolve) =>
      socket.listen(path.join(dir, 'skills/linked/socket'), resolve),
    );
    onTestFinished(() => new Promise<void>((resolve) => socket.close(() => resolve())));
    fs.symlinkSync(outside, path.join(dir, 'skills/elsewhere'));

    const { files } = await new FactoryFolder(dir).read();
    expect(files.skills.linked).toEqual([
      { path: 'SKILL.md', bytes: expect.any(Uint8Array) },
      { path: 'pipe', kind: 'special' },
      { path: 'refs', kind: 'symlink' },
      { path: 'secret.md', kind: 'symlink' },
      { path: 'socket', kind: 'special' },
    ]);
    expect(files.skills.many).toHaveLength(101);
    expect(files.skills.many[100].path).toBe('f100.md');
    // Past 2 MB the read stops: b.bin is read one byte past it, which says "over", and the rest is never reached.
    expect(files.skills.large.map((entry) => entry.path)).toEqual(['SKILL.md', 'a.bin', 'b.bin']);
    const total = files.skills.large.reduce((sum, entry) => sum + bytesOf(entry), 0);
    expect(total).toBeGreaterThan(MAX_SKILL_BYTES);
    expect(total).toBeLessThanOrEqual(MAX_SKILL_BYTES + 1);
    // A skill folder that is itself a link is not followed: it is no skill folder.
    expect(Object.keys(files.skills)).not.toContain('elsewhere');
    expect(files.stray).toEqual(['skills/elsewhere']);
  });

  it('texts: a leading byte-order mark is removed, line endings kept', async () => {
    const dir = tmp();
    layout(dir, {
      'agents/investigator.md': `﻿${AGENT.replace(/\n/g, '\r\n')}`,
      'factory.yml': `﻿${FACTORY}`,
    });
    const { files } = await new FactoryFolder(dir).read();
    expect(files.agents.investigator).toBe(AGENT.replace(/\n/g, '\r\n'));
    expect(files.factoryYml).toBe(FACTORY);
  });

  // The conductor's ruling on review S3: a file whose real path leaves the folder's is never read.
  it('a linked workspace folder is read whole; a file linking out of it is not read (review S3)', async () => {
    const dotfiles = tmp('factory-dotfiles-');
    layout(dotfiles, {
      'consola/factory.yml': FACTORY,
      'consola/automations/investigate-alerts.yaml': ENTRY,
      'consola/shared/summariser.md': `${AGENT}Summarise.\n`,
      'investigator.md': AGENT,
      'factory.yml': `${FACTORY}# from dotfiles\n`,
    });
    fs.mkdirSync(path.join(dotfiles, 'consola/agents'));
    fs.symlinkSync(
      path.join(dotfiles, 'investigator.md'),
      path.join(dotfiles, 'consola/agents/investigator.md'),
    );
    // A link that stays inside the folder is read through.
    fs.symlinkSync('../shared/summariser.md', path.join(dotfiles, 'consola/agents/summariser.md'));
    const link = path.join(tmp(), 'workspace');
    fs.symlinkSync(path.join(dotfiles, 'consola'), link);
    const { files } = await new FactoryFolder(link).read();
    expect(files.factoryYml).toBe(FACTORY);
    expect(files.automations).toEqual({ 'investigate-alerts': ENTRY });
    expect(files.agents).toEqual({ summariser: `${AGENT}Summarise.\n` });
    expect(files.outside).toEqual(['agents/investigator.md']);

    const plain = tmp();
    fs.symlinkSync(path.join(dotfiles, 'factory.yml'), path.join(plain, 'factory.yml'));
    const read = await new FactoryFolder(plain).read();
    expect(read.exists).toBe(true);
    expect(read.files.factoryYml).toBeNull();
    expect(read.files.outside).toEqual(['factory.yml']);
    expect(read.files.unread).toEqual([]);
  });

  it('reads environments/ as it reads agents/: <name>.yaml, strays, no link outside (slice 3-B)', async () => {
    const outside = tmp('factory-outside-');
    layout(outside, { 'out.yaml': 'isolation: host\n' });
    const dir = tmp();
    layout(dir, {
      'factory.yml': FACTORY,
      'environments/sandboxed.yaml': 'isolation: sandbox\n',
      'environments/notes.txt': 'notes',
      'environments/Big.yaml': 'isolation: host\n',
      'environments/.sandboxed.yaml.swp': 'an editor',
      'environments/sandboxed.yaml~': 'an editor',
    });
    fs.symlinkSync(path.join(outside, 'out.yaml'), path.join(dir, 'environments/out.yaml'));
    const { files } = await new FactoryFolder(dir).read();
    expect(files.environments).toEqual({ sandboxed: 'isolation: sandbox\n' });
    expect(files.stray).toEqual(['environments/Big.yaml', 'environments/notes.txt']);
    expect(files.outside).toEqual(['environments/out.yaml']);
    expect(files.laterFolders).toEqual([]);
    expect(new FactoryFolder(dir).pathOf('environments/sandboxed.yaml')).toBe(
      path.join(dir, 'environments/sandboxed.yaml'),
    );
  });

  it('an environments/ folder that links outside is not listed', async () => {
    const elsewhere = tmp('factory-elsewhere-');
    layout(elsewhere, { 'environments/sandboxed.yaml': 'isolation: sandbox\n' });
    const dir = tmp();
    layout(dir, { 'factory.yml': FACTORY });
    fs.symlinkSync(path.join(elsewhere, 'environments'), path.join(dir, 'environments'));
    const { files } = await new FactoryFolder(dir).read();
    expect(files.outside).toEqual(['environments/']);
    expect(files.environments).toEqual({});
  });

  it('a folder of the three that links outside is not listed (review S3)', async () => {
    const elsewhere = tmp('factory-elsewhere-');
    layout(elsewhere, {
      'agents/investigator.md': AGENT,
      'automations/investigate-alerts.yaml': ENTRY,
      'skills/incident-triage/SKILL.md': SKILL,
    });
    const dir = tmp();
    layout(dir, { 'factory.yml': FACTORY });
    for (const folder of ['agents', 'automations', 'skills'])
      fs.symlinkSync(path.join(elsewhere, folder), path.join(dir, folder));
    const { files } = await new FactoryFolder(dir).read();
    expect(files.outside).toEqual(['automations/', 'agents/', 'skills/']);
    expect(files.agents).toEqual({});
    expect(files.automations).toEqual({});
    expect(files.skills).toEqual({});
    expect(files.stray).toEqual([]);
  });

  it('a link whose target is gone is unread, not gone: the link says it is still meant (review M4)', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.symlinkSync(path.join(dir, 'nowhere.md'), path.join(dir, 'agents/investigator.md'));
    fs.symlinkSync(path.join(dir, 'nowhere.yml'), path.join(dir, 'factory.yml'));
    const { exists, files } = await new FactoryFolder(dir).read();
    expect(exists).toBe(true);
    expect(files.factoryYml).toBeNull();
    expect(files.agents).toEqual({});
    expect(files.unread).toEqual([
      { path: 'factory.yml', reason: 'its target is not there' },
      { path: 'agents/investigator.md', reason: 'its target is not there' },
    ]);
    // Deleting the link is deleting the file.
    fs.rmSync(path.join(dir, 'agents/investigator.md'));
    expect((await new FactoryFolder(dir).read()).files.unread).toEqual([
      { path: 'factory.yml', reason: 'its target is not there' },
    ]);
  });
});

describe('FactoryFolder.watch', () => {
  /** A folder with the four kinds, watched every 20 ms; `changes()` counts calls. */
  function watched(dir = tmp()) {
    if (!fs.existsSync(path.join(dir, 'factory.yml'))) layout(dir, { 'factory.yml': FACTORY });
    layout(dir, {
      'automations/investigate-alerts.yaml': ENTRY,
      'agents/investigator.md': AGENT,
      'skills/incident-triage/SKILL.md': SKILL,
    });
    const folder = new FactoryFolder(dir, 20);
    let count = 0;
    folder.watch(() => {
      count += 1;
    });
    onTestFinished(() => folder.unwatch());
    return { dir, folder, changes: () => count };
  }

  it('sees a write to an agent file', async () => {
    const { dir, changes } = watched();
    fs.writeFileSync(path.join(dir, 'agents/investigator.md'), `${AGENT}More.\n`);
    await eventually(() => changes() > 0);
  });

  it('sees factory.yml replaced by rename: a new inode, the same size and time', async () => {
    const dir = tmp();
    // The same bytes and the same time: only the inode tells the files apart.
    const at = 1_700_000_000;
    layout(dir, { 'factory.yml': FACTORY });
    fs.utimesSync(path.join(dir, 'factory.yml'), at, at);
    const { changes } = watched(dir);
    const next = path.join(dir, 'factory.yml.new');
    fs.writeFileSync(next, FACTORY);
    fs.utimesSync(next, at, at);
    fs.renameSync(next, path.join(dir, 'factory.yml'));
    await eventually(() => changes() > 0);
  });

  it('sees a new file in a skill', async () => {
    const { dir, changes } = watched();
    fs.writeFileSync(path.join(dir, 'skills/incident-triage/queries.md'), 'service:catalog\n');
    await eventually(() => changes() > 0);
  });

  it('sees an automation file deleted', async () => {
    const { dir, changes } = watched();
    fs.rmSync(path.join(dir, 'automations/investigate-alerts.yaml'));
    await eventually(() => changes() > 0);
  });

  it('sees a later folder appear', async () => {
    const { dir, changes } = watched();
    fs.mkdirSync(path.join(dir, 'evals'));
    await eventually(() => changes() > 0);
  });

  it('sees an environment file written (slice 3-B)', async () => {
    const { dir, changes } = watched();
    layout(dir, { 'environments/sandboxed.yaml': 'isolation: sandbox\n' });
    await eventually(() => changes() > 0);
  });

  it("a write under runs/, checks/, to a dotfile or an editor's leftover does not count", async () => {
    const { dir, changes } = watched();
    layout(dir, {
      'runs/r1/x': 'run state',
      'checks/c/stdout.log': 'a log',
      'agents/.investigator.md.swp': 'an editor',
      'agents/investigator.md~': 'an editor',
      'automations/#investigate-alerts.yaml#': 'an editor',
      'skills/incident-triage/SKILL.md~': 'an editor',
      'orchestrator.md': 'not read',
    });
    await pause(200);
    expect(changes()).toBe(0);
  });

  it('a skill is watched no further than it is read', async () => {
    const { dir, changes } = watched();
    const many: Record<string, string> = {};
    for (let index = 0; index < 150; index += 1)
      many[`skills/many/f${String(index).padStart(3, '0')}.md`] = 'x';
    layout(dir, many);
    await eventually(() => changes() === 1);
    // Past the first 101 entries the read stops, and so does the watch.
    fs.writeFileSync(path.join(dir, 'skills/many/f149.md'), 'changed');
    await pause(200);
    expect(changes()).toBe(1);
    fs.writeFileSync(path.join(dir, 'skills/many/f000.md'), 'changed');
    await eventually(() => changes() === 2);
  });

  it('after unwatch, nothing does', async () => {
    const { dir, folder, changes } = watched();
    // Watching twice is watching once: one unwatch ends it.
    folder.watch(() => {
      throw new Error('A second watch is not kept.');
    });
    folder.unwatch();
    fs.writeFileSync(path.join(dir, 'agents/investigator.md'), `${AGENT}More.\n`);
    await pause(200);
    expect(changes()).toBe(0);
  });

  it('watching through links inside the folder: an edit of a link target, a re-pointed link and a gone target', async () => {
    const dir = tmp();
    const dotfiles = path.join(dir, 'shared');
    layout(dotfiles, {
      'factory.yml': FACTORY,
      'investigator.md': AGENT,
      'other.md': `${AGENT}Other.\n`,
    });
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.symlinkSync(path.join(dotfiles, 'factory.yml'), path.join(dir, 'factory.yml'));
    const agentLink = path.join(dir, 'agents/investigator.md');
    fs.symlinkSync(path.join(dotfiles, 'investigator.md'), agentLink);
    const folder = new FactoryFolder(dir, 20);
    let count = 0;
    folder.watch(() => {
      count += 1;
    });
    onTestFinished(() => folder.unwatch());

    // The target written, the link untouched: a `git pull` in the dotfiles repository.
    fs.writeFileSync(path.join(dotfiles, 'factory.yml'), `${FACTORY}# pulled\n`);
    await eventually(() => count === 1);
    fs.writeFileSync(path.join(dotfiles, 'investigator.md'), `${AGENT}Pulled.\n`);
    await eventually(() => count === 2);
    // The link re-pointed.
    fs.rmSync(agentLink);
    fs.symlinkSync(path.join(dotfiles, 'other.md'), agentLink);
    await eventually(() => count === 3);
    // The target gone: the file went.
    fs.rmSync(path.join(dotfiles, 'other.md'));
    await eventually(() => count === 4);
    const { files } = await folder.read();
    expect(files.agents).toEqual({});
    expect(files.factoryYml).toBe(`${FACTORY}# pulled\n`);
    await pause(100);
    expect(count).toBe(4);
  });

  it('agrees with the read on a link outside: an edit of its target is not seen, re-pointing it is (review S3)', async () => {
    const elsewhere = tmp('factory-elsewhere-');
    layout(elsewhere, { 'investigator.md': AGENT, 'other.md': `${AGENT}Other.\n` });
    const dir = tmp();
    layout(dir, { 'factory.yml': FACTORY, 'shared/inside.md': AGENT });
    fs.mkdirSync(path.join(dir, 'agents'));
    const agentLink = path.join(dir, 'agents/investigator.md');
    fs.symlinkSync(path.join(elsewhere, 'investigator.md'), agentLink);
    const folder = new FactoryFolder(dir, 20);
    let count = 0;
    folder.watch(() => {
      count += 1;
    });
    onTestFinished(() => folder.unwatch());

    // What the read never reads cannot change what it reads.
    fs.writeFileSync(path.join(elsewhere, 'investigator.md'), `${AGENT}Pulled.\n`);
    await pause(150);
    expect(count).toBe(0);
    // Re-pointed to another file outside: still nothing read, but the link changed.
    fs.rmSync(agentLink);
    fs.symlinkSync(path.join(elsewhere, 'other.md'), agentLink);
    await eventually(() => count === 1);
    // Re-pointed inside: now it is read.
    fs.rmSync(agentLink);
    fs.symlinkSync(path.join(dir, 'shared/inside.md'), agentLink);
    await eventually(() => count === 2);
    expect((await folder.read()).files.agents).toEqual({ investigator: AGENT });
  });
});

describe('FactoryFolder writes', () => {
  const MORNING = `# Mine, by hand.
version: 1
automations:
  # Every morning.
  - name: morning # the first one
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
    mode: confirm
  # - name: someday
  #   on: { cron: "0 10 * * *" }
`;
  const namesIn = (yaml: string | null) => {
    const parsed = parseFactorySpec(yaml ?? '');
    expect(parsed.issues).toEqual([]);
    return parsed.automations.map((automation) => automation.name);
  };

  it('appendAutomation keeps comments and existing entries, and the entry loads', async () => {
    const dir = tmp();
    layout(dir, { 'factory.yml': MORNING });
    const folder = new FactoryFolder(dir);
    await folder.appendAutomation(assignedReviewsEntry());
    const written = fs.readFileSync(folder.filePath, 'utf8');
    for (const kept of [
      '# Mine, by hand.',
      '# Every morning.',
      '# the first one',
      '# - name: someday',
    ])
      expect(written).toContain(kept);
    expect(namesIn(await folder.readText())).toEqual(['morning', ASSIGNED_REVIEWS_NAME]);
  });

  it('appendAutomation fills an empty automations list', async () => {
    for (const empty of [
      'version: 1\nautomations:\n  # - name: someday\n  #   on: { cron: "0 10 * * *" }\n',
      'version: 1\nautomations: []\n',
    ]) {
      const dir = tmp();
      layout(dir, { 'factory.yml': empty });
      const folder = new FactoryFolder(dir);
      await folder.appendAutomation(assignedReviewsEntry());
      const written = fs.readFileSync(folder.filePath, 'utf8');
      if (empty.includes('someday')) expect(written).toContain('# - name: someday');
      expect(namesIn(written)).toEqual([ASSIGNED_REVIEWS_NAME]);
    }
  });

  it('appendAutomation leaves every other byte as it was', async () => {
    const original = `version: 1
automations:
    # Four spaces, a long flow map, and a quoted prompt that runs past eighty columns.
    -   name: sweep
        on: { cron: "0 9 * * *" }
        run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed], keep_branches: true } }
        mode: confirm
    -   name: summary
        on: { cron: "0 9 * * 1-5" }
        run: { prompt: "Use Consola's list_inbox tool to list my open pull requests and say which are blocked." }
        scope: api
    # - name: someday
`;
    const dir = tmp();
    layout(dir, { 'factory.yml': original });
    const folder = new FactoryFolder(dir);
    await folder.appendAutomation(assignedReviewsEntry());
    const written = fs.readFileSync(folder.filePath, 'utf8');
    const inserted = `${assignedReviewsEntry()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n`;
    expect(written.replace(inserted, '')).toBe(original);
    expect(written.indexOf(inserted)).toBeLessThan(written.indexOf('# - name: someday'));
    expect(namesIn(written)).toEqual(['sweep', 'summary', ASSIGNED_REVIEWS_NAME]);
  });

  it('appendAutomation writes through a symlinked factory.yml inside the folder, keeping the link', async () => {
    const workspace = tmp();
    const target = path.join(workspace, 'shared', 'factory.yml');
    layout(workspace, { 'shared/factory.yml': 'version: 1\nautomations: []\n' });
    fs.symlinkSync(target, path.join(workspace, 'factory.yml'));
    await new FactoryFolder(workspace).appendAutomation(assignedReviewsEntry());
    expect(fs.lstatSync(path.join(workspace, 'factory.yml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(`name: ${ASSIGNED_REVIEWS_NAME}`);
  });

  it('refuses to read or write through a link that leaves the folder, writing nothing (review S3)', async () => {
    const dir = tmp();
    const target = path.join(dir, 'dotfiles-factory.yml');
    const automation = path.join(dir, 'dotfiles-entry.yaml');
    fs.writeFileSync(target, TIDY);
    fs.writeFileSync(automation, ENTRY);
    const workspace = path.join(dir, 'ws');
    fs.mkdirSync(path.join(workspace, 'automations'), { recursive: true });
    fs.symlinkSync(target, path.join(workspace, 'factory.yml'));
    fs.symlinkSync(automation, path.join(workspace, 'automations/investigate-alerts.yaml'));
    const folder = new FactoryFolder(workspace);
    const outside = (file: string) =>
      `\`${file}\` links outside the factory folder; Consola reads only files inside it.`;
    await expect(folder.readText()).rejects.toThrow(outside('factory.yml'));
    await expect(folder.appendAutomation(assignedReviewsEntry())).rejects.toThrow(
      outside('factory.yml'),
    );
    await expect(
      folder.replaceAutomation(
        'tidy',
        '- name: tidy\n  on: { cron: "0 7 * * *" }\n  run: { tool: consola#cleanup_stale_sessions }',
      ),
    ).rejects.toThrow(outside('factory.yml'));
    await expect(folder.readAutomationFile('investigate-alerts')).rejects.toThrow(
      outside('automations/investigate-alerts.yaml'),
    );
    await expect(folder.writeAutomationFile('investigate-alerts', 'on: manual\n')).rejects.toThrow(
      outside('automations/investigate-alerts.yaml'),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe(TIDY);
    expect(fs.readFileSync(automation, 'utf8')).toBe(ENTRY);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'dotfiles-entry.yaml',
      'dotfiles-factory.yml',
      'ws',
    ]);
  });

  it('appendAutomation refuses a file that does not parse, leaving it as it was', async () => {
    const dir = tmp();
    const broken = 'version: 1\nautomations: [\n';
    layout(dir, { 'factory.yml': broken });
    const folder = new FactoryFolder(dir);
    await expect(folder.appendAutomation(assignedReviewsEntry())).rejects.toThrow(/does not parse/);
    expect(fs.readFileSync(folder.filePath, 'utf8')).toBe(broken);
  });

  const TIDY = `# Kept with my dotfiles.
version: 1
automations:
  # Every weekday.
  - name: tidy
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
  # - name: someday
`;

  it('replaceAutomation keeps a symlinked factory.yml a link, and every byte outside the entry', async () => {
    const workspace = tmp();
    const dir = path.join(workspace, 'shared');
    const target = path.join(dir, 'dotfiles-factory.yml');
    layout(dir, { 'dotfiles-factory.yml': TIDY });
    const link = path.join(workspace, 'factory.yml');
    fs.symlinkSync(target, link);
    const folder = new FactoryFolder(workspace);
    expect(await folder.readText()).toBe(TIDY);

    await folder.replaceAutomation(
      'tidy',
      '- name: tidy\n  on: { cron: "0 7 * * 1-5" }\n  run: { tool: consola#cleanup_stale_sessions }\n  mode: confirm',
    );
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(
      TIDY.replace(
        '    on: { cron: "0 9 * * *" }\n    run: { tool: consola#cleanup_stale_sessions }\n',
        '    on: { cron: "0 7 * * 1-5" }\n    run: { tool: consola#cleanup_stale_sessions }\n    mode: confirm\n',
      ),
    );
    expect(fs.readdirSync(dir).sort()).toEqual(['dotfiles-factory.yml']);
    expect(fs.readdirSync(workspace).sort()).toEqual(['factory.yml', 'shared']);
  });

  it('replaceAutomation refuses a name that is not in the file, leaving it as it was', async () => {
    const dir = tmp();
    layout(dir, { 'factory.yml': TIDY });
    const folder = new FactoryFolder(dir);
    await expect(
      folder.replaceAutomation(
        'gone',
        '- name: gone\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }',
      ),
    ).rejects.toThrow(/no automation named "gone"/);
    expect(fs.readFileSync(folder.filePath, 'utf8')).toBe(TIDY);
  });

  it('readText is null when there is no factory.yml yet', async () => {
    expect(await new FactoryFolder(tmp()).readText()).toBeNull();
  });

  it('ensureExists makes the folder and factory.yml from the template, once', async () => {
    const dir = path.join(tmp(), 'ws-1');
    const folder = new FactoryFolder(dir);
    expect(await folder.ensureExists(FACTORY)).toBe(path.join(dir, 'factory.yml'));
    expect(fs.readFileSync(path.join(dir, 'factory.yml'), 'utf8')).toBe(FACTORY);
    fs.writeFileSync(path.join(dir, 'factory.yml'), TIDY);
    expect(await folder.ensureExists(FACTORY)).toBe(path.join(dir, 'factory.yml'));
    expect(fs.readFileSync(path.join(dir, 'factory.yml'), 'utf8')).toBe(TIDY);
  });

  it('writeAutomationFile creates automations/, replaces whole and leaves no temporary file', async () => {
    const dir = tmp();
    const folder = new FactoryFolder(dir);
    await folder.writeAutomationFile('investigate-alerts', ENTRY);
    expect(fs.readFileSync(path.join(dir, 'automations/investigate-alerts.yaml'), 'utf8')).toBe(
      ENTRY,
    );
    await folder.writeAutomationFile('investigate-alerts', 'on: { cron: "0 7 * * *" }\n');
    expect(fs.readFileSync(path.join(dir, 'automations/investigate-alerts.yaml'), 'utf8')).toBe(
      'on: { cron: "0 7 * * *" }\n',
    );
    expect(fs.readdirSync(path.join(dir, 'automations'))).toEqual(['investigate-alerts.yaml']);
  });

  it("a write's temporary file is a dotfile, which the read and the watch leave out", async () => {
    const dir = tmp();
    layout(dir, { 'factory.yml': FACTORY });
    const rename = vi.spyOn(fs.promises, 'rename');
    onTestFinished(() => rename.mockRestore());
    const folder = new FactoryFolder(dir);
    await folder.writeAutomationFile('investigate-alerts', ENTRY);
    await folder.appendAutomation(assignedReviewsEntry());
    expect(rename).toHaveBeenCalledTimes(2);
    for (const [from] of rename.mock.calls) expect(path.basename(String(from))).toMatch(/^\./);
  });

  it('writeAutomationFile writes through a symlink inside the folder, keeping the link', async () => {
    const dir = tmp();
    const dotfiles = path.join(dir, 'shared');
    layout(dotfiles, { 'investigate-alerts.yaml': ENTRY });
    fs.mkdirSync(path.join(dir, 'automations'));
    const link = path.join(dir, 'automations/investigate-alerts.yaml');
    fs.symlinkSync(path.join(dotfiles, 'investigate-alerts.yaml'), link);
    await new FactoryFolder(dir).writeAutomationFile('investigate-alerts', 'on: manual\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dotfiles, 'investigate-alerts.yaml'), 'utf8')).toBe(
      'on: manual\n',
    );
    expect(fs.readdirSync(dotfiles)).toEqual(['investigate-alerts.yaml']);
  });

  it('writeAutomationFile refuses a name that is no name, writing nothing', async () => {
    const dir = tmp();
    const folder = new FactoryFolder(dir);
    await expect(folder.writeAutomationFile('../escape', ENTRY)).rejects.toThrow(
      /Not an automation name/,
    );
    await expect(folder.writeAutomationFile('Upper', ENTRY)).rejects.toThrow(
      /Not an automation name/,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('whereIs: factory.yml first, then its own file, else nowhere', async () => {
    const dir = tmp();
    layout(dir, {
      'factory.yml': TIDY,
      'automations/tidy.yaml': ENTRY,
      'automations/investigate-alerts.yaml': ENTRY,
    });
    const folder = new FactoryFolder(dir);
    expect(await folder.whereIs('tidy')).toBe('factory.yml');
    expect(await folder.whereIs('investigate-alerts')).toBe('file');
    expect(await folder.whereIs('nope')).toBeNull();
    expect(await new FactoryFolder(tmp()).whereIs('tidy')).toBeNull();
  });

  it('readAutomationFile reads one, or gives null', async () => {
    const dir = tmp();
    layout(dir, { 'automations/investigate-alerts.yaml': `﻿${ENTRY}` });
    const folder = new FactoryFolder(dir);
    expect(await folder.readAutomationFile('investigate-alerts')).toBe(ENTRY);
    expect(await folder.readAutomationFile('nope')).toBeNull();
  });
});

describe('FactoryFolder.pathOf', () => {
  const folder = new FactoryFolder('/home/alice/.consola/workspaces/ws-1');

  it.each([
    'factory.yml',
    'automations/x.yaml',
    'agents/x.md',
    'skills/x/SKILL.md',
    'environments/sandboxed.yaml',
  ])('gives %s inside the folder', (relative) => {
    expect(folder.pathOf(relative)).toBe(`/home/alice/.consola/workspaces/ws-1/${relative}`);
  });

  it.each([
    '../x',
    'runs/a',
    'agents/X.md',
    'agents/x.txt',
    'skills/x/other.md',
    '/etc/passwd',
    'factory.yml/..',
    'agents/../factory.yml',
    'automations/x.yml',
    'agents/.hidden.md',
    'environments/a/b.yaml',
    'environments/x.yml',
    'environments/.x.yaml',
    'environments/X.yaml',
    '',
  ])('refuses %j', (relative) => {
    expect(folder.pathOf(relative)).toBeNull();
  });
});
