import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ARTIFACT_NAME_PATTERN,
  AUTOMATION_NAME_PATTERN,
  STEP_ID_PATTERN,
} from '@consola/factory-spec';
import type { RunFolderPort } from '../ports';
import { MAX_ARTIFACT_BYTES, type RunDefinition } from '../steps/definition';
import type { StepTurnFile } from '../views';
import { workspaceDataDir } from './factoryFolder';

const TOKEN = /^[A-Za-z0-9_-]+$/;
const LEGACY_STEP = /^step-\d+$/;
const DEFAULT_TAIL_BYTES = 64 * 1024;
/** The most a definition snapshot may hold; larger is refused on write so it can always be read back. */
export const MAX_DEFINITION_BYTES = 16 * 1024 * 1024;

function token(what: string, value: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new Error(`Not a ${what}: ${JSON.stringify(value)}.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** `runs/<run>/skills/`: the run's copy of its skills. */
const SKILLS = 'skills';

/** A skill's name as its folder is named (`skills/<name>/`), or a throw. */
function skillName(name: string): string {
  if (typeof name !== 'string' || !AUTOMATION_NAME_PATTERN.test(name))
    throw new Error(`Not a skill name: ${JSON.stringify(name)}.`);
  return name;
}

/** A path segment that stays where it is put: not empty, `.` or `..`, no separator or NUL. */
const isSegment = (segment: string) =>
  segment !== '' && segment !== '.' && segment !== '..' && !/[\\/\0]/.test(segment);

/** A skill file's path as its segments; it never leaves the skill's folder. */
function segmentsOf(name: string, relative: string): string[] {
  const segments = typeof relative === 'string' ? relative.split('/') : [];
  if (segments.length === 0 || !segments.every(isSegment))
    throw new Error(`${JSON.stringify(`${name}/${relative}`)} is not a path inside a skill.`);
  return segments;
}

function lstatOrNull(at: string): fs.Stats | null {
  try {
    return fs.lstatSync(at);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** One skill folder's files, sorted by path; null when it is missing or holds anything but folders and regular files. */
function readSkillFolder(dir: string): Array<{ path: string; bytes: Uint8Array }> | null {
  if (lstatOrNull(dir)?.isDirectory() !== true) return null;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = (relative: string): boolean => {
    const at = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    const stats = fs.lstatSync(at);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(at))
        if (!walk(relative === '' ? entry : `${relative}/${entry}`)) return false;
      return true;
    }
    if (!stats.isFile()) return false;
    files.push({ path: relative, bytes: new Uint8Array(fs.readFileSync(at)) });
    return true;
  };
  return walk('') ? files.sort(byPath) : null;
}

/** The file holds the old content or the new, and a write that fails leaves no temporary beside it. */
function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The write's own error is the one worth reporting.
    }
    throw error;
  }
}

/**
 * `<workspace>/runs/<run>/`: the definition a run executes and, per step
 * attempt, its artifacts, outputs and logs. Each execution of a step has its own
 * numbered folder, so a retry never overwrites what the first left. Every path
 * component is a validated token, so nothing climbs out of the folder.
 */
export class RunFolder implements RunFolderPort {
  constructor(private readonly root: (workspaceId: string) => string = workspaceDataDir) {}

  /**
   * A path the file methods may touch: inside `<root>/<workspace token>/runs/`
   * or `.../checks/`, compared by segments so `runs-evil` is not `runs`. Returns the resolved path.
   */
  private confine(file: string): string {
    if (typeof file !== 'string' || file === '' || file.includes('\0'))
      throw new Error(`Not a run folder path: ${JSON.stringify(file)}.`);
    const base = path.dirname(this.root('w'));
    const relative = path.relative(base, path.resolve(file));
    const parts = relative.split(path.sep);
    const inRuns = parts[1] === 'runs';
    const inChecks =
      parts[1] === 'checks' && parts.length > 3 && AUTOMATION_NAME_PATTERN.test(parts[2]);
    const inside =
      !path.isAbsolute(relative) &&
      parts.length > 2 &&
      TOKEN.test(parts[0]) &&
      (inRuns || inChecks) &&
      !parts.includes('..');
    if (!inside) throw new Error(`Outside the run folder: ${JSON.stringify(file)}.`);
    return path.resolve(file);
  }

  private runsDir(workspaceId: string): string {
    return path.join(this.root(token('workspace id', workspaceId, TOKEN)), 'runs');
  }

  private checksDir(workspaceId: string): string {
    return path.join(this.root(token('workspace id', workspaceId, TOKEN)), 'checks');
  }

  /** Where `factory.yml` is: a check's working directory. */
  public workspaceDir(workspaceId: string): string {
    return this.root(token('workspace id', workspaceId, TOKEN));
  }

  /** `<workspace>/checks/<automation>/stdout.log` and `stderr.log`: overwritten each check. */
  public checkFiles(workspaceId: string, automation: string): { stdout: string; stderr: string } {
    const dir = path.join(
      this.checksDir(workspaceId),
      token('automation name', automation, AUTOMATION_NAME_PATTERN),
    );
    return { stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log') };
  }

  public itemPath(workspaceId: string, runId: string): string {
    return path.join(this.runDir(workspaceId, runId), 'item.json');
  }

  public writeItem(workspaceId: string, runId: string, item: Record<string, unknown>): void {
    writeAtomically(this.itemPath(workspaceId, runId), JSON.stringify(item));
  }

  public readItem(workspaceId: string, runId: string): Record<string, unknown> | null {
    const text = this.readText(this.itemPath(workspaceId, runId), MAX_DEFINITION_BYTES);
    return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
  }

  public latestAttempt(workspaceId: string, runId: string, stepId: string): number | null {
    if (!STEP_ID_PATTERN.test(stepId) && !LEGACY_STEP.test(stepId))
      throw new Error(`Not a step id: ${JSON.stringify(stepId)}.`);
    let names: string[];
    try {
      names = fs.readdirSync(path.join(this.runDir(workspaceId, runId), stepId));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const attempts = names.filter((name) => /^[1-9]\d*$/.test(name)).map(Number);
    return attempts.length === 0 ? null : Math.max(...attempts);
  }

  public runDir(workspaceId: string, runId: string): string {
    return path.join(this.runsDir(workspaceId), token('run id', runId, TOKEN));
  }

  public attemptDir(workspaceId: string, runId: string, stepId: string, attempt: number): string {
    if (!STEP_ID_PATTERN.test(stepId) && !LEGACY_STEP.test(stepId))
      throw new Error(`Not a step id: ${JSON.stringify(stepId)}.`);
    if (!Number.isInteger(attempt) || attempt < 1)
      throw new Error(`Not an attempt number: ${JSON.stringify(attempt)}.`);
    return path.join(this.runDir(workspaceId, runId), stepId, String(attempt));
  }

  public skillsDir(workspaceId: string, runId: string): string {
    return path.join(this.runDir(workspaceId, runId), SKILLS);
  }

  /**
   * The run's copy of its skills, swapped in whole: every name and path is
   * checked before anything is written, the files go into a staging folder
   * beside it, and that folder is renamed over any copy there was.
   */
  public writeSkills(
    workspaceId: string,
    runId: string,
    skills: Readonly<Record<string, ReadonlyArray<{ path: string; bytes: Uint8Array }>>>,
  ): void {
    const placed = Object.keys(skills).map((name) => ({
      name: skillName(name),
      files: skills[name].map((entry) => ({
        segments: segmentsOf(name, entry.path),
        bytes: entry.bytes,
      })),
    }));
    const target = this.skillsDir(workspaceId, runId);
    const staging = `${target}.tmp-${process.pid}`;
    const old = `${target}.old-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.mkdirSync(staging);
      for (const skill of placed) {
        fs.mkdirSync(path.join(staging, skill.name));
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
        if (had) fs.renameSync(old, target);
        throw error;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    }
  }

  /**
   * Each named skill's files, read without following a link: a skill whose
   * folder, or anything in it, is not a real folder or a regular file reads
   * as null, as does one that is not there.
   */
  public readSkills(
    workspaceId: string,
    runId: string,
    names: readonly string[],
  ): Record<string, Array<{ path: string; bytes: Uint8Array }> | null> {
    const root = this.skillsDir(workspaceId, runId);
    const read: Record<string, Array<{ path: string; bytes: Uint8Array }> | null> = {};
    const rootIsFolder = lstatOrNull(root)?.isDirectory() === true;
    for (const name of names) {
      skillName(name);
      read[name] = rootIsFolder ? readSkillFolder(path.join(root, name)) : null;
    }
    return read;
  }

  public writeDefinition(workspaceId: string, runId: string, definition: RunDefinition): void {
    const text = JSON.stringify(definition);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_DEFINITION_BYTES) {
      throw new Error(
        `The definition is ${bytes} bytes; the cap is ${MAX_DEFINITION_BYTES / (1024 * 1024)} MB.`,
      );
    }
    writeAtomically(path.join(this.runDir(workspaceId, runId), 'definition.json'), text);
  }

  public readDefinition(workspaceId: string, runId: string): RunDefinition | null {
    const text = this.readText(
      path.join(this.runDir(workspaceId, runId), 'definition.json'),
      MAX_DEFINITION_BYTES,
    );
    return text === null ? null : (JSON.parse(text) as RunDefinition);
  }

  public artifactPath(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
    format?: 'json' | 'text',
  ): string {
    const dir = this.attemptDir(workspaceId, runId, stepId, attempt);
    if (name === 'output') {
      if (format !== 'json' && format !== 'text')
        throw new Error('The output artifact needs a format: json or text.');
      return path.join(dir, format === 'json' ? 'output.json' : 'output.txt');
    }
    return path.join(dir, `${token('artifact name', name, ARTIFACT_NAME_PATTERN)}.md`);
  }

  public writeArtifact(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
    content: string,
    format?: 'json' | 'text',
  ): { bytes: number } {
    const file = this.artifactPath(workspaceId, runId, stepId, attempt, name, format);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact "${name}" is ${bytes} bytes; the cap is ${MAX_ARTIFACT_BYTES / 1024} KB.`,
      );
    }
    writeAtomically(file, content);
    return { bytes };
  }

  public readArtifact(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    name: string,
  ): string | null {
    if (name === 'output') {
      for (const format of ['json', 'text'] as const) {
        const text = this.readText(
          this.artifactPath(workspaceId, runId, stepId, attempt, name, format),
          MAX_ARTIFACT_BYTES,
        );
        if (text !== null) return text;
      }
      return null;
    }
    return this.readText(
      this.artifactPath(workspaceId, runId, stepId, attempt, name),
      MAX_ARTIFACT_BYTES,
    );
  }

  public writeJson(dir: string, file: 'command.json' | 'outputs.json', value: unknown): void {
    if (file !== 'command.json' && file !== 'outputs.json')
      throw new Error(`Not a run file: ${JSON.stringify(file)}.`);
    writeAtomically(path.join(this.confine(dir), file), JSON.stringify(value));
  }

  /**
   * `turn.json` in the attempt's folder gains `turn` at the end of its
   * `turns`, written atomically. A missing file, or one that is not a
   * `{ turns: [...] }`, counts as empty: the record holds the figures, so a
   * damaged file only loses the CLI's own objects of earlier turns.
   */
  public appendTurn(
    workspaceId: string,
    runId: string,
    stepId: string,
    attempt: number,
    turn: StepTurnFile,
  ): void {
    const file = path.join(this.attemptDir(workspaceId, runId, stepId, attempt), 'turn.json');
    let turns: unknown[] = [];
    try {
      const existing = JSON.parse(this.readText(file, MAX_DEFINITION_BYTES) ?? '{}') as {
        turns?: unknown;
      };
      if (Array.isArray(existing?.turns)) turns = existing.turns;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    writeAtomically(this.confine(file), JSON.stringify({ turns: [...turns, turn] }));
  }

  public tail(
    file: string,
    bytes: number = DEFAULT_TAIL_BYTES,
  ): { text: string; bytes: number; truncated: boolean } | null {
    let fd: number;
    try {
      fd = fs.openSync(this.confine(file), 'r');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return { text: buffer.toString('utf8'), bytes: size, truncated: size > bytes };
    } finally {
      fs.closeSync(fd);
    }
  }

  public readText(file: string, maxBytes: number): string | null {
    file = this.confine(file);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (size > maxBytes)
      throw new Error(`${path.basename(file)} is ${size} bytes; the most read is ${maxBytes}.`);
    return fs.readFileSync(file, 'utf8');
  }

  public ensureEmptyFile(file: string): void {
    file = this.confine(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }

  public writeText(file: string, text: string): void {
    writeAtomically(this.confine(file), text);
  }

  public exists(file: string): boolean {
    return fs.existsSync(this.confine(file));
  }

  public sweep(workspaceId: string, keep: ReadonlySet<string>): void {
    const dir = this.runsDir(workspaceId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  public sweepChecks(workspaceId: string, keep: ReadonlySet<string>): void {
    const dir = this.checksDir(workspaceId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  public removeAll(workspaceId: string): void {
    fs.rmSync(this.runsDir(workspaceId), { recursive: true, force: true });
    fs.rmSync(this.checksDir(workspaceId), { recursive: true, force: true });
  }
}
