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
    /** The skill folder the version's document names. */
    const folderOf = (dir: string) =>
      JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8')).skillsFolder as string;
    const skillsDir = (dir: string) => path.join(dir, folderOf(dir));
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
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', folderOf(dir)]);
      expect(
        fs.readFileSync(path.join(skillsDir(dir), 'incident-triage', 'queries.md'), 'utf8'),
      ).toBe('rate() over five minutes.\n');
      expect(
        new Uint8Array(
          fs.readFileSync(path.join(skillsDir(dir), 'incident-triage', 'refs', 'logo.png')),
        ),
      ).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]));
    });

    it('a version written again with fewer skills, or none, leaves no old skill folder behind', () => {
      const { store, dir } = written();
      store.write({ ...APPLIED, skills: { 'release-notes': NOTES } });
      expect(fs.readdirSync(skillsDir(dir))).toEqual(['release-notes']);
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
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', folderOf(dir)]);
    });

    it('a byte changed in a skill file reads as none, renamed aside', () => {
      const { store, dir } = written();
      fs.writeFileSync(
        path.join(skillsDir(dir), 'incident-triage', 'queries.md'),
        'rate() over 1m.\n',
      );
      readsAsNone(store, dir);
    });

    it.each([
      [
        'a file added',
        (dir: string) =>
          fs.writeFileSync(path.join(skillsDir(dir), 'release-notes', 'extra.md'), 'x'),
      ],
      [
        'a file removed',
        (dir: string) => fs.rmSync(path.join(skillsDir(dir), 'incident-triage', 'queries.md')),
      ],
      [
        'a skill folder removed',
        (dir: string) => fs.rmSync(path.join(skillsDir(dir), 'release-notes'), { recursive: true }),
      ],
      [
        'the skills folder removed',
        (dir: string) => fs.rmSync(skillsDir(dir), { recursive: true }),
      ],
      [
        'a skill the version does not name',
        (dir: string) => fs.mkdirSync(path.join(skillsDir(dir), 'stowaway')),
      ],
      [
        'a file in the skills folder itself',
        (dir: string) => fs.writeFileSync(path.join(skillsDir(dir), 'notes.md'), 'x'),
      ],
    ])('%s reads as none', (_label, change) => {
      const { store, dir } = written();
      change(dir);
      readsAsNone(store, dir);
    });

    it.each([
      ['inside a skill', (dir: string) => path.join(skillsDir(dir), 'incident-triage', 'link.md')],
      ['in the skills folder itself', (dir: string) => path.join(skillsDir(dir), 'stowaway')],
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
      fs.cpSync(path.join(skillsDir(dir), 'release-notes'), copy, { recursive: true });
      fs.rmSync(path.join(skillsDir(dir), 'release-notes'), { recursive: true });
      fs.symlinkSync(copy, path.join(skillsDir(dir), 'release-notes'));
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
      fs.rmSync(path.join(skillsDir(dir), 'incident-triage'), { recursive: true });
      fs.renameSync(path.join(skillsDir(dir), 'release-notes'), path.join(skillsDir(dir), '0'));
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
      fs.cpSync(skillsDir(dir), copy, { recursive: true });
      fs.rmSync(skillsDir(dir), { recursive: true });
      fs.symlinkSync(copy, skillsDir(dir));
      readsAsNone(store, dir);
    });

    it('a skill file swapped for a link to an identical copy reads as none', () => {
      const { root, store, dir } = written();
      const queries = path.join(skillsDir(dir), 'incident-triage', 'queries.md');
      const copy = path.join(root, 'queries-copy.md');
      fs.copyFileSync(queries, copy);
      fs.rmSync(queries);
      fs.symlinkSync(copy, queries);
      readsAsNone(store, dir);
    });

    it('a skill that is a file reads as none, whatever hash its document records', () => {
      const { store, dir } = written();
      const content = bytes('Not a folder.\n');
      fs.rmSync(path.join(skillsDir(dir), 'release-notes'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(dir), 'release-notes'), content);
      // A document that records the hash of that one file, at the skill's own path.
      const file = path.join(dir, 'applied.json');
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      document.skills['release-notes'] = skillHash([{ path: '', bytes: content }]);
      fs.writeFileSync(file, JSON.stringify(document));
      readsAsNone(store, dir);
    });

    it('a skill that is a file, not a folder, reads as none', () => {
      const { store, dir } = written();
      fs.rmSync(path.join(skillsDir(dir), 'release-notes'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(dir), 'release-notes'), 'x');
      readsAsNone(store, dir);
    });

    it('skill files that cannot be read read as none, saying why', () => {
      const { store, dir } = written();
      const locked = path.join(skillsDir(dir), 'incident-triage');
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
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', folderOf(dir)]);
      expect(store.read(FOLDER)).toEqual({ ...WITH_SKILLS, appliedAt: '2026-11-22T09:00:00.000Z' });
    });

    it('a new skill folder that cannot be put in place keeps the version there, its skill files included', () => {
      const { store, dir } = written();
      const rename = vi.mocked(fs.renameSync);
      const real = rename.getMockImplementation()!;
      onTestFinished(() => {
        rename.mockImplementation(real);
      });
      // The rename of the new version's staging folder fails.
      rename.mockImplementation((from, to) => {
        if (/skills-[0-9a-f]{16}\.tmp$/.test(String(from)))
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
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', folderOf(dir)]);
      expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
    });

    describe('the document and its skill files, written as a pair (review M2)', () => {
      const documentOf = (dir: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8')) as Record<
          string,
          unknown
        >;
      const failRename = (matches: (from: string) => boolean) => {
        const rename = vi.mocked(fs.renameSync);
        const real = rename.getMockImplementation()!;
        onTestFinished(() => {
          rename.mockImplementation(real);
        });
        rename.mockImplementation((from, to) => {
          if (matches(String(from))) throw new Error('EIO: i/o error, rename');
          return real(from, to);
        });
      };

      it('applied.json names its skill folder, a fresh one per write; the old one goes once it is renamed over', () => {
        const { store, dir } = written();
        const first = documentOf(dir).skillsFolder;
        expect(first).toMatch(/^skills-[0-9a-f]{16}$/);
        store.write({ ...WITH_SKILLS, appliedAt: '2026-11-22T09:00:00.000Z' });
        const second = documentOf(dir).skillsFolder;
        expect(second).toMatch(/^skills-[0-9a-f]{16}$/);
        expect(second).not.toBe(first);
        expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', second]);
        expect(store.read(FOLDER)).toEqual({
          ...WITH_SKILLS,
          appliedAt: '2026-11-22T09:00:00.000Z',
        });
      });

      it('a write whose applied.json fails keeps the version there, its skill files included', () => {
        const { store, dir } = written();
        const before = fs.readdirSync(dir).sort();
        failRename((from) => from.includes('applied.json.'));
        expect(() =>
          store.write({
            ...APPLIED,
            appliedAt: '2026-11-22T10:00:00.000Z',
            skills: { 'release-notes': NOTES },
          }),
        ).toThrow(/EIO/);
        const error = silenced();
        expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
        expect(error).not.toHaveBeenCalled();
        // Neither the new skill folder nor the temporary document is left.
        expect(fs.readdirSync(dir).sort()).toEqual(before);
      });

      it('a skill folder the document does not name, as a write cut short leaves, is ignored, and the next write removes it', () => {
        const { store, dir } = written();
        const named = documentOf(dir).skillsFolder as string;
        const orphan = path.join(dir, 'skills-0123456789abcdef');
        fs.mkdirSync(path.join(orphan, 'stowaway'), { recursive: true });
        fs.writeFileSync(path.join(orphan, 'stowaway', 'SKILL.md'), 'Not applied.\n');
        const error = silenced();
        expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
        expect(error).not.toHaveBeenCalled();
        expect(fs.readdirSync(dir).sort()).toEqual(
          ['applied.json', named, 'skills-0123456789abcdef'].sort(),
        );
        store.write(APPLIED);
        expect(fs.readdirSync(dir)).toEqual(['applied.json']);
        expect(store.read(FOLDER)).toEqual(APPLIED);
      });

      it.each([
        ['a path', '../skills-0123456789abcdef'],
        ['a folder of another name', 'texts'],
        ['the old folder name', 'skills'],
        ['no string', 7],
      ])('a document naming %s as its skill folder reads as none', (_label, skillsFolder) => {
        const { store, dir } = written();
        const document = documentOf(dir);
        // The skills the document names sit where it now points, so only the name refuses it.
        if (typeof skillsFolder === 'string')
          fs.cpSync(path.join(dir, document.skillsFolder as string), path.join(dir, skillsFolder), {
            recursive: true,
          });
        const file = path.join(dir, 'applied.json');
        fs.writeFileSync(file, JSON.stringify({ ...document, skillsFolder }));
        readsAsNone(store, dir);
      });

      it.each([
        ['there', false],
        ['gone', true],
      ])(
        'a document naming a skill folder but no skills reads as none, the folder %s',
        (_label, removed) => {
          const { store, dir } = written();
          const document = documentOf(dir);
          if (removed)
            fs.rmSync(path.join(dir, document.skillsFolder as string), { recursive: true });
          delete document.skills;
          fs.writeFileSync(path.join(dir, 'applied.json'), JSON.stringify(document));
          readsAsNone(store, dir);
        },
      );

      it('a document from before this, its skills in skills/ and no folder named, reads them there; the next write moves them', () => {
        const root = tmp();
        const dir = path.join(root, keyOf(FOLDER));
        fs.mkdirSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'skills', 'release-notes', 'SKILL.md'),
          NOTES.files[0].bytes,
        );
        const { folder, appliedAt, clean, texts } = APPLIED;
        fs.writeFileSync(
          path.join(dir, 'applied.json'),
          `${JSON.stringify({ version: 1, folder, appliedAt, clean, texts, skills: { 'release-notes': NOTES.hash } })}\n`,
        );
        const store = new AppliedFactoryFiles(root);
        expect(store.read(FOLDER)).toEqual({ ...APPLIED, skills: { 'release-notes': NOTES } });
        store.write({ ...APPLIED, skills: { 'release-notes': NOTES } });
        const now = documentOf(dir).skillsFolder;
        expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', now]);
        expect(store.read(FOLDER)).toEqual({ ...APPLIED, skills: { 'release-notes': NOTES } });
      });
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
      ['a backslash', { notes: skill([{ path: String.raw`refs\a.md`, bytes: bytes('x') }]) }],
    ])('refuses to write %s, and keeps the version it had', (_label, skills) => {
      const { root, store, dir } = written();
      expect(() =>
        store.write({ ...APPLIED, appliedAt: '2026-11-22T10:00:00.000Z', skills }),
      ).toThrow(/is not a path inside a skill/);
      expect(store.read(FOLDER)).toEqual(WITH_SKILLS);
      expect(fs.readdirSync(dir).sort()).toEqual(['applied.json', folderOf(dir)]);
      expect(fs.readdirSync(root).sort()).toEqual([keyOf(FOLDER)]);
    });
  });
});
