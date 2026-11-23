import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDefinition } from '../steps/definition';
import type { StepTurnFile } from '../views';
import { RunFolder } from './runFolder';

describe('RunFolder', () => {
  let tmp: string;
  let folder: RunFolder;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-folder-'));
    folder = new RunFolder((workspaceId) => path.join(tmp, workspaceId));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes and reads a definition', () => {
    expect(folder.readDefinition('ws', 'r1')).toBeNull();
    const definition = {
      automation: { name: 'a', steps: [] },
      version: 'v1',
      actions: { review: { name: 'x', body: 'b' } },
    } as unknown as RunDefinition;
    folder.writeDefinition('ws', 'r1', definition);
    expect(folder.readDefinition('ws', 'r1')).toEqual(definition);
  });

  it("keeps each attempt's artifacts apart", () => {
    folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'first');
    folder.writeArtifact('ws', 'r1', 'review', 2, 'handover', 'second');
    expect(folder.readArtifact('ws', 'r1', 'review', 1, 'handover')).toBe('first');
    expect(folder.readArtifact('ws', 'r1', 'review', 2, 'handover')).toBe('second');
    expect(folder.artifactPath('ws', 'r1', 'review', 2, 'handover')).toMatch(
      /review[\\/]2[\\/]handover\.md$/,
    );
  });

  it('maps the output artifact to its format', () => {
    folder.writeArtifact('ws', 'r1', 'review', 1, 'output', '{"a":1}', 'json');
    expect(folder.artifactPath('ws', 'r1', 'review', 1, 'output', 'json')).toMatch(/output\.json$/);
    expect(folder.readArtifact('ws', 'r1', 'review', 1, 'output')).toBe('{"a":1}');
    folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'hi', 'text');
    expect(folder.readArtifact('ws', 'r1', 'other', 1, 'output')).toBe('hi');
    expect(() => folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'hi')).toThrow(/format/);
    expect(() =>
      folder.writeArtifact('ws', 'r1', 'other', 1, 'output', 'x'.repeat(256 * 1024 + 1), 'text'),
    ).toThrow(/256 KB/);
  });

  it('refuses a path component that is not a token', () => {
    expect(() => folder.writeDefinition('ws', '../x', {} as RunDefinition)).toThrow();
    expect(() => folder.writeArtifact('ws', 'r1', '../x', 1, 'handover', 'a')).toThrow();
    expect(() => folder.writeArtifact('ws', 'r1', 'review', 1, '../x', 'a')).toThrow();
    expect(() => folder.runDir('../ws', 'r1')).toThrow();
    expect(() => folder.attemptDir('ws', 'r1', 'review', 0)).toThrow();
    expect(() => folder.attemptDir('ws', 'r1', 'review', 1.5)).toThrow();
    expect(() =>
      folder.writeJson(folder.attemptDir('ws', 'r1', 'review', 1), '../x' as 'command.json', {}),
    ).toThrow();
    expect(folder.attemptDir('ws', 'r1', 'step-3', 1)).toMatch(/step-3[\\/]1$/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('refuses an artifact over 256 KB, leaving the old one', () => {
    folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', '0123456789');
    expect(() =>
      folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x'.repeat(256 * 1024 + 1)),
    ).toThrow(/256 KB/);
    expect(folder.readArtifact('ws', 'r1', 'review', 1, 'handover')).toBe('0123456789');
  });

  it('writes command.json and outputs.json', () => {
    const dir = folder.attemptDir('ws', 'r1', 'review', 1);
    folder.writeJson(dir, 'outputs.json', { a: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'outputs.json'), 'utf8'))).toEqual({ a: 1 });
  });

  it("writes a call's call.json and result.json beside them (5a-2)", () => {
    const dir = folder.attemptDir('ws', 'r1', 'post', 1);
    folder.writeJson(dir, 'call.json', { tool: 'chat_post_message' });
    folder.writeJson(dir, 'result.json', { isError: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'call.json'), 'utf8'))).toEqual({
      tool: 'chat_post_message',
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'))).toEqual({
      isError: false,
    });
    expect(() => folder.writeJson(dir, 'server.log' as 'call.json', {})).toThrow(/Not a run file/);
  });

  describe('turn.json', () => {
    const turn = (exitCode: number): StepTurnFile => ({
      endedAt: '2026-11-16T09:05:00.000Z',
      exitCode,
      maxTurns: 6,
      init: { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
      result: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123 },
      otherLines: ['Warning: x'],
    });
    const file = () => path.join(folder.attemptDir('ws', 'r1', 'review', 1), 'turn.json');

    it("appendTurn writes turn.json in the attempt's folder and appends to it", () => {
      folder.appendTurn('ws', 'r1', 'review', 1, turn(0));
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ turns: [turn(0)] });
      folder.appendTurn('ws', 'r1', 'review', 1, turn(1));
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ turns: [turn(0), turn(1)] });
      // Another attempt's folder has its own.
      folder.appendTurn('ws', 'r1', 'review', 2, turn(2));
      expect(JSON.parse(fs.readFileSync(file(), 'utf8')).turns).toHaveLength(2);
    });

    it('a damaged turn.json is replaced by one holding the new turn', () => {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), 'not json');
      folder.appendTurn('ws', 'r1', 'review', 1, turn(0));
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ turns: [turn(0)] });
      fs.writeFileSync(file(), '{"turns": "not a list"}');
      folder.appendTurn('ws', 'r1', 'review', 1, turn(1));
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ turns: [turn(1)] });
    });

    it('refuses a step id that is not a token', () => {
      expect(() => folder.appendTurn('ws', 'r1', '../x', 1, turn(0))).toThrow(/step id/);
      expect(() => folder.appendTurn('ws', '../r', 'review', 1, turn(0))).toThrow(/run id/);
      expect(() => folder.appendTurn('ws', 'r1', 'review', 0, turn(0))).toThrow(/attempt/);
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  it('tails a log', () => {
    const file = path.join(folder.attemptDir('ws', 'r1', 'review', 1), 'stdout.log');
    folder.ensureEmptyFile(file);
    fs.writeFileSync(file, `${'a'.repeat(36 * 1024)}${'b'.repeat(64 * 1024)}`);
    const tail = folder.tail(file)!;
    expect(tail.truncated).toBe(true);
    expect(tail.text).toBe('b'.repeat(64 * 1024));
    expect(tail.bytes).toBe(100 * 1024);
    expect(folder.tail(file, 1024 * 1024)!.truncated).toBe(false);
    expect(folder.tail(path.join(folder.runDir('ws', 'r1'), 'missing'))).toBeNull();
  });

  it('readText returns null for a missing file and throws past maxBytes', () => {
    const file = path.join(folder.runDir('ws', 'r1'), 'f.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(folder.readText(file, 10)).toBeNull();
    fs.writeFileSync(file, '12345678901');
    expect(() => folder.readText(file, 10)).toThrow(/most read is 10/);
    expect(folder.readText(file, 11)).toBe('12345678901');
  });

  it('ensureEmptyFile creates a missing file with its folder and empties an existing one', () => {
    const file = path.join(folder.runDir('ws', 'r1'), 'deep', 'er', 'f.log');
    folder.ensureEmptyFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    fs.writeFileSync(file, 'data');
    folder.ensureEmptyFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('exists', () => {
    const file = path.join(folder.runDir('ws', 'r1'), 'f');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(folder.exists(file)).toBe(false);
    fs.writeFileSync(file, '');
    expect(folder.exists(file)).toBe(true);
  });

  it("sweeps runs history no longer names, never another workspace's", () => {
    for (const run of ['keep', 'drop'])
      folder.writeArtifact('ws', run, 'review', 1, 'handover', 'x');
    folder.writeArtifact('other', 'drop', 'review', 1, 'handover', 'x');
    folder.sweep('ws', new Set(['keep']));
    expect(fs.readdirSync(path.join(tmp, 'ws', 'runs'))).toEqual(['keep']);
    expect(fs.existsSync(path.join(tmp, 'other', 'runs', 'drop'))).toBe(true);
    expect(() => folder.sweep('never', new Set())).not.toThrow();
  });

  it('removeAll leaves factory.yml beside runs/', () => {
    fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ws', 'factory.yml'), 'automations: []');
    folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x');
    folder.removeAll('ws');
    expect(fs.readdirSync(path.join(tmp, 'ws'))).toEqual(['factory.yml']);
  });

  const BAD = ['.', '..', '../x', 'a/b', '/abs/path', 'a\0b', ''];

  it.each(BAD)('refuses %j as a workspace id, run id, step id and artifact name', (bad) => {
    expect(() => folder.runDir(bad, 'r1')).toThrow();
    expect(() => folder.runDir('ws', bad)).toThrow();
    expect(() => folder.attemptDir('ws', 'r1', bad, 1)).toThrow();
    expect(() => folder.readArtifact('ws', 'r1', 'review', 1, bad)).toThrow();
    expect(() => folder.artifactPath('ws', 'r1', 'review', 1, bad)).toThrow();
    expect(() => folder.writeArtifact('ws', 'r1', 'review', 1, bad, 'x')).toThrow();
  });

  it('confines the path-taking methods to runs/', () => {
    const inside = path.join(folder.attemptDir('ws', 'r1', 'review', 1), 'stdout.log');
    const outside = [
      path.join(tmp, 'ws', 'factory.yml'),
      path.join(tmp, 'ws', 'runs-evil', 'x'),
      path.join(tmp, 'ws', 'runs'),
      path.join(tmp, 'ws', 'runs', '..', 'factory.yml'),
      path.join(tmp, '..', 'x'),
      '/etc/passwd',
      '',
    ];
    const calls: Array<(p: string) => unknown> = [
      (p) => folder.tail(p),
      (p) => folder.readText(p, 10),
      (p) => folder.ensureEmptyFile(p),
      (p) => folder.exists(p),
      (p) => folder.writeJson(p, 'command.json', {}),
      (p) => folder.writeJson(p, 'call.json', {}),
      (p) => folder.writeJson(p, 'result.json', {}),
      (p) => folder.writeText(p, 'x'),
    ];
    for (const call of calls) {
      for (const bad of outside) expect(() => call(bad), bad).toThrow();
    }
    fs.mkdirSync(path.join(tmp, 'ws', 'runs-evil'), { recursive: true });
    expect(fs.readdirSync(path.join(tmp, 'ws', 'runs-evil'))).toEqual([]);
    folder.ensureEmptyFile(inside);
    expect(folder.exists(inside)).toBe(true);
    expect(folder.tail(inside)).not.toBeNull();
    expect(folder.readText(inside, 10)).toBe('');
    folder.writeJson(path.dirname(inside), 'command.json', {});
  });

  it("replaces a file's text inside runs/, whole", () => {
    const file = path.join(folder.attemptDir('ws', 'r1', 'page', 1), 'outputs.env');
    folder.ensureEmptyFile(file);
    fs.writeFileSync(file, 'note=stub-pager-secret\n');
    folder.writeText(file, 'note=***\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('note=***\n');
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves nothing half-written when a write fails', () => {
    const definition = { automation: {}, version: 'v', actions: {} } as unknown as RunDefinition;
    // definition.json is a folder with something in it: the rename onto it fails.
    const target = path.join(folder.runDir('ws', 'r1'), 'definition.json');
    fs.mkdirSync(path.join(target, 'inside'), { recursive: true });
    expect(() => folder.writeDefinition('ws', 'r1', definition)).toThrow();
    expect(fs.readdirSync(folder.runDir('ws', 'r1'))).toEqual(['definition.json']);
  });

  it('refuses a definition over its cap on write', () => {
    const big = {
      automation: {},
      version: 'v',
      actions: { a: { name: 'n', body: 'x'.repeat(16 * 1024 * 1024) } },
    } as unknown as RunDefinition;
    expect(() => folder.writeDefinition('ws', 'r1', big)).toThrow(/16 MB/);
    expect(folder.readDefinition('ws', 'r1')).toBeNull();
  });

  describe('checks and the polled item', () => {
    it("checkFiles puts a check's logs under checks/<automation>/", () => {
      const files = folder.checkFiles('ws', 'review-prs');
      expect(files.stdout).toBe(path.join(tmp, 'ws', 'checks', 'review-prs', 'stdout.log'));
      expect(files.stderr).toBe(path.join(tmp, 'ws', 'checks', 'review-prs', 'stderr.log'));
      folder.ensureEmptyFile(files.stdout);
      expect(folder.readText(files.stdout, 10)).toBe('');
    });

    it('checkFiles refuses a name that is not a token', () => {
      for (const bad of ['../x', 'a/b', '', 'A', '.', '-x'])
        expect(() => folder.checkFiles('ws', bad)).toThrow();
      expect(() => folder.checkFiles('../ws', 'a')).toThrow();
      expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
    });

    it('confine still refuses checks-evil and runs-evil', () => {
      for (const dir of ['checks-evil', 'runs-evil', 'checks']) {
        expect(() => folder.readText(path.join(tmp, 'ws', dir, 'x'), 10)).toThrow(
          /Outside the run folder/,
        );
      }
      expect(() =>
        folder.readText(path.join(tmp, 'ws', 'checks', '..', 'factory.yml'), 10),
      ).toThrow(/Outside the run folder/);
    });

    it('writeItem and readItem round-trip an object; readItem is null when there is none', () => {
      expect(folder.readItem('ws', 'r1')).toBeNull();
      const item = { id: 7, title: 'Add retries', nested: { a: [1, 2] } };
      folder.writeItem('ws', 'r1', item);
      expect(folder.readItem('ws', 'r1')).toEqual(item);
      expect(fs.readdirSync(folder.runDir('ws', 'r1'))).toEqual(['item.json']);
    });

    it('latestAttempt is the highest numbered folder, null when the step has none', () => {
      expect(folder.latestAttempt('ws', 'r1', 'review')).toBeNull();
      for (const attempt of [1, 2, 10])
        folder.writeArtifact('ws', 'r1', 'review', attempt, 'handover', 'x');
      expect(folder.latestAttempt('ws', 'r1', 'review')).toBe(10);
      expect(folder.latestAttempt('ws', 'r1', 'other')).toBeNull();
    });

    it('itemPath is runs/<run>/item.json', () => {
      expect(folder.itemPath('ws', 'r1')).toBe(path.join(tmp, 'ws', 'runs', 'r1', 'item.json'));
    });

    it('sweep leaves checks/ alone', () => {
      folder.ensureEmptyFile(folder.checkFiles('ws', 'a').stdout);
      folder.writeArtifact('ws', 'drop', 'review', 1, 'handover', 'x');
      folder.sweep('ws', new Set());
      expect(fs.existsSync(folder.checkFiles('ws', 'a').stdout)).toBe(true);
    });

    it('sweepChecks removes the folders of names not kept, and nothing under runs/', () => {
      for (const name of ['keep', 'drop'])
        folder.ensureEmptyFile(folder.checkFiles('ws', name).stdout);
      folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x');
      folder.sweepChecks('ws', new Set(['keep']));
      expect(fs.readdirSync(path.join(tmp, 'ws', 'checks'))).toEqual(['keep']);
      expect(fs.existsSync(path.join(tmp, 'ws', 'runs', 'r1'))).toBe(true);
      expect(() => folder.sweepChecks('never', new Set())).not.toThrow();
    });

    it('removeAll removes runs/ and checks/, and leaves factory.yml', () => {
      fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'ws', 'factory.yml'), 'automations: []');
      folder.writeArtifact('ws', 'r1', 'review', 1, 'handover', 'x');
      folder.ensureEmptyFile(folder.checkFiles('ws', 'a').stdout);
      folder.removeAll('ws');
      expect(fs.readdirSync(path.join(tmp, 'ws'))).toEqual(['factory.yml']);
    });

    it('workspaceDir is the folder factory.yml is in', () => {
      expect(folder.workspaceDir('ws')).toBe(path.join(tmp, 'ws'));
      expect(() => folder.workspaceDir('../x')).toThrow();
    });
  });

  describe("the run's own copy of its skills (2-C)", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    /** Not UTF-8: a PNG's signature and bytes no text decoder keeps. */
    const BLOB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    const TRIAGE = [
      { path: 'refs/queries.md', bytes: bytes('Use rate() over five minutes.\n') },
      { path: 'SKILL.md', bytes: bytes('---\nname: incident-triage\n---\nCheck the alert.\n') },
      { path: 'blob.bin', bytes: BLOB },
      // Beside the folder `refs`: by path it comes first, though a walk reaches the folder first.
      { path: 'refs.md', bytes: bytes('See refs/.\n') },
    ];

    it('skillsDir is <run dir>/skills', () => {
      expect(folder.skillsDir('ws', 'r1')).toBe(path.join(folder.runDir('ws', 'r1'), 'skills'));
      expect(() => folder.skillsDir('ws', '../r1')).toThrow();
    });

    it('writeSkills then readSkills gives every file back, binaries too, sorted by path', () => {
      folder.writeSkills('ws', 'r1', {
        'incident-triage': TRIAGE,
        'release-notes': [{ path: 'SKILL.md', bytes: bytes('Short lines.\n') }],
      });
      const read = folder.readSkills('ws', 'r1', ['incident-triage', 'release-notes']);
      expect(read['incident-triage']?.map((file) => file.path)).toEqual([
        'SKILL.md',
        'blob.bin',
        'refs.md',
        'refs/queries.md',
      ]);
      expect(read['incident-triage']?.[1].bytes).toEqual(BLOB);
      expect(new TextDecoder().decode(read['release-notes']?.[0].bytes)).toBe('Short lines.\n');
      expect(
        fs.readFileSync(path.join(folder.skillsDir('ws', 'r1'), 'incident-triage', 'blob.bin')),
      ).toEqual(Buffer.from(BLOB));
      // Only what is asked for is read.
      expect(Object.keys(folder.readSkills('ws', 'r1', ['release-notes']))).toEqual([
        'release-notes',
      ]);
    });

    it('refuses a name or a path that is no token, writing nothing', () => {
      const one = [{ path: 'SKILL.md', bytes: bytes('x') }];
      const refused: Array<Record<string, Array<{ path: string; bytes: Uint8Array }>>> = [
        { '../x': one },
        { 'Incident Triage': one },
        { 'incident-triage': [{ path: '../SKILL.md', bytes: bytes('x') }] },
        { 'incident-triage': [{ path: '/etc/SKILL.md', bytes: bytes('x') }] },
        { 'incident-triage': [{ path: 'refs/./a.md', bytes: bytes('x') }] },
        { 'incident-triage': [{ path: 'refs\\a.md', bytes: bytes('x') }] },
        { 'incident-triage': [{ path: '', bytes: bytes('x') }] },
        // A good skill beside a bad one: the good one is not written either.
        { 'release-notes': one, 'incident-triage': [{ path: 'a/../../b', bytes: bytes('x') }] },
      ];
      for (const skills of refused) {
        expect(
          () => folder.writeSkills('ws', 'r1', skills),
          JSON.stringify(Object.keys(skills)),
        ).toThrow(/not a path inside a skill|Not a skill name/);
      }
      expect(fs.existsSync(folder.skillsDir('ws', 'r1'))).toBe(false);
      expect(() => folder.readSkills('ws', 'r1', ['../x'])).toThrow(/Not a skill name/);
    });

    it('a missing skill, or a run with no copy, reads as null', () => {
      expect(folder.readSkills('ws', 'r1', ['incident-triage'])).toEqual({
        'incident-triage': null,
      });
      folder.writeSkills('ws', 'r1', { 'incident-triage': TRIAGE });
      expect(folder.readSkills('ws', 'r1', ['incident-triage', 'release-notes'])).toMatchObject({
        'release-notes': null,
      });
    });

    it('a skill holding a link, or one that is a link or a file, reads as null', () => {
      folder.writeSkills('ws', 'r1', {
        'incident-triage': TRIAGE,
        'release-notes': [{ path: 'SKILL.md', bytes: bytes('Short lines.\n') }],
      });
      const dir = folder.skillsDir('ws', 'r1');
      const outside = path.join(tmp, 'outside.md');
      fs.writeFileSync(outside, 'Use rate() over five minutes.\n');
      // An identical copy, through a link: the bytes would hash the same, and it is still refused.
      fs.rmSync(path.join(dir, 'incident-triage', 'refs', 'queries.md'));
      fs.symlinkSync(outside, path.join(dir, 'incident-triage', 'refs', 'queries.md'));
      fs.rmSync(path.join(dir, 'release-notes'), { recursive: true });
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dir, 'release-notes'));
      fs.mkdirSync(path.join(tmp, 'elsewhere'));
      fs.writeFileSync(path.join(tmp, 'elsewhere', 'SKILL.md'), 'Short lines.\n');
      fs.writeFileSync(path.join(dir, 'plain-file'), 'x');
      expect(
        folder.readSkills('ws', 'r1', ['incident-triage', 'release-notes', 'plain-file']),
      ).toEqual({
        'incident-triage': null,
        'release-notes': null,
        'plain-file': null,
      });
    });

    it('a skills folder that is a link reads every skill as null', () => {
      const elsewhere = path.join(tmp, 'elsewhere');
      fs.mkdirSync(path.join(elsewhere, 'incident-triage'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'incident-triage', 'SKILL.md'), 'x');
      fs.mkdirSync(folder.runDir('ws', 'r1'), { recursive: true });
      fs.symlinkSync(elsewhere, folder.skillsDir('ws', 'r1'));
      expect(folder.readSkills('ws', 'r1', ['incident-triage'])).toEqual({
        'incident-triage': null,
      });
    });

    it('writing again replaces the copy whole', () => {
      folder.writeSkills('ws', 'r1', { 'incident-triage': TRIAGE });
      folder.writeSkills('ws', 'r1', {
        'release-notes': [{ path: 'SKILL.md', bytes: bytes('Short lines.\n') }],
      });
      expect(fs.readdirSync(folder.skillsDir('ws', 'r1'))).toEqual(['release-notes']);
      expect(fs.readdirSync(folder.runDir('ws', 'r1'))).toEqual(['skills']);
    });
  });
});
