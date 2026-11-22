import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendAutomationEntry,
  AUTOMATION_NAME_PATTERN,
  automationEntryText,
  LATER_FOLDERS,
  MAX_FACTORY_TEXT_BYTES,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  replaceAutomationEntry,
  type FactoryFiles,
  type SkillFileEntry,
} from '@consola/factory-spec';
import type { FactoryFolderHandle, FactoryFolderRead } from '../ports';

/** Workspace ids are generated tokens; anything else never reaches the filesystem as a path. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One workspace's folder under `~/.consola/workspaces/<id>`: the home of its
 * factory (`factory.yml`, `automations/`, `agents/`, `skills/`) and of
 * slice 1's `runs/` and `checks/`. Under `~/.consola` with the worktrees rather
 * than in Consola's own state, so the files are text a person can keep with
 * their dotfiles. Keyed by id, not name, so renaming a workspace never orphans
 * them. `CONSOLA_FACTORY_DIR` replaces the `workspaces` folder — the seam tests use.
 */
export function workspaceDataDir(workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId))
    throw new Error(`Not a workspace id: ${JSON.stringify(workspaceId)}.`);
  const root = process.env.CONSOLA_FACTORY_DIR ?? path.join(os.homedir(), '.consola', 'workspaces');
  return path.join(root, workspaceId);
}

/** One workspace's `factory.yml`, in its data folder. */
export function workspaceFactoryPath(workspaceId: string): string {
  return path.join(workspaceDataDir(workspaceId), 'factory.yml');
}

const FACTORY_YML = 'factory.yml';
const AUTOMATION_FILE = /^(.+)\.yaml$/;
const AGENT_FILE = /^(.+)\.md$/;
const OVER = 'it is over 1 MB';
/** How much of a file one read takes: a small file is never given a buffer the size of the cap. */
const READ_CHUNK = 64 * 1024;
const NOT_A_FILE = 'it is not a regular file';

const isDotfile = (name: string) => name.startsWith('.');
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A file's text, decoded as UTF-8 with a leading byte-order mark removed. */
function decode(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The names in a folder that is there, dotfiles left out, sorted; [] when it is not there. */
async function listNames(dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => !isDotfile(entry.name)).sort((a, b) => byName(a.name, b.name));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

type Bounded = { kind: 'bytes'; bytes: Uint8Array; over: boolean } | { kind: 'not-a-file' };

/**
 * The file at `file`, read no further than `limit + 1` bytes, so a large one
 * is never held: `over` says it holds more than `limit` (and `bytes` then
 * holds `limit + 1`). Opened without blocking, so a FIFO named like a file
 * never hangs the read; `noFollow` refuses a symlink. Throws as `open` does
 * (ENOENT when there is no file, or a link's target is gone).
 */
async function readBounded(file: string, limit: number, noFollow = false): Promise<Bounded> {
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(file, flags);
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'not-a-file' };
    const chunks: Buffer[] = [];
    let filled = 0;
    while (filled <= limit) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit + 1 - filled));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      filled += bytesRead;
    }
    return { kind: 'bytes', bytes: Buffer.concat(chunks, filled), over: filled > limit };
  } finally {
    await handle.close();
  }
}

/**
 * One line of the watch signature: a file's `[path, mtime, size, inode]`, a
 * folder's `[path, inode]` (its listing is in the signature entry by entry,
 * and its own mtime moves with every dotfile an editor writes beside a file),
 * or the path marked missing.
 */
function statLine(relative: string, stat: fs.Stats | null): string {
  if (!stat) return `${relative}\tmissing`;
  if (stat.isDirectory()) return `${relative}\tfolder\t${stat.ino}`;
  return `${relative}\t${stat.mtimeMs}\t${stat.size}\t${stat.ino}`;
}

/** `stat` (through links) or `lstat`, null where it throws: a link whose target is gone, a file deleted meanwhile. */
function statOrNull(file: string, follow: boolean): fs.Stats | null {
  try {
    return follow ? fs.statSync(file) : fs.lstatSync(file);
  } catch {
    return null;
  }
}

/** The names in a folder, dotfiles left out, sorted; [] where it cannot be listed. */
function namesOrNone(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !isDotfile(name))
      .sort(byName);
  } catch {
    return [];
  }
}

/**
 * One workspace's factory folder: read, watched and written.
 *
 * It reads `factory.yml`, `automations/*`, `agents/*` and `skills/**` only:
 * dotfiles, `runs/`, `checks/` and every other root entry are not the
 * factory's. `factory.yml` and the agent and automation files are read
 * through a symlink (a person keeps them with dotfiles); nothing inside
 * `skills/` is, so a skill can deliver nothing from outside its folder.
 *
 * Watched by polling a signature rather than `fs.watch`: the folders and
 * files may not exist yet, and editors replace files atomically, both cases
 * event-based watching misses silently, which is the one failure a scheduler
 * cannot afford. The signature stats through links where the read follows
 * them, so an edit of a link's target, or a `git pull` in the dotfiles
 * repository, is seen.
 */
export class FactoryFolder implements FactoryFolderHandle {
  public readonly filePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly folderPath: string,
    private readonly pollMs = 2000,
  ) {
    this.filePath = path.join(folderPath, FACTORY_YML);
  }

  public async read(): Promise<FactoryFolderRead> {
    const files: FactoryFiles = {
      factoryYml: null,
      automations: {},
      agents: {},
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
    };
    const factoryYml = await this.readOne(FACTORY_YML, this.filePath, files);
    files.factoryYml = factoryYml.text;
    await this.readTexts('automations', AUTOMATION_FILE, files.automations, files);
    await this.readTexts('agents', AGENT_FILE, files.agents, files);
    await this.readSkills(files);
    for (const folder of Object.keys(LATER_FOLDERS)) {
      if (statOrNull(path.join(this.folderPath, folder), true)?.isDirectory())
        files.laterFolders.push(folder);
    }
    files.stray.sort(byName);
    return { exists: factoryYml.exists, files };
  }

  /**
   * A text file through any link: its text, or nothing when it is not there
   * (a link whose target is gone included). Over `MAX_FACTORY_TEXT_BYTES`, not
   * a regular file, or a read that fails, it is unread, with the reason.
   */
  private async readOne(
    relative: string,
    file: string,
    files: FactoryFiles,
  ): Promise<{ exists: boolean; text: string | null }> {
    let read: Bounded;
    try {
      read = await readBounded(file, MAX_FACTORY_TEXT_BYTES);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { exists: false, text: null };
      files.unread.push({ path: relative, reason: describe(error) });
      return { exists: true, text: null };
    }
    if (read.kind === 'not-a-file') {
      files.unread.push({ path: relative, reason: NOT_A_FILE });
      return { exists: true, text: null };
    }
    if (read.over) {
      files.unread.push({ path: relative, reason: OVER });
      return { exists: true, text: null };
    }
    return { exists: true, text: decode(read.bytes) };
  }

  /** `automations/<name>.yaml` or `agents/<name>.md`, by name; anything else in the folder is a stray. */
  private async readTexts(
    folder: 'automations' | 'agents',
    pattern: RegExp,
    into: Record<string, string>,
    files: FactoryFiles,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await listNames(path.join(this.folderPath, folder));
    } catch (error) {
      files.unread.push({ path: `${folder}/`, reason: describe(error) });
      return;
    }
    for (const entry of entries) {
      const relative = `${folder}/${entry.name}`;
      const name = pattern.exec(entry.name)?.[1];
      if (name === undefined) {
        files.stray.push(relative);
        continue;
      }
      const read = await this.readOne(relative, path.join(this.folderPath, relative), files);
      if (read.text !== null) into[name] = read.text;
    }
  }

  /** Each folder in `skills/` is a skill, walked without following a link; anything else there is a stray. */
  private async readSkills(files: FactoryFiles): Promise<void> {
    const root = path.join(this.folderPath, 'skills');
    let entries: fs.Dirent[];
    try {
      entries = await listNames(root);
    } catch (error) {
      files.unread.push({ path: 'skills/', reason: describe(error) });
      return;
    }
    for (const entry of entries) {
      // A Dirent is the entry itself, never a link's target: a linked folder is no skill folder.
      if (!entry.isDirectory()) {
        files.stray.push(`skills/${entry.name}`);
        continue;
      }
      const skill: SkillFileEntry[] = [];
      const budget = { bytes: MAX_SKILL_BYTES + 1 };
      // A skill whose folder cannot be listed is unread, not a skill with no files.
      if (await this.walkSkill(entry.name, '', skill, budget, files))
        files.skills[entry.name] = skill;
    }
  }

  /**
   * One folder of a skill, depth-first and sorted, by `lstat`: a regular
   * file's bytes, a symlink or anything else as what it is, never read. It
   * stops past `MAX_SKILL_FILES` entries or `MAX_SKILL_BYTES`, so the
   * validator sees "over" without this holding more. False when this folder
   * could not be listed (it is then unread).
   */
  private async walkSkill(
    skillName: string,
    inside: string,
    skill: SkillFileEntry[],
    budget: { bytes: number },
    files: FactoryFiles,
  ): Promise<boolean> {
    const full = (relative: string) =>
      path.join(this.folderPath, 'skills', skillName, ...relative.split('/'));
    let names: string[];
    try {
      names = (await fs.promises.readdir(full(inside)))
        .filter((name) => !isDotfile(name))
        .sort(byName);
    } catch (error) {
      files.unread.push({
        path: `skills/${skillName}/${inside === '' ? '' : `${inside}/`}`,
        reason: describe(error),
      });
      return false;
    }
    for (const name of names) {
      if (skill.length > MAX_SKILL_FILES || budget.bytes <= 0) break;
      const relative = inside === '' ? name : `${inside}/${name}`;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(full(relative));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        files.unread.push({ path: `skills/${skillName}/${relative}`, reason: describe(error) });
        continue;
      }
      if (stat.isDirectory()) {
        await this.walkSkill(skillName, relative, skill, budget, files);
      } else if (stat.isSymbolicLink()) {
        skill.push({ path: relative, kind: 'symlink' });
      } else if (!stat.isFile()) {
        skill.push({ path: relative, kind: 'special' });
      } else {
        try {
          // No further than the skill's budget: past it, one byte more says "over".
          const read = await readBounded(full(relative), budget.bytes - 1, true);
          if (read.kind === 'not-a-file') {
            skill.push({ path: relative, kind: 'special' });
            continue;
          }
          budget.bytes -= read.bytes.length;
          skill.push({ path: relative, bytes: new Uint8Array(read.bytes) });
        } catch (error) {
          const code = errorCode(error);
          if (code === 'ENOENT') continue;
          // A file replaced by a link between the listing and the read.
          if (code === 'ELOOP') skill.push({ path: relative, kind: 'symlink' });
          else
            files.unread.push({ path: `skills/${skillName}/${relative}`, reason: describe(error) });
        }
      }
    }
    return true;
  }

  /**
   * What the poll compares: `factory.yml`, the three folders and each entry of
   * `automations/` and `agents/` by `stat` (through links), each entry under
   * `skills/` by `lstat` (a link there is refused anyway), bounded as the
   * read is, and which later folders exist. A path whose stat fails counts as
   * missing. Never throws.
   */
  private signature(): string {
    const lines: string[] = [statLine(FACTORY_YML, statOrNull(this.filePath, true))];
    for (const folder of ['automations', 'agents']) {
      const dir = path.join(this.folderPath, folder);
      lines.push(statLine(`${folder}/`, statOrNull(dir, true)));
      for (const name of namesOrNone(dir))
        lines.push(statLine(`${folder}/${name}`, statOrNull(path.join(dir, name), true)));
    }
    const skills = path.join(this.folderPath, 'skills');
    lines.push(statLine('skills/', statOrNull(skills, true)));
    for (const name of namesOrNone(skills)) {
      const stat = statOrNull(path.join(skills, name), false);
      lines.push(statLine(`skills/${name}`, stat));
      if (stat?.isDirectory()) this.skillLines(path.join(skills, name), `skills/${name}`, lines);
    }
    for (const folder of Object.keys(LATER_FOLDERS)) {
      if (statOrNull(path.join(this.folderPath, folder), true)?.isDirectory())
        lines.push(`later\t${folder}`);
    }
    return lines.join('\n');
  }

  private skillLines(dir: string, relative: string, lines: string[], count = { entries: 0 }): void {
    for (const name of namesOrNone(dir)) {
      if (count.entries > MAX_SKILL_FILES) return;
      count.entries += 1;
      const stat = statOrNull(path.join(dir, name), false);
      lines.push(statLine(`${relative}/${name}`, stat));
      if (stat?.isDirectory())
        this.skillLines(path.join(dir, name), `${relative}/${name}`, lines, count);
    }
  }

  public watch(onChange: () => void): void {
    if (this.timer) return;
    let last = this.signature();
    this.timer = setInterval(() => {
      const next = this.signature();
      if (next === last) return;
      last = next;
      onChange();
    }, this.pollMs);
    this.timer.unref?.();
  }

  public unwatch(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Create `factory.yml` from `template` if missing; returns its path. */
  public async ensureExists(template: string): Promise<string> {
    await fs.promises.mkdir(this.folderPath, { recursive: true });
    try {
      await fs.promises.writeFile(this.filePath, template, { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    return this.filePath;
  }

  /** `factory.yml` as written, or null when there is none yet. */
  public async readText(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /** `automations/<name>.yaml` as written (a leading byte-order mark removed), or null when there is none. */
  public async readAutomationFile(name: string): Promise<string | null> {
    try {
      return decode(await fs.promises.readFile(this.automationFile(name)));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /** Where an entry of that name is written now, read now: `factory.yml` first, then its own file. */
  public async whereIs(name: string): Promise<'factory.yml' | 'file' | null> {
    const text = await this.readText();
    if (text !== null && automationEntryText(text, name) !== null) return 'factory.yml';
    const file = statOrNull(this.automationFile(name), true);
    return file?.isFile() ? 'file' : null;
  }

  /**
   * Add one automation at the end of `factory.yml`'s list, leaving every other
   * entry and comment as the person wrote it.
   */
  public async appendAutomation(entryYaml: string): Promise<void> {
    await this.rewrite(this.filePath, (text) => appendAutomationEntry(text, entryYaml));
  }

  /** Swap the automation called `name` in `factory.yml` for `entryYaml`, every byte outside it kept. */
  public async replaceAutomation(name: string, entryYaml: string): Promise<void> {
    await this.rewrite(this.filePath, (text) => replaceAutomationEntry(text, name, entryYaml));
  }

  /** `automations/<name>.yaml`, written whole: created with its folder, or replaced through any link. */
  public async writeAutomationFile(name: string, text: string): Promise<void> {
    const file = this.automationFile(name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    let target = file;
    try {
      target = await fs.promises.realpath(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    await this.replaceWhole(target, text);
  }

  /** The absolute path of one of the folder's own files; null for any other path. */
  public pathOf(relative: string): string | null {
    const named = (name: string | undefined) =>
      name !== undefined && AUTOMATION_NAME_PATTERN.test(name);
    const own =
      relative === FACTORY_YML ||
      named(/^automations\/([^/]+)\.yaml$/.exec(relative)?.[1]) ||
      named(/^agents\/([^/]+)\.md$/.exec(relative)?.[1]) ||
      named(/^skills\/([^/]+)\/SKILL\.md$/.exec(relative)?.[1]);
    return own ? path.join(this.folderPath, relative) : null;
  }

  private automationFile(name: string): string {
    if (!AUTOMATION_NAME_PATTERN.test(name))
      throw new Error(`Not an automation name: ${JSON.stringify(name)}.`);
    return path.join(this.folderPath, 'automations', `${name}.yaml`);
  }

  /**
   * `file` edited whole, through any symlink to it: one kept with dotfiles
   * stays a link. An edit that throws leaves the file as it was.
   */
  private async rewrite(file: string, edit: (text: string) => string): Promise<void> {
    const target = await fs.promises.realpath(file);
    await this.replaceWhole(target, edit(await fs.promises.readFile(target, 'utf8')));
  }

  /**
   * Written through a temporary file beside it, then renamed over it, so a
   * read never sees half of it. The temporary file is a dotfile, which the
   * read and the watch leave out.
   */
  private async replaceWhole(target: string, text: string): Promise<void> {
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.tmp`,
    );
    await fs.promises.writeFile(temporary, text);
    await fs.promises.rename(temporary, target);
  }
}
