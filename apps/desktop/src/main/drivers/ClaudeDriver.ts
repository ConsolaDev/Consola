import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLoginEnv } from '../LoginEnvironment';
import { readSessionModel } from './sessionModel';
import {
  copyConversation,
  findSessionFile,
  readConversation,
  readCustomTitleSince,
  readFirstUserPrompt,
} from '../ClaudeSessionIndex';
import { probeClaudeCapabilities, requestUsage } from './claudeCapabilities';
import { mapClaudeUsage, showsClaudeLimitNotice } from './claudeUsage';
import type { ConversationRecord, ConversationWindow } from '../../shared/conversation';
import type { HarnessAccount, HarnessCapabilities, HarnessProbeResult } from '../../shared/types';
import type { HarnessLimits } from '../../shared/usageLimits';
import type { SessionToolPolicy } from '../../shared/workspace';
import { CONSOLA_MCP_SERVER, mcpToolName, READ_ONLY_CONSOLA_TOOLS } from '../mcp/names';
import { compileClaudeAgent, probeClaudeMcpServers } from './claudeAgent';
import { claudeAttentionHooks, claudeHookSettings } from './claudeHooks';
import { createClaudeTurnReader } from './claudeTurnReader';
import {
  looseningProblem,
  namedFlags,
  type CliNameRead,
  type CompileAgentInput,
  type CompiledAgent,
  type HarnessConfig,
  type HarnessDriver,
  type McpServerReport,
  type SessionLaunch,
  type TextGenerationRequest,
  type TurnReader,
  type UsageLimitReporting,
} from './HarnessDriver';

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

/** How Claude names a tool of an MCP server in permission rules. */
function claudeToolName(tool: string): string {
  return `mcp__${CONSOLA_MCP_SERVER}__${mcpToolName(tool)}`;
}

/**
 * `read-only` as Claude enforces it (verified live against 2.1.318):
 *
 * - `--restricted` drops the tools that run code and WebFetch, ignores user,
 *   project and local settings files — so the checkout's own hooks and
 *   permission rules never load — and confines file tools to the folder.
 * - `--strict-mcp-config` skips the checkout's `.mcp.json`; Consola's own
 *   `--mcp-config` still loads.
 * - `--tools` leaves only reading files. No Bash at all: every allow rule
 *   for a shell command turned out to be a door — `git diff --output=<path>`
 *   writes the author's text anywhere, and `gh … --repo <host>/…` reaches any
 *   host and any repository the person's token can read. What a reviewer
 *   needs from the provider, Consola fetches itself and serves as the
 *   read-only tools allowed below; the session holds no token at all.
 * - `--permission-mode dontAsk` denies anything not allowed below instead of
 *   asking. Pinned because the CLI's default is now `auto`, whose classifier
 *   approves calls on its own; and denying rather than asking means an
 *   unattended review can never stall on a prompt nobody is there to answer.
 */
const READ_ONLY_ARGS = [
  '--strict-mcp-config',
  '--permission-mode',
  'dontAsk',
  '--tools',
  'Read,Grep,Glob',
  '--allowedTools',
  ...READ_ONLY_CONSOLA_TOOLS.map(claudeToolName),
  // Last, and taking no value: it closes the variadic tool list above, so
  // nothing after it — the harness's extra args — can join that list.
  '--restricted',
];

/**
 * Print mode never shows the folder-trust prompt and, unless restricted,
 * loads the folder's hooks and settings without asking: an unattended turn
 * is safe only inside the read-only policy, whose `--restricted` shuts them
 * out.
 */
const UNATTENDED_NEEDS_READ_ONLY =
  'A turn nobody is watching skips Claude’s folder-trust prompt, so Consola runs one only in a read-only session.';

/** Extra args that could widen what a read-only session may do, or what it can reach. */
const LOOSENING_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompt-tool',
  '--allowedTools',
  '--allowed-tools',
  '--tools',
  '--settings',
  '--setting-sources',
  // File tools reach every working directory, --add-dir included.
  '--add-dir',
  // Plugins carry hooks and commands; agents carry tools of their own.
  '--plugin-dir',
  '--plugin-url',
  '--agent',
  '--agents',
];

/**
 * Extra args that would override what a step's reporting turn is launched
 * with: Claude takes a flag's last occurrence, and the harness's extra args
 * come last, so `--output-format text` there would replace the report and
 * `--max-turns` the step's cap. `--input-format` is the driver's alone to
 * add, for a later session that takes several turns over stream-json.
 */
const STEP_TURN_FLAGS = ['--output-format', '--input-format', '--max-turns'];

/**
 * Extra args that would override the servers an agent's grants load: a
 * second `--mcp-config` replaces the step's list, `--strict-mcp-config` drops
 * the connectors it grants.
 */
const SERVER_FLAGS = ['--mcp-config', '--strict-mcp-config'];

/** `a`, `a` and `b`, `a`, `b` and `c`, each in backticks. */
function namedList(flags: readonly string[]): string {
  const named = flags.map((flag) => `\`${flag}\``);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

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
  return configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/**
 * Where Claude records a running process: `<config>/sessions/<pid>.json`,
 * written by the CLI itself and kept current while it runs — `cwd` moves
 * when EnterWorktree moves the process, `sessionId` when /clear starts a
 * new conversation. Not a documented contract, so it is read strictly.
 */
function processRecordFile(config: HarnessConfig, pid: number): string {
  const configDir = resolveConfigDir(config) ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'sessions', `${pid}.json`);
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

const TEXT_GENERATION_TIMEOUT_MS = 60_000;

/**
 * Argv for a throwaway structured answer: no tools, no slash commands, no MCP
 * servers, no hooks, nothing written to disk. `effort` and `fast` are sent
 * only when asked for; the caller has already checked the model offers them.
 */
export function buildTextGenerationArgs(request: TextGenerationRequest): string[] {
  const { schema, model, effort, fast } = request;
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    '--tools',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--settings',
    JSON.stringify({ disableAllHooks: true, ...(fast ? { fastMode: true } : {}) }),
  ];
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
  public readonly attentionHooks = claudeAttentionHooks;
  public readonly usageLimits: UsageLimitReporting = {
    read: (config) => this.readUsageLimits(config),
    showsLimitNotice: showsClaudeLimitNotice,
  };

  /**
   * Absolute path to the `claude` binary.
   *
   * A pinned binary is returned exactly as given, even when it is missing or
   * not executable. Quietly falling back to whatever is on PATH would run a
   * different installation — and so a different account — than the harness
   * was configured for; failing at spawn, and reporting it from the health
   * probe, is the honest outcome.
   */
  public async getSessionModel(config: HarnessConfig, sessionId: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const file = findSessionFile(sessionId, config.configDir);
    return file ? readSessionModel(file, 'claude') : null;
  }

  public async readConversation(
    config: HarnessConfig,
    conversationId: string,
    window?: ConversationWindow,
  ): Promise<ConversationRecord | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    return readConversation(conversationId, resolveConfigDir(config), window);
  }

  public async readFirstPrompt(
    config: HarnessConfig,
    conversationId: string,
  ): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    return readFirstUserPrompt(conversationId, resolveConfigDir(config));
  }

  public async readCliNameSince(
    config: HarnessConfig,
    conversationId: string,
    from: number,
  ): Promise<CliNameRead | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    return readCustomTitleSince(conversationId, resolveConfigDir(config), from);
  }

  /** Copy the transcript into `to`'s identical project folder; `--fork-session` does the rest. */
  public async transplantConversation(
    from: HarnessConfig,
    to: HarnessConfig,
    conversationId: string,
  ): Promise<'carried' | 'missing'> {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) throw new Error('Invalid conversation ID.');
    const copied = await copyConversation(
      conversationId,
      resolveConfigDir(from),
      resolveConfigDir(to),
    );
    return copied === 'missing' ? 'missing' : 'carried';
  }

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
    const problem = this.toolPolicyProblem(config, launch.toolPolicy);
    if (problem) throw new Error(problem);
    if (launch.unattended && launch.toolPolicy !== 'read-only')
      throw new Error(UNATTENDED_NEEDS_READ_ONLY);
    if (launch.unattended && !launch.initialPrompt)
      throw new Error('An unattended turn needs the prompt it runs.');
    if (launch.unattended && launch.reportTurn) {
      // A harness edited after its run was queued: fail the step rather
      // than launch a turn whose report or cap its extra args replace.
      const overridden = this.stepTurnProblem(config, { model: Boolean(launch.model) });
      if (overridden) throw new Error(overridden);
    }
    const base = launch.resume
      ? ['--resume', launch.sessionId]
      : launch.forkFrom
        ? ['--resume', launch.forkFrom, '--fork-session', '--session-id', launch.sessionId]
        : ['--session-id', launch.sessionId];
    const model = launch.model ? ['--model', launch.model] : [];
    const mcp = launch.mcpConfigPath ? ['--mcp-config', launch.mcpConfigPath] : [];
    // The harness's own extra args come after Consola's so a hand-written
    // `--model` there still wins: Claude takes the last occurrence of a
    // flag. A tool policy comes before them, so an extra arg left wanting
    // a value (`--append-system-prompt` with none) cannot take one of its
    // flags as that value; every extra arg that could override the policy
    // is refused above.
    const policy = launch.toolPolicy === 'read-only' ? READ_ONLY_ARGS : [];
    // Hooks ride in `--settings`, which adds to the user's own and writes
    // nothing to disk. Under `--restricted` it is one of the only two
    // sources still loaded, so a read-only turn reports too.
    const hooks = launch.attentionUrl
      ? ['--settings', claudeHookSettings(launch.attentionUrl)]
      : [];
    // A step's unattended turn reports itself as stream-json, and takes its
    // cap; an interactive launch of the same session gets neither, so a
    // person's reopen is exactly what it was before steps reported.
    const report =
      launch.unattended && launch.reportTurn ? ['--output-format', 'stream-json', '--verbose'] : [];
    const turns =
      launch.unattended && launch.maxTurns !== undefined
        ? ['--max-turns', String(launch.maxTurns)]
        : [];
    const args = [
      ...base,
      ...model,
      ...mcp,
      ...hooks,
      ...report,
      ...turns,
      ...policy,
      ...config.extraArgs,
    ];
    // Print mode: one turn, its answer, and exit. The prompt goes after
    // `--`, because `--allowedTools` takes every value up to the next
    // flag and would otherwise swallow it.
    return launch.unattended ? ['-p', ...args, '--', launch.initialPrompt!] : args;
  }

  public toolPolicyProblem(
    config: HarnessConfig,
    policy: SessionToolPolicy | undefined,
  ): string | null {
    if (!policy) return null;
    return looseningProblem(namedFlags(config.extraArgs, LOOSENING_FLAGS));
  }

  public stepTurnProblem(
    config: HarnessConfig,
    compiled?: { model?: boolean; servers?: boolean },
  ): string | null {
    // A step that sets no model compiles none, so the harness's own `--model`
    // is left to win; one whose agent names no server compiles no server
    // flags, so the harness's own `--mcp-config` is left alone too.
    const flags = namedFlags(config.extraArgs, [
      ...(compiled?.model ? ['--model'] : []),
      ...(compiled?.servers ? SERVER_FLAGS : []),
      ...STEP_TURN_FLAGS,
    ]);
    if (flags.length === 0) return null;
    return (
      `This harness's extra arguments set ${namedList(flags)}, which would override what ` +
      `Consola launches each step's turn with. Remove ${flags.length === 1 ? 'it' : 'them'} ` +
      'in Settings › Harnesses.'
    );
  }

  /** Whether a step may run `input.agent` on this harness, against its account file. Pure. */
  public compileAgent(input: CompileAgentInput): CompiledAgent {
    return compileClaudeAgent({ ...input, accountFile: resolveAccountFile(input.config) });
  }

  public createTurnReader(): TurnReader {
    return createClaudeTurnReader();
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
        },
      );
    });
  }

  public readWorkingDirectory(config: HarnessConfig, pid: number): string | null {
    let raw: string;
    try {
      raw = fs.readFileSync(processRecordFile(config, pid), 'utf8');
    } catch {
      // Not written yet, or the process is gone: nothing to say.
      return null;
    }
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      // Caught mid-write. The next read sees the whole record.
      return null;
    }
    const { pid: recordedPid, cwd } = (record ?? {}) as { pid?: unknown; cwd?: unknown };
    if (recordedPid !== pid || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error(`Unrecognised session record for process ${pid}.`);
    }
    return cwd;
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
        this.composeEnv(config, getLoginEnv()),
      );
    } catch (error) {
      throw new Error(
        describeSpawnFailure(
          resolvedBinary,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
  }

  /**
   * Ask this harness's CLI which MCP servers it would offer a step: its
   * user servers, from the account file when there is one (whether it is
   * there is all that is looked at: its contents are the CLI's to read),
   * and its claude.ai connectors. From the home directory, as
   * `probeCapabilities`, and without the harness's extra args. It connects
   * to every server it lists, so it starts the profile's stdio servers.
   */
  public async probeMcpServers(config: HarnessConfig): Promise<McpServerReport[]> {
    if (config.binaryPath && !isExecutable(config.binaryPath)) {
      throw new Error(`Not executable: ${config.binaryPath}`);
    }
    const resolvedBinary = this.resolveBinary(config);
    const accountFile = resolveAccountFile(config);
    try {
      return await probeClaudeMcpServers(
        resolvedBinary,
        this.composeEnv(config, getLoginEnv()),
        fs.existsSync(accountFile) ? accountFile : null,
      );
    } catch (error) {
      throw new Error(
        describeSpawnFailure(
          resolvedBinary,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
  }

  /**
   * One `claude -p` call from the home directory (like the capabilities probe,
   * so no repo's settings or hooks load), with the prompt on stdin.
   * `config.extraArgs` are deliberately not passed: they configure
   * interactive sessions, and this call must stay tool-less and hook-less.
   */
  public async generateText(
    config: HarnessConfig,
    request: TextGenerationRequest,
  ): Promise<unknown> {
    if (config.binaryPath && !isExecutable(config.binaryPath)) {
      throw new Error(`Not executable: ${config.binaryPath}`);
    }
    const resolvedBinary = this.resolveBinary(config);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const child = spawn(resolvedBinary, buildTextGenerationArgs(request), {
        cwd: os.homedir(),
        env: this.composeEnv(config, getLoginEnv()),
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => reject(new Error('The title call timed out.')));
      }, request.timeoutMs ?? TEXT_GENERATION_TIMEOUT_MS);

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.stdin.on('error', () => {
        // The process may exit before reading its prompt; close/error say why.
      });
      child.on('error', (error) =>
        settle(() => reject(new Error(describeSpawnFailure(resolvedBinary, error)))),
      );
      child.on('close', (code) =>
        settle(() => {
          // A refused call (not logged in, unknown model) still answers on
          // stdout, and exits 1: its reason is there, not on stderr.
          let parsed: { is_error?: unknown; result?: unknown; structured_output?: unknown } | null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }
          if (parsed?.is_error === true) {
            reject(
              new Error(
                typeof parsed.result === 'string' && parsed.result.trim()
                  ? parsed.result.trim()
                  : 'The title call failed.',
              ),
            );
          } else if (code !== 0) {
            // The process ran, so this is no longer a question of where the
            // binary is: say what it said, or how it ended.
            const lastLine = stderr
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .pop();
            reject(new Error(lastLine ?? `claude exited with code ${code}.`));
          } else if (parsed?.structured_output && typeof parsed.structured_output === 'object') {
            resolve(parsed.structured_output);
          } else {
            reject(new Error('The title call returned no answer.'));
          }
        }),
      );
      child.stdin.end(request.prompt);
    });
  }

  /**
   * Ask this harness's CLI for its usage limits, from the home directory for
   * the same reason as `probeCapabilities`: the answer belongs to the profile,
   * not to any folder.
   */
  private async readUsageLimits(config: HarnessConfig): Promise<HarnessLimits> {
    if (config.binaryPath && !isExecutable(config.binaryPath)) {
      throw new Error(`Not executable: ${config.binaryPath}`);
    }
    const resolvedBinary = this.resolveBinary(config);
    let answer: unknown;
    try {
      answer = await requestUsage(
        resolvedBinary,
        os.homedir(),
        this.composeEnv(config, getLoginEnv()),
      );
    } catch (error) {
      throw new Error(
        describeSpawnFailure(
          resolvedBinary,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
    return mapClaudeUsage(answer, Date.now());
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
  options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
  driver: HarnessDriver = new ClaudeDriver(),
): Promise<HeadlessResult> {
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
      },
    );
  });
}
