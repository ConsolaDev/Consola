import * as path from 'node:path';
import { looksLikeCredential } from '@consola/factory-spec';

/**
 * What a `sandbox` write step's session gets from the person's environment
 * (slice 3-B Task 18, containment row 15): these names, then every `LC_*`
 * present. `USER` and `LOGNAME` are here because Claude finds its sign-in
 * in the keychain under the user's name (canary row 37; the conductor's
 * ruling 3).
 */
export const SANDBOX_BASE_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TERM',
  'LANG',
  'TMPDIR',
] as const;

/** Git's names a step never gets (review NB1): its git finds the run clone through the checkout's pointer. */
const GIT_FOLDER_NAMES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']);

/**
 * The allow-list: the base names and `LC_*` from `login`; the harness's
 * config variable with its **effective** value (`harness.value`, else
 * `login[harness.envVar]` when set, review B2: a harness that pins nothing
 * runs on the ambient profile); each of `names` present in `login` (never
 * one `looksLikeCredential` matches); the caches under
 * `<checkout>/.consola-cache/` (`XDG_CACHE_HOME`, `npm_config_cache`,
 * `npm_config_store_dir` for pnpm 10, `pnpm_config_store_dir` for pnpm 11
 * on, `YARN_CACHE_FOLDER`, review S10). A sandboxed shell reads no
 * `~/.npmrc` (it is on the deny list): pnpm and npm fall back to their
 * defaults. Never `GIT_DIR`,
 * `GIT_WORK_TREE` or `GIT_COMMON_DIR`, not even the login environment's
 * (review NB1: the session's git finds the run clone's folder through the
 * checkout's pointer, which Consola checks before the spawn; exported, they
 * would break `git clone` and aim git in any other repository at the run's
 * clone). `passed` and `missing` are `names` as the login environment had
 * and lacked them.
 */
export function sandboxSessionEnv(
  login: NodeJS.ProcessEnv,
  harness: { envVar?: string; value?: string },
  names: readonly string[],
  checkout: string,
): { env: NodeJS.ProcessEnv; passed: string[]; missing: string[] } {
  const env: NodeJS.ProcessEnv = {};
  // Only the fixed base names and `LC_*` come through here: none is a git folder variable.
  const take = (name: string) => {
    const value = login[name];
    if (value !== undefined) env[name] = value;
  };
  for (const name of SANDBOX_BASE_NAMES) take(name);
  for (const name of Object.keys(login)) if (name.startsWith('LC_')) take(name);
  const passed: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (GIT_FOLDER_NAMES.has(name) || looksLikeCredential(name)) {
      missing.push(name);
      continue;
    }
    if (login[name] === undefined) missing.push(name);
    else {
      env[name] = login[name];
      passed.push(name);
    }
  }
  if (harness.envVar) {
    const profile = harness.value ?? login[harness.envVar];
    if (profile !== undefined) env[harness.envVar] = profile;
  }
  const cache = path.join(checkout, '.consola-cache');
  env.XDG_CACHE_HOME = cache;
  env.npm_config_cache = path.join(cache, 'npm');
  env.npm_config_store_dir = path.join(cache, 'pnpm-store');
  // pnpm 11 on reads its own name and ignores npm's (pnpm 12.21.0 seen, the 3-B code review's F12).
  env.pnpm_config_store_dir = path.join(cache, 'pnpm-store');
  env.YARN_CACHE_FOLDER = path.join(cache, 'yarn');
  return { env, passed, missing };
}
