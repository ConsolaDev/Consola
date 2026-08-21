import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLoginEnv } from '../LoginEnvironment';
import { getDisplayName } from '../ClaudeSessionIndex';
import { probeClaudeCapabilities } from './claudeCapabilities';
import type {
    HarnessAccount,
    HarnessCapabilities,
    HarnessProbeResult,
    SessionNameResult,
} from '../../shared/types';
import type { HarnessConfig, HarnessDriver, SessionLaunch } from './HarnessDriver';

/**
 * Driver for Anthropic's `claude` CLI.
 *
 * Everything Claude-specific lives here: where the binary installs, the
 * `--session-id`/`--resume` grammar, the `CLAUDE_CONFIG_DIR` variable that
 * redirects a whole profile, and the shape of the account file it writes.
 */

const VERSION_TIMEOUT_MS = 10000;
const HEADLESS_TIMEOUT_MS = 60000;

// Locations `claude` commonly installs to, checked when the PATH search fails.
const FALLBACK_BINARY_PATHS = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
];

const BINARY_NAME = 'claude';

// The binary found on PATH, cached for the app's lifetime. Only auto-detection
// is cached: a pinned path is cheap to check and must never be answered from a
// stale lookup, or fixing a bad path would need a restart to take effect.
let autoDetectedBinary: string | null = null;

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * The config directory this harness's CLI would use.
 *
 * Falls back to the ambient `CLAUDE_CONFIG_DIR` so a harness that pins nothing
 * behaves exactly as Consola did before harnesses existed — including for
 * users who set the variable in their own shell profile.
 */
function resolveConfigDir(config: HarnessConfig): string | undefined {
    return config.configDir || getLoginEnv().CLAUDE_CONFIG_DIR || undefined;
}

/**
 * Where Claude records the signed-in account.
 *
 * With a config directory set the file lives inside it; with none set it sits
 * at `~/.claude.json`, beside `~/.claude` rather than within it.
 */
function resolveAccountFile(config: HarnessConfig): string {
    const configDir = resolveConfigDir(config);
    return configDir
        ? path.join(configDir, '.claude.json')
        : path.join(os.homedir(), '.claude.json');
}

function readAccount(config: HarnessConfig): HarnessAccount | undefined {
    try {
        const raw = fs.readFileSync(resolveAccountFile(config), 'utf8');
        const parsed = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> };
        const account = parsed.oauthAccount;
        if (!account) return undefined;

        const pick = (key: string): string | undefined => {
            const value = account[key];
            return typeof value === 'string' && value ? value : undefined;
        };

        return {
            emailAddress: pick('emailAddress'),
            displayName: pick('displayName'),
            organizationName: pick('organizationName'),
            organizationType: pick('organizationType'),
        };
    } catch {
        // No account file, unreadable, or mid-write: treat as signed out.
        return undefined;
    }
}

/**
 * Explain why running the binary failed.
 *
 * An unresolved name means the search found nothing, which is worth saying
 * plainly; anything else already has the CLI's own message, which is more
 * specific than anything that could be written here.
 */
function describeSpawnFailure(resolvedBinary: string, error: Error): string {
    return resolvedBinary === BINARY_NAME
        ? `Not found — \`${BINARY_NAME}\` is not installed or not on PATH.`
        : error.message;
}

/** Trim `2.1.232 (Claude Code)` down to the version itself. */
function parseVersion(stdout: string): string | undefined {
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    return trimmed.split(/\s+/)[0];
}

export class ClaudeDriver implements HarnessDriver {
    public readonly id = 'claude' as const;
    public readonly configDirEnvVar = 'CLAUDE_CONFIG_DIR';

    /**
     * Absolute path to the `claude` binary.
     *
     * A pinned binary is returned exactly as given, even when it is missing or
     * not executable. Quietly falling back to whatever is on PATH would run a
     * different installation — and so a different account — than the harness
     * was configured for; failing at spawn, and reporting it from the health
     * probe, is the honest outcome.
     */
    public resolveBinary(config: HarnessConfig): string {
        if (config.binaryPath) return config.binaryPath;

        if (autoDetectedBinary) return autoDetectedBinary;

        const searchPath = getLoginEnv().PATH ?? '';
        for (const dir of searchPath.split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, BINARY_NAME);
            if (isExecutable(candidate)) {
                autoDetectedBinary = candidate;
                return candidate;
            }
        }

        for (const candidate of FALLBACK_BINARY_PATHS) {
            if (isExecutable(candidate)) {
                autoDetectedBinary = candidate;
                return candidate;
            }
        }

        // Let the spawn fail with a real error rather than guessing further.
        // Deliberately uncached, so installing the CLI takes effect without a
        // restart.
        return BINARY_NAME;
    }

    /**
     * Build the argv for an interactive session.
     *
     * A session ID is assigned by Consola up front so the tab can be
     * reconnected to the same conversation later. `--session-id` only works
     * once per ID — Claude rejects reuse — so every launch after the first
     * resumes instead.
     */
    public buildSessionArgs(config: HarnessConfig, launch: SessionLaunch): string[] {
        const base = launch.resume
            ? ['--resume', launch.sessionId]
            : ['--session-id', launch.sessionId];
        const model = launch.model ? ['--model', launch.model] : [];
        // The harness's own extra args come last so a hand-written `--model`
        // there still wins: Claude takes the last occurrence of a flag.
        return [...base, ...model, ...config.extraArgs];
    }

    /**
     * The ambient environment with this harness's profile directory applied.
     *
     * Always returns a copy: the base environment is shared across every
     * harness, and mutating it would leak one harness's profile into all the
     * others.
     */
    public composeEnv(config: HarnessConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        if (!config.configDir) return { ...baseEnv };
        return { ...baseEnv, [this.configDirEnvVar]: config.configDir };
    }

    public async probeHealth(config: HarnessConfig): Promise<HarnessProbeResult> {
        const resolvedBinary = this.resolveBinary(config);
        const account = readAccount(config);

        // Checked here rather than inferred from resolution, which now returns
        // a pinned path unchanged so a bad one fails loudly instead of quietly
        // running a different install.
        if (config.binaryPath && !isExecutable(config.binaryPath)) {
            return {
                available: false,
                resolvedBinary,
                account,
                error: `Not executable: ${config.binaryPath}`,
            };
        }

        return new Promise((resolve) => {
            execFile(
                resolvedBinary,
                ['--version'],
                {
                    env: this.composeEnv(config, getLoginEnv()),
                    timeout: VERSION_TIMEOUT_MS,
                },
                (error, stdout) => {
                    if (error) {
                        resolve({
                            available: false,
                            resolvedBinary,
                            account,
                            error: describeSpawnFailure(resolvedBinary, error),
                        });
                        return;
                    }
                    resolve({
                        available: true,
                        resolvedBinary,
                        version: parseVersion(stdout),
                        account,
                    });
                }
            );
        });
    }

    public getSessionDisplayName(config: HarnessConfig, sessionId: string): SessionNameResult | null {
        return getDisplayName(sessionId, resolveConfigDir(config));
    }

    /**
     * Ask this harness's CLI what it can offer a composer.
     *
     * Run from the home directory rather than any workspace. What comes back
     * is scoped to the config directory, not the working directory — a repo's
     * own `.claude/commands` never appears here — so a per-workspace probe
     * would buy nothing and would run that repo's SessionStart hooks for the
     * privilege.
     */
    public async probeCapabilities(config: HarnessConfig): Promise<HarnessCapabilities> {
        if (config.binaryPath && !isExecutable(config.binaryPath)) {
            throw new Error(`Not executable: ${config.binaryPath}`);
        }
        const resolvedBinary = this.resolveBinary(config);
        try {
            return await probeClaudeCapabilities(
                resolvedBinary,
                os.homedir(),
                this.composeEnv(config, getLoginEnv())
            );
        } catch (error) {
            throw new Error(
                describeSpawnFailure(
                    resolvedBinary,
                    error instanceof Error ? error : new Error(String(error))
                )
            );
        }
    }
}

export interface HeadlessResult {
    text: string;
    isError: boolean;
}

/**
 * Run a one-shot prompt through `claude -p` and return its text.
 *
 * Used for side tasks like commit messages. Tools are disabled: these prompts
 * only transform text handed to them and must not touch the repository.
 *
 * This is a workspace-level side task rather than part of a conversation, so
 * it runs against the ambient environment rather than any one harness.
 */
export async function runHeadless(
    prompt: string,
    options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }
): Promise<HeadlessResult> {
    const driver = new ClaudeDriver();
    const config: HarnessConfig = { extraArgs: [] };
    const binary = driver.resolveBinary(config);
    const args = ['-p', prompt, '--output-format', 'json', '--allowed-tools', ''];

    return new Promise((resolve) => {
        execFile(
            binary,
            args,
            {
                cwd: options.cwd,
                env: driver.composeEnv(config, getLoginEnv()),
                timeout: options.timeoutMs ?? HEADLESS_TIMEOUT_MS,
                maxBuffer: 10 * 1024 * 1024,
            },
            (error, stdout) => {
                if (error) {
                    resolve({ text: '', isError: true });
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
                    resolve({
                        text: (parsed.result ?? '').trim(),
                        isError: parsed.is_error === true,
                    });
                } catch {
                    // Non-JSON output means something went wrong upstream.
                    resolve({ text: '', isError: true });
                }
            }
        );
    });
}
