import fs from 'node:fs';
import path from 'node:path';

/** How a factory file reaches the person's editor. */
export interface OpenFactoryFileDeps {
  platform: NodeJS.Platform;
  /** Runs a program with its arguments, never through a shell: macOS's `open -t`. */
  execFile: (file: string, args: string[]) => Promise<void>;
  /** The OS opener, elsewhere (Electron's `shell.openPath`): an error message, or empty. */
  openPath: (filePath: string) => Promise<string>;
}

const GONE = 'That file is not there any more.';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Open one of a factory folder's files (`relative` names it in the words),
 * which `factoryFilePath` has already accepted by its path. The OS opener
 * runs whatever it is handed with that file's default handler, and a file
 * of the folder can be a link (kept with dotfiles; from slice 6 the folder
 * holds other people's files), so a click must never launch what a link
 * points at: the path is resolved first, and only a regular file whose real
 * path is inside the folder's real path opens. On macOS it opens as text
 * (`open -t`), never through its default handler; elsewhere the OS opener
 * gets the real path, of a file proven to be the folder's own text.
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
      `Not opened: \`${relative}\` leads outside this factory's folder; Open shows only the folder's own files.`,
    );
  }
  // The resolved path itself: no directory, socket, device or pipe.
  if (!fs.lstatSync(real).isFile()) {
    throw new Error(
      `Not opened: \`${relative}\` is not a regular file; Open shows only the folder's own text files.`,
    );
  }
  if (deps.platform === 'darwin') {
    await deps.execFile('open', ['-t', real]);
    return;
  }
  const failure = await deps.openPath(real);
  if (failure) throw new Error(failure);
}
