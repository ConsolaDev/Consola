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

/**
 * Variables that aim git at another repository, index or object store than
 * the folder it runs in. A login shell may export one; in a checkout that is
 * reset, it would reset someone else's.
 */
const GIT_REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/** `env` without the variables that aim git at another repository than the folder it runs in. */
export function withoutRepositoryOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of GIT_REPOSITORY_VARIABLES) delete clean[name];
  return clean;
}
