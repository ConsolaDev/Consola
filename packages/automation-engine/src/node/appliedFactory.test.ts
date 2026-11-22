import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skillHash } from '@consola/factory-spec';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AppliedFactory, AppliedSkill } from '../ports';
import { AppliedFactoryFiles } from './appliedFactory';

// (vi.mock is hoisted above the imports.) `renameSync` passes through, so one test can fail a rename.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync = vi.fn((from: fs.PathLike, to: fs.PathLike) => actual.renameSync(from, to));
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-applied-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FOLDER = '/home/alice/.consola/workspaces/ws-1';
const keyOf = (folder: string) =>
  createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 16);

const APPLIED: AppliedFactory = {
  folder: FOLDER,
  appliedAt: '2026-11-22T08:00:00.000Z',
  clean: true,
  texts: {
    'factory.yml': 'version: 1\nautomations: []\n',
    'automations/catalog-review.yaml': 'on: manual\nsteps:\n  - agent: reviewer\n',
    'agents/reviewer.md': 'You review.\n',
  },
};

describe('AppliedFactoryFiles', () => {
  it('reads null for a folder never written, and logs nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    expect(new AppliedFactoryFiles(tmp()).read(FOLDER)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('round-trips a write', () => {
    const store = new AppliedFactoryFiles(tmp());
    store.write(APPLIED);
    expect(store.read(FOLDER)).toEqual(APPLIED);
    store.write({ ...APPLIED, clean: false, texts: { 'agents/reviewer.md': 'You review.\n' } });
    expect(store.read(FOLDER)).toEqual({
      ...APPLIED,
      clean: false,
      texts: { 'agents/reviewer.md': 'You review.\n' },
    });
  });

  it('keeps one file per folder, keyed by the resolved path', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    const other = '/home/alice/.consola/workspaces/ws-2';
    store.write(APPLIED);
    store.write({ ...APPLIED, folder: other, clean: false });
    expect(fs.readdirSync(root).sort()).toEqual([keyOf(FOLDER), keyOf(other)].sort());
    expect(keyOf(FOLDER)).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readdirSync(path.join(root, keyOf(FOLDER)))).toEqual(['applied.json']);
    expect(store.read(other)?.clean).toBe(false);
    expect(store.read(FOLDER)?.clean).toBe(true);
    // A trailing slash, or a dot segment, names the same folder.
    expect(store.read(`${FOLDER}/`)).toEqual(APPLIED);
    expect(store.read('/home/alice/.consola/workspaces/./ws-1')).toEqual(APPLIED);
  });

  it.each([
    ['not JSON', 'not json at all {'],
    ['JSON of another shape', JSON.stringify({ version: 1, folder: FOLDER })],
    ['another version', JSON.stringify({ ...APPLIED, version: 2 })],
    ['a text that is no string', JSON.stringify({ ...APPLIED, version: 1, texts: { a: 3 } })],
    ['texts that are a list', JSON.stringify({ ...APPLIED, version: 1, texts: ['a'] })],
    ['clean that is no boolean', JSON.stringify({ ...APPLIED, version: 1, clean: 'yes' })],
    ['another folder', JSON.stringify({ ...APPLIED, version: 1, folder: '/elsewhere' })],
  ])('%s reads as none, logged once and renamed aside as it was', (_label, bytes) => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    const dir = path.join(root, keyOf(FOLDER));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'applied.json'), bytes);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());

    expect(store.read(FOLDER)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const left = fs.readdirSync(dir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^applied\.json\.damaged-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    expect(fs.readFileSync(path.join(dir, left[0]), 'utf8')).toBe(bytes);
    // Read as none from then on, and logged no more.
    expect(store.read(FOLDER)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a write leaves no temporary file', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    store.write(APPLIED);
    store.write({ ...APPLIED, appliedAt: '2026-11-22T09:00:00.000Z' });
    expect(fs.readdirSync(path.join(root, keyOf(FOLDER)))).toEqual(['applied.json']);
  });

  it('forget removes the folder’s entry', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    store.write(APPLIED);
    store.forget(FOLDER);
    expect(fs.existsSync(path.join(root, keyOf(FOLDER)))).toBe(false);
    expect(store.read(FOLDER)).toBeNull();
    // Forgetting what was never written is no error.
    store.forget('/home/alice/.consola/workspaces/ws-9');
  });

  describe('skills (2-C)', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const skill = (files: Array<{ path: string; bytes: Uint8Array }>): AppliedSkill => ({
      hash: skillHash(files),
      files,
    });
    const TRIAGE = skill([
      {
        path: 'SKILL.md',
        bytes: bytes('---\nname: incident-triage\ndescription: The checklist.\n---\nTriage.\n'),
      },
      { path: 'queries.md', bytes: bytes('rate() over five minutes.\n') },
      // Not UTF-8, as a supporting file may be: kept byte for byte.
      { path: 'refs/logo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]) },
    ]);
    const NOTES = skill([
      {
        path: 'SKILL.md',
        bytes: bytes('---\nname: release-notes\ndescription: The notes.\n---\nWrite.\n'),
      },
    ]);
    const WITH_SKILLS: AppliedFactory = {
      ...APPLIED,
      skills: { 'incident-triage': TRIAGE, 'release-notes': NOTES },
    };
    const silenced = () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => error.mockRestore());
      return error;
    };
    const written = () => {
      const root = tmp();
      const store = new AppliedFactoryFiles(root);
      store.write(WITH_SKILLS);
      return { root, store, dir: path.join(root, keyOf(FOLDER)) };
    };
    /** applied.json is renamed aside, and the version reads as none from then on. */
    const readsAsNone = (store: AppliedFactoryFiles, dir: string) => {
      const error = silenced();
      expect(store.read(FOLDER)).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('applied.json'))).toEqual([
        expect.stringMatching(/^applied\.json\.damaged-/),
      ]);
      expect(store.read(FOLDER)).toBeNull();
    };

    it('a written version with skills reads back equal, bytes and hashes', () => {
      const { store } = written();
      expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
    });

    it('applied.json holds each skill by its hash and no bytes; the files sit beside it', () => {
      const { dir } = written();
      const document = JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8'));
      expect(document.skills).toEqual({
        'incident-triage': TRIAGE.hash,
        'release-notes': NOTES.hash,
      });
      expect(JSON.stringify(document)).not.toContain('rate() over five minutes');
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', 'skills']);
      expect(
        fs.readFileSync(path.join(dir, 'skills', 'incident-triage', 'queries.md'), 'utf8'),
      ).toBe('rate() over five minutes.\n');
      expect(
        new Uint8Array(
          fs.readFileSync(path.join(dir, 'skills', 'incident-triage', 'refs', 'logo.png')),
        ),
      ).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    });

    it('a version written again with fewer skills, or none, leaves no old skill folder behind', () => {
      const { store, dir } = written();
      store.write({ ...APPLIED, skills: { 'release-notes': NOTES } });
      expect(fs.readdirSync(path.join(dir, 'skills'))).toEqual(['release-notes']);
      expect(store.read(FOLDER)).toEqual({ ...APPLIED, skills: { 'release-notes': NOTES } });
      store.write(APPLIED);
      expect(fs.readdirSync(dir)).toEqual(['applied.json']);
      expect(store.read(FOLDER)).toEqual(APPLIED);
      // An empty list is none.
      store.write({ ...APPLIED, skills: {} });
      expect(fs.readdirSync(dir)).toEqual(['applied.json']);
      expect(store.read(FOLDER)).toEqual(APPLIED);
    });

    it('a write leaves no temporary or old skill folder', () => {
      const { store, dir } = written();
      store.write({ ...WITH_SKILLS, appliedAt: '2026-11-22T09:00:00.000Z' });
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', 'skills']);
    });

    it('a byte changed in a skill file reads as none, renamed aside', () => {
      const { store, dir } = written();
      fs.writeFileSync(
        path.join(dir, 'skills', 'incident-triage', 'queries.md'),
        'rate() over 1m.\n',
      );
      readsAsNone(store, dir);
    });

    it.each([
      [
        'a file added',
        (dir: string) =>
          fs.writeFileSync(path.join(dir, 'skills', 'release-notes', 'extra.md'), 'x'),
      ],
      [
        'a file removed',
        (dir: string) => fs.rmSync(path.join(dir, 'skills', 'incident-triage', 'queries.md')),
      ],
      [
        'a skill folder removed',
        (dir: string) => fs.rmSync(path.join(dir, 'skills', 'release-notes'), { recursive: true }),
      ],
      [
        'the skills folder removed',
        (dir: string) => fs.rmSync(path.join(dir, 'skills'), { recursive: true }),
      ],
      [
        'a skill the version does not name',
        (dir: string) => fs.mkdirSync(path.join(dir, 'skills', 'stowaway')),
      ],
      [
        'a file in the skills folder itself',
        (dir: string) => fs.writeFileSync(path.join(dir, 'skills', 'notes.md'), 'x'),
      ],
    ])('%s reads as none', (_label, change) => {
      const { store, dir } = written();
      change(dir);
      readsAsNone(store, dir);
    });

    it.each([
      ['inside a skill', (dir: string) => path.join(dir, 'skills', 'incident-triage', 'link.md')],
      ['in the skills folder itself', (dir: string) => path.join(dir, 'skills', 'stowaway')],
    ])('a symlink planted %s reads as none', (_label, where) => {
      const { root, store, dir } = written();
      const outside = path.join(root, 'outside.md');
      fs.writeFileSync(outside, 'Not a skill file.\n');
      fs.symlinkSync(outside, where(dir));
      readsAsNone(store, dir);
    });

    it('a skill folder swapped for a link to an identical copy reads as none', () => {
      const { root, store, dir } = written();
      const copy = path.join(root, 'copy');
      fs.cpSync(path.join(dir, 'skills', 'release-notes'), copy, { recursive: true });
      fs.rmSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
      fs.symlinkSync(copy, path.join(dir, 'skills', 'release-notes'));
      readsAsNone(store, dir);
    });

    it('a skills folder beside a document that names none reads as none', () => {
      const { store, dir } = written();
      const file = path.join(dir, 'applied.json');
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete document.skills;
      fs.writeFileSync(file, JSON.stringify(document));
      readsAsNone(store, dir);
    });

    it('a list of hashes, even beside a folder named as its index, reads as none', () => {
      const { store, dir } = written();
      fs.rmSync(path.join(dir, 'skills', 'incident-triage'), { recursive: true });
      fs.renameSync(path.join(dir, 'skills', 'release-notes'), path.join(dir, 'skills', '0'));
      const file = path.join(dir, 'applied.json');
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...document, skills: [NOTES.hash] }));
      readsAsNone(store, dir);
    });

    it.each([
      ['skills that are a list', ['incident-triage']],
      ['a hash that is no string', { 'incident-triage': 7 }],
      ['a name that leaves the folder', { '../incident-triage': TRIAGE.hash }],
    ])('%s reads as none', (_label, skills) => {
      const { store, dir } = written();
      const file = path.join(dir, 'applied.json');
      fs.writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), skills }),
      );
      readsAsNone(store, dir);
    });

    it('a skills folder that is a link, even to an identical copy, reads as none', () => {
      const { root, store, dir } = written();
      const copy = path.join(root, 'copy');
      fs.cpSync(path.join(dir, 'skills'), copy, { recursive: true });
      fs.rmSync(path.join(dir, 'skills'), { recursive: true });
      fs.symlinkSync(copy, path.join(dir, 'skills'));
      readsAsNone(store, dir);
    });

    it('a skill file swapped for a link to an identical copy reads as none', () => {
      const { root, store, dir } = written();
      const queries = path.join(dir, 'skills', 'incident-triage', 'queries.md');
      const copy = path.join(root, 'queries-copy.md');
      fs.copyFileSync(queries, copy);
      fs.rmSync(queries);
      fs.symlinkSync(copy, queries);
      readsAsNone(store, dir);
    });

    it('a skill that is a file reads as none, whatever hash its document records', () => {
      const { store, dir } = written();
      const content = bytes('Not a folder.\n');
      fs.rmSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'release-notes'), content);
      // A document that records the hash of that one file, at the skill's own path.
      const file = path.join(dir, 'applied.json');
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      document.skills['release-notes'] = skillHash([{ path: '', bytes: content }]);
      fs.writeFileSync(file, JSON.stringify(document));
      readsAsNone(store, dir);
    });

    it('a skill that is a file, not a folder, reads as none', () => {
      const { store, dir } = written();
      fs.rmSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'release-notes'), 'x');
      readsAsNone(store, dir);
    });

    it('skill files that cannot be read read as none, saying why', () => {
      const { store, dir } = written();
      const locked = path.join(dir, 'skills', 'incident-triage');
      fs.chmodSync(locked, 0o000);
      onTestFinished(() => fs.chmodSync(locked, 0o755));
      const error = silenced();
      expect(store.read(FOLDER)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('its skill files could not be read'),
      );
    });

    it('a staging or old folder an earlier write left behind is not swapped in', () => {
      const { store, dir } = written();
      fs.mkdirSync(path.join(dir, `skills.tmp-${process.pid}`, 'stowaway'), { recursive: true });
      fs.mkdirSync(path.join(dir, `skills.old-${process.pid}`, 'stowaway'), { recursive: true });
      store.write({ ...WITH_SKILLS, appliedAt: '2026-11-22T09:00:00.000Z' });
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', 'skills']);
      expect(store.read(FOLDER)).toEqual({ ...WITH_SKILLS, appliedAt: '2026-11-22T09:00:00.000Z' });
    });

    it('a swap that fails keeps the version there, its skill files included', () => {
      const { store, dir } = written();
      const rename = vi.mocked(fs.renameSync);
      const real = rename.getMockImplementation()!;
      onTestFinished(() => {
        rename.mockImplementation(real);
      });
      // The swap's rename of its staging folder fails; setting the old one aside, and back, go through.
      rename.mockImplementation((from, to) => {
        if (String(from).includes(`skills.tmp-${process.pid}`))
          throw new Error('EXDEV: cross-device link not permitted');
        return real(from, to);
      });
      expect(() =>
        store.write({
          ...APPLIED,
          appliedAt: '2026-11-22T10:00:00.000Z',
          skills: { 'release-notes': NOTES },
        }),
      ).toThrow(/EXDEV/);
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', 'skills']);
      expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
    });

    it('a 2-B document, with no skills key, reads with skills absent', () => {
      const root = tmp();
      const dir = path.join(root, keyOf(FOLDER));
      fs.mkdirSync(dir, { recursive: true });
      const { folder, appliedAt, clean, texts } = APPLIED;
      fs.writeFileSync(
        path.join(dir, 'applied.json'),
        `${JSON.stringify({ version: 1, folder, appliedAt, clean, texts })}\n`,
      );
      const read = new AppliedFactoryFiles(root).read(FOLDER);
      expect(read).toEqual(APPLIED);
      expect(read).not.toHaveProperty('skills');
    });

    it.each([
      ['a name that leaves the folder', { '..': NOTES }],
      ['a name with a separator', { 'a/b': NOTES }],
      [
        'a path that leaves the skill',
        { notes: skill([{ path: '../../applied.json', bytes: bytes('{}') }]) },
      ],
      ['an absolute path', { notes: skill([{ path: '/etc/passwd', bytes: bytes('x') }]) }],
      ['an empty segment', { notes: skill([{ path: 'refs//a.md', bytes: bytes('x') }]) }],
      ['a dot segment', { notes: skill([{ path: './a.md', bytes: bytes('x') }]) }],
      ['a backslash', { notes: skill([{ path: 'refs\\a.md', bytes: bytes('x') }]) }],
    ])('refuses to write %s, and keeps the version it had', (_label, skills) => {
      const { root, store, dir } = written();
      expect(() =>
        store.write({ ...APPLIED, appliedAt: '2026-11-22T10:00:00.000Z', skills }),
      ).toThrow(/is not a path inside a skill/);
      expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', 'skills']);
      expect(fs.readdirSync(root).sort()).toEqual([keyOf(FOLDER)]);
    });
  });
});
