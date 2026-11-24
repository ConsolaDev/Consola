import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** scutil answers at once; a hung one hands over to the host name. */
const SCUTIL_TIMEOUT_MS = 2000;

/** Where macOS keeps scutil, so finding it never depends on the PATH main inherited. */
const SCUTIL = '/usr/sbin/scutil';

/**
 * The name this computer goes by. On a Mac that is the one the person gave it
 * in System Settings (`scutil --get ComputerName`), not its network name. Off
 * a Mac, or when scutil fails or says nothing, it is the host name less a
 * `.local` suffix, on every platform. Null when neither has a name.
 *
 * The first answer is kept for the run: renaming the computer while Consola
 * runs is not worth a process on every read.
 */
export function createComputerNameReader(deps: {
  platform: NodeJS.Platform;
  run(command: string, args: string[]): Promise<string>;
  hostname(): string;
}): () => Promise<string | null> {
  const read = async (): Promise<string | null> => {
    if (deps.platform === 'darwin') {
      const named = await deps.run(SCUTIL, ['--get', 'ComputerName']).then(
        (stdout) => stdout.trim(),
        () => '',
      );
      if (named) return named;
    }
    const host = deps.hostname().trim();
    return host.replace(/\.local$/i, '') || null;
  };
  let answer: Promise<string | null> | undefined;
  return () => {
    answer ??= read().catch(() => null);
    return answer;
  };
}

export const readComputerName = createComputerNameReader({
  platform: process.platform,
  run: async (command, args) =>
    (await execFileAsync(command, args, { timeout: SCUTIL_TIMEOUT_MS })).stdout,
  hostname: os.hostname,
});
