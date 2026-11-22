import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenInResult, OpenInTarget } from '../../shared/openIn';
import type { Launcher } from './launchers';
import type { DetectedTarget } from './targets';

export interface OpenInServiceDeps {
  /** The apps on this computer, the file manager last (`detectTargets`). */
  detect(): Promise<DetectedTarget[]>;
  /** An app's icon, as a data URL; undefined when it has none. */
  readIcon(appPath: string): Promise<string | undefined>;
  launch: Launcher;
}

/**
 * The apps a session's folder can be opened in, and the opening.
 *
 * What is installed is found once and kept for the run; each later `list`
 * answers from that at once and looks again behind the answer, so an app
 * installed or removed since shows the next time the menu opens. An app's
 * icon is read once per bundle.
 *
 * `open` acts only on what it can check itself: an app it found, and an
 * absolute path that is a folder now, and not an app's bundle (Finder would
 * launch it). Everything it refuses, and every
 * failure to open, comes back as a sentence; nothing throws.
 */
export class OpenInService {
  private found: DetectedTarget[] | undefined;
  private looking: Promise<DetectedTarget[]> | undefined;
  private readonly icons = new Map<string, Promise<string | undefined>>();

  constructor(private readonly deps: OpenInServiceDeps) {}

  async list(): Promise<OpenInTarget[]> {
    const known = this.found;
    if (!known) return this.withIcons(await this.look());
    this.look().catch((error: unknown) => {
      console.warn('Open in: looking for apps again failed:', error);
    });
    return this.withIcons(known);
  }

  async open(request: unknown): Promise<OpenInResult> {
    if (!isRequest(request)) {
      return { ok: false, error: 'Consola was not told which app and folder to open.' };
    }
    const { targetId, path: folder } = request;
    const target = (this.found ?? (await this.look())).find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) {
      return { ok: false, error: `Consola found no app “${targetId}” on this computer.` };
    }
    if (!path.isAbsolute(folder)) {
      return { ok: false, error: `“${folder}” is not a full path to a folder.` };
    }
    const stat = await fs.promises.stat(folder).catch(() => null);
    if (!stat) return { ok: false, error: `${folder} does not exist.` };
    if (!stat.isDirectory()) return { ok: false, error: `${folder} is not a folder.` };
    // A bundle is a folder on disk, but the file manager would launch it.
    if (path.extname(path.basename(folder)).toLowerCase() === '.app') {
      return { ok: false, error: `${folder} is an app, not a folder.` };
    }
    const failure = await this.deps.launch(target, folder);
    return failure
      ? { ok: false, error: `Couldn't open the folder in ${target.label}: ${failure}` }
      : { ok: true };
  }

  /** Looks for the apps, once at a time for every caller, and keeps what it found. */
  private look(): Promise<DetectedTarget[]> {
    this.looking ??= this.deps
      .detect()
      .then((found) => {
        this.found = found;
        return found;
      })
      .finally(() => {
        this.looking = undefined;
      });
    return this.looking;
  }

  private withIcons(targets: readonly DetectedTarget[]): Promise<OpenInTarget[]> {
    return Promise.all(
      targets.map(async ({ appPath, ...target }) => {
        const icon = appPath ? await this.iconOf(appPath) : undefined;
        return icon ? { ...target, icon } : target;
      }),
    );
  }

  private iconOf(appPath: string): Promise<string | undefined> {
    let icon = this.icons.get(appPath);
    if (!icon) {
      icon = this.deps.readIcon(appPath).catch(() => undefined);
      this.icons.set(appPath, icon);
    }
    return icon;
  }
}

function isRequest(value: unknown): value is { targetId: string; path: string } {
  if (!value || typeof value !== 'object') return false;
  const { targetId, path: folder } = value as Record<string, unknown>;
  return typeof targetId === 'string' && typeof folder === 'string';
}
