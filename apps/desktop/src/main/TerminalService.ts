import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { TerminalDimensions, HarnessLaunchFields, ScreenReplay } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';
import { getLoginEnv, loginEnvProblem, loginEnvRetry } from './LoginEnvironment';
import { getDriver, toHarnessConfig, type HarnessConfig, type HarnessDriver } from './drivers';
import { ScreenModel } from './ScreenModel';
import { PROVIDER_META, isGitProviderId, type GitProviderId } from '../shared/providers';
import { getProviderDriver, layerProviderToken } from './providers';
import { deriveTerminalStatus, type TerminalStatus } from '../shared/terminalStatus';
import type { SessionToolPolicy } from '../shared/workspace';

/**
 * One session tab's terminal.
 *
 * Owns the `claude` process behind a single pane. The process outlives the
 * React component that renders it: output is mirrored here so remounting a tab
 * repaints instead of restarting the conversation.
 */

/** Silence after which a terminal is considered idle. */
const IDLE_DEBOUNCE_MS = 500;

/**
 * How long output must keep coming, with nothing from the view for it to
 * answer, before it counts as a turn.
 *
 * Output alone is not work. The CLI paints when it launches, repaints when
 * its pane is fitted, and answers a focus report, a scroll and every key, so
 * merely opening a session used to read as `working` — moving its row to
 * Working and back, and counting as activity. Each of those is a burst that
 * ends within about 400 ms (measured against Claude Code 2.1), or that
 * follows the view's own input. A turn is the CLI painting its spinner, on
 * its own, for as long as the turn runs.
 */
const TURN_MIN_MS = 1_000;

/**
 * How long after the person types into a menu the screen is read again.
 *
 * A menu is otherwise only looked for when output pauses, and a turn that
 * goes on after its answer does not pause: recorded against Claude Code
 * 2.1.327, it paints without a half-second gap until it ends. Long enough
 * for the CLI to have repainted over the menu, short enough that the session
 * stops saying it waits on the person about when they stop waiting on it.
 */
const ANSWER_RECHECK_MS = 300;

/** How often a working CLI is asked where it works. Never while it is idle. */
const WORKING_DIRECTORY_POLL_MS = 2_000;

/**
 * How long an unattended turn may run before Consola stops it. A print-mode
 * process that never exits would hold one of the few automation slots
 * forever; an hour is far past any review.
 */
export const UNATTENDED_TURN_LIMIT_MS = 60 * 60_000;

const UNATTENDED_NOTICE =
  'Consola is running this unattended and read-only. What it finds appears here when it finishes. Press Ctrl+C to stop it.';
const UNATTENDED_LIMIT_REASON = 'it ran for an hour without finishing';
const UNATTENDED_LIMIT_NOTICE = 'Stopped: it ran for an hour without finishing.';

/** How long a turn stopped at the limit gets to exit before it is killed outright. */
const UNATTENDED_KILL_GRACE_MS = 10_000;

/**
 * Markers for a TUI screen that is waiting on a keyboard confirmation — the
 * workspace trust gate, tool permission prompts, and similar menus.
 *
 * Matched against the emulated screen with whitespace collapsed, so wrapping
 * and column padding do not defeat them.
 */
const TRUST_GATE_MARKERS = [/do you trust/i, /trust this folder/i];

const CONFIRMATION_MARKERS = [
  ...TRUST_GATE_MARKERS,
  /do you want to proceed/i,
  /enter to confirm/i,
];

/**
 * An empty prompt composer: the CLI is booted, idle, and waiting for typing.
 *
 * Waiting for this positive signal — rather than merely for output to stop —
 * keeps a queued prompt out of the startup repaint and out of any menu, and
 * requiring the composer to be *empty* means it can never clobber text the user
 * has already begun typing. Matched against the screen with faint text
 * removed, so Claude's placeholder suggestion still counts as empty.
 */
const COMPOSER_READY_PATTERN = /^\s*[❯>›]\s*$/;

/** Erase the display and scrollback, then home the cursor. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** Wrap Consola's own words in red, on their own line, so they read as ours. */
function formatNotice(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

/** Consola's own words that are news, not a problem: dim instead of red. */
function formatInfo(message: string): string {
  return `\x1b[2m${message}\x1b[0m\r\n\r\n`;
}

function normalizeScreen(visibleText: string): string {
  return visibleText.replace(/\s+/g, ' ');
}

export interface TerminalServiceOptions extends HarnessLaunchFields {
  cwd: string;
  /** Session ID Consola assigned to this tab. */
  claudeSessionId: string;
  /** Resume the existing conversation instead of starting one. */
  resume: boolean;
  /** Initial size, so the TUI paints at the right dimensions immediately. */
  cols?: number;
  rows?: number;
  /** Prompt to submit once the CLI is ready for input; with `unattended`, the turn's argument. */
  initialPrompt?: string;
  /**
   * Run the first launch as one non-interactive turn (`SessionLaunch.unattended`).
   * Consumed by the first spawn: a restart resumes interactively.
   */
  unattended?: boolean;
  /** Start this session as a fork of that conversation. Consumed by the first spawn. */
  forkFrom?: string;
  /**
   * How this conversation opens should a resume find it missing, when a
   * harness switch began it (`openingFor`). Unlike `forkFrom`, never
   * consumed: Claude writes a fork only once its first message is sent, so
   * any later launch may find it missing. Absent, a missing conversation
   * starts fresh.
   */
  opening?: ConversationOpening;
  /** Model this session is pinned to, replayed on every relaunch. */
  model?: string;
  /**
   * Consola's own line for the first spawn to print above the CLI — that a
   * worktree was rebuilt, say. Written to the screen, never typed into the
   * PTY, so it is in the snapshot a remounted pane repaints from.
   */
  launchNotice?: string;
  /**
   * MCP config file registered with the CLI on every launch of this
   * session. Set by main for conductor sessions only; opaque here — which
   * flag it becomes is the driver's business.
   */
  mcpConfigPath?: string;
  /**
   * Provider whose token this session's PTY gets, and as which account.
   * Resolved from the workspace's binding by whoever builds these options;
   * both absent for workspaces without a binding, which then spawn exactly
   * as before. The variable the token lands in is the driver's to name.
   */
  providerId?: GitProviderId;
  providerAccountLogin?: string;
  /**
   * What the agent may do, from the session record. Replayed on every
   * launch like the model; the driver enforces it or refuses to launch.
   */
  toolPolicy?: SessionToolPolicy;
  /**
   * Where this session's CLI should post its hooks, asked at each launch
   * (the endpoint may still be binding). Set by `TerminalManager` for a
   * driver that has `attentionHooks`; resolves undefined when there is
   * nothing to post to, and the session runs on the screen heuristic alone.
   */
  attentionUrl?: () => Promise<string | undefined>;
}

export interface TerminalExitInfo {
  exitCode: number;
  /** The launch that exited was an unattended turn. */
  unattended?: boolean;
  /** That turn's last non-empty screen line: its answer's end, or the CLI's error. */
  lastLine?: string;
  /**
   * Why that turn ended without finishing, whatever its exit code: the
   * person pressed Ctrl+C, Consola stopped it at the limit, a signal
   * killed it, or it never started. Claude exits 0 on Ctrl+C, and node-pty
   * reports a death by signal as exit 0, so the code alone cannot say.
   */
  stopped?: string;
}

/**
 * Characters a paste must not carry. Remote text reaches a paste -- a PR
 * title in an action's prompt, a review comment in a Fix -- and an ESC would
 * let it write its own `ESC[201~`: the paste would end early, and whatever
 * followed would arrive as keystrokes, Enter included, sent as the person.
 * Tab and line breaks are content; every other C0 control, DEL and the C1
 * controls (whose CSI, U+009B, is ESC[ in one byte) are not.
 */
const UNSAFE_IN_PASTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** `text` as one bracketed paste that nothing inside it can end early. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(UNSAFE_IN_PASTE, '')}\x1b[201~`;
}

/**
 * How a conversation opens when it does not exist yet: forked from another
 * one, and/or with a first prompt. What a harness switch began a
 * conversation with, kept for any launch that finds it missing.
 */
export interface ConversationOpening {
  forkFrom?: string;
  prompt?: string;
}

/** What `TerminalService.switchHarness` moves a terminal onto. */
export interface TerminalHarnessSwitch {
  /** The target harness's launch fields; `{}` is the built-in one. */
  launch: HarnessLaunchFields;
  /** Where the target driver's hooks post, when it has any. */
  attentionUrl?: () => Promise<string | undefined>;
  /** The conversation the terminal runs from now on. */
  claudeSessionId: string;
  /** How it opens: a native switch forks, a handoff prompts; neither for nothing to carry. */
  opening?: ConversationOpening;
  /** Printed above the new CLI, once. */
  notice: string;
}

/** What an exited terminal is started again with. */
export interface RelaunchFields {
  cwd: string;
  prompt: string;
  /** Run it as one non-interactive turn, prompt as argument; otherwise queue it for the composer. */
  unattended: boolean;
}

export class TerminalService extends EventEmitter {
  private claudePty: pty.IPty | null = null;
  private dimensions: TerminalDimensions;
  private readonly options: TerminalServiceOptions;
  /** Both follow `options`, and change only together, through `switchHarness`. */
  private driver: HarnessDriver;
  private harness: HarnessConfig;
  /** Consola's own line for the next spawn to print above the CLI, once. */
  private launchNotice: string | undefined;

  private screen: ScreenModel | null = null;
  /** Set while output is arriving: from a chunk until IDLE_DEBOUNCE_MS of quiet. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** A look at the screen owed to a key typed into a menu. */
  private answerRecheck: NodeJS.Timeout | null = null;
  /** When the output now arriving began. */
  private outputStartedAt = 0;
  /** When the view last sent the CLI anything: keys, a paste, a focus or mouse report, a size. */
  private lastInputAt = 0;
  /** A turn is running. */
  private isBusy = false;
  private claudeExited = false;
  /** Whether the current Claude launch has painted anything at all. */
  private claudeProducedOutput = false;
  /** Prompts waiting for the composer, oldest first. */
  private promptQueue: string[] = [];
  private isAwaitingConfirmation = false;
  /** Whether the settled screen shows the CLI's own notice that a turn stopped on a usage limit. */
  private isShowingLimitNotice = false;
  private isDestroyed = false;
  private isLaunching = false;
  private initialPromptArgument: string | undefined;
  private lastStatus: TerminalStatus | null = null;
  /** The next spawn is the unattended turn. */
  private unattendedPending: boolean;
  /** The next spawn forks this conversation. */
  private forkPending: string | undefined;
  /** The live process is an unattended turn: busy until it exits. */
  private unattendedTurn = false;
  private unattendedLimit: NodeJS.Timeout | null = null;
  private unattendedKill: NodeJS.Timeout | null = null;
  /** Why Consola stopped the unattended turn, when it did. */
  private unattendedStopReason: string | null = null;
  /** A stop asked for while the unattended launch was still being prepared. */
  private unattendedPendingStop: string | null = null;
  /** An exit waiting for the screen to catch up, run early if the screen goes first. */
  private screenSettling: (() => void) | null = null;
  private workingDirectoryPoll: NodeJS.Timeout | null = null;
  /** Where the live process last said it works. Cleared with every spawn. */
  private reportedWorkingDirectory: string | null = null;
  /** The CLI's answer could not be read once; asking again would only repeat that. */
  private workingDirectoryUnreadable = false;

  constructor(options: TerminalServiceOptions) {
    super();
    this.dimensions = {
      cols: options.cols ?? DEFAULT_DIMENSIONS.cols,
      rows: options.rows ?? DEFAULT_DIMENSIONS.rows,
    };
    this.options = options;
    // Resolved once, up front: an unrecognised driver has to surface here
    // rather than part-way through the resume-retry path below, where a
    // failure would be indistinguishable from a missing conversation.
    this.driver = getDriver(options.driverId);
    this.harness = toHarnessConfig(options);
    this.unattendedPending = options.unattended === true;
    this.forkPending = options.forkFrom;
    this.launchNotice = options.launchNotice;
    // An unattended turn takes its prompt as its argument: there is no
    // composer to type it into.
    if (this.driver.initialPromptViaArgs || this.unattendedPending) {
      this.initialPromptArgument = options.initialPrompt;
    } else {
      this.promptQueue = options.initialPrompt != null ? [options.initialPrompt] : [];
    }
  }

  public start(): void {
    void this.initClaude(this.options.resume);
  }

  /**
   * Queue a prompt to submit once the CLI is ready. Prompts append — they
   * are delivered oldest-first, one per ready-composer transition.
   *
   * Delivery waits for the terminal to go quiet and refuses to type into a
   * confirmation menu, so a prompt can never be mistaken for an answer to the
   * workspace trust gate or a permission request.
   */
  public queuePrompt(prompt: string): void {
    this.promptQueue.push(prompt);
    // Output still arriving may be a turn that has not yet lasted long
    // enough to read as one; the composer stays on screen beneath it.
    if (!this.isBusy && this.idleTimer === null) {
      this.deliverPendingPrompt();
    }
  }

  /** Whether the visible screen is a menu waiting on a keypress. */
  public awaitingConfirmation(): boolean {
    return this.isAwaitingConfirmation;
  }

  /** Whether output is still flowing — the CLI is working. */
  public busy(): boolean {
    return this.isBusy;
  }

  /** Escape sequences that repaint the PTY's current screen, and its size. */
  public getReplay(): ScreenReplay {
    return this.screen?.snapshot() ?? { replay: '', ...this.dimensions };
  }

  public hasClaudeExited(): boolean {
    return this.claudeExited;
  }

  public write(data: string): void {
    // Print mode exits 0 on Ctrl+C: remember that the person stopped it.
    if (this.unattendedTurn && data.includes('\x03'))
      this.unattendedStopReason ??= 'you pressed Ctrl+C';
    this.lastInputAt = Date.now();
    this.claudePty?.write(data);
    if (this.isAwaitingConfirmation) this.recheckAfterAnswer();
  }

  /**
   * The person typed into a menu: see whether that answered it, without
   * waiting for output to pause. Only ever clears the flag. A key that moved
   * through the menu leaves it on screen and so leaves the flag set, and a
   * frame caught half-painted is put right by the next pause, which is also
   * the only place a prompt is delivered — so this cannot let one be typed
   * into a menu.
   */
  private recheckAfterAnswer(): void {
    if (this.answerRecheck) clearTimeout(this.answerRecheck);
    this.answerRecheck = setTimeout(() => {
      this.answerRecheck = null;
      const screen = this.screen;
      if (!screen || this.isDestroyed) return;
      // The emulator parses asynchronously: read it once it has caught up.
      screen.write('', () => {
        if (this.isDestroyed || this.screen !== screen || !this.isAwaitingConfirmation) return;
        this.classifyScreen();
        this.emitStatus();
      });
    }, ANSWER_RECHECK_MS);
    this.answerRecheck.unref?.();
  }

  /**
   * Paste text as a single block.
   *
   * Bracketed paste tells the TUI to treat the payload as pasted input rather
   * than keystrokes, so multi-line content lands in the composer instead of
   * submitting at the first newline.
   */
  public paste(text: string): void {
    if (!this.claudePty) return;
    this.lastInputAt = Date.now();
    this.claudePty.write(bracketedPaste(text));
  }

  public resize(cols: number, rows: number): void {
    this.lastInputAt = Date.now();
    this.dimensions = { cols, rows };
    this.claudePty?.resize(cols, rows);
    this.screen?.resize(cols, rows);
  }

  /** The conversation this terminal launches: the record's, unless replaced since. */
  public conversationId(): string {
    return this.options.claudeSessionId;
  }

  /** Whether an unattended turn is running, or is what the pending launch will run. */
  public runningUnattended(): boolean {
    return this.unattendedTurn || this.unattendedPending;
  }

  /**
   * Replace the conversation this terminal runs with a new, empty one, and
   * open it with `prompt`.
   *
   * The tab, its view and everything it launches with stay; only the
   * session id the CLI is handed changes, and the launch creates instead
   * of resuming. A running process is stopped first, and from then on it
   * is not this terminal's: whatever it still prints and however it exits
   * are ignored, so a non-zero exit can neither retry as fresh nor report.
   * The prompt goes the way any first prompt goes — as an argument for a
   * driver that takes one, otherwise queued for the empty composer, never
   * into a menu. Prompts still queued for the old conversation are dropped
   * with it: they were written for a context that is gone.
   *
   * Refused while an unattended turn runs (its automation run waits on that
   * process's exit) and while a launch is already under way (it would
   * spawn under whichever id it read first).
   */
  public startFreshConversation(claudeSessionId: string, prompt?: string): void {
    if (this.isDestroyed) return;
    const refusal = this.moveRefusal();
    if (refusal) throw new Error(refusal);
    // A fresh conversation that goes missing starts fresh again, however the last one began.
    this.options.opening = undefined;
    this.moveToConversation(claudeSessionId, { prompt });
  }

  /**
   * Why this terminal cannot switch harness right now, or null when it
   * can. A turn in progress is the person's to finish or stop; what it was
   * doing would be lost mid-step. A CLI sitting at a menu is no turn — a
   * usage-limit notice is where a switch is most wanted — and the switch
   * stops that process rather than answering the menu.
   */
  public switchRefusal(): string | null {
    const refusal = this.moveRefusal();
    if (refusal) return refusal;
    if (this.isBusy)
      return 'This session is in the middle of a turn. Let it finish, or stop it, before switching.';
    return null;
  }

  /**
   * Move this terminal onto another harness, in place, and onto the
   * conversation it runs there: a fork of the old one (`forkFrom`), or a
   * fresh one opened with `prompt`.
   *
   * The instance stays — a mounted pane, the owner and every listener
   * keep working — while the process, the screen and everything this
   * terminal knew from the old CLI go, as `startFreshConversation` does.
   * The driver and harness are resolved anew from `launch`, and the model
   * is dropped with the harness that offered it. `notice` is printed above
   * the new CLI so the switch shows in the pane.
   */
  public switchHarness(change: TerminalHarnessSwitch): void {
    if (this.isDestroyed) return;
    const refusal = this.switchRefusal();
    if (refusal) throw new Error(refusal);

    this.options.driverId = change.launch.driverId;
    this.options.binaryOverride = change.launch.binaryOverride;
    this.options.configDirOverride = change.launch.configDirOverride;
    this.options.extraArgs = change.launch.extraArgs;
    this.options.model = undefined;
    this.options.attentionUrl = change.attentionUrl;
    this.driver = getDriver(change.launch.driverId);
    this.harness = toHarnessConfig(change.launch);
    // What the old CLI said about where it works says nothing about the new one.
    this.stopWorkingDirectoryPoll();
    this.reportedWorkingDirectory = null;
    this.workingDirectoryUnreadable = false;
    this.launchNotice = change.notice;
    this.options.opening = change.opening;
    this.moveToConversation(change.claudeSessionId, change.opening ?? {});
  }

  /**
   * Why the conversation cannot be replaced right now: an unattended turn's
   * automation run waits on that process's exit, and a launch under way
   * would spawn under whichever id it read first.
   */
  private moveRefusal(): string | null {
    if (this.runningUnattended())
      return 'An automation is still running its turn in this session. Wait for it to finish.';
    if (this.isLaunching) return 'This session is still starting. Try again in a moment.';
    return null;
  }

  /**
   * Stop the running process and launch `claudeSessionId` in its place:
   * a fork of `forkFrom` when given, otherwise a new conversation opened
   * with `prompt`. Callers have checked that a move is allowed.
   */
  private moveToConversation(claudeSessionId: string, opening: ConversationOpening): void {
    const previous = this.claudePty;
    this.claudePty = null;
    previous?.kill();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.options.claudeSessionId = claudeSessionId;
    // Prompts still queued were written for the context that is gone.
    this.initialPromptArgument = undefined;
    this.promptQueue = [];
    this.open(opening);

    // The old conversation's screen goes with it, in every view of it.
    this.disposeScreen();
    this.emit('data', CLEAR_SCREEN);
    this.setBusy(false);
    // Output that had not yet read as a turn was still being followed.
    this.followWorkingDirectory();
    if (this.isAwaitingConfirmation) {
      this.isAwaitingConfirmation = false;
      this.emit('awaiting-confirmation', false);
    }
    // A launch is under way; a view attaching before it spawns must not
    // offer a restart. Every way the launch can fail sets this back.
    this.claudeExited = false;
    this.emitStatus();
    void this.initClaude(false);
  }

  /**
   * Have the next spawn open its conversation this way: forking `forkFrom`,
   * and with `prompt` first — as an argument for a driver that takes one,
   * otherwise ahead of anything queued for the empty composer.
   */
  private open(opening: ConversationOpening): void {
    this.forkPending = opening.forkFrom;
    if (opening.prompt == null) return;
    if (this.driver.initialPromptViaArgs) this.initialPromptArgument = opening.prompt;
    else this.promptQueue.unshift(opening.prompt);
  }

  /** Restart Claude after it exited, resuming the same conversation. */
  /** The agent CLI's process id while it runs. */
  public pid(): number | undefined {
    return this.claudePty?.pid;
  }

  public restartClaude(cwd?: string, notice?: string): void {
    if (this.claudePty || this.isLaunching) return;
    if (cwd !== undefined) this.options.cwd = cwd;
    if (notice) this.launchNotice = notice;
    this.disposeScreen();
    // The screen the flag described is gone with it. Only classifyScreen()
    // ever clears this, and it does not run until the new PTY paints
    // something — so a CLI that died on a menu would leave the flag set
    // and the spawn's leading emitStatus() would ring needs-attention for
    // a menu nobody can answer.
    this.isAwaitingConfirmation = false;
    void this.initClaude(true);
  }

  /**
   * Start an exited terminal again, in place, resuming its conversation.
   *
   * Interactive, the prompt joins the queue and so waits for an empty
   * composer with no confirmation menu; never written straight to the PTY.
   * Unattended, it is the turn's argument.
   */
  public relaunch(launch: RelaunchFields): void {
    if (this.claudePty || this.isLaunching) throw new Error('It is already running.');
    if (launch.unattended) {
      this.unattendedPending = true;
      this.initialPromptArgument = launch.prompt;
    } else {
      this.promptQueue.push(launch.prompt);
    }
    this.restartClaude(launch.cwd);
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.answerRecheck) {
      clearTimeout(this.answerRecheck);
      this.answerRecheck = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.stopWorkingDirectoryPoll();
    this.clearUnattendedLimit();
    this.claudePty?.kill();
    this.claudePty = null;
    this.disposeScreen();
    this.removeAllListeners();
  }

  private async initClaude(resume: boolean): Promise<void> {
    if (this.claudePty || this.isLaunching || this.isDestroyed) return;

    // First, so it sits above the CLI and above any reason it failed to start.
    if (this.launchNotice) {
      this.writeNotice(this.launchNotice, formatInfo);
      this.launchNotice = undefined;
    }

    // Checked before the spawn, not after: a directory Consola cannot enter
    // fails inside the PTY child, where the failure is silent (see
    // `describeCwdProblem`). Retrying a resume as a fresh session would not
    // help either — the working directory is the same both times.
    const cwdProblem = this.describeCwdProblem();
    if (cwdProblem) {
      this.claudeExited = true;
      this.emitStatus();
      this.writeNotice(cwdProblem);
      this.emit('exit', {
        exitCode: 1,
        ...this.unattendedNeverStarted(cwdProblem),
      } as TerminalExitInfo);
      return;
    }

    this.isLaunching = true;
    try {
      // The process keeps the environment it is spawned with, so a login
      // shell still being asked again (after a slow first probe, say
      // right after the machine starts) is waited for: otherwise this
      // session would run its whole life on the bare PATH.
      const loginEnvPending = loginEnvRetry();
      if (loginEnvPending) await loginEnvPending;
      const borrowed = await this.borrowProviderToken();
      // The await yields; the session may have been closed or restarted in
      // the meantime, and spawning now would leak an untracked PTY.
      if (this.isDestroyed || this.claudePty) return;

      const binary = this.driver.resolveBinary(this.harness);
      // Read from `options` on every launch rather than captured once, so a
      // pinned model survives a resume, a restart, and the retry-as-fresh
      // path below without any of them having to remember it.
      const unattended = this.unattendedPending;
      const attentionUrl = await this.options.attentionUrl?.();
      if (this.isDestroyed || this.claudePty) return;
      const launchArgs = this.driver.buildSessionArgs(this.harness, {
        sessionId: this.options.claudeSessionId,
        cwd: this.options.cwd,
        resume,
        model: this.options.model,
        mcpConfigPath: this.options.mcpConfigPath,
        initialPrompt: this.initialPromptArgument,
        toolPolicy: this.options.toolPolicy,
        unattended,
        forkFrom: resume ? undefined : this.forkPending,
        attentionUrl,
      });
      const args = Array.isArray(launchArgs) ? launchArgs : await launchArgs;
      if (this.isDestroyed || this.claudePty) return;

      // Stopped before it spawned: the turn never starts, and its run hears why.
      const stopBeforeSpawn = unattended ? this.unattendedPendingStop : null;
      if (stopBeforeSpawn) {
        this.claudeExited = true;
        this.emitStatus();
        this.writeNotice(`Stopped: ${stopBeforeSpawn}.`);
        this.emit('exit', {
          exitCode: 1,
          ...this.unattendedNeverStarted(stopBeforeSpawn),
        } as TerminalExitInfo);
        return;
      }

      // Written before the spawn so it sits above whatever the turn prints.
      if (unattended) this.writeNotice(UNATTENDED_NOTICE, formatInfo);
      this.claudeProducedOutput = false;
      this.claudePty = pty.spawn(binary, args, {
        name: 'xterm-256color',
        cols: this.dimensions.cols,
        rows: this.dimensions.rows,
        cwd: this.options.cwd,
        env: layerProviderToken(
          this.driver.composeEnv(this.harness, getLoginEnv()),
          borrowed?.envVar ?? null,
          borrowed?.token ?? null,
        ) as { [key: string]: string },
      });
      // A prompt on the command line is delivered by the spawn itself,
      // and the turn and fork it asked for are done with once spawned.
      this.initialPromptArgument = undefined;
      this.unattendedPending = false;
      this.forkPending = undefined;
      this.claudeExited = false;
      // A new process says where it is for itself, even where the last
      // one already had: the record may have moved in between.
      this.reportedWorkingDirectory = null;
      if (unattended) this.beginUnattendedTurn();
      this.emitStatus();

      const observeOutput = this.driver.createOutputObserver?.(
        this.harness,
        this.options.claudeSessionId,
      );
      // Both handlers check that their process is still this terminal's:
      // one stopped by startFreshConversation (or destroy) belongs to a
      // conversation the session no longer has.
      const spawned = this.claudePty;
      spawned.onData((data) => {
        if (this.claudePty !== spawned) return;
        try {
          observeOutput?.(data);
        } catch (error) {
          console.error('Could not save the active conversation:', error);
          this.writeNotice(
            'Could not save the active conversation. Check available disk space before restarting.',
          );
        }
        this.handleData(data);
      });

      spawned.onExit(({ exitCode, signal }) => {
        if (this.claudePty !== spawned) return;
        this.claudePty = null;
        this.claudeExited = true;
        const turn = this.endUnattendedTurn();
        const stopped = turn
          ? (this.unattendedStopReason ?? (signal ? `it was killed (signal ${signal})` : undefined))
          : undefined;
        this.setBusy(false);

        // A resume against a session Claude no longer has fails
        // immediately; retry once as a new conversation so the tab
        // stays usable. Wipe the failed attempt's output first so its
        // error message does not sit above the fresh session. Never
        // for an unattended turn: it belongs to that conversation,
        // and a fresh one would answer a question nobody asked it.
        if (resume && exitCode !== 0 && !turn && this.driver.retryResumeAsFresh !== false) {
          this.disposeScreen();
          this.emit('data', CLEAR_SCREEN);
          // One a harness switch began opens the way it began — the
          // fork again, or the handoff — never blank: Claude writes a
          // fork only once its first message is sent.
          if (this.options.opening) this.open(this.options.opening);
          void this.initClaude(false);
          return;
        }

        // A failure with nothing on screen means the CLI never got far
        // enough to say anything, so there is no error for the user to
        // read. Name what was run instead of leaving an empty pane.
        // Print mode is silent until it answers, so an unattended turn
        // stopped partway — Ctrl+C, the time limit — printed nothing
        // either, without having failed to start.
        if (exitCode !== 0 && !this.claudeProducedOutput && !this.unattendedStopReason) {
          this.writeNotice(
            turn
              ? `\`${binary}\` stopped (exit ${exitCode}) before printing anything. ` +
                  "If it never started, check this session's harness in Settings."
              : `\`${binary}\` exited immediately without starting. ` +
                  "Check this session's harness in Settings — is that binary installed and executable?",
          );
        }

        this.emitStatus();
        if (!turn) {
          this.emit('exit', { exitCode } as TerminalExitInfo);
          return;
        }
        // The screen parses output a tick behind the PTY: wait for it,
        // so the last line is what the turn actually printed last.
        this.afterScreenSettles(() => {
          // Only what the CLI printed: with nothing from it, the last
          // line on screen would be Consola's own notice.
          const lastLine = this.claudeProducedOutput ? this.lastScreenLine() : undefined;
          this.emit('exit', {
            exitCode,
            unattended: true,
            ...(lastLine ? { lastLine } : {}),
            ...(stopped ? { stopped } : {}),
          } as TerminalExitInfo);
        });
      });
    } catch (error) {
      if (this.isDestroyed) return;
      console.error(`Error spawning ${this.driver.id}:`, error);
      const message = error instanceof Error ? error.message : `Could not start ${this.driver.id}.`;
      this.writeNotice(message);
      this.claudeExited = true;
      this.emitStatus();
      this.emit('exit', {
        exitCode: 1,
        ...this.unattendedNeverStarted(message),
      } as TerminalExitInfo);
    } finally {
      this.isLaunching = false;
    }
  }

  /**
   * Why this session's working directory cannot be entered, or null if it can.
   *
   * Worth answering before every spawn because the failure it prevents is
   * invisible: node-pty enters the directory inside the PTY child, and on
   * macOS the helper that does it exits without writing a word when the
   * `chdir` fails. The pane would go blank with a code 1 and nothing to read
   * — which is exactly what a workspace whose folder has been moved or
   * renamed produces.
   */
  private describeCwdProblem(): string | null {
    const { cwd } = this.options;

    let stats: fs.Stats;
    try {
      stats = fs.statSync(cwd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT'
        ? `Working folder not found: ${cwd} — this workspace points at a folder that has been moved, renamed, or deleted. Update its path to start sessions here again.`
        : `Working folder unreadable: ${cwd} (${code ?? 'unknown error'}).`;
    }

    return stats.isDirectory() ? null : `Working folder is not a directory: ${cwd}.`;
  }

  /**
   * The provider token for this session's workspace account, with the
   * variable it belongs in, or null.
   *
   * Null is the whole degradation story: no binding means no token and a
   * spawn identical to pre-v6 Consola. A binding whose token cannot be
   * borrowed — or whose provider this build lacks — also launches, but with
   * a visible notice, because an agent silently running the provider CLI
   * as whatever account happens to be active in its keyring is exactly the
   * cross-account accident bindings exist to prevent.
   */
  private async borrowProviderToken(): Promise<{ envVar: string; token: string } | null> {
    const { providerId, providerAccountLogin: login } = this.options;
    if (!providerId || !login) return null;
    // A read-only session acts as nobody on the provider: what it needs
    // of the item, main fetches with the token for it.
    if (this.options.toolPolicy === 'read-only') return null;
    try {
      const driver = getProviderDriver(providerId);
      return { envVar: driver.tokenEnvVar, token: await driver.token(login) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const meta = isGitProviderId(providerId) ? PROVIDER_META[providerId] : undefined;
      // With no login PATH, the message already says what to do, and
      // `auth status` would only send the user after a working sign-in.
      const hint = loginEnvProblem()
        ? ''
        : ` — check \`${meta?.cliName ?? providerId} auth status\``;
      this.writeNotice(
        `Could not borrow a ${meta?.displayName ?? providerId} token for ${login}: ${message} ` +
          `This session runs without one${hint}.`,
      );
      return null;
    }
  }

  /**
   * Write Consola's own message into the pane, as if the PTY had printed it.
   *
   * Deferred by a tick because a real PTY never produces output synchronously
   * from `start()`. Emitting inline would reach the renderer twice: once live,
   * and again in the replay buffer `TerminalManager.ensure` captures after
   * starting the terminal.
   */
  private writeNotice(message: string, format: (message: string) => string = formatNotice): void {
    const text = format(message);
    setImmediate(() => {
      // The session may have been closed in the meantime; recreating its
      // screen here would leak an emulator nothing will ever dispose.
      if (this.isDestroyed) return;
      this.getScreen().write(text);
      this.emit('data', text);
    });
  }

  private handleData(data: string): void {
    this.claudeProducedOutput = true;
    this.getScreen().write(data);
    this.emit('data', data);

    const now = Date.now();
    const starting = this.idleTimer === null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.classifyScreen();
      // Print mode is silent while it works; only its exit ends the turn.
      if (!this.unattendedTurn) this.setBusy(false);
      this.followWorkingDirectory();
      this.deliverPendingPrompt();
      this.emitStatus();
    }, IDLE_DEBOUNCE_MS);
    if (starting) {
      this.outputStartedAt = now;
      this.followWorkingDirectory();
    }
    // See TURN_MIN_MS: a paint, a repaint or an echo is over before this.
    if (now - Math.max(this.outputStartedAt, this.lastInputAt) >= TURN_MIN_MS) this.setBusy(true);
    this.emitStatus();
  }

  /** Busy from spawn to exit, and stopped if it outlasts the limit. */
  private beginUnattendedTurn(): void {
    this.unattendedTurn = true;
    this.unattendedStopReason = null;
    this.setBusy(true);
    this.clearUnattendedLimit();
    this.unattendedLimit = setTimeout(() => {
      this.unattendedLimit = null;
      this.stopUnattendedTurn(UNATTENDED_LIMIT_REASON, UNATTENDED_LIMIT_NOTICE);
    }, UNATTENDED_TURN_LIMIT_MS);
  }

  /**
   * Ends the running unattended turn the way Ctrl+C does. False when none is
   * running. The first reason wins, as with Ctrl+C.
   */
  public stopUnattendedTurn(reason: string, notice = `Stopped: ${reason}.`): boolean {
    // Launched but not yet spawned: the spawn is skipped and the exit says why.
    if (!this.unattendedTurn && this.unattendedPending && !this.isDestroyed) {
      this.unattendedPendingStop ??= reason;
      return true;
    }
    if (!this.unattendedTurn) return false;
    this.unattendedStopReason ??= reason;
    this.writeNotice(notice);
    this.claudePty?.kill();
    // A process that ignores the hangup would hold its slot forever.
    if (this.unattendedKill) clearTimeout(this.unattendedKill);
    this.unattendedKill = setTimeout(() => {
      this.unattendedKill = null;
      this.claudePty?.kill('SIGKILL');
    }, UNATTENDED_KILL_GRACE_MS);
    return true;
  }

  /**
   * What an exit reports when the unattended turn this launch was for never
   * started (a refused launch, a missing folder): the turn is over, and its
   * run must hear so. A restart afterwards resumes interactively.
   */
  private unattendedNeverStarted(reason: string): Pick<TerminalExitInfo, 'unattended' | 'stopped'> {
    if (!this.unattendedPending) return {};
    this.unattendedPending = false;
    this.unattendedPendingStop = null;
    this.initialPromptArgument = undefined;
    return { unattended: true, stopped: reason };
  }

  /** Whether an unattended turn was running; it is over now either way. */
  private endUnattendedTurn(): boolean {
    if (!this.unattendedTurn) return false;
    this.unattendedTurn = false;
    this.clearUnattendedLimit();
    return true;
  }

  /** The screen's last non-empty line: a turn's answer ends there, and so does the CLI's error. */
  private lastScreenLine(): string | undefined {
    return (this.screen?.visibleText() ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop();
  }

  /**
   * Run `callback` once the screen has parsed everything written to it.
   * A screen torn down first (a restart, a close) runs it then, with what
   * it had — never not at all, or an automation run would wait forever for
   * the turn's end. A closed session runs nothing.
   */
  private afterScreenSettles(callback: () => void): void {
    const screen = this.screen;
    if (!screen) {
      callback();
      return;
    }
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (this.screenSettling === settle) this.screenSettling = null;
      if (!this.isDestroyed) callback();
    };
    this.screenSettling = settle;
    screen.write('', settle);
  }

  private clearUnattendedLimit(): void {
    if (this.unattendedLimit) clearTimeout(this.unattendedLimit);
    if (this.unattendedKill) clearTimeout(this.unattendedKill);
    this.unattendedLimit = null;
    this.unattendedKill = null;
  }

  /** Note whether the settled screen is waiting on a keyboard confirmation. */
  private classifyScreen(): void {
    if (!this.screen) return;

    const visible = normalizeScreen(this.screen.visibleText());
    const awaiting = CONFIRMATION_MARKERS.some((marker) => marker.test(visible));

    if (awaiting !== this.isAwaitingConfirmation) {
      this.isAwaitingConfirmation = awaiting;
      this.emit('awaiting-confirmation', awaiting);
    }

    // A hint only, asked of the driver so nothing here knows its words: a
    // notice that appears prompts a read of the harness's limits, which
    // decides. The raw text, since a notice is matched at a line's start.
    const notice = this.driver.usageLimits?.showsLimitNotice?.(this.screen.visibleText()) ?? false;
    if (notice !== this.isShowingLimitNotice) {
      this.isShowingLimitNotice = notice;
      this.emit('limit-notice', notice);
    }
  }

  /** Whether the CLI is showing an empty composer, ready for input. */
  private isComposerReady(): boolean {
    if (!this.screen) return false;

    // Without faint cells: the placeholder suggestion Claude shows in an
    // empty composer would otherwise read as text the user had typed.
    return this.screen
      .visibleTextWithoutFaint()
      .split('\n')
      .some((line) => COMPOSER_READY_PATTERN.test(line));
  }

  private disposeScreen(): void {
    const settling = this.screenSettling;
    this.screenSettling = null;
    settling?.();
    this.screen?.dispose();
    this.screen = null;
  }

  private getScreen(): ScreenModel {
    if (!this.screen) {
      this.screen = new ScreenModel(this.dimensions.cols, this.dimensions.rows);
    }
    return this.screen;
  }

  /**
   * Submit a queued prompt, but never into a confirmation menu.
   *
   * Typing a prompt at the workspace trust gate or a permission request would
   * answer it — the keystrokes become menu selections — so delivery holds
   * until the user has dealt with the menu themselves.
   */
  private deliverPendingPrompt(): void {
    if (this.promptQueue.length === 0) return;
    if (!this.claudePty) return;
    if (this.isAwaitingConfirmation) return;
    if (!this.isComposerReady()) return;

    const prompt = this.promptQueue.shift()!;
    this.paste(prompt);
    this.claudePty.write('\r');
  }

  /**
   * A turn is inferred from output flow: Claude animates while it works and
   * goes quiet when it wants input. A heuristic, so `handleData` only calls
   * it once output has outlasted anything but a turn (TURN_MIN_MS).
   */
  private setBusy(busy: boolean): void {
    if (this.isBusy === busy) return;
    this.isBusy = busy;
    this.emit('activity', busy);
    this.followWorkingDirectory();
  }

  /**
   * Keep up with where the agent works, which its CLI can change on its own:
   * Claude's EnterWorktree moves the whole process into a worktree, and every
   * git view belongs on the checkout the agent edits. Only a running process
   * moves it, so the CLI is asked while output flows or a turn runs — a long
   * turn shows the move as it happens — and once more when both stop. A
   * launch's first paint is not a turn, but it is output: that one answer is
   * how a relaunched process reports where it now is. An idle session costs
   * nothing.
   */
  private followWorkingDirectory(): void {
    if (!this.driver.readWorkingDirectory || this.workingDirectoryUnreadable) return;
    if (this.isBusy || this.idleTimer !== null) {
      this.workingDirectoryPoll ??= setInterval(
        () => this.readWorkingDirectory(),
        WORKING_DIRECTORY_POLL_MS,
      );
      return;
    }
    if (this.workingDirectoryPoll === null) return;
    this.stopWorkingDirectoryPoll();
    this.readWorkingDirectory();
  }

  /** Ask the live process where it works, and emit it when that changed. */
  private readWorkingDirectory(): void {
    const pid = this.claudePty?.pid;
    if (pid === undefined || !this.driver.readWorkingDirectory || this.workingDirectoryUnreadable)
      return;
    let cwd: string | null;
    try {
      cwd = this.driver.readWorkingDirectory(this.harness, pid);
    } catch (error) {
      this.workingDirectoryUnreadable = true;
      this.stopWorkingDirectoryPoll();
      console.warn(`Not following where this ${this.driver.id} session works:`, error);
      return;
    }
    if (!cwd || cwd === this.reportedWorkingDirectory) return;
    this.reportedWorkingDirectory = cwd;
    this.emit('working-directory', cwd);
  }

  private stopWorkingDirectoryPoll(): void {
    if (!this.workingDirectoryPoll) return;
    clearInterval(this.workingDirectoryPoll);
    this.workingDirectoryPoll = null;
  }

  /**
   * Emit 'status' when the derived status changed.
   *
   * Called at the seams where the flags settle — spawn, data starting to
   * flow, the idle debounce classifying the screen, and exit — never per
   * flag, so listeners see one event per transition. Deduped here, which
   * makes calling it liberally safe.
   */
  private emitStatus(): void {
    const status = deriveTerminalStatus({
      busy: this.isBusy,
      awaitingConfirmation: this.isAwaitingConfirmation,
      exited: this.claudeExited,
    });
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.emit('status', status);
  }
}
