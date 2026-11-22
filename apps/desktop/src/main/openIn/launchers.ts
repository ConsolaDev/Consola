import type { DetectedTarget } from './targets';

/** Opens `folder` in `target`: null once done, else why not, in the system's words. */
export type Launcher = (target: DetectedTarget, folder: string) => Promise<string | null>;

/** Where macOS keeps `open`, so finding it never depends on the PATH main inherited. */
const OPEN = '/usr/bin/open';

/**
 * The launcher a normal run uses. An app is opened by `open -a` with its
 * bundle's path, as an argument list and never a shell string, the folder
 * after `--` so nothing in it is read as an option. The file manager opens
 * the folder itself (`shell.openPath`), as a double-click would.
 */
export function createSystemLauncher(deps: {
  /** `execFile`, resolving once the command exits cleanly. */
  run(command: string, args: string[]): Promise<void>;
  /** `shell.openPath`: '' once opened, else the reason it was not. */
  openPath(folder: string): Promise<string>;
}): Launcher {
  return async (target, folder) => {
    if (target.kind === 'file-manager') return (await deps.openPath(folder)) || null;
    if (!target.appPath) return 'Consola does not know where this app is.';
    try {
      await deps.run(OPEN, ['-a', target.appPath, '--', folder]);
      return null;
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const said = typeof stderr === 'string' ? stderr.trim() : '';
      return said || (error instanceof Error ? error.message : String(error));
    }
  };
}

/** What a test run would have opened, in order. */
export interface RecordedLaunch {
  targetId: string;
  appPath?: string;
  folder: string;
}

/**
 * The launcher a test run uses, whatever it is asked: it records what would
 * have opened and opens nothing, so no test ever starts a real app. The e2e
 * reads `launches` through `exposeToTests`.
 */
export function createRecordingLauncher(): { launch: Launcher; launches: RecordedLaunch[] } {
  const launches: RecordedLaunch[] = [];
  return {
    launches,
    launch: async (target, folder) => {
      launches.push({
        targetId: target.id,
        ...(target.appPath ? { appPath: target.appPath } : {}),
        folder,
      });
      return null;
    },
  };
}
