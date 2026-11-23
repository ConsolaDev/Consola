/**
 * The Claude CLI version on which the containment canary's rows 29 to 48
 * (`apps/desktop/scripts/claude-steps-canary.mjs`, slice 3-B's plan Task 2)
 * last ran with every stop row passing, or null while no version has. A
 * write agent's card names it beside the version this Mac runs, and every
 * canary run on a new CLI sets it again.
 *
 * 2.1.330 since 2026-11-23: on 2026-11-22 every stop row passed on it but
 * rows 37 and 39 (the s3-build ledger's *3-B Task 2 records*); the
 * conductor then ruled on both (the ledger's *Conductor rulings on canary
 * rows 37 and 39*), and on 2026-11-23 both passed on 2.1.330 as ruled
 * (*3-B Task 17 records*). Row 37: the CLI's sandbox refuses `.git/config`
 * and `.git/hooks` in every folder it lets the shell write, so `git clone`
 * and `git init` are refused in a sandboxed shell, and `git status` works.
 * Row 39: a `sandbox` write agent's one `--settings` holds `sandbox` and
 * `allowedMcpServers` and no attention hooks (the CLI posts an HTTP hook
 * through the sandbox's proxy, which refuses Consola's loopback endpoint,
 * and nothing local joins `allowedDomains`), and both keys hold.
 */
export const SANDBOX_CHECKED_ON_CLAUDE: string | null = '2.1.330';
