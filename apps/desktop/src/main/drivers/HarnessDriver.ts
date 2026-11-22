import * as os from 'node:os';
import * as path from 'node:path';
import type { ConversationRecord, ConversationWindow } from '../../shared/conversation';
import type {
  HarnessCapabilities,
  HarnessDriverId,
  HarnessLaunchFields,
  HarnessProbeResult,
} from '../../shared/types';
import type { HarnessLimits } from '../../shared/usageLimits';
import type { SessionToolPolicy } from '../../shared/workspace';
import type { AttentionSignal } from '../attention/hookSignals';

/** One throwaway, tool-less call to a small model that must answer in `schema`. */
export interface TextGenerationRequest {
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  effort?: string;
  fast?: boolean;
  timeoutMs?: number;
}

/** What `readCliNameSince` found: the name given since, and where to read from next. */
export interface CliNameRead {
  name: string | null;
  next: number;
}

/**
 * What Consola needs to know about an agent CLI in order to drive it.
 *
 * Consola coordinates external CLIs rather than reimplementing them, so a
 * driver describes only how to *launch and inspect* one — never how its
 * conversation looks. Each method corresponds to something that genuinely
 * differs between CLIs: where the binary lives, how a session is named on the
 * command line, which environment variable redirects its profile, and how to
 * tell whether it is installed and signed in.
 */
export interface HarnessDriver {
  readonly id: HarnessDriverId;

  /**
   * Environment variable this CLI reads for its config/profile directory, when
   * the CLI supports redirecting its profile that way.
   *
   * Named per driver rather than assumed, so a second CLI with a differently
   * named variable is a new driver rather than a change to shared code.
   */
  readonly configDirEnvVar?: string;

  /** Absolute path to the binary, or a bare name to let the spawn fail loudly. */
  resolveBinary(config: HarnessConfig): string;

  /**
   * argv for an interactive session, including the harness's extra args.
   *
   * Throws when `launch.toolPolicy` is set and `toolPolicyProblem` says it
   * cannot be enforced: a session that was meant to be restricted must
   * never start unrestricted.
   */
  buildSessionArgs(config: HarnessConfig, launch: SessionLaunch): string[] | Promise<string[]>;

  /**
   * Why this harness cannot launch a session under `policy`, or null when
   * it can. Null for no policy. A driver whose CLI has no way to enforce a
   * policy says so here rather than launching without it, and so does one
   * whose harness's extra args would loosen it.
   */
  toolPolicyProblem(config: HarnessConfig, policy: SessionToolPolicy | undefined): string | null;

  /**
   * Why this harness's extra args would override what a step's reporting
   * turn is launched with; null when they would not. A driver that offers
   * `createTurnReader` and compiles flags into a step's turn says so here,
   * and `buildSessionArgs` refuses such a turn in the same words.
   * `compiled.model`: the turn sets a model (its agent's), so the driver's
   * model flag is one of those flags; a turn without one compiles none.
   */
  stepTurnProblem?(config: HarnessConfig, compiled?: { model?: boolean }): string | null;

  /** Deliver the opening prompt through argv instead of waiting on the TUI. */
  readonly initialPromptViaArgs?: boolean;

  /** False when retrying a failed resume would risk replacing a conversation. */
  readonly retryResumeAsFresh?: boolean;

  /** Observe one PTY's output to persist native conversation switches. */
  createOutputObserver?(config: HarnessConfig, sessionId: string): (data: string) => void;

  /**
   * A reader for one unattended turn launched with `SessionLaunch.reportTurn`.
   * Absent: the driver cannot report turns.
   */
  createTurnReader?(): TurnReader;

  /**
   * The folder a running session's process says it works in, read from
   * the CLI's own record of it — never inferred from what it printed.
   *
   * Optional: an agent can move itself (Claude's EnterWorktree moves the
   * whole process into a worktree), and a CLI that keeps no such record
   * simply omits this, leaving its sessions shown where they launched.
   * Null while the CLI has nothing to say for `pid`; throws when the record
   * is there but not one this driver recognises, since a guess would put
   * every git view on the wrong checkout.
   */
  readWorkingDirectory?(config: HarnessConfig, pid: number): string | null;

  /** The ambient environment plus this harness's own variables. */
  composeEnv(config: HarnessConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /** Whether the binary is present and who it is authenticated as. */
  probeHealth(config: HarnessConfig): Promise<HarnessProbeResult>;

  /**
   * The first real message of a conversation, with only outer whitespace
   * trimmed, read from this CLI's own transcript. `null` when there is no
   * transcript or no real message yet. Optional: a CLI whose transcripts
   * Consola cannot read omits it and its sessions are not named from it.
   */
  readFirstPrompt?(config: HarnessConfig, conversationId: string): Promise<string | null>;

  /**
   * The latest name the person gave this conversation inside the CLI, among
   * the complete records after `from`. `from` is the opaque position this
   * method last returned (`0` for the start); `next` is where to resume.
   * `null` when there is no transcript. Optional, like `readFirstPrompt`.
   */
  readCliNameSince?(
    config: HarnessConfig,
    conversationId: string,
    from: number,
  ): Promise<CliNameRead | null>;

  /**
   * Ask a model one question outside any conversation: no tools, no hooks,
   * nothing persisted. Resolves to the structured answer; rejects with an
   * `Error` whose message can be shown to the person. Optional: a CLI that
   * cannot do this omits it.
   */
  generateText?(config: HarnessConfig, request: TextGenerationRequest): Promise<unknown>;

  /** Latest model reported by this conversation, when a transcript exists. */
  getSessionModel?(config: HarnessConfig, sessionId: string): Promise<string | null>;

  /**
   * A conversation's prompts, tool calls and replies, read from the CLI's
   * own transcript — never by resuming it. Serves the Automations side
   * panel and any future "read a session" tool alike. `window` keeps only
   * the records inside it. `null` when there is no transcript.
   *
   * Optional: a CLI whose transcripts Consola cannot read omits it, and the
   * UI offers "Open session" alone.
   */
  readConversation?(
    config: HarnessConfig,
    conversationId: string,
    window?: ConversationWindow,
  ): Promise<ConversationRecord | null>;

  /**
   * Make one of this CLI's conversations, stored under `from`, forkable by
   * a launch under `to` — another harness of this same driver — with
   * `SessionLaunch.forkFrom`. How a harness switch carries a conversation
   * over whole, tool results included.
   *
   * Never overwrites what `to` holds, and resolves `carried` only once the
   * conversation is verifiably there: a fork of something missing fails.
   * `missing` when `from` holds no transcript for it, which the caller
   * reports: it cannot tell a conversation never spoken in from one kept
   * somewhere `from` does not point.
   *
   * Optional: a driver whose CLI cannot fork (`buildSessionArgs` refuses
   * `forkFrom`), or whose storage Consola cannot copy, omits it, and a
   * switch hands the conversation over as a transcript instead.
   */
  transplantConversation?(
    from: HarnessConfig,
    to: HarnessConfig,
    conversationId: string,
  ): Promise<'carried' | 'missing'>;

  /**
   * The commands, agents and models this CLI offers, asked of the CLI itself.
   *
   * Optional: a CLI with no way to enumerate its own features simply omits
   * this, and the composer goes without autocomplete rather than waiting on
   * an answer that never comes.
   *
   * Unlike the other methods here this one may reject. It talks to a separate
   * process over a pipe, so a missing binary, a hung child and unrecognised
   * output are all ordinary outcomes. `HarnessCapabilitiesCache` is the one
   * place that turns any driver's failure into the uniform shape the UI
   * renders, so drivers should throw rather than invent an empty result.
   */
  probeCapabilities?(config: HarnessConfig): Promise<HarnessCapabilities>;

  /**
   * How this CLI reports, on its own initiative, that it needs the person.
   *
   * Optional: a CLI with nothing like hooks omits it and its sessions stay
   * on the screen heuristic alone, which is always running regardless. What
   * this adds is truth the screen cannot show — a question that is no known
   * menu, a subagent waiting — never a replacement for reading the screen.
   */
  readonly attentionHooks?: AttentionHooks;

  /**
   * How this CLI answers "what are my limits, and when do they reset?".
   *
   * Optional: a CLI that cannot say omits it, and a session that stops on a
   * limit there simply stops, with no time to come back at.
   */
  readonly usageLimits?: UsageLimitReporting;
}

/** A driver's attention-reporting capability: where its CLI is told to post, and what the posts mean. */
export interface AttentionHooks {
  /** Translate one posted payload. Null for an event that says nothing about attention. */
  parse(body: unknown): AttentionSignal | null;
}

/** A driver's usage-limit reporting, asked of the CLI itself. */
export interface UsageLimitReporting {
  /**
   * Ask the CLI for this harness's limits. Starts a process and runs no turn,
   * so it costs no tokens. Rejects on an answer it does not recognise, rather
   * than inventing one: a guessed reset would wake a session into the same
   * limit.
   */
  read(config: HarnessConfig): Promise<HarnessLimits>;
  /**
   * Whether `visibleText`, a terminal screen, shows the CLI's own notice that
   * a turn stopped on a usage limit. A hint only: a match prompts a `read`,
   * and the session is limited only when a used-up window binds it.
   */
  showsLimitNotice?(visibleText: string): boolean;
}

/**
 * A reporting turn's first word about itself: the model it runs and every
 * MCP server it loaded, with how each connected. `raw` is the CLI's own
 * object, for `turn.json`.
 */
export interface TurnInit {
  model?: string;
  servers: Array<{ name: string; status: string }>;
  /** Where this CLI signs in to a server, in the driver's words. */
  signInHint?: string;
  raw: unknown;
}

/**
 * A reporting turn's last word about itself. `text` and a string
 * `apiErrorStatus` are the CLI's text as `oneLine` shapes it; `raw` is the
 * CLI's own object, whole, for `turn.json`.
 */
export interface TurnResult {
  subtype: string;
  isError: boolean;
  /** The CLI's estimate, as it printed it: for a resumed turn, the conversation's so far. */
  costUsd?: number;
  turns?: number;
  text?: string;
  apiErrorStatus?: string | number;
  /** The tools it was refused, distinct, in the order they were first refused. */
  deniedTools: string[];
  raw: unknown;
}

/** One thing a reporting turn's stream said that the pane or the launcher acts on. */
export type TurnEvent =
  | { kind: 'init'; init: TurnInit }
  | { kind: 'tool'; name: string }
  | { kind: 'line'; text: string };

/** What a reporting turn said about itself, read whole at its exit. */
export interface TurnReport {
  init?: TurnInit;
  result?: TurnResult;
  /** The lines that were not JSON, cleaned: the last ones. */
  otherLines: string[];
  /** Whether the stream said the turn stopped on a usage limit. A hint, as a notice on screen is. */
  limitNotice: boolean;
  /** The cap the turn launched with: the launcher's to add, never the reader's. */
  maxTurns?: number;
}

/** One reporting turn's stream, read as it arrives. */
export interface TurnReader {
  /** One raw PTY chunk; the events of every line it completed, in order. */
  push(chunk: string): TurnEvent[];
  /** Whether the stream has said this turn stopped on a usage limit, so far. */
  readonly limitNotice: boolean;
  /** At exit: the events of a last line with no newline, and the report (`maxTurns` is the launcher's to add). */
  end(): { events: TurnEvent[]; report: TurnReport };
}

/**
 * What fixes one session's argv, beyond the harness's own settings.
 *
 * An object rather than positional parameters: `buildSessionArgs` already took
 * three, and everything here is chosen per conversation and then frozen, so
 * the list grows as new session-scoped pins are added.
 */
export interface SessionLaunch {
  sessionId: string;
  cwd?: string;
  initialPrompt?: string;
  /** Resume the existing conversation instead of starting one. */
  resume: boolean;
  /** Model selector to pin, when the session chose one. */
  model?: string;
  /**
   * MCP config file to register with the CLI, when the session carries one.
   *
   * Set only for conductor sessions. A driver whose CLI cannot load MCP
   * servers from a config file must throw when this is set — silently
   * ignoring it would launch a conductor with no hands.
   */
  mcpConfigPath?: string;
  /** What the agent may do, fixed for the session's lifetime and replayed on every resume. */
  toolPolicy?: SessionToolPolicy;
  /**
   * Run one turn non-interactively, with `initialPrompt` as its argument,
   * and exit: nobody is there to type, so there is no composer to type
   * into. Only for a read-only session — a non-interactive turn skips the
   * CLI's folder-trust prompt — and a driver that cannot do it refuses.
   */
  unattended?: boolean;
  /**
   * Start `sessionId` as a copy of this conversation, leaving the original
   * as it was. First launch only; a driver that cannot fork refuses.
   */
  forkFrom?: string;
  /**
   * Loopback URL this session's hooks post to, when the driver has
   * `attentionHooks` and Consola's endpoint is up. Absent otherwise, and a
   * session launched without it is simply not reporting.
   */
  attentionUrl?: string;
  /**
   * Run this unattended turn with the CLI's structured report, which
   * `createTurnReader` reads. Ignored on an interactive launch.
   */
  reportTurn?: boolean;
  /** The most turns this launch may take. Ignored on an interactive launch. */
  maxTurns?: number;
}

/**
 * Whether `args` names any of `flags`, as `--flag value` or `--flag=value`.
 * The shared half of every driver's loosening check; which flags loosen is
 * each CLI's own business.
 */
export function namedFlags(args: readonly string[], flags: readonly string[]): string[] {
  return flags.filter((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
}

/** The refusal every driver gives for loosening extra args, so they read alike. */
export function looseningProblem(flags: readonly string[]): string | null {
  if (flags.length === 0) return null;
  return (
    `This harness's extra arguments (${flags.join(', ')}) would loosen a read-only session, ` +
    'so automations cannot start sessions on it. Remove them in Settings › Harnesses, or make ' +
    'another harness this workspace’s default.'
  );
}

/** A harness's launch settings, normalised for driver consumption. */
export interface HarnessConfig {
  /** Explicit binary path, when the harness pins one. */
  binaryPath?: string;
  /** Config directory for this driver's `configDirEnvVar`, when set. */
  configDir?: string;
  extraArgs: string[];
}

/**
 * Resolve a leading `~` against the current user's home directory.
 *
 * Harness paths are typed by hand, and `~/.claude-work` is how people write a
 * home-relative path. Nothing expands it downstream: a config directory becomes
 * an environment variable read by a spawned process, and env vars get no shell
 * expansion — `claude` would create a literal `~` directory under the session's
 * working directory and run against an empty profile. Expanding here, at the
 * single point where launch fields become driver input, covers every consumer
 * (session spawn, health probe, transcript lookup) and leaves the stored value
 * readable as the user wrote it.
 *
 * Only `~` alone and a leading `~/` are home references. `~someone/...` means
 * another user's home, which is not ours to guess, and a tilde anywhere else is
 * an ordinary character in a path name.
 */
function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

/**
 * Normalise the optional fields that cross IPC into a driver-ready config.
 *
 * Empty strings are treated as absent so a cleared text field in the harness
 * form means "use the default" rather than "use the empty path".
 */
export function toHarnessConfig(fields: HarnessLaunchFields | undefined): HarnessConfig {
  const binaryPath = fields?.binaryOverride?.trim() || undefined;
  const configDir = fields?.configDirOverride?.trim() || undefined;
  return {
    binaryPath: binaryPath && expandHome(binaryPath),
    configDir: configDir && expandHome(configDir),
    extraArgs: fields?.extraArgs ?? [],
  };
}
