import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenInResult, OpenInTarget } from '../../shared/openIn';
import type { Launcher } from './launchers';
import type { DetectedTarget } from './targets';

/** How long the list waits for an app's icon before it lists the app without one. */
export const ICON_READ_TIMEOUT_MS = 2_000;

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
 * icon is kept once read; one that fails, or takes longer than
 * `ICON_READ_TIMEOUT_MS`, leaves the app without one this time and is read
 * again at the next list.
 *
 * `open` acts only on what it can check itself: an app it found, and a
 * folder, checked where its absolute path really leads (links and `..`
 * followed) and handed on as that real path, which is not an app's bundle
 * (Finder would launch it). Everything it refuses, and every failure to
 * open, comes back as a sentence; neither `list` nor `open` throws.
 */
export class OpenInService {
  private found: DetectedTarget[] | undefined;
  private looking: Promise<DetectedTarget[]> | undefined;
  private readonly icons = new Map<string, string>();
  private readonly reading = new Map<string, Promise<string | undefined>>();

  constructor(private readonly deps: OpenInServiceDeps) {}

  async list(): Promise<OpenInTarget[]> {
    const known = this.found;
    if (!known) return this.withIcons(await this.look());
    void this.look();
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
    let real: string;
    let stat: fs.Stats;
    try {
      real = await fs.promises.realpath(folder);
      stat = await fs.promises.stat(real);
    } catch (error) {
      return { ok: false, error: unreachable(folder, error) };
    }
    if (!stat.isDirectory()) return { ok: false, error: `${folder} is not a folder.` };
    // A bundle is a folder on disk, but the file manager would launch it.
    if (path.extname(real).toLowerCase() === '.app') {
      return { ok: false, error: `${folder} is an app, not a folder.` };
    }
    const failure = await this.deps
      .launch(target, real)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    return failure
      ? { ok: false, error: `Couldn't open the folder in ${target.label}: ${failure}` }
      : { ok: true };
  }

  /**
   * Looks for the apps, once at a time for every caller, and keeps what it
   * found. A look that fails keeps what was found before, or answers none,
   * so the next one tries again.
   */
  private look(): Promise<DetectedTarget[]> {
    this.looking ??= this.deps
      .detect()
      .then(
        (found) => {
          this.found = found;
          return found;
        },
        (error: unknown) => {
          console.warn('Open in: looking for apps failed:', error);
          return this.found ?? [];
        },
      )
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

  /** The icon kept, else one read now, once at a time per bundle and in time; never throws. */
  private async iconOf(appPath: string): Promise<string | undefined> {
    const kept = this.icons.get(appPath);
    if (kept) return kept;
    let read = this.reading.get(appPath);
    if (!read) {
      read = inTime(this.deps.readIcon(appPath), ICON_READ_TIMEOUT_MS)
        .then(
          (icon) => {
            if (icon) this.icons.set(appPath, icon);
            return icon;
          },
          () => undefined,
        )
        .finally(() => {
          this.reading.delete(appPath);
        });
      this.reading.set(appPath, read);
    }
    return read;
  }
}

/** `work`'s answer, or undefined once `ms` have passed without one. */
function inTime<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Why a folder could not be reached: not there, or not readable by this user. */
function unreachable(folder: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM'
    ? `${folder} cannot be read.`
    : `${folder} does not exist.`;
}

function isRequest(value: unknown): value is { targetId: string; path: string } {
  if (!value || typeof value !== 'object') return false;
  const { targetId, path: folder } = value as Record<string, unknown>;
  return typeof targetId === 'string' && typeof folder === 'string';
}
