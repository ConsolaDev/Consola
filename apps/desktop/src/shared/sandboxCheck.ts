/**
 * The Claude CLI version on which the containment canary's rows 29 to 48
 * (`apps/desktop/scripts/claude-steps-canary.mjs`, slice 3-B's plan Task 2)
 * last ran with every stop row passing, or null while no version has. A
 * write agent's card names it beside the version this Mac runs, and every
 * canary run on a new CLI sets it again.
 *
 * Null since the run of 2026-11-22 on 2.1.330 (rows 29 to 48, the
 * s3-build ledger's *3-B Task 2 records*): every stop row passed but two.
 * Row 37: the CLI's sandbox refuses `.git/config` and `.git/hooks` in every
 * folder it lets the shell write, so `git clone` and `git init` fail in a
 * sandboxed shell. Row 39: the CLI sends an HTTP hook through the sandbox's
 * proxy, which refuses `127.0.0.1` unless `network.allowedDomains` names
 * its host and port, so a write agent's attention hooks never arrive.
 */
export const SANDBOX_CHECKED_ON_CLAUDE: string | null = null;
