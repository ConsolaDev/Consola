import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConversationRecord, ConversationWindow } from '../../shared/conversation';
import type { HarnessAccount, HarnessCapabilities, HarnessProbeResult } from '../../shared/types';
import type { SessionToolPolicy } from '../../shared/workspace';
import { getLoginEnv } from '../LoginEnvironment';
import { JsonStateFile } from '../state/JsonStateFile';
import { probeAntigravityCapabilities } from './antigravityCapabilities';
import { readAntigravityFirstPrompt, readAntigravityTranscript } from './antigravityConversation';
import type { HarnessConfig, HarnessDriver, SessionLaunch } from './HarnessDriver';
import { readSessionModel } from './sessionModel';

/**
 * Driver for Google's Antigravity CLI (`agy`).
 *
 * Antigravity allocates its own conversation UUIDs and stores transcripts under
 * `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
 * Like Codex, Consola maps each tab's session ID to the active native
 * conversation ID and tracks `/new`, `/clear`, `/fork`, and `/resume` inside
 * the TUI through the CLI's session-only `--settings` `title` command, which
 * emits the active UUID in OSC 0/2.
 */

interface AntigravityMapping {
  conversationId: string;
}

const BINARY_NAME = 'agy';
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Extracts `conversation_id` (a 36-char UUID) from the JSON state payload
 * Antigravity pipes to its `title` script on stdin.
 */
const POSIX_TITLE_COMMAND = String.raw`sed -n 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]\{36\}\)".*/\1/p'`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why Antigravity cannot run a `read-only` session yet: `agy` has no
 * `--restricted` or `--strict-mcp-config` flag to shut out global or
 * repository hooks (`~/.gemini/config/hooks.json`, `.agents/hooks.json`) and
 * MCP servers, nor a tool allowlist flag that confines it to file reads and
 * Consola's read-only tools. Refused rather than launched looser than asked.
 */
const READ_ONLY_REFUSAL =
  'Antigravity sessions cannot be made read-only yet, so automations cannot start one: make a Claude harness ' +
  'this workspace’s default to run them.';

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveDataDir(config: HarnessConfig): string {
  return config.configDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function mappingPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'consola', 'sessions', `${sessionId}.json`);
}

function transcriptPath(dataDir: string, conversationId: string): string {
  return path.join(
    dataDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a `--settings` argument value: either inline JSON or a path to a JSON
 * file, matching `agy --settings`. Returns null when unreadable or not an object.
 */
function parseSettingsValue(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(raw, 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * Append Consola's session-only `title` identity channel via `--settings`,
 * merging with any `--settings` already in `extraArgs` so user overrides stay
 * intact while Consola still learns the active conversation ID.
 */
export function withTitleSettings(extraArgs: readonly string[]): string[] {
  const titleSetting = { type: 'command', command: POSIX_TITLE_COMMAND };
  const result: string[] = [];
  let merged: Record<string, unknown> | null = null;
  let sawUnmergeableSettings = false;

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '--settings' && i + 1 < extraArgs.length) {
      const parsed = parseSettingsValue(extraArgs[i + 1]);
      if (parsed) {
        merged = { ...(merged ?? {}), ...parsed };
        i++;
      } else {
        sawUnmergeableSettings = true;
        result.push(arg, extraArgs[++i]);
      }
      continue;
    }
    if (arg.startsWith('--settings=')) {
      const parsed = parseSettingsValue(arg.slice('--settings='.length));
      if (parsed) {
        merged = { ...(merged ?? {}), ...parsed };
      } else {
        sawUnmergeableSettings = true;
        result.push(arg);
      }
      continue;
    }
    result.push(arg);
  }

  if (sawUnmergeableSettings) return result;
  const payload = { ...(merged ?? {}), title: titleSetting };
  result.push('--settings', JSON.stringify(payload));
  return result;
}

/** Read non-sensitive auth mode hints from `settings.json` and env when signed in. */
function readAccountHint(config: HarnessConfig, env: NodeJS.ProcessEnv): HarnessAccount {
  try {
    const raw = fs.readFileSync(path.join(resolveDataDir(config), 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as {
      modelProvider?: unknown;
      gcp?: { project?: unknown };
    };
    if (settings?.modelProvider === 'gemini') {
      return { displayName: 'Gemini API key' };
    }
    const project = typeof settings?.gcp?.project === 'string' ? settings.gcp.project.trim() : '';
    if (project) {
      return { displayName: 'Google Cloud', organizationName: project };
    }
  } catch {
    // Missing or unreadable settings.json: fall back to default account label.
  }
  if (env.AGY_ADC_AUTH === 'true') {
    const project = env.GOOGLE_CLOUD_PROJECT?.trim() || undefined;
    return { displayName: 'Google Cloud (ADC)', organizationName: project };
  }
  return { displayName: 'Google' };
}

function parseVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return trimmed.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/)?.[1] ?? trimmed.split(/\s+/)[0];
}

export class AntigravityDriver implements HarnessDriver {
  public readonly id = 'antigravity' as const;
  public readonly initialPromptViaArgs = true;
  public readonly retryResumeAsFresh = false;

  /**
   * What it pins, else `~/.gemini`: the folder that holds its data dir
   * (`~/.gemini/antigravity-cli`) and the CLI's own sign-in beside it, so a
   * write step's sandbox denies both (plan Call 21). It reads no variable.
   */
  public profileDir(config: HarnessConfig): string {
    return config.configDir || path.join(os.homedir(), '.gemini');
  }

  public resolveBinary(config: HarnessConfig): string {
    if (config.binaryPath) return config.binaryPath;
    const dirs = (getLoginEnv().PATH ?? '').split(path.delimiter).filter(Boolean);
    const candidates = [
      ...dirs.map((dir) => path.join(dir, BINARY_NAME)),
      path.join(os.homedir(), '.local/bin', BINARY_NAME),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    ];
    return candidates.find(isExecutable) ?? BINARY_NAME;
  }

  public composeEnv(_config: HarnessConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv };
  }

  public toolPolicyProblem(
    _config: HarnessConfig,
    policy: SessionToolPolicy | undefined,
  ): string | null {
    return policy ? READ_ONLY_REFUSAL : null;
  }

  public buildSessionArgs(config: HarnessConfig, launch: SessionLaunch): string[] {
    const problem = this.toolPolicyProblem(config, launch.toolPolicy);
    if (problem) throw new Error(problem);
    if (launch.unattended || launch.forkFrom) {
      throw new Error(
        'This harness can’t run a turn unattended or continue a conversation in a new session.',
      );
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(launch.sessionId)) {
      throw new Error('Invalid Consola session ID.');
    }

    const conversationId = this.readMappedConversation(config, launch.sessionId);
    return [
      ...(conversationId ? ['--conversation', conversationId] : []),
      ...(launch.model ? ['--model', launch.model] : []),
      ...withTitleSettings(config.extraArgs),
      ...(launch.initialPrompt ? ['--prompt-interactive', launch.initialPrompt] : []),
    ];
  }

  public createOutputObserver(config: HarnessConfig, sessionId: string): (data: string) => void {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Consola session ID.');
    const file = new JsonStateFile<AntigravityMapping>(
      mappingPath(resolveDataDir(config), sessionId),
    );
    let mapping = file.read();
    let pending = '';
    return (data) => {
      // Parse only OSC 0/2 titles emitted by our `--settings` title command,
      // never UUIDs printed in model output or resume hints. Sequences can split
      // anywhere across PTY reads.
      pending += data;
      while (pending) {
        const start = pending.indexOf('\x1b]');
        if (start < 0) {
          pending = pending.endsWith('\x1b') ? '\x1b' : '';
          break;
        }
        pending = pending.slice(start);
        const end = /\x07|\x1b\\/.exec(pending);
        if (!end) {
          if (pending.length > 1024) pending = '';
          break;
        }
        const title = pending.slice(2, end.index);
        pending = pending.slice(end.index + end[0].length);
        const match = /^[02];([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
          title,
        );
        if (match && match[1] !== mapping?.conversationId) {
          mapping = { conversationId: match[1] };
          file.write(mapping);
        }
      }
    };
  }

  public async readFirstPrompt(
    config: HarnessConfig,
    conversationId: string,
  ): Promise<string | null> {
    try {
      const file = this.locateTranscript(config, conversationId);
      return file ? await readAntigravityFirstPrompt(file) : null;
    } catch {
      return null;
    }
  }

  public async getSessionModel(config: HarnessConfig, sessionId: string): Promise<string | null> {
    try {
      const file = this.locateTranscript(config, sessionId);
      return file ? await readSessionModel(file, 'antigravity') : null;
    } catch {
      return null;
    }
  }

  public async readConversation(
    config: HarnessConfig,
    conversationId: string,
    window?: ConversationWindow,
  ): Promise<ConversationRecord | null> {
    const file = this.locateTranscript(config, conversationId);
    return file ? readAntigravityTranscript(file, window) : null;
  }

  public async probeCapabilities(config: HarnessConfig): Promise<HarnessCapabilities> {
    if (config.binaryPath && !isExecutable(config.binaryPath)) {
      throw new Error(`Not executable: ${config.binaryPath}`);
    }
    return probeAntigravityCapabilities(
      this.resolveBinary(config),
      os.homedir(),
      this.composeEnv(config, getLoginEnv()),
    );
  }

  public async probeHealth(config: HarnessConfig): Promise<HarnessProbeResult> {
    const resolvedBinary = this.resolveBinary(config);
    if (config.binaryPath && !isExecutable(config.binaryPath)) {
      return { available: false, resolvedBinary, error: `Not executable: ${config.binaryPath}` };
    }
    const env = this.composeEnv(config, getLoginEnv());
    const run = (args: string[]) =>
      new Promise<{ ok: boolean; stdout: string; stderr: string; code?: string }>((resolve) => {
        execFile(
          resolvedBinary,
          args,
          {
            cwd: os.homedir(),
            env,
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              stdout,
              stderr,
              code: error ? String((error as NodeJS.ErrnoException).code ?? '') : undefined,
            }),
        );
      });

    const version = await run(['--version']);
    if (!version.ok) {
      return {
        available: false,
        resolvedBinary,
        error:
          version.code === 'ENOENT'
            ? 'Not found — `agy` is not installed or not on PATH.'
            : 'Could not run Antigravity. Check the binary path and configuration.',
      };
    }

    // `agy models` verifies cached auth without running a turn or creating a conversation.
    const auth = await run(['models']);
    return {
      available: true,
      resolvedBinary,
      version: parseVersion(version.stdout || version.stderr),
      account: auth.ok ? readAccountHint(config, env) : undefined,
    };
  }

  /**
   * Read the native conversation ID saved for `sessionId`, or undefined when
   * this tab has not started a conversation yet. Throws on corrupt mappings.
   */
  private readMappedConversation(config: HarnessConfig, sessionId: string): string | undefined {
    const file = new JsonStateFile<AntigravityMapping>(
      mappingPath(resolveDataDir(config), sessionId),
    );
    const stored = file.read();
    if (!stored) return undefined;
    if (typeof stored.conversationId !== 'string' || !UUID_PATTERN.test(stored.conversationId)) {
      throw new Error('Invalid saved Antigravity conversation ID.');
    }
    return stored.conversationId;
  }

  private locateTranscript(config: HarnessConfig, sessionId: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const dataDir = resolveDataDir(config);
    let raw: string;
    try {
      raw = fs.readFileSync(mappingPath(dataDir, sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const mapping = JSON.parse(raw) as Partial<AntigravityMapping>;
    const nativeId = mapping?.conversationId;
    if (typeof nativeId !== 'string' || !UUID_PATTERN.test(nativeId)) return null;
    const file = transcriptPath(dataDir, nativeId);
    return fs.existsSync(file) ? file : null;
  }
}
