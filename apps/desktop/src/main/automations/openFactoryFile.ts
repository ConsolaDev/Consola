import fs from 'node:fs';
import path from 'node:path';
import { FactoryFolder, locateInFolder } from '@consola/automation-engine';

/** How a factory file reaches the person's editor. */
export interface OpenFactoryFileDeps {
  platform: NodeJS.Platform;
  /** Runs a program with its arguments, never through a shell: macOS's `/usr/bin/open -t`. */
  execFile: (file: string, args: string[]) => Promise<void>;
  /** Shows a file in its folder in the OS's file manager, opening nothing: Electron's `shell.showItemInFolder`. */
  reveal: (file: string) => void;
}

const GONE = 'That file is not there any more.';
/** macOS's own `open`, by its path: never whatever `open` a PATH (a dev shell's, say) finds first. */
const MAC_OPEN = '/usr/bin/open';
const OWN_FILES =
  "Open shows only the factory's own files: factory.yml, automations/<name>.yaml, agents/<name>.md and skills/<name>/SKILL.md.";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Open one of a factory folder's files (`relative` names it in the words),
 * which `factoryFilePath` has already accepted by its path. A file of the
 * folder can be a link (one that stays inside it; from slice 6 the folder
 * holds other people's files), and the OS default handler runs a
 * `.command`, an app or a script it is handed, so a click must never launch
 * anything. Every link is resolved first, by the reader's own rule
 * (`locateInFolder`), and only a regular file whose real path is one of the
 * factory's own files (what its reader reads, by `FactoryFolder.pathOf`'s
 * rule) inside the folder's real path opens, and only as text: `/usr/bin/open -t` on
 * macOS, through `execFile`, never a shell. Nothing goes to the default
 * handler: elsewhere the file is shown in its folder (`reveal`), which
 * launches nothing, for the person to open in their editor.
 */
export async function openFactoryFile(
  folderPath: string,
  filePath: string,
  relative: string,
  deps: OpenFactoryFileDeps,
): Promise<void> {
  // The reader's own rule: a link may stay inside the folder, never leave it.
  let located: ReturnType<typeof locateInFolder>;
  try {
    located = locateInFolder(folderPath, filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(GONE);
    throw error;
  }
  if (located === null) throw new Error(GONE);
  const { real, realFolder } = located;
  if (!located.inside) {
    throw new Error(
      `Not opened: \`${relative}\` leads outside this factory's folder; ${OWN_FILES}`,
    );
  }
  // What it really is, by the reader's own names: no dotfile, run folder or stray file.
  const own = path.relative(realFolder, real).split(path.sep).join('/');
  if (new FactoryFolder(realFolder).pathOf(own) === null) {
    throw new Error(`Not opened: \`${relative}\` leads to \`${own}\`. ${OWN_FILES}`);
  }
  // The resolved path itself: no directory, socket, device or pipe.
  if (!fs.lstatSync(real).isFile()) {
    throw new Error(
      `Not opened: \`${relative}\` is not a regular file; Open shows only the folder's own text files.`,
    );
  }
  if (deps.platform !== 'darwin') {
    deps.reveal(real);
    return;
  }
  await deps.execFile(MAC_OPEN, ['-t', real]);
}
