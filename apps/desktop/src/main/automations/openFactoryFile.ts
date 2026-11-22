import fs from 'node:fs';
import path from 'node:path';
import { FactoryFolder } from '@consola/automation-engine';

/** How a factory file reaches the person's editor. */
export interface OpenFactoryFileDeps {
  platform: NodeJS.Platform;
  /** Runs a program with its arguments, never through a shell: macOS's `open -t`. */
  execFile: (file: string, args: string[]) => Promise<void>;
}

const GONE = 'That file is not there any more.';
const OWN_FILES =
  "Open shows only the factory's own files: factory.yml, automations/<name>.yaml, agents/<name>.md and skills/<name>/SKILL.md.";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Open one of a factory folder's files (`relative` names it in the words),
 * which `factoryFilePath` has already accepted by its path. A file of the
 * folder can be a link (kept with dotfiles; from slice 6 the folder holds
 * other people's files), and the OS default handler runs a `.command`, an
 * app or a script it is handed, so a click must never launch anything.
 * Every link is resolved first, and only a regular file whose real path is
 * one of the factory's own files (what its reader reads, by
 * `FactoryFolder.pathOf`'s rule) inside the folder's real path opens, and
 * only as text: `open -t` on macOS, through `execFile`, never a shell.
 * Nothing goes to the default handler: elsewhere the person is given the
 * path to open in their editor.
 */
export async function openFactoryFile(
  folderPath: string,
  filePath: string,
  relative: string,
  deps: OpenFactoryFileDeps,
): Promise<void> {
  let real: string;
  let realFolder: string;
  try {
    real = fs.realpathSync(filePath);
    realFolder = fs.realpathSync(folderPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(GONE);
    throw error;
  }
  const inside = path.relative(realFolder, real);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(
      `Not opened: \`${relative}\` leads outside this factory's folder; ${OWN_FILES}`,
    );
  }
  // What it really is, by the reader's own names: no dotfile, run folder or stray file.
  const own = inside.split(path.sep).join('/');
  if (new FactoryFolder(realFolder).pathOf(own) === null) {
    throw new Error(`Not opened: \`${relative}\` leads to \`${own}\`. ${OWN_FILES}`);
  }
  // The resolved path itself: no directory, socket, device or pipe.
  if (!fs.lstatSync(real).isFile()) {
    throw new Error(
      `Not opened: \`${relative}\` is not a regular file; Open shows only the folder's own text files.`,
    );
  }
  if (deps.platform !== 'darwin') throw new Error(`Open it in your editor: ${real}`);
  await deps.execFile('open', ['-t', real]);
}
