import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { TerminalDimensions, HarnessLaunchFields } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';
import { getLoginEnv } from './LoginEnvironment';
import { getDriver, toHarnessConfig, type HarnessConfig, type HarnessDriver } from './drivers';
import { ScreenModel } from './ScreenModel';
import { ghBroker, layerGhToken } from './github/GhBroker';
import { deriveTerminalStatus, type TerminalStatus } from '../shared/terminalStatus';

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
 * Markers for a TUI screen that is waiting on a keyboard confirmation — the
 * workspace trust gate, tool permission prompts, and similar menus.
 *
 * Matched against the emulated screen with whitespace collapsed, so wrapping
 * and column padding do not defeat them.
 */
const CONFIRMATION_MARKERS = [
    /do you trust/i,
    /trust this folder/i,
    /do you want to proceed/i,
    /enter to confirm/i,
];

/**
 * An empty prompt composer: the CLI is booted, idle, and waiting for typing.
 *
 * Waiting for this positive signal — rather than merely for output to stop —
 * keeps a queued prompt out of the startup repaint and out of any menu, and
 * requiring the composer to be *empty* means it can never clobber text the user
 * has already begun typing.
 */
const COMPOSER_READY_PATTERN = /^\s*[❯>]\s*$/;

/** Erase the display and scrollback, then home the cursor. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** Wrap Consola's own words in red, on their own line, so they read as ours. */
function formatNotice(message: string): string {
    return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
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
    /** Prompt to submit once the CLI is ready for input. */
    initialPrompt?: string;
    /** Model this session is pinned to, replayed on every relaunch. */
    model?: string;
    /**
     * GitHub account whose token this session's PTY gets as GH_TOKEN.
     * Resolved from the workspace's binding by the create handler; absent for
     * workspaces without a binding, which then spawn exactly as before.
     */
    githubAccountLogin?: string;
}

export interface TerminalExitInfo {
    exitCode: number;
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
    private lastStatus: TerminalStatus | null = null;

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
        this.promptQueue = options.initialPrompt != null ? [options.initialPrompt] : [];
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

    /** Escape sequences that repaint the PTY's current screen. */
    public getReplayBuffer(): string {
        return this.screen?.snapshot() ?? '';
    }

    public hasClaudeExited(): boolean {
        return this.claudeExited;
    }

    public write(data: string): void {
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
        this.claudePty.write(`\x1b[200~${text}\x1b[201~`);
    }

    public resize(cols: number, rows: number): void {
        this.dimensions = { cols, rows };
        this.claudePty?.resize(cols, rows);
        this.screen?.resize(cols, rows);
    }

    /** Restart Claude after it exited, resuming the same conversation. */
    public restartClaude(): void {
        if (this.claudePty) return;
        this.disposeScreen();
        // The screen the flag described is gone with it. Only classifyScreen()
        // ever clears this, and it does not run until the new PTY paints
        // something — so a CLI that died on a menu would leave the flag set
        // and the spawn's leading emitStatus() would ring needs-attention for
        // a menu nobody can answer.
        this.isAwaitingConfirmation = false;
        void this.initClaude(true);
    }

    public destroy(): void {
        this.isDestroyed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.claudePty?.kill();
        this.claudePty = null;
        this.disposeScreen();
        this.removeAllListeners();
    }

    private async initClaude(resume: boolean): Promise<void> {
        if (this.claudePty) return;

        // Checked before the spawn, not after: a directory Consola cannot enter
        // fails inside the PTY child, where the failure is silent (see
        // `describeCwdProblem`). Retrying a resume as a fresh session would not
        // help either — the working directory is the same both times.
        const cwdProblem = this.describeCwdProblem();
        if (cwdProblem) {
            this.claudeExited = true;
            this.emitStatus();
            this.writeNotice(cwdProblem);
            this.emit('exit', { exitCode: 1 } as TerminalExitInfo);
            return;
        }

        const ghToken = await this.borrowGhToken();
        // The await yields; the session may have been closed or restarted in
        // the meantime, and spawning now would leak an untracked PTY.
        if (this.isDestroyed || this.claudePty) return;

        const binary = this.driver.resolveBinary(this.harness);
        // Read from `options` on every launch rather than captured once, so a
        // pinned model survives a resume, a restart, and the retry-as-fresh
        // path below without any of them having to remember it.
        const args = this.driver.buildSessionArgs(this.harness, {
            sessionId: this.options.claudeSessionId,
            resume,
            model: this.options.model,
        });

        try {
            this.claudeProducedOutput = false;
            this.claudePty = pty.spawn(binary, args, {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.options.cwd,
                env: layerGhToken(
                    this.driver.composeEnv(this.harness, getLoginEnv()),
                    ghToken
                ) as { [key: string]: string },
            });
            this.claudeExited = false;
            this.emitStatus();

            this.claudePty.onData((data) => this.handleData(data));

            this.claudePty.onExit(({ exitCode }) => {
                this.claudePty = null;
                this.claudeExited = true;
                this.setBusy(false);

                // A resume against a session Claude no longer has fails
                // immediately; retry once as a new conversation so the tab
                // stays usable. Wipe the failed attempt's output first so its
                // error message does not sit above the fresh session.
                if (resume && exitCode !== 0) {
                    this.disposeScreen();
                    this.emit('data', CLEAR_SCREEN);
                    void this.initClaude(false);
                    return;
                }

                // A failure with nothing on screen means the CLI never got far
                // enough to say anything, so there is no error for the user to
                // read. Name what was run instead of leaving an empty pane.
                if (exitCode !== 0 && !this.claudeProducedOutput) {
                    this.writeNotice(
                        `\`${binary}\` exited immediately without starting. ` +
                            'Check this session\'s harness in Settings — is that binary installed and executable?'
                    );
                }

                this.emitStatus();
                this.emit('exit', { exitCode } as TerminalExitInfo);
            });
        } catch (error) {
            console.error(`Error spawning ${this.driver.id}:`, error);
            this.claudeExited = true;
            this.emitStatus();
            this.emit('exit', { exitCode: 1 } as TerminalExitInfo);
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
     * GH_TOKEN for this session's workspace account, or null.
     *
     * Null is the whole degradation story: no binding means no token and a
     * spawn identical to pre-v6 Consola. A binding whose token cannot be
     * borrowed also launches — but with a visible notice, because an agent
     * silently running `gh` as whatever account happens to be active in the
     * keyring is exactly the cross-account accident bindings exist to prevent.
     */
    private async borrowGhToken(): Promise<string | null> {
        const login = this.options.githubAccountLogin;
        if (!login) return null;
        try {
            return await ghBroker.token(login);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeNotice(
                `Could not borrow a GitHub token for ${login}: ${message} ` +
                    'This session runs without GH_TOKEN — check `gh auth status`.'
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
    private writeNotice(message: string): void {
        const text = formatNotice(message);
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
            this.setBusy(false);
            this.deliverPendingPrompt();
            this.emitStatus();
        }, IDLE_DEBOUNCE_MS);
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

        return this.screen
            .visibleText()
            .split('\n')
            .some((line) => COMPOSER_READY_PATTERN.test(line));
    }

    private disposeScreen(): void {
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
