import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolution and headless invocation of the `claude` CLI.
 *
 * Consola drives Claude Code as a real subprocess rather than through the SDK,
 * so every feature the CLI ships arrives for free. The two things this module
 * has to get right are (a) finding the binary and (b) giving it the same
 * environment the user's terminal would.
 */

const PROBE_TIMEOUT_MS = 5000;
const HEADLESS_TIMEOUT_MS = 60000;

// Locations `claude` commonly installs to, checked when the shell probe fails.
const FALLBACK_BINARY_PATHS = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
];

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
let cachedBinary: string | null = null;

function getLoginShell(): string {
    if (os.platform() === 'win32') {
        return process.env.COMSPEC || 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
}

/**
 * The environment a login shell would produce.
 *
 * An Electron app launched from Finder or the Dock inherits a minimal
 * environment — no ~/.zshrc, so no nvm/rbenv/homebrew on PATH and none of the
 * API keys or proxy settings the user sets up there. Claude Code and the tools
 * it shells out to need all of it, so we ask the login shell once and cache the
 * answer for the lifetime of the app.
 */
export function getLoginEnv(): NodeJS.ProcessEnv {
    if (cachedEnv) return cachedEnv;

    // Windows shells don't support the -ilc/env -0 probe; the GUI environment
    // there is already close enough to the user's.
    if (os.platform() === 'win32') {
        cachedEnv = stripInheritedSession({ ...process.env });
        return cachedEnv;
    }

    try {
        // NUL-separated output so values containing newlines survive parsing.
        const raw = execFileSync(getLoginShell(), ['-ilc', 'env -0'], {
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        const parsed: NodeJS.ProcessEnv = {};
        for (const entry of raw.split('\0')) {
            const separator = entry.indexOf('=');
            if (separator > 0) {
                parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
            }
        }

        // Keep Electron's own variables, but let the login shell win on PATH.
        cachedEnv = stripInheritedSession({ ...process.env, ...parsed });
    } catch (error) {
        console.error('Failed to probe login shell environment:', error);
        cachedEnv = stripInheritedSession({ ...process.env });
    }

    return cachedEnv;
}

function stripInheritedSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    for (const name of INHERITED_SESSION_VARS) {
        delete env[name];
    }
    return env;
}

/**
 * Absolute path to the `claude` binary.
 *
 * @param override Explicit path from settings, used verbatim when it exists.
 */
export function resolveClaudeBinary(override?: string): string {
    if (override && fs.existsSync(override)) {
        return override;
    }
    if (cachedBinary) return cachedBinary;

    const searchPath = getLoginEnv().PATH ?? '';
    for (const dir of searchPath.split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'claude');
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            cachedBinary = candidate;
            return cachedBinary;
        } catch {
            // Not here — keep looking.
        }
    }

    for (const candidate of FALLBACK_BINARY_PATHS) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            cachedBinary = candidate;
            return cachedBinary;
        } catch {
            // Not here either.
        }
    }

    // Let the spawn fail with a real error rather than guessing further.
    cachedBinary = 'claude';
    return cachedBinary;
}

/** True when a `claude` binary was actually located on disk. */
export function isClaudeAvailable(override?: string): boolean {
    return resolveClaudeBinary(override) !== 'claude';
}

/**
 * Build the argv for an interactive session.
 *
 * A session ID is assigned by Consola up front so the tab can be reconnected to
 * the same conversation later. `--session-id` only works once per ID — Claude
 * rejects reuse — so every launch after the first resumes instead.
 */
export function buildSessionArgs(sessionId: string, isResume: boolean): string[] {
    return isResume ? ['--resume', sessionId] : ['--session-id', sessionId];
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
 */
export async function runHeadless(
    prompt: string,
    options: { cwd: string; binaryOverride?: string; timeoutMs?: number } = { cwd: process.cwd() }
): Promise<HeadlessResult> {
    const binary = resolveClaudeBinary(options.binaryOverride);
    const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--allowed-tools', '',
    ];

    return new Promise((resolve) => {
        execFile(
            binary,
            args,
            {
                cwd: options.cwd,
                env: getLoginEnv(),
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
