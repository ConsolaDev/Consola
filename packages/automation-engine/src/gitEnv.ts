/**
 * `env` with git's hooks turned off for every git it reaches — including the
 * ones `gh` starts — by a command-line-level config entry that beats any
 * repository or user setting. Appends to entries already in `env`.
 */
export function withoutGitHooks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Only a plain count is one to append to. Anything else (`-1`, `2.5`, `abc`)
  // counts as none, so the entry below is always one git reads.
  const written = env.GIT_CONFIG_COUNT ?? '0';
  const count =
    /^\d+$/.test(written) && Number.isSafeInteger(Number(written)) ? Number(written) : 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${count}`]: '/dev/null',
  };
}
