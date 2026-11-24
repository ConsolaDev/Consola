import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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
 * transcript written anywhere Consola later reads back. Asked `get_usage`
 * once initialised, the same process answers with the account's usage limits.
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
const HANDSHAKE_TIMEOUT_MS = 15_000;

export const INITIALIZE: ControlRequest = {
  requestId: 'consola-initialize',
  request: { subtype: 'initialize' },
};

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

/** One control request, and the id its answer comes back under. */
export interface ControlRequest {
  requestId: string;
  request: Record<string, unknown>;
}

/**
 * Asking `requestControl`'s last request again until its answer settles: a
 * question whose answer is still on its way (a server still connecting).
 */
export interface RepeatLast {
  /** Whether this answer is the one to keep; asking stops once it is. */
  until(answer: unknown): boolean;
  /** How long to wait after an answer before asking again. */
  everyMs: number;
  /** How long to keep asking, from its first answer; then the last answer is kept. */
  forMs: number;
}

/**
 * Ask the CLI a sequence of control requests and return each raw `response`
 * payload, in order.
 *
 * Each request is written only once the one before it is answered — the second
 * question is about a CLI the first has finished setting up — and stdin stays
 * open until the last is written. `extraArgs` follow the protocol flags.
 * With `repeat`, the last request is asked again (`RepeatLast`), stdin stays
 * open while it is, and its last answer is the one returned.
 *
 * Resolves exactly once, and always kills the child on the way out: this
 * process is asked its questions and is of no further use, so it must never be
 * left running because a later line never arrived. `timeoutMs` bounds the
 * whole exchange, repeats included.
 */
export function requestControl(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  requests: readonly ControlRequest[],
  {
    timeoutMs = HANDSHAKE_TIMEOUT_MS,
    extraArgs = [],
    repeat,
  }: { timeoutMs?: number; extraArgs?: readonly string[]; repeat?: RepeatLast } = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    // While the last request is repeated: the next ask, and the end of asking.
    let again: NodeJS.Timeout | undefined;
    let enough: NodeJS.Timeout | undefined;
    const answers: unknown[] = [];
    const last = requests.length - 1;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (again) clearTimeout(again);
      if (enough) clearTimeout(enough);
      // SIGKILL rather than SIGTERM: this child has no cleanup worth
      // waiting for, and a wedged one is exactly the case being escaped.
      if (child && !child.killed) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(answers);
    };

    if (requests.length === 0) {
      resolve(answers);
      return;
    }

    try {
      child = spawn(binary, [...HANDSHAKE_ARGS, ...extraArgs], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    timer = setTimeout(
      () => finish(new Error(`No answer from \`${binary}\` within ${timeoutMs}ms.`)),
      timeoutMs,
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
      // Output still buffered after the last answer has no request to match.
      if (settled) return;
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
        // Once the last request has an answer, a repeat of it is what is awaited.
        const awaited = requests[Math.min(answers.length, last)];
        if (!isRecord(response) || response.request_id !== awaited.requestId) continue;
        if (response.subtype === 'error') {
          finish(new Error(asString(response.error) ?? 'The CLI rejected the request.'));
          return;
        }
        if (answers.length < last) {
          answers.push(response.response);
          send(answers.length);
          continue;
        }
        answers[last] = response.response;
        if (!repeat || settles(response.response)) {
          finish(null);
          return;
        }
        if (!enough) enough = setTimeout(() => finish(null), repeat.forMs);
        again = setTimeout(() => send(last), repeat.everyMs);
      }
    });

    /** Whether the last answer is the one to keep; a caller's check that throws ends the exchange. */
    function settles(answer: unknown): boolean {
      try {
        return repeat!.until(answer);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return true;
      }
    }

    // Exiting before answering means this CLI never understood the request
    // — an older build, or one that does not speak the protocol. Reporting
    // it now beats waiting out the whole timeout for a child that is gone.
    child.on('exit', (code) => {
      finish(
        new Error(stderrTail.trim() || `\`${binary}\` exited with code ${code} before answering.`),
      );
    });

    function send(index: number): void {
      const { requestId, request } = requests[index];
      try {
        child.stdin.write(
          `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`,
        );
        // After the last request nothing further is coming. Leaving stdin
        // open would have the CLI wait for a conversation that never starts;
        // a request already written is still answered. A request that is
        // repeated keeps it open: the child is killed when asking ends.
        if (index === last && !repeat) child.stdin.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }

    send(0);
  });
}

/** Ask the CLI to describe itself and return the raw `initialize` payload. */
export async function requestInitializeHandshake(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<unknown> {
  const [answer] = await requestControl(binary, cwd, env, [INITIALIZE], { timeoutMs });
  return answer;
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

/**
 * Ask the CLI for its usage limits and return the raw `get_usage` payload.
 *
 * Hooks are off: unlike the `/` menu, nothing in this answer depends on them,
 * and asking must never run the person's SessionStart hooks. `skip_behaviors`
 * keeps the CLI from first scanning a week of transcripts for a summary that
 * is not read here. The deadline is tighter than the menu's, since there are
 * no hooks to wait out.
 */
export async function requestUsage(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<unknown> {
  const [, usage] = await requestControl(
    binary,
    cwd,
    env,
    [
      INITIALIZE,
      { requestId: 'consola-get-usage', request: { subtype: 'get_usage', skip_behaviors: true } },
    ],
    { timeoutMs, extraArgs: ['--settings', JSON.stringify({ disableAllHooks: true })] },
  );
  return usage;
}

export async function probeClaudeCapabilities(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessCapabilities> {
  return mapInitializeResponse(await requestInitializeHandshake(binary, cwd, env));
}
