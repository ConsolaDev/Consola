/**
 * `env` with git's hooks turned off for every git it reaches — including the
 * ones `gh` starts — by a command-line-level config entry that beats any
 * repository or user setting. Appends to entries already in `env`.
 *
 * Everything Consola runs in a worktree whose code it did not write — a pull
 * request's checkout, a removal, a rebuild — runs with this: a repo whose
 * hooks path lives in its own tree (husky) would otherwise run the author's
 * hooks unattended.
 *
 * The one implementation lives in the automation engine, whose steps runs
 * need it too; this path is kept for the desktop's callers.
 */
export { withoutGitHooks } from '@consola/automation-engine';
