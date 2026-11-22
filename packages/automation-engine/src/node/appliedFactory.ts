import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { skillHash } from '@consola/factory-spec';
import type { AppliedFactory, AppliedFactoryStore, AppliedSkill } from '../ports';

const FILE = 'applied.json';
/** Beside `applied.json`: `skills/<name>/<path>`, each applied skill's files. */
const SKILLS = 'skills';
const VERSION = 1;

/** A folder's key: the first 16 hex of the sha256 of its path, resolved by the caller. */
function keyOf(resolved: string): string {
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A name or path segment that stays where it is put: not empty, `.` or `..`, no separator or NUL. */
const isSegment = (segment: string) =>
  segment !== '' && segment !== '.' && segment !== '..' && !/[\\/\0]/.test(segment);

/** A skill file's path as its segments; it never leaves the skill's folder. */
function segmentsOf(name: string, relative: string): string[] {
  const segments = relative.split('/');
  if (!isSegment(name) || !segments.every(isSegment))
    throw new Error(
      `${JSON.stringify(`${name}/${relative}`)} is not a path inside a skill, so the applied version was not kept.`,
    );
  return segments;
}

/** The document as this version writes it, checked field by field; null for anything else. */
function parseApplied(
  raw: unknown,
  folder: string,
): { applied: AppliedFactory; skillHashes: Record<string, string> } | null {
  if (!isRecord(raw)) return null;
  const { version, appliedAt, clean, texts, skills } = raw;
  if (version !== VERSION) return null;
  if (raw.folder !== folder) return null;
  if (typeof appliedAt !== 'string' || typeof clean !== 'boolean' || !isRecord(texts)) return null;
  const kept: Record<string, string> = {};
  for (const key of Object.keys(texts)) {
    const text = texts[key];
    if (typeof text !== 'string') return null;
    kept[key] = text;
  }
  // A version kept before skills were has no `skills`: it holds none. A name
  // is never a path here: `readSkills` reads only the names its folder lists.
  const skillHashes: Record<string, string> = {};
  if (skills !== undefined) {
    if (!isRecord(skills)) return null;
    for (const name of Object.keys(skills)) {
      const hash = skills[name];
      if (typeof hash !== 'string') return null;
      skillHashes[name] = hash;
    }
  }
  return { applied: { folder, appliedAt, clean, texts: kept }, skillHashes };
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The skills a document names, read back from `<dir>/skills/`, or why they
 * cannot be: the folder must hold exactly those skills, as real folders of
 * folders and regular files (never a link), and each skill's files must hash
 * to what the document recorded. Anything else is a damaged version.
 */
function readSkills(
  dir: string,
  hashes: Record<string, string>,
): { skills: Record<string, AppliedSkill> } | { why: string } {
  const names = Object.keys(hashes).sort();
  const root = path.join(dir, SKILLS);
  if (!fs.existsSync(root))
    return names.length === 0
      ? { skills: {} }
      : { why: `its skill files are missing (${names.join(', ')})` };
  if (!fs.lstatSync(root).isDirectory()) return { why: `its ${SKILLS} folder is not a folder` };
  const held = fs.readdirSync(root).sort();
  if (held.join('\0') !== names.join('\0'))
    return {
      why: `its ${SKILLS} folder holds ${held.join(', ') || 'nothing'}, not the skills it names (${names.join(', ') || 'none'})`,
    };
  const skills: Record<string, AppliedSkill> = {};
  for (const name of names) {
    const files: AppliedSkill['files'] = [];
    const walk = (relative: string): string | null => {
      const at = path.join(root, name, relative);
      const stats = fs.lstatSync(at);
      if (stats.isDirectory()) {
        for (const entry of fs.readdirSync(at)) {
          const problem = walk(relative === '' ? entry : `${relative}/${entry}`);
          if (problem) return problem;
        }
        return null;
      }
      if (!stats.isFile() || relative === '')
        return `${SKILLS}/${name}/${relative} is not a regular file`;
      files.push({ path: relative, bytes: new Uint8Array(fs.readFileSync(at)) });
      return null;
    };
    const problem = walk('');
    if (problem) return { why: problem };
    files.sort(byPath);
    if (skillHash(files) !== hashes[name])
      return { why: `the files of skill ${name} are not the ones it applied from` };
    skills[name] = { hash: hashes[name], files };
  }
  return { skills };
}

/**
 * Each factory folder's last applied version, in Consola's own state folder:
 * `<root>/<key>/applied.json`, `<key>` from the folder's resolved path, with
 * its skills' files beside it in `<root>/<key>/skills/<name>/<path>` and
 * their hashes in the document. Written whole, through a temporary file
 * renamed over it. A file that cannot be read, is not this shape, or whose
 * skill files are not the ones it recorded, is logged and renamed aside
 * (`applied.json.damaged-<time>`) so nothing is lost silently, and reads as
 * none: the folder then applies as on its first start, which never runs
 * anything a file does not say.
 */
export class AppliedFactoryFiles implements AppliedFactoryStore {
  constructor(private readonly root: string) {}

  public read(folder: string): AppliedFactory | null {
    const resolved = path.resolve(folder);
    const file = this.fileOf(resolved);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return this.damaged(file, resolved, `it could not be read (${(error as Error).message})`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.damaged(file, resolved, 'it is not JSON');
    }
    const parsed = parseApplied(raw, resolved);
    if (!parsed) return this.damaged(file, resolved, 'it is not an applied version');
    let read: ReturnType<typeof readSkills>;
    try {
      read = readSkills(path.dirname(file), parsed.skillHashes);
    } catch (error) {
      return this.damaged(
        file,
        resolved,
        `its skill files could not be read (${(error as Error).message})`,
      );
    }
    if ('why' in read) return this.damaged(file, resolved, read.why);
    return Object.keys(read.skills).length > 0
      ? { ...parsed.applied, skills: read.skills }
      : parsed.applied;
  }

  /**
   * The skill files first, into a folder of their own swapped in whole, then
   * `applied.json` renamed over: a crash between leaves a document whose
   * hashes its skill files do not match, which reads as damaged, never as a
   * version with another version's skills.
   */
  public write(applied: AppliedFactory): void {
    const folder = path.resolve(applied.folder);
    const file = this.fileOf(folder);
    const dir = path.dirname(file);
    const skills = applied.skills ?? {};
    const names = Object.keys(skills).sort();
    // Every path is checked before anything is written, so a refusal keeps the version there.
    const placed = names.map((name) => ({
      name,
      files: skills[name].files.map((entry) => ({
        segments: segmentsOf(name, entry.path),
        bytes: entry.bytes,
      })),
    }));
    fs.mkdirSync(dir, { recursive: true });
    this.writeSkills(dir, placed);
    const document = {
      version: VERSION,
      folder,
      appliedAt: applied.appliedAt,
      clean: applied.clean,
      texts: applied.texts,
      ...(names.length > 0
        ? { skills: Object.fromEntries(names.map((name) => [name, skills[name].hash])) }
        : {}),
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`);
    fs.renameSync(temporary, file);
  }

  /** `<dir>/skills/` becomes exactly these skills' files; with none, it is removed. */
  private writeSkills(
    dir: string,
    placed: Array<{ name: string; files: Array<{ segments: string[]; bytes: Uint8Array }> }>,
  ): void {
    const target = path.join(dir, SKILLS);
    if (placed.length === 0) {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    }
    const staging = path.join(dir, `${SKILLS}.tmp-${process.pid}`);
    const old = path.join(dir, `${SKILLS}.old-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      for (const skill of placed) {
        fs.mkdirSync(path.join(staging, skill.name), { recursive: true });
        for (const entry of skill.files) {
          const at = path.join(staging, skill.name, ...entry.segments);
          fs.mkdirSync(path.dirname(at), { recursive: true });
          fs.writeFileSync(at, entry.bytes);
        }
      }
      fs.rmSync(old, { recursive: true, force: true });
      const had = fs.existsSync(target);
      if (had) fs.renameSync(target, old);
      try {
        fs.renameSync(staging, target);
      } catch (error) {
        // The version there keeps its files.
        if (had) fs.renameSync(old, target);
        throw error;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    }
  }

  public forget(folder: string): void {
    fs.rmSync(path.dirname(this.fileOf(path.resolve(folder))), { recursive: true, force: true });
  }

  private fileOf(resolved: string): string {
    return path.join(this.root, keyOf(resolved), FILE);
  }

  private damaged(file: string, folder: string, why: string): null {
    const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let kept = `kept as ${path.basename(aside)}`;
    try {
      fs.renameSync(file, aside);
    } catch (error) {
      kept = `and could not be moved aside (${(error as Error).message})`;
    }
    console.error(
      `[automations] The applied version of ${folder} reads as none: ${why}; ${kept}. The folder applies as on its first start.`,
    );
    return null;
  }
}
