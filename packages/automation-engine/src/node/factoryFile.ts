import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendAutomationEntry,
  parseFactorySpec,
  replaceAutomationEntry,
} from '@consola/factory-spec';
import type { LoadedFactoryFile } from '../ports';

/** Workspace ids are generated tokens; anything else never reaches the filesystem as a path. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One workspace's folder under `~/.consola/workspaces/<id>`: the home of its
 * `factory.yml` and its Assistant. Under `~/.consola` with the worktrees rather
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

/** One workspace's personal automations: `factory.yml` in its data folder. */
export function workspaceFactoryPath(workspaceId: string): string {
  return path.join(workspaceDataDir(workspaceId), 'factory.yml');
}

/**
 * One workspace's spec file: read, parsed, watched.
 *
 * Watched by polling its stat rather than `fs.watch`: the file and even its
 * directory may not exist yet, and editors replace files atomically — both
 * cases that event-based watching misses silently, which is the one failure
 * a scheduler cannot afford.
 */
export class FactoryFile {
  private watching = false;

  constructor(
    public readonly filePath: string,
    private readonly pollMs = 2000,
  ) {}

  public async load(): Promise<LoadedFactoryFile> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, spec: { automations: [], issues: [] } };
      }
      return {
        exists: true,
        spec: {
          automations: [],
          issues: [{ message: `Could not read the file: ${(error as Error).message}`, path: '' }],
        },
      };
    }
    return { exists: true, spec: parseFactorySpec(text) };
  }

  public watch(onChange: () => void): void {
    if (this.watching) return;
    this.watching = true;
    fs.watchFile(
      this.filePath,
      { interval: this.pollMs, persistent: false },
      (current, previous) => {
        if (
          current.mtimeMs !== previous.mtimeMs ||
          current.size !== previous.size ||
          current.ino !== previous.ino
        ) {
          onChange();
        }
      },
    );
  }

  public unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    fs.unwatchFile(this.filePath);
  }

  /** Create the file from `template` if missing; returns its path. */
  public async ensureExists(template: string): Promise<string> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.promises.writeFile(this.filePath, template, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.filePath;
  }

  /** The file as written, or null when there is none yet. */
  public async readText(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Add one automation at the end of the file's list, leaving every other
   * entry and comment as the person wrote it.
   */
  public async appendAutomation(entryYaml: string): Promise<void> {
    await this.rewrite((text) => appendAutomationEntry(text, entryYaml));
  }

  /** Swap the automation called `name` for `entryYaml` in place, every byte outside it kept. */
  public async replaceAutomation(name: string, entryYaml: string): Promise<void> {
    await this.rewrite((text) => replaceAutomationEntry(text, name, entryYaml));
  }

  /**
   * Written whole, through a temporary file, so the watcher never reads
   * half of it. An edit that throws leaves the file as it was.
   */
  private async rewrite(edit: (text: string) => string): Promise<void> {
    // Through any symlink to the file itself — one kept with dotfiles stays a link.
    const target = await fs.promises.realpath(this.filePath);
    const next = edit(await fs.promises.readFile(target, 'utf8'));
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, next);
    await fs.promises.rename(temporary, target);
  }
}
