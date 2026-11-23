import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTest } from '../test-mode';

/**
 * The one place the real secret programs are named (rule 5a-secrets). Outside
 * a test run the keychain is always `/usr/bin/security`, by that path, and
 * 1Password is the `op` found on the login `PATH` when the person bound the
 * reference, by the path kept with the binding: neither is ever looked up on
 * `PATH` at read time. In a test run the answer is a stub's path
 * (`CONSOLA_E2E_SECURITY`, `CONSOLA_E2E_OP`) or nothing, so a test that
 * forgot its stub fails with words instead of reaching the person's keychain.
 */

export const KEYCHAIN_PROGRAM = '/usr/bin/security';

export interface SecretPrograms {
  /** The keychain program, or null when this run may read none (a test run with no stub). */
  keychain: string | null;
  /** The 1Password program for a binding that kept `bound`, or null. */
  onePassword(bound: string | undefined): string | null;
  /** Where `op` is on `loginPath`, at bind time (Call 13), or null. */
  findOnePassword(loginPath: string | undefined): string | null;
}

/** Whether `file` is a regular file this process may run. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `<dir>/<name>` on `pathValue` that is an executable regular file.
 * Empty and relative segments are skipped: a binding keeps an absolute path,
 * and a reader runs nothing else.
 */
export function findOnPath(
  name: string,
  pathValue: string | undefined,
  isExecutable: (path: string) => boolean,
): string | null {
  for (const dir of (pathValue ?? '').split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Defaults are `test = isTest` and `env = process.env` (as `automationsTickMs`
 * takes them, `test-mode.ts`), so a call with no argument can never mean "not
 * a test run" inside one (review M7).
 */
export function secretPrograms(
  options: {
    test?: boolean;
    env?: NodeJS.ProcessEnv;
    isExecutable?: (path: string) => boolean;
  } = {},
): SecretPrograms {
  const test = options.test ?? isTest;
  const env = options.env ?? process.env;
  if (test) {
    const keychain = env.CONSOLA_E2E_SECURITY || null;
    const onePassword = env.CONSOLA_E2E_OP || null;
    return {
      keychain,
      onePassword: () => onePassword,
      findOnePassword: () => onePassword,
    };
  }
  const isExecutable = options.isExecutable ?? isExecutableFile;
  return {
    keychain: KEYCHAIN_PROGRAM,
    onePassword: (bound) => bound ?? null,
    findOnePassword: (loginPath) => findOnPath('op', loginPath, isExecutable),
  };
}
