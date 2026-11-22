/**
 * The rules for an environment variable's name that `env:` and `secrets:`
 * share: the pattern, and the names and prefixes refused because they make a
 * program run a value. Its own module so `steps.ts` and `secrets.ts` both read
 * it without importing each other.
 */

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `env:` names that make a program run a value: a shell sources a file or runs
 * a string, git or ssh starts a program, a loader or runtime loads code, or
 * the value picks which program runs. `BASH_ENV: "{{steps.review.handover.file}}"`
 * would have bash source a file an agent wrote from a pull request's text.
 * Refused outright, templated or not: a value must stay data, and a command
 * that needs one sets it inside `run:`, where it reads as the code it is.
 *
 * A denylist cannot name every such variable, so it says only what it
 * refuses: these exact names, every name with one of `REFUSED_ENV_PREFIXES`
 * but `ENV_PREFIX_EXCEPTIONS`. Names a prefix covers are not repeated here.
 */
export const REFUSED_ENV_NAMES = [
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS4',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'HOME',
  'ZDOTDIR',
  'SSH_ASKPASS',
  'PAGER',
  'EDITOR',
  'VISUAL',
  'BROWSER',
  'LESSOPEN',
  'LESSCLOSE',
  'GCONV_PATH',
  '_JAVA_OPTIONS',
  'PATH',
] as const;

/**
 * Prefixes `env:` refuses every name with: loaders (`LD_`, `DYLD_`), runtimes
 * (`PYTHON`, `PERL`, `RUBY`, `NODE_`, `JAVA_`, `NPM_CONFIG_`), where programs
 * find their configuration (`XDG_`), and git's and gh's own (`GIT_`, `GH_`).
 * `NPM_CONFIG_` matches in any case, as npm reads `npm_config_*` too; the
 * rest match as written. (Git's `GIT_CONFIG_COUNT` from the login
 * environment still reaches a command; the engine appends its hooks-off
 * entry after it.)
 */
export const REFUSED_ENV_PREFIXES = [
  'LD_',
  'DYLD_',
  'PYTHON',
  'PERL',
  'RUBY',
  'NODE_',
  'JAVA_',
  'NPM_CONFIG_',
  'XDG_',
  'GIT_',
  'GH_',
] as const;

/** Names a refused prefix lets through: gh's token and host are data. */
export const ENV_PREFIX_EXCEPTIONS = ['GH_TOKEN', 'GH_HOST'] as const;

/** Prefixes matched in any case. */
const CASELESS_ENV_PREFIXES: ReadonlySet<string> = new Set(['NPM_CONFIG_']);

/** Whether `env:` refuses a name: one of `REFUSED_ENV_NAMES`, or a refused prefix's that is not an exception. */
export function isRefusedEnvName(name: string): boolean {
  if ((REFUSED_ENV_NAMES as readonly string[]).includes(name)) return true;
  if ((ENV_PREFIX_EXCEPTIONS as readonly string[]).includes(name)) return false;
  return REFUSED_ENV_PREFIXES.some((prefix) =>
    CASELESS_ENV_PREFIXES.has(prefix)
      ? name.toUpperCase().startsWith(prefix)
      : name.startsWith(prefix),
  );
}

/** What `env:` refuses, as its refusal lists it (its own refusal of `ENV_PREFIX_EXCEPTIONS` is `GH_IDENTITY_ENV_REASON`'s). */
export const REFUSED_ENV_LIST = `${REFUSED_ENV_NAMES.join(', ')}, and every name matching ${REFUSED_ENV_PREFIXES.map((prefix) => `${prefix}*`).join(', ')}`;
