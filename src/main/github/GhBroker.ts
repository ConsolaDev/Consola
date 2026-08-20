import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLoginEnv } from '../LoginEnvironment';
import type { GhAccount, GhProbeResult } from '../../shared/github';

/**
 * The `gh` CLI as Consola's GitHub credential broker.
 *
 * Consola stores zero GitHub credentials: `gh` owns the keyring, and this
 * broker borrows a per-account token at the moment it is needed. Tokens live
 * in memory for minutes — only so an account change is picked up promptly;
 * the tokens themselves are long-lived — and are never persisted and never
 * put on an IPC channel. There is deliberately no `gh auth switch` anywhere:
 * two workspaces on two accounts must be able to run at the same time.
 */

const BINARY_NAME = 'gh';
const RUN_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 5 * 60 * 1000;

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
function parseAccounts(text: string): GhAccount[] {
    const accounts: GhAccount[] = [];
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
 * `GhProbeResult.error` — which crosses IPC.
 *
 * `parseAccounts` only recognizes today's `gh auth status` wording; a future
 * or unusual wording could slip past it while the masked `Token:` line is
 * still present, so the fallback text is scrubbed independently of parsing
 * rather than trusted just because parsing found nothing. Matches on the
 * word "token" (catches `Token:` and `Token scopes:`) and on gh's own token
 * prefixes, so a stray raw or masked token survives neither.
 */
function stripTokenLines(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/token/i.test(line) && !/\bgh[oprsu]_|\bgithub_pat_/i.test(line))
        .join('\n')
        .trim();
}

/**
 * A copy of `env` with GH_TOKEN layered on, or a plain copy for null.
 *
 * Always a copy: the base environment is shared (getLoginEnv caches it), and
 * mutating it would leak one workspace's token into every other spawn.
 */
export function layerGhToken(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
    return token ? { ...env, GH_TOKEN: token } : { ...env };
}

export class GhBroker {
    private readonly tokenCache = new Map<string, { token: string; fetchedAt: number }>();

    constructor(
        private readonly getEnv: () => NodeJS.ProcessEnv = getLoginEnv,
        private readonly tokenTtlMs: number = TOKEN_TTL_MS
    ) {}

    /**
     * Whether `gh` is installed, its version, and the keyring accounts.
     *
     * Feeds the workspace settings account picker and the "install gh" empty
     * state. Deliberately uncached: it runs when the settings section opens,
     * and installing `gh` or running `gh auth login` must take effect without
     * an app restart.
     */
    public async probe(): Promise<GhProbeResult> {
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
                error:
                    stripTokenLines(version.stderr) ||
                    version.errorMessage ||
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
            throw new Error(
                result.stderr.trim() ||
                    result.errorMessage ||
                    `gh auth token failed for ${accountLogin}.`
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
     * Absolute path to `gh`, or null when nothing was found.
     *
     * `CONSOLA_GH_PATH` wins first — the seam Phase 1's unit tests and its
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
}

/** The app-wide broker. Tests construct their own with a stubbed environment. */
export const ghBroker = new GhBroker();
