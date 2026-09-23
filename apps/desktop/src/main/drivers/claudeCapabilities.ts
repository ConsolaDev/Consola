import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type {
    HarnessAgent,
    HarnessCapabilities,
    HarnessCapabilityAccount,
    HarnessCommand,
    HarnessModel,
} from '../../shared/types';

/**
 * Asking `claude` to describe itself, over its own control protocol.
 *
 * The CLI speaks a line-delimited JSON protocol on stdio. Given an
 * `initialize` control request it answers with everything its `/` menu is
 * built from — commands, agents, models, output styles and the signed-in
 * account — before running any turn at all. That makes this a free, fast
 * question rather than a conversation: no tokens, no API call, and no
 * transcript written anywhere Consola later reads back.
 *
 * The wire format is the CLI's own, not a documented contract, so parsing is
 * strict: an unrecognised shape throws rather than yielding a plausible-looking
 * empty menu that would read as "this harness has no commands".
 */

const HANDSHAKE_ARGS = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    // Nothing here is a conversation, so nothing should be resumable later.
    '--no-session-persistence',
];

/**
 * How long to wait for the answer.
 *
 * The handshake itself takes well under a second, but it runs the user's
 * SessionStart hooks first, and those are arbitrary shell commands. The
 * timeout is a backstop against a hung child rather than a tight deadline.
 */
const HANDSHAKE_TIMEOUT_MS = 15000;

const CONTROL_REQUEST_ID = 'consola-initialize';

/** Keep enough stderr to explain a failure without buffering a runaway log. */
const MAX_STDERR_CHARS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Ask the CLI to describe itself and return the raw `response` payload.
 *
 * Resolves exactly once, and always kills the child on the way out: this
 * process is asked one question and is of no further use, so it must never be
 * left running because a later line never arrived.
 */
export function requestInitializeHandshake(
    binary: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number = HANDSHAKE_TIMEOUT_MS
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const finish = (error: Error | null, payload?: unknown) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            // SIGKILL rather than SIGTERM: this child has no cleanup worth
            // waiting for, and a wedged one is exactly the case being escaped.
            if (child && !child.killed) child.kill('SIGKILL');
            if (error) reject(error);
            else resolve(payload);
        };

        try {
            child = spawn(binary, HANDSHAKE_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }

        timer = setTimeout(
            () => finish(new Error(`No answer from \`${binary}\` within ${timeoutMs}ms.`)),
            timeoutMs
        );

        // A missing binary reports asynchronously here rather than throwing
        // above. The stream handlers matter just as much: writing to a child
        // that already died raises EPIPE on the stream, and an unhandled
        // stream error takes the whole main process down with it.
        child.on('error', (error) => finish(error));
        child.stdin.on('error', () => {});
        child.stdout.on('error', () => {});
        child.stderr.on('error', () => {});

        let stderrTail = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_CHARS);
        });

        let pending = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            pending += chunk;
            // Pull whole lines off an accumulating buffer rather than
            // splitting each chunk: a JSON line routinely straddles two reads,
            // and splitting per chunk would corrupt exactly the long responses
            // this is here to collect.
            let newline = pending.indexOf('\n');
            while (newline !== -1) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
                if (!line) continue;

                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    // The stream carries hook output and status lines too. One
                    // unparseable line is not a reason to abandon the answer.
                    continue;
                }
                if (!isRecord(parsed) || parsed.type !== 'control_response') continue;

                const response = parsed.response;
                if (!isRecord(response) || response.request_id !== CONTROL_REQUEST_ID) continue;
                if (response.subtype === 'error') {
                    finish(new Error(asString(response.error) ?? 'The CLI rejected the request.'));
                    return;
                }
                finish(null, response.response);
                return;
            }
        });

        // Exiting before answering means this CLI never understood the request
        // — an older build, or one that does not speak the protocol. Reporting
        // it now beats waiting out the whole timeout for a child that is gone.
        child.on('exit', (code) => {
            finish(
                new Error(
                    stderrTail.trim() ||
                        `\`${binary}\` exited with code ${code} before answering.`
                )
            );
        });

        try {
            child.stdin.write(
                `${JSON.stringify({
                    type: 'control_request',
                    request_id: CONTROL_REQUEST_ID,
                    request: { subtype: 'initialize' },
                })}\n`
            );
            // Nothing further is coming. Leaving stdin open would have the CLI
            // wait for a conversation that never starts.
            child.stdin.end();
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

function toCommand(raw: unknown): HarnessCommand | null {
    if (!isRecord(raw)) return null;
    const name = asString(raw.name);
    if (!name) return null;
    return {
        name,
        description: asString(raw.description) ?? '',
        argumentHint: asString(raw.argumentHint),
        aliases: asStringArray(raw.aliases),
    };
}

function toAgent(raw: unknown): HarnessAgent | null {
    if (!isRecord(raw)) return null;
    const name = asString(raw.name);
    if (!name) return null;
    return { name, description: asString(raw.description) ?? '' };
}

function toModel(raw: unknown): HarnessModel | null {
    if (!isRecord(raw)) return null;
    const value = asString(raw.value);
    if (!value) return null;
    return {
        value,
        resolvedModel: asString(raw.resolvedModel) ?? value,
        displayName: asString(raw.displayName) ?? value,
        description: asString(raw.description) ?? '',
        supportsEffort: asBoolean(raw.supportsEffort),
        supportedEffortLevels: asStringArray(raw.supportedEffortLevels),
        supportsFastMode: asBoolean(raw.supportsFastMode),
        supportsAdaptiveThinking: asBoolean(raw.supportsAdaptiveThinking),
        supportsAutoMode: asBoolean(raw.supportsAutoMode),
    };
}

/**
 * Read the account block, if there is one.
 *
 * A signed-out profile still answers, with a `tokenSource` of `none` and no
 * email — reported as `signedIn: false` rather than dropped, so the harness
 * card can distinguish "not signed in" from "never asked".
 */
function toAccount(raw: unknown): HarnessCapabilityAccount | undefined {
    if (!isRecord(raw)) return undefined;
    const emailAddress = asString(raw.email);
    const subscriptionType = asString(raw.subscriptionType);
    return {
        signedIn: Boolean(emailAddress || subscriptionType),
        emailAddress,
        organization: asString(raw.organization),
        subscriptionType,
        apiProvider: asString(raw.apiProvider),
    };
}

/**
 * Turn the handshake payload into capabilities.
 *
 * Exported for its own tests: this is where a future change to the CLI's wire
 * format would first show up, and a fast failing test beats an empty menu in
 * production. A payload that is not an object at all, or that carries no
 * command list, is treated as unrecognised rather than as an empty harness.
 */
export function mapInitializeResponse(raw: unknown): HarnessCapabilities {
    if (!isRecord(raw)) {
        throw new Error('The CLI answered with something other than an object.');
    }
    if (!Array.isArray(raw.commands)) {
        throw new Error('The CLI answered without a command list.');
    }
    return {
        commands: raw.commands
            .map(toCommand)
            .filter((command): command is HarnessCommand => command !== null),
        agents: Array.isArray(raw.agents)
            ? raw.agents.map(toAgent).filter((agent): agent is HarnessAgent => agent !== null)
            : [],
        models: Array.isArray(raw.models)
            ? raw.models.map(toModel).filter((model): model is HarnessModel => model !== null)
            : [],
        outputStyles: asStringArray(raw.available_output_styles) ?? [],
        account: toAccount(raw.account),
    };
}

export async function probeClaudeCapabilities(
    binary: string,
    cwd: string,
    env: NodeJS.ProcessEnv
): Promise<HarnessCapabilities> {
    return mapInitializeResponse(await requestInitializeHandshake(binary, cwd, env));
}
