import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { TerminalDimensions, HarnessLaunchFields, type ScreenReplay } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';
import { getLoginEnv } from './LoginEnvironment';
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

const CONFIRMATION_MARKERS = [...TRUST_GATE_MARKERS, /do you want to proceed/i, /enter to confirm/i];

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
    /** Model this session is pinned to, replayed on every relaunch. */
    model?: string;
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
    private readonly driver: HarnessDriver;
    private readonly harness: HarnessConfig;

    private screen: ScreenModel | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private isBusy = false;
    private claudeExited = false;
    /** Whether the current Claude launch has painted anything at all. */
    private claudeProducedOutput = false;
    /** Prompts waiting for the composer, oldest first. */
    private promptQueue: string[] = [];
    private isAwaitingConfirmation = false;
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
        if (!this.isBusy) {
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
        if (this.unattendedTurn && data.includes('\x03')) this.unattendedStopReason ??= 'you pressed Ctrl+C';
        this.claudePty?.write(data);
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
        this.claudePty.write(bracketedPaste(text));
    }

    public resize(cols: number, rows: number): void {
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
        if (this.runningUnattended()) {
            throw new Error('An automation is still running its turn in this session. Wait for it to finish.');
        }
        if (this.isLaunching) throw new Error('This session is still starting. Try again in a moment.');

        const previous = this.claudePty;
        this.claudePty = null;
        previous?.kill();
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        this.options.claudeSessionId = claudeSessionId;
        this.forkPending = undefined;
        if (this.driver.initialPromptViaArgs) {
            this.initialPromptArgument = prompt;
            this.promptQueue = [];
        } else {
            this.initialPromptArgument = undefined;
            this.promptQueue = prompt != null ? [prompt] : [];
        }

        // The old conversation's screen goes with it, in every view of it.
        this.disposeScreen();
        this.emit('data', CLEAR_SCREEN);
        this.setBusy(false);
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

    /** Restart Claude after it exited, resuming the same conversation. */
    public restartClaude(cwd?: string): void {
        if (this.claudePty || this.isLaunching) return;
        if (cwd !== undefined) this.options.cwd = cwd;
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

    /** The visible screen, without trailing blank lines; empty with no screen. */
    public screenText(): string {
        return (this.screen?.visibleText() ?? '').replace(/\s+$/, '');
    }

    public destroy(): void {
        this.isDestroyed = true;
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

        // Checked before the spawn, not after: a directory Consola cannot enter
        // fails inside the PTY child, where the failure is silent (see
        // `describeCwdProblem`). Retrying a resume as a fresh session would not
        // help either — the working directory is the same both times.
        const cwdProblem = this.describeCwdProblem();
        if (cwdProblem) {
            this.claudeExited = true;
            this.emitStatus();
            this.writeNotice(cwdProblem);
            this.emit('exit', { exitCode: 1, ...this.unattendedNeverStarted(cwdProblem) } as TerminalExitInfo);
            return;
        }

        this.isLaunching = true;
        try {
            const borrowed = await this.borrowProviderToken();
            // The await yields; the session may have been closed or restarted in
            // the meantime, and spawning now would leak an untracked PTY.
            if (this.isDestroyed || this.claudePty) return;

            const binary = this.driver.resolveBinary(this.harness);
            // Read from `options` on every launch rather than captured once, so a
            // pinned model survives a resume, a restart, and the retry-as-fresh
            // path below without any of them having to remember it.
            const unattended = this.unattendedPending;
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
            });
            const args = Array.isArray(launchArgs) ? launchArgs : await launchArgs;
            if (this.isDestroyed || this.claudePty) return;

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
                    borrowed?.token ?? null
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

            const observeOutput = this.driver.createOutputObserver?.(this.harness, this.options.claudeSessionId);
            // Both handlers check that their process is still this terminal's:
            // one stopped by startFreshConversation (or destroy) belongs to a
            // conversation the session no longer has.
            const spawned = this.claudePty;
            spawned.onData((data) => {
                if (this.claudePty !== spawned) return;
                try { observeOutput?.(data); }
                catch (error) {
                    console.error('Could not save the active conversation:', error);
                    this.writeNotice('Could not save the active conversation. Check available disk space before restarting.');
                }
                this.handleData(data);
            });

            spawned.onExit(({ exitCode, signal }) => {
                if (this.claudePty !== spawned) return;
                this.claudePty = null;
                this.claudeExited = true;
                const turn = this.endUnattendedTurn();
                const stopped = turn ? (this.unattendedStopReason ?? (signal ? `it was killed (signal ${signal})` : undefined)) : undefined;
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
                                  'If it never started, check this session\'s harness in Settings.'
                            : `\`${binary}\` exited immediately without starting. ` +
                                  'Check this session\'s harness in Settings — is that binary installed and executable?'
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
            this.emit('exit', { exitCode: 1, ...this.unattendedNeverStarted(message) } as TerminalExitInfo);
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
            this.writeNotice(
                `Could not borrow a ${meta?.displayName ?? providerId} token for ${login}: ${message} ` +
                    `This session runs without one — check \`${meta?.cliName ?? providerId} auth status\`.`
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

        this.setBusy(true);
        this.emitStatus();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.classifyScreen();
            // Print mode is silent while it works; only its exit ends the turn.
            if (!this.unattendedTurn) this.setBusy(false);
            this.deliverPendingPrompt();
            this.emitStatus();
        }, IDLE_DEBOUNCE_MS);
    }

    /** Busy from spawn to exit, and stopped if it outlasts the limit. */
    private beginUnattendedTurn(): void {
        this.unattendedTurn = true;
        this.unattendedStopReason = null;
        this.setBusy(true);
        this.clearUnattendedLimit();
        this.unattendedLimit = setTimeout(() => {
            this.unattendedLimit = null;
            this.unattendedStopReason = UNATTENDED_LIMIT_REASON;
            this.writeNotice(UNATTENDED_LIMIT_NOTICE);
            this.claudePty?.kill();
            // A process that ignores the hangup would hold its slot forever.
            this.unattendedKill = setTimeout(() => {
                this.unattendedKill = null;
                this.claudePty?.kill('SIGKILL');
            }, UNATTENDED_KILL_GRACE_MS);
        }, UNATTENDED_TURN_LIMIT_MS);
    }

    /**
     * What an exit reports when the unattended turn this launch was for never
     * started (a refused launch, a missing folder): the turn is over, and its
     * run must hear so. A restart afterwards resumes interactively.
     */
    private unattendedNeverStarted(reason: string): Pick<TerminalExitInfo, 'unattended' | 'stopped'> {
        if (!this.unattendedPending) return {};
        this.unattendedPending = false;
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
     * Activity is inferred from output flow: Claude animates while it works and
     * goes quiet when it wants input. This is a heuristic — it reads as busy
     * for a moment while the user's own keystrokes echo.
     */
    private setBusy(busy: boolean): void {
        if (this.isBusy === busy) return;
        this.isBusy = busy;
        this.emit('activity', busy);
        this.followWorkingDirectory(busy);
    }

    /**
     * Keep up with where the agent works, which its CLI can change on its own:
     * Claude's EnterWorktree moves the whole process into a worktree, and every
     * git view belongs on the checkout the agent edits. Only work moves it, so
     * the CLI is asked while output flows — a long turn shows the move as it
     * happens — and once more as the turn ends. An idle session costs nothing.
     */
    private followWorkingDirectory(busy: boolean): void {
        if (!this.driver.readWorkingDirectory || this.workingDirectoryUnreadable) return;
        if (busy) {
            this.workingDirectoryPoll ??= setInterval(() => this.readWorkingDirectory(), WORKING_DIRECTORY_POLL_MS);
            return;
        }
        this.stopWorkingDirectoryPoll();
        this.readWorkingDirectory();
    }

    /** Ask the live process where it works, and emit it when that changed. */
    private readWorkingDirectory(): void {
        const pid = this.claudePty?.pid;
        if (pid === undefined || !this.driver.readWorkingDirectory || this.workingDirectoryUnreadable) return;
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
