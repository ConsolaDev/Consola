import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { skillHash } from '@consola/factory-spec';
import type { AppliedFactory, AppliedFactoryStore, AppliedSkill } from '../ports';

const FILE = 'applied.json';
/**
 * Beside `applied.json`: `skills-<16 hex>/<name>/<path>`, each applied
 * skill's files, in a folder of the version's own that the document names
 * (`skillsFolder`), so the two are always a pair (review M2).
 */
const SKILLS_FOLDER = /^skills-[0-9a-f]{16}$/;
/** Where a document written before `skillsFolder` keeps its skills. */
const LEGACY_SKILLS = 'skills';
/** Every folder a write of skills may leave beside the document: what a later write removes. */
const ANY_SKILLS_FOLDER = /^skills($|[-.])/;
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

/**
 * The document as this version writes it, checked field by field; null for
 * anything else. `skillsFolder` is the folder its skills are in: the one it
 * names, or, for a document from before it named one, `skills`.
 */
function parseApplied(
  raw: unknown,
  folder: string,
): {
  applied: AppliedFactory;
  skillHashes: Record<string, string>;
  skillsFolder: string;
} | null {
  if (!isRecord(raw)) return null;
  const { version, appliedAt, clean, texts, skills, skillsFolder } = raw;
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
  // A folder is named only beside skills, and only as this store names one: never a path.
  if (skillsFolder !== undefined) {
    if (typeof skillsFolder !== 'string' || !SKILLS_FOLDER.test(skillsFolder)) return null;
    if (Object.keys(skillHashes).length === 0) return null;
  }
  return {
    applied: { folder, appliedAt, clean, texts: kept },
    skillHashes,
    skillsFolder: skillsFolder ?? LEGACY_SKILLS,
  };
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The skills a document names, read back from `<dir>/<folder>/`, or why they
 * cannot be: the folder must hold exactly those skills, as real folders of
 * folders and regular files (never a link), and each skill's files must hash
 * to what the document recorded. Anything else is a damaged version.
 */
function readSkills(
  dir: string,
  hashes: Record<string, string>,
  folder: string,
): { skills: Record<string, AppliedSkill> } | { why: string } {
  const names = Object.keys(hashes).sort();
  const root = path.join(dir, folder);
  if (!fs.existsSync(root))
    return names.length === 0
      ? { skills: {} }
      : { why: `its skill files are missing (${names.join(', ')})` };
  if (!fs.lstatSync(root).isDirectory()) return { why: `its ${folder} folder is not a folder` };
  const held = fs.readdirSync(root).sort();
  if (held.join('\0') !== names.join('\0'))
    return {
      why: `its ${folder} folder holds ${held.join(', ') || 'nothing'}, not the skills it names (${names.join(', ') || 'none'})`,
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
        return `${folder}/${name}/${relative} is not a regular file`;
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
 * its skills' files beside it in `<root>/<key>/skills-<16 hex>/<name>/<path>`,
 * a folder the document names, and their hashes in the document. Written
 * whole, through a temporary file renamed over it. A file that cannot be read, is not this shape, or whose
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
      read = readSkills(path.dirname(file), parsed.skillHashes, parsed.skillsFolder);
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
   * The skill files first, whole, into a fresh folder of the version's own;
   * then `applied.json`, naming that folder, renamed over the last one; then
   * every other skill folder goes. The document names its folder, so a crash
   * or a failure anywhere leaves the last version and its own skill files
   * there (review M2): a folder no document names is a write cut short,
   * which reading ignores and the next write removes.
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
    const skillsFolder = placed.length > 0 ? this.placeSkills(dir, placed) : undefined;
    const document = {
      version: VERSION,
      folder,
      appliedAt: applied.appliedAt,
      clean: applied.clean,
      texts: applied.texts,
      ...(skillsFolder !== undefined
        ? {
            skills: Object.fromEntries(names.map((name) => [name, skills[name].hash])),
            skillsFolder,
          }
        : {}),
    };
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`);
      fs.renameSync(temporary, file);
    } catch (error) {
      // The last version and its skill folder stay as they were.
      fs.rmSync(temporary, { force: true });
      if (skillsFolder !== undefined)
        fs.rmSync(path.join(dir, skillsFolder), { recursive: true, force: true });
      throw error;
    }
    this.removeSkillFoldersBut(dir, skillsFolder);
  }

  /** A fresh `skills-<16 hex>/` beside the document holding exactly these skills' files; its name. */
  private placeSkills(
    dir: string,
    placed: Array<{ name: string; files: Array<{ segments: string[]; bytes: Uint8Array }> }>,
  ): string {
    const name = `skills-${randomBytes(8).toString('hex')}`;
    const staging = path.join(dir, `${name}.tmp`);
    try {
      for (const skill of placed) {
        fs.mkdirSync(path.join(staging, skill.name), { recursive: true });
        for (const entry of skill.files) {
          const at = path.join(staging, skill.name, ...entry.segments);
          fs.mkdirSync(path.dirname(at), { recursive: true });
          fs.writeFileSync(at, entry.bytes);
        }
      }
      fs.renameSync(staging, path.join(dir, name));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return name;
  }

  /**
   * Every skill folder beside the document but the one it names: an earlier
   * version's, the old `skills/`, a write cut short. The document is already
   * in place, so a folder that cannot be removed waits for the next write.
   */
  private removeSkillFoldersBut(dir: string, kept: string | undefined): void {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === kept || !ANY_SKILLS_FOLDER.test(entry)) continue;
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      } catch (error) {
        console.error(
          `[automations] Could not remove ${path.join(dir, entry)}, an earlier applied version's skill files; the next write tries again.`,
          error,
        );
      }
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
