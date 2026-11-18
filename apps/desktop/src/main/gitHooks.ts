/**
 * `env` with git's hooks turned off for every git it reaches — including the
 * ones `gh` starts — by a command-line-level config entry that beats any
 * repository or user setting. Appends to entries already in `env`.
 *
 * Everything Consola runs in a worktree whose code it did not write — a pull
 * request's checkout, a removal, a rebuild — runs with this: a repo whose
 * hooks path lives in its own tree (husky) would otherwise run the author's
 * hooks unattended.
 */
export function withoutGitHooks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${count}`]: '/dev/null',
  };
}
