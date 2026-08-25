import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PROVIDER_META } from '../../../shared/providers';
import type {
    GitProviderId,
    ProviderAccount,
    ProviderBinding,
    ProviderProbeResult,
} from '../../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { workItemUrl } from '../../../shared/workItems';
import { renderSeedHeader } from '../../../shared/workItemPrompt';
import { getLoginEnv } from '../../LoginEnvironment';
import type { GitProviderDriver } from '../GitProviderDriver';
import { INBOX_QUERY, INBOX_SEARCH_ALIASES, parseInboxPayload, searchStrings } from './inboxQuery';

const execFileAsync = promisify(execFile);

/**
 * GitHub, driven through the `gh` CLI.
 *
 * Consola stores zero GitHub credentials: `gh` owns the keyring, and this
 * driver borrows a per-account token at the moment it is needed. Tokens live
 * in memory for minutes — only so an account change is picked up promptly;
 * the tokens themselves are long-lived — and are never persisted and never
 * put on an IPC channel. There is deliberately no `gh auth switch` anywhere:
 * two workspaces on two accounts must be able to run at the same time.
 *
 * Everything gh-shaped lives here: the GraphQL fetch, `gh pr checkout`,
 * `gh repo clone`, remote-URL matching, the seed header. The services above
 * only ever see the GitProviderDriver interface.
 */

const BINARY_NAME = 'gh';
const RUN_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const WEB_HOST = 'github.com';

interface RunResult {
    stdout: string;
    stderr: string;
    failed: boolean;
    errorMessage?: string;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Trim `gh version 2.63.1 (2026-01-15)` down to the version itself. */
function parseVersion(stdout: string): string | undefined {
    const match = stdout.match(/gh version (\S+)/);
    return match?.[1];
}

/**
 * The accounts `gh auth status` lists, with their active flags.
 *
 * Parsed line-by-line: an account line opens an entry and the following
 * `Active account:` line closes it. The masked token lines are deliberately
 * never captured — this result crosses IPC.
 */
function parseAccounts(text: string): ProviderAccount[] {
    const accounts: ProviderAccount[] = [];
    for (const line of text.split('\n')) {
        const login = line.match(/Logged in to \S+ account (\S+)/);
        if (login) {
            accounts.push({ login: login[1], active: false });
            continue;
        }
        const active = line.match(/Active account:\s*(true|false)/);
        if (active && accounts.length > 0) {
            accounts[accounts.length - 1].active = active[1] === 'true';
        }
    }
    return accounts;
}

/**
 * Drop any line that could carry a credential, for text that ends up in
 * `ProviderProbeResult.error` or an InboxSnapshot's error — both cross IPC.
 *
 * `parseAccounts` only recognizes today's `gh auth status` wording; a future
 * or unusual wording could slip past it while the masked `Token:` line is
 * still present, so the fallback text is scrubbed independently of parsing
 * rather than trusted just because parsing found nothing. Matches gh's own
 * credential-label lines (`Token:` / `Token scopes:`, anchored to the start
 * of the line so only the label counts) and any line carrying a raw or
 * masked token value (gh's `gho_`/`ghp_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`
 * prefixes) — deliberately NOT the bare word "token" anywhere in a line: gh
 * uses that word in genuine, non-secret diagnostics too (e.g. "no oauth
 * token found for account X"), and matching it unconditionally would drop
 * that useful text, pushing callers toward a less-safe, unscrubbed fallback
 * — which is exactly the failure mode this function exists to prevent.
 */
function stripTokenLines(text: string): string {
    return text
        .split('\n')
        .filter(
            (line) =>
                !/^\s*[-*]?\s*tokens?\s*(scopes?)?\s*:/i.test(line) &&
                !/\bgh[oprsu]_|\bgithub_pat_/i.test(line)
        )
        .join('\n')
        .trim();
}

/**
 * Node's `execFile` prefixes a non-zero-exit error's `message` with
 * `Command failed: <argv>` — an echo of the argv we already built ourselves,
 * never new information, and for `gh auth token` it always names the
 * "token" subcommand, which `stripTokenLines`'s label match deliberately
 * leaves alone as ordinary text. Dropped unconditionally before an error
 * message is used as a scrub source, so it never reintroduces the bare word
 * "token" (or, for a command with a query argument, that argument) into a
 * user-facing message.
 */
function stripCommandEcho(message: string): string {
    return message.replace(/^Command failed:.*(\n|$)/, '');
}

/**
 * `owner/repo` (lowercased) from a git remote URL that names github.com, or
 * null for anything else.
 *
 * Lowercased because GitHub treats repo names case-insensitively while
 * remembering the display casing — a clone made from a differently-cased URL
 * must still resolve. The host is checked because the same owner/name on
 * another host is a different repository entirely, and matching it would
 * point an agent's `gh` calls at the wrong one.
 */
function parseGitHubRemote(url: string): string | null {
    const trimmed = url.trim().replace(/\.git$/, '');
    if (!trimmed) return null;
    // scp-style: git@github.com:owner/repo
    const scp = trimmed.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
    // url-style: https://github.com/owner/repo or ssh://git@github.com/owner/repo
    const web = trimmed.match(/^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
    const host = (scp?.[1] ?? web?.[1])?.toLowerCase();
    const repoPath = (scp?.[2] ?? web?.[2])?.replace(/^\/+/, '');
    if (host !== WEB_HOST || !repoPath) return null;
    const parts = repoPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

export class GitHubDriver implements GitProviderDriver {
    readonly id: GitProviderId = 'github';
    readonly tokenEnvVar = 'GH_TOKEN';

    private readonly tokenCache = new Map<string, { token: string; fetchedAt: number }>();

    constructor(
        private readonly getEnv: () => NodeJS.ProcessEnv = getLoginEnv,
        private readonly tokenTtlMs: number = TOKEN_TTL_MS
    ) {}

    /**
     * Whether `gh` is installed, its version, and the keyring accounts.
     *
     * Feeds the binding panel's account picker and its "install gh" empty
     * state. Deliberately uncached: it runs when the panel opens, and
     * installing `gh` or running `gh auth login` must take effect without an
     * app restart.
     */
    public async probe(): Promise<ProviderProbeResult> {
        const binary = this.resolveBinary();
        if (!binary) {
            return {
                available: false,
                accounts: [],
                error: '`gh` is not installed or not on PATH.',
            };
        }

        const version = await this.run(binary, ['--version']);
        if (version.failed) {
            return {
                available: false,
                resolvedBinary: binary,
                accounts: [],
                // Both sources scrubbed: errorMessage embeds stderr verbatim
                // (via Node's "Command failed: ..." wrapping), so leaving it
                // raw would undo the scrub the moment stderr alone reduces
                // to nothing.
                error:
                    stripTokenLines(version.stderr) ||
                    stripTokenLines(stripCommandEcho(version.errorMessage ?? '')) ||
                    `\`${binary}\` did not run.`,
            };
        }

        // `gh auth status` exits non-zero and writes to stderr when nobody is
        // signed in (and historically wrote its report to stderr even on
        // success), so both streams are parsed and a failure is not fatal.
        const status = await this.run(binary, ['auth', 'status']);
        const accounts = parseAccounts(`${status.stdout}\n${status.stderr}`);

        return {
            available: true,
            resolvedBinary: binary,
            version: parseVersion(version.stdout),
            accounts,
            // Scrubbed rather than raw: this field crosses IPC, and a gh
            // version whose account-line wording parseAccounts doesn't
            // recognize would otherwise carry its masked `Token:` line
            // straight through here.
            ...(accounts.length === 0
                ? {
                      error:
                          stripTokenLines(`${status.stderr}\n${status.stdout}`) ||
                          'No GitHub accounts are signed in. Run `gh auth login`.',
                  }
                : {}),
        };
    }

    /**
     * A token for one keyring account, via `gh auth token --user <login>`.
     *
     * Cached in memory for a few minutes and nowhere else. Throws with gh's
     * own stderr on failure — the caller decides how to degrade.
     */
    public async token(accountLogin: string): Promise<string> {
        const cached = this.tokenCache.get(accountLogin);
        if (cached && Date.now() - cached.fetchedAt < this.tokenTtlMs) {
            return cached.token;
        }

        const binary = this.resolveBinary();
        if (!binary) {
            throw new Error('`gh` is not installed or not on PATH.');
        }

        const result = await this.run(binary, ['auth', 'token', '--user', accountLogin]);
        if (result.failed) {
            // Scrubbed like probe()'s failures, and both sources scrubbed
            // for the same reason: this error reaches InboxService's
            // InboxSnapshot.error, which is broadcast to every renderer, so
            // no raw subprocess text may cross that line — including via
            // errorMessage's verbatim copy of stderr once stderr alone
            // scrubs to nothing (e.g. stderr that is only a masked token
            // line). The literal fallback deliberately avoids the word
            // "token" itself, so a rejection is never mistaken for a leak.
            throw new Error(
                stripTokenLines(result.stderr) ||
                    stripTokenLines(stripCommandEcho(result.errorMessage ?? '')) ||
                    `gh could not authenticate ${accountLogin}.`
            );
        }

        const token = result.stdout.trim();
        if (!token) {
            throw new Error(`gh returned an empty token for ${accountLogin}.`);
        }

        this.tokenCache.set(accountLogin, { token, fetchedAt: Date.now() });
        return token;
    }

    /**
     * One `gh api graphql` call, five searches, parsed into neutral items.
     *
     * `env` is the caller's composed environment — the login env plus
     * GH_TOKEN — so the request runs as the workspace's account rather than
     * whatever the keyring considers active. The flag list is derived from
     * INBOX_SEARCH_ALIASES so the query, the parser and this argv cannot
     * drift apart. Parse failures propagate: an unrecognised reply must
     * never read as an empty inbox.
     */
    public async fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]> {
        const searches = searchStrings(binding.accountLogin, binding.org);
        const args = ['api', 'graphql', '-f', `query=${INBOX_QUERY}`];
        for (const alias of INBOX_SEARCH_ALIASES) {
            args.push('-f', `${alias}=${searches[alias]}`);
        }
        const stdout = await this.exec(args, env);
        return parseInboxPayload(JSON.parse(stdout));
    }

    /**
     * `gh pr checkout <n>` inside the worktree — gh owns the branch naming
     * and the fetch, with GH_TOKEN in `env`. An issue has no branch on
     * GitHub to fetch; WorktreeService creates its local `consola/issue-<n>`
     * branch itself, so for an issue there is nothing to do here.
     */
    public async checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<void> {
        if (ref.type !== 'pr') return;
        await this.exec(['pr', 'checkout', String(ref.number)], env, worktreeDir);
    }

    /**
     * `gh repo clone` rather than bare `git clone`: gh authenticates from
     * GH_TOKEN in the subprocess env, so private repos clone as the
     * workspace's account and Consola still stores zero credentials.
     */
    public async cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void> {
        await this.exec(['repo', 'clone', repo, destinationDir], env);
    }

    public matchesRemote(remoteUrl: string, repo: string): boolean {
        return parseGitHubRemote(remoteUrl) === repo.toLowerCase();
    }

    public workItemUrl(ref: WorkItemRef): string {
        return workItemUrl(ref);
    }

    public seedHeader(ref: WorkItemRef, item?: InboxItem): string {
        return renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, ref, item);
    }

    /**
     * Absolute path to `gh`, or null when nothing was found.
     *
     * `CONSOLA_GH_PATH` wins first — the seam the unit tests and the
     * Playwright rig use to point at a stub `gh` without touching the real
     * PATH or a real install. Otherwise this searches the login-shell PATH
     * like every binary Consola drives: a Dock-launched app inherits a
     * minimal environment, and getLoginEnv restores whatever the user's shell
     * profile puts on PATH — including Homebrew.
     *
     * Deliberately uncached (both branches) so installing `gh`, or changing
     * the override, takes effect without a restart.
     */
    private resolveBinary(): string | null {
        // No hardcoded fallback locations (unlike ClaudeDriver): getLoginEnv
        // already reproduces the user's real PATH, and machine-wide fallbacks
        // would make "gh is absent" untestable — and would override a user's
        // intentional PATH choice.
        const override = process.env.CONSOLA_GH_PATH;
        if (override) return override;

        const searchPath = this.getEnv().PATH ?? '';
        for (const dir of searchPath.split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, BINARY_NAME);
            if (isExecutable(candidate)) return candidate;
        }
        return null;
    }

    /** probe/token: run in the ambient login env, never throw, hand back both streams. */
    private run(binary: string, args: string[]): Promise<RunResult> {
        return new Promise((resolve) => {
            execFile(
                binary,
                args,
                {
                    env: this.getEnv() as { [key: string]: string },
                    timeout: RUN_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout, stderr) =>
                    resolve({
                        stdout,
                        stderr,
                        failed: error !== null,
                        errorMessage: error?.message,
                    })
            );
        });
    }

    /**
     * fetch/checkout/clone: run in the caller's composed env, surfacing
     * stderr as the Error message.
     *
     * The binary is resolved fresh on every call — a PATH scan is a handful
     * of stat calls — so CONSOLA_GH_PATH and a newly installed gh both take
     * effect at once. A bare `gh` when nothing resolves lets the spawn fail
     * loudly rather than inventing a location.
     */
    private async exec(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
        const binary = this.resolveBinary() ?? BINARY_NAME;
        try {
            const { stdout } = await execFileAsync(binary, args, {
                cwd,
                env: env as { [key: string]: string },
                maxBuffer: 10 * 1024 * 1024,
                // Unlike run(), this used to have no timeout: a hung `gh api
                // graphql` (or any exec caller) would pin
                // InboxService.inFlight[workspaceId] forever.
                timeout: 60_000,
            });
            return stdout;
        } catch (error) {
            const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim() ?? '';
            const exitCode = (error as { code?: number | string }).code;
            // Scrubbed like probe()/token(): fetchInbox's rejection can
            // become InboxSnapshot.error, broadcast to every renderer, and
            // all three callers run with GH_TOKEN in `env`. The fallback
            // deliberately never falls back to error.message: that embeds
            // the full argv (fetchInbox's is a multi-KB GraphQL document),
            // so it names only the verb/noun that was run and gh's exit
            // code instead.
            throw new Error(
                stripTokenLines(stderr) ||
                    `gh ${args.slice(0, 2).join(' ')} failed${
                        exitCode !== undefined ? ` (exit ${exitCode})` : ''
                    }.`
            );
        }
    }
}
