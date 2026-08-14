import { execFileSync } from 'child_process';
import * as os from 'os';

/**
 * The ambient environment every spawned process inherits.
 *
 * This is deliberately provider-agnostic: it answers "what would the user's
 * login shell produce on this machine", which is the same question regardless
 * of which CLI is about to run. Harness-specific variables are layered on top
 * by each driver's `composeEnv`, never here.
 */

const PROBE_TIMEOUT_MS = 5000;

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

/**
 * The environment a login shell would produce.
 *
 * An Electron app launched from Finder or the Dock inherits a minimal
 * environment — no ~/.zshrc, so no nvm/rbenv/homebrew on PATH and none of the
 * API keys or proxy settings the user sets up there. The CLIs Consola drives
 * and the tools they shell out to need all of it, so we ask the login shell
 * once and cache the answer for the lifetime of the app.
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
