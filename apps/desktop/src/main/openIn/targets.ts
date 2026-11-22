import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenInTarget } from '../../shared/openIn';

/** Finder, which every Mac has: offered without looking for it. */
export const FINDER_PATH = '/System/Library/CoreServices/Finder.app';

/** One app a folder can be opened in, as main found it: where its bundle is. */
export interface DetectedTarget extends Omit<OpenInTarget, 'icon'> {
  /** The bundle found (an app) or Finder's; absent for a file manager off macOS. */
  appPath?: string;
}

/**
 * The apps a session's folder can be opened in on a Mac: main's id for
 * each, its name, and every `.app` bundle name it installs under (an edition
 * or a channel the person may have instead), in the order the menu lists
 * them. Finder is not here: it is always offered, after these.
 */
const MAC_APPS: ReadonlyArray<{ id: string; label: string; bundles: readonly string[] }> = [
  { id: 'vscode', label: 'VS Code', bundles: ['Visual Studio Code.app'] },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    bundles: ['Visual Studio Code - Insiders.app'],
  },
  { id: 'cursor', label: 'Cursor', bundles: ['Cursor.app'] },
  { id: 'windsurf', label: 'Windsurf', bundles: ['Windsurf.app'] },
  { id: 'zed', label: 'Zed', bundles: ['Zed.app'] },
  { id: 'sublime-text', label: 'Sublime Text', bundles: ['Sublime Text.app'] },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    bundles: [
      'IntelliJ IDEA.app',
      'IntelliJ IDEA Ultimate.app',
      'IntelliJ IDEA CE.app',
      'IntelliJ IDEA Community Edition.app',
    ],
  },
  { id: 'webstorm', label: 'WebStorm', bundles: ['WebStorm.app'] },
  {
    id: 'pycharm',
    label: 'PyCharm',
    bundles: [
      'PyCharm.app',
      'PyCharm Professional Edition.app',
      'PyCharm CE.app',
      'PyCharm Community Edition.app',
    ],
  },
  { id: 'goland', label: 'GoLand', bundles: ['GoLand.app'] },
  { id: 'xcode', label: 'Xcode', bundles: ['Xcode.app'] },
];

const FINDER: DetectedTarget = {
  id: 'finder',
  label: 'Finder',
  kind: 'file-manager',
  appPath: FINDER_PATH,
};

/**
 * Off macOS only the file manager is offered: the editors above install
 * under names and places of their own on Windows and Linux, which nothing
 * here knows yet. `shell.openPath` opens the folder in whichever file
 * manager the system has.
 */
const FILE_MANAGER: DetectedTarget = {
  id: 'file-manager',
  label: 'File Manager',
  kind: 'file-manager',
};

/**
 * Where a Mac's apps are: the system-wide folder, the person's own (where
 * JetBrains Toolbox puts its IDEs) and the system's own apps.
 */
export function applicationDirs(home: string): string[] {
  return ['/Applications', path.join(home, 'Applications'), '/System/Applications'];
}

async function isBundle(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The apps on this computer a folder can be opened in, in the menu's order,
 * the file manager last. An app counts once, as the first bundle found for
 * it, looking through `dirs` in order and its bundle names in order.
 */
export async function detectTargets(options: {
  platform: NodeJS.Platform;
  /** Where to look for apps, in order (`applicationDirs`). */
  dirs: readonly string[];
}): Promise<DetectedTarget[]> {
  if (options.platform !== 'darwin') return [FILE_MANAGER];
  const found = await Promise.all(
    MAC_APPS.map(async (app): Promise<DetectedTarget | null> => {
      for (const dir of options.dirs) {
        for (const bundle of app.bundles) {
          const appPath = path.join(dir, bundle);
          if (await isBundle(appPath)) {
            return { id: app.id, label: app.label, kind: 'app', appPath };
          }
        }
      }
      return null;
    }),
  );
  return [...found.filter((target): target is DetectedTarget => target !== null), FINDER];
}
