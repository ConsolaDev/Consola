import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A hung git (a stale lock on a network drive) must not hold a panel or a header hostage. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Git's environment for a read: it never asks the person anything
 * (`GIT_TERMINAL_PROMPT=0`), and a partial clone never fetches, unasked, an
 * object it is missing from the remote it was cloned from
 * (`GIT_NO_LAZY_FETCH=1`, which git honours from 2.44; an older git ignores
 * it and fetches).
 */
const READ_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };

/**
 * One git read in `dir`: its output, trimmed, or null when there is none to
 * give. Null covers every way a read can come back empty-handed: git said no
 * (no such ref, not a repository), git is missing, it ran past the timeout,
 * or it wrote more than `maxBuffer` (Node's 1 MiB unless the caller makes
 * room). A caller that has to tell those apart cannot use this.
 */
export async function readGit(
  dir: string,
  args: string[],
  options: { maxBuffer?: number } = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, ...READ_ENV },
      ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
