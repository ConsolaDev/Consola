import { execFile, execFileSync, type ExecFileOptions, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import * as os from 'os';

/**
 * The ambient environment every spawned process inherits.
 *
 * This is deliberately provider-agnostic: it answers "what would the user's
 * login shell produce on this machine", which is the same question regardless
 * of which CLI is about to run. Harness-specific variables are layered on top
 * by each driver's `composeEnv`, never here.
 */

/** The first probe blocks the main process, so it gets little time. */
const PROBE_TIMEOUT_MS = 5000;

/** A retry runs in the background, so it can afford to wait for a slow shell. */
const RETRY_TIMEOUT_MS = 20000;

/**
 * Pauses before the second and third retries; the first starts at once.
 *
 * Bounded because every attempt runs the user's rc files, which can have side
 * effects of their own. A shell that is still failing after the last one is
 * broken rather than slow, and the problem says to restart Consola.
 */
const RETRY_BACKOFF_MS = [30_000, 120_000];

const PROBE_ARGS = ['-ilc', 'env -0'];

/**
 * Variables identifying an enclosing Claude Code session.
 *
 * If Consola is itself started from inside a Claude session, these leak into
 * the environment and the sessions it spawns are treated as nested children —
 * which, among other things, turns off transcript saving and so breaks resume.
 * Each terminal must look like a fresh top-level session.
 */
const INHERITED_SESSION_VARS = [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID',
];

let cachedEnv: NodeJS.ProcessEnv | null = null;

/** Why `cachedEnv` is the fallback rather than the login shell's; null when it isn't. */
let probeProblem: string | null = null;

/** The background probe currently running, if any. Never rejects. */
let retryInFlight: Promise<void> | null = null;

function getLoginShell(): string {
    if (os.platform() === 'win32') {
        return process.env.COMSPEC || 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
}

function stripInheritedSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    for (const name of INHERITED_SESSION_VARS) {
        delete env[name];
    }
    return env;
}

/** Electron's own variables with the login shell's on top, so its PATH wins. */
function fromLoginShell(raw: string): NodeJS.ProcessEnv {
    const parsed: NodeJS.ProcessEnv = {};
    for (const entry of raw.split('\0')) {
        const separator = entry.indexOf('=');
        if (separator > 0) {
            parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
    }
    return stripInheritedSession({ ...process.env, ...parsed });
}

function describeProbeFailure(shell: string, error: unknown, timeoutMs: number): string {
    const failure = error as { code?: unknown; killed?: boolean; message?: string };
    // execFileSync reports a timeout as ETIMEDOUT; execFile kills the child
    // and says so on the error.
    if (failure.code === 'ETIMEDOUT' || failure.killed) {
        return `\`${shell} -ilc\` did not finish within ${timeoutMs / 1000}s`;
    }
    const firstLine = (failure.message ?? String(error)).split('\n')[0];
    return `\`${shell} -ilc\` failed: ${firstLine}`;
}

/**
 * The environment a login shell would produce.
 *
 * An Electron app launched from Finder or the Dock inherits a minimal
 * environment — no ~/.zshrc, so no nvm/rbenv/homebrew on PATH and none of the
 * API keys or proxy settings the user sets up there. The CLIs Consola drives
 * and the tools they shell out to need all of it, so we ask the login shell
 * and cache the answer.
 *
 * A failed probe is not the final answer. Right after login the shell can
 * take longer than the first probe allows, and caching the bare environment
 * for the app's lifetime would hide every Homebrew tool until a restart. So
 * the fallback is served while the shell is asked again in the background
 * (`retryProbe`), and a successful retry replaces it.
 *
 * The returned object is shared. Callers layering variables on top must spread
 * it into a copy rather than mutating it, or one harness's configuration would
 * leak into every other.
 */
export function getLoginEnv(): NodeJS.ProcessEnv {
    if (cachedEnv) return cachedEnv;

    // Windows shells don't support the -ilc/env -0 probe; the GUI environment
    // there is already close enough to the user's.
    if (os.platform() === 'win32') {
        cachedEnv = stripInheritedSession({ ...process.env });
        return cachedEnv;
    }

    const shell = getLoginShell();
    try {
        // NUL-separated output so values containing newlines survive parsing.
        // Node supports detached for synchronous spawns; our Node typings omit it.
        const probeOptions: ExecFileSyncOptionsWithStringEncoding & { detached: boolean } = {
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
            // An interactive zsh can open /dev/tty even with stdin ignored,
            // take the parent's foreground process group, and leave Ctrl+C
            // targeting its dead group. A new session has no controlling tty.
            detached: true,
        };
        cachedEnv = fromLoginShell(execFileSync(shell, PROBE_ARGS, probeOptions));
    } catch (error) {
        console.error('Failed to probe login shell environment:', error);
        cachedEnv = stripInheritedSession({ ...process.env });
        probeProblem = describeProbeFailure(shell, error, PROBE_TIMEOUT_MS);
        retryProbe(shell, 0);
    }

    return cachedEnv;
}

/**
 * Ask the login shell again, without blocking the main process.
 *
 * Started synchronously, so a `loginEnvRetry` in the same tick as the failed
 * probe already finds it running.
 */
function retryProbe(shell: string, attempt: number): void {
    retryInFlight = probeInBackground(shell)
        .then(
            (raw) => {
                cachedEnv = fromLoginShell(raw);
                probeProblem = null;
            },
            (error: unknown) => {
                console.error('Retrying the login shell environment probe failed:', error);
                probeProblem = describeProbeFailure(shell, error, RETRY_TIMEOUT_MS);
                const backoff = RETRY_BACKOFF_MS[attempt];
                if (backoff !== undefined) {
                    setTimeout(() => retryProbe(shell, attempt + 1), backoff).unref?.();
                }
            }
        )
        .finally(() => {
            retryInFlight = null;
        });
}

function probeInBackground(shell: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Detached for the same reason as the first probe. Our Node typings
        // omit `detached` here too, though execFile passes it on to spawn.
        const options: ExecFileOptions & { encoding: 'utf8'; detached: boolean } = {
            encoding: 'utf8',
            timeout: RETRY_TIMEOUT_MS,
            detached: true,
        };
        const child = execFile(shell, PROBE_ARGS, options, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
        // Like the first probe's ignored stdin: nothing in an rc file should
        // sit waiting to read from Consola.
        child.stdin?.end();
    });
}

/**
 * The background probe still running after a failed first probe, or null
 * when there is nothing to wait for. Runs the first probe if nothing has yet.
 *
 * For callers about to bake the environment into something that outlives the
 * call, such as a session's process: awaiting this first means they get the
 * login shell's answer if a retry is about to deliver it. Null rather than a
 * resolved promise so a launch on a healthy machine does not wait even a tick.
 *
 * Covers only an attempt in progress, never one still backing off, so a shell
 * that keeps failing delays a launch by at most one retry.
 */
export function loginEnvRetry(): Promise<void> | null {
    getLoginEnv();
    return retryInFlight;
}

/**
 * Why the environment is the bare one apps are launched with rather than the
 * login shell's, or null when the shell answered (or was never asked).
 *
 * A tool missing from PATH is then most likely not missing at all, and an
 * error that says "not installed" would send the user looking in the wrong
 * place.
 */
export function loginEnvProblem(): string | null {
    return probeProblem;
}
