import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { TerminalMode, TerminalDimensions, HarnessLaunchFields } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';
import { getLoginEnv } from './LoginEnvironment';
import { getDriver, toHarnessConfig, type HarnessConfig, type HarnessDriver } from './drivers';
import { ScreenModel } from './ScreenModel';

/**
 * One session tab's terminal.
 *
 * Owns a `claude` process — the main panel — and, lazily, a plain shell the
 * user can switch to in the same pane. The process outlives the React
 * component that renders it: output is buffered here so remounting a tab
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
}

export interface TerminalExitInfo {
    mode: TerminalMode;
    exitCode: number;
}

export class TerminalService extends EventEmitter {
    private shellPty: pty.IPty | null = null;
    private claudePty: pty.IPty | null = null;
    private currentMode: TerminalMode = TerminalMode.CLAUDE;
    private dimensions: TerminalDimensions;
    private readonly options: TerminalServiceOptions;
    private readonly driver: HarnessDriver;
    private readonly harness: HarnessConfig;

    private readonly screens = new Map<TerminalMode, ScreenModel>();
    private idleTimer: NodeJS.Timeout | null = null;
    private isBusy = false;
    private claudeExited = false;
    /** Whether the current Claude launch has painted anything at all. */
    private claudeProducedOutput = false;
    private pendingPrompt: string | null = null;
    private isAwaitingConfirmation = false;
    private isDestroyed = false;

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
        this.pendingPrompt = options.initialPrompt ?? null;
    }

    public start(): void {
        this.initClaude(this.options.resume);
    }

    /**
     * Queue a prompt to submit once the CLI is ready.
     *
     * Delivery waits for the terminal to go quiet and refuses to type into a
     * confirmation menu, so a prompt can never be mistaken for an answer to the
     * workspace trust gate or a permission request.
     */
    public queuePrompt(prompt: string): void {
        this.pendingPrompt = prompt;
        if (!this.isBusy) {
            this.deliverPendingPrompt();
        }
    }

    /** Whether the visible screen is a menu waiting on a keypress. */
    public awaitingConfirmation(): boolean {
        return this.isAwaitingConfirmation;
    }

    public getCurrentMode(): TerminalMode {
        return this.currentMode;
    }

    /** Escape sequences that repaint the active PTY's current screen. */
    public getReplayBuffer(): string {
        return this.screens.get(this.currentMode)?.snapshot() ?? '';
    }

    public hasClaudeExited(): boolean {
        return this.claudeExited;
    }

    public write(data: string): void {
        this.getActivePty()?.write(data);
    }

    /**
     * Paste text as a single block.
     *
     * Bracketed paste tells the TUI to treat the payload as pasted input rather
     * than keystrokes, so multi-line content lands in the composer instead of
     * submitting at the first newline.
     */
    public paste(text: string): void {
        const activePty = this.getActivePty();
        if (!activePty) return;
        activePty.write(`\x1b[200~${text}\x1b[201~`);
    }

    public resize(cols: number, rows: number): void {
        this.dimensions = { cols, rows };
        this.shellPty?.resize(cols, rows);
        this.claudePty?.resize(cols, rows);
        for (const screen of this.screens.values()) {
            screen.resize(cols, rows);
        }
    }

    public switchMode(mode: TerminalMode): void {
        if (this.currentMode === mode) return;

        this.currentMode = mode;

        if (mode === TerminalMode.SHELL && !this.shellPty) {
            this.initShell();
        }
        if (mode === TerminalMode.CLAUDE && !this.claudePty) {
            // Claude exited earlier; bring it back on the existing conversation.
            this.initClaude(true);
        }

        this.emit('mode-changed', mode);

        // Nudge the newly active PTY into repainting the pane.
        this.getActivePty()?.resize(this.dimensions.cols, this.dimensions.rows);
    }

    /** Restart Claude after it exited, resuming the same conversation. */
    public restartClaude(): void {
        if (this.claudePty) return;
        this.disposeScreen(TerminalMode.CLAUDE);
        this.initClaude(true);
        if (this.currentMode !== TerminalMode.CLAUDE) {
            this.switchMode(TerminalMode.CLAUDE);
        }
    }

    public destroy(): void {
        this.isDestroyed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.shellPty?.kill();
        this.shellPty = null;
        this.claudePty?.kill();
        this.claudePty = null;
        for (const screen of this.screens.values()) {
            screen.dispose();
        }
        this.screens.clear();
        this.removeAllListeners();
    }

    private initClaude(resume: boolean): void {
        if (this.claudePty) return;

        // Checked before the spawn, not after: a directory Consola cannot enter
        // fails inside the PTY child, where the failure is silent (see
        // `describeCwdProblem`). Retrying a resume as a fresh session would not
        // help either — the working directory is the same both times.
        const cwdProblem = this.describeCwdProblem();
        if (cwdProblem) {
            this.claudeExited = true;
            this.writeNotice(TerminalMode.CLAUDE, cwdProblem);
            this.emit('exit', { mode: TerminalMode.CLAUDE, exitCode: 1 } as TerminalExitInfo);
            return;
        }

        const binary = this.driver.resolveBinary(this.harness);
        const args = this.driver.buildSessionArgs(
            this.harness,
            this.options.claudeSessionId,
            resume
        );

        try {
            this.claudeProducedOutput = false;
            this.claudePty = pty.spawn(binary, args, {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.options.cwd,
                env: this.driver.composeEnv(this.harness, getLoginEnv()) as {
                    [key: string]: string;
                },
            });
            this.claudeExited = false;

            this.claudePty.onData((data) => this.handleData(TerminalMode.CLAUDE, data));

            this.claudePty.onExit(({ exitCode }) => {
                this.claudePty = null;
                this.claudeExited = true;
                this.setBusy(false);

                // A resume against a session Claude no longer has fails
                // immediately; retry once as a new conversation so the tab
                // stays usable. Wipe the failed attempt's output first so its
                // error message does not sit above the fresh session.
                if (resume && exitCode !== 0) {
                    this.disposeScreen(TerminalMode.CLAUDE);
                    if (this.currentMode === TerminalMode.CLAUDE) {
                        this.emit('data', CLEAR_SCREEN);
                    }
                    this.initClaude(false);
                    return;
                }

                // A failure with nothing on screen means the CLI never got far
                // enough to say anything, so there is no error for the user to
                // read. Name what was run instead of leaving an empty pane.
                if (exitCode !== 0 && !this.claudeProducedOutput) {
                    this.writeNotice(
                        TerminalMode.CLAUDE,
                        `\`${binary}\` exited immediately without starting. ` +
                            'Check this session\'s harness in Settings — is that binary installed and executable?'
                    );
                }

                this.emit('exit', { mode: TerminalMode.CLAUDE, exitCode } as TerminalExitInfo);
            });
        } catch (error) {
            console.error(`Error spawning ${this.driver.id}:`, error);
            this.claudeExited = true;
            this.emit('exit', { mode: TerminalMode.CLAUDE, exitCode: 1 } as TerminalExitInfo);
        }
    }

    private initShell(): void {
        if (this.shellPty) return;

        // Same silent failure as Claude's launch. The notice stays on the shell
        // screen rather than bouncing back to Claude, which cannot start here
        // either — the user should get to read why before switching away.
        const cwdProblem = this.describeCwdProblem();
        if (cwdProblem) {
            this.writeNotice(TerminalMode.SHELL, cwdProblem);
            return;
        }

        // The shell shares the session's harness environment, so invoking the
        // CLI by hand from here talks to the same profile the tab does.
        const env = this.driver.composeEnv(this.harness, getLoginEnv());
        const shell = env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');

        try {
            this.shellPty = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.options.cwd,
                env: env as { [key: string]: string },
            });

            this.shellPty.onData((data) => this.handleData(TerminalMode.SHELL, data));

            this.shellPty.onExit(({ exitCode }) => {
                this.shellPty = null;
                this.disposeScreen(TerminalMode.SHELL);
                if (this.currentMode === TerminalMode.SHELL) {
                    // Exiting the shell returns the pane to Claude.
                    this.switchMode(TerminalMode.CLAUDE);
                }
                this.emit('exit', { mode: TerminalMode.SHELL, exitCode } as TerminalExitInfo);
            });
        } catch (error) {
            console.error('Error spawning shell:', error);
            this.switchMode(TerminalMode.CLAUDE);
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
     * Write Consola's own message into a pane, as if the PTY had printed it.
     *
     * Deferred by a tick because a real PTY never produces output synchronously
     * from `start()`. Emitting inline would reach the renderer twice: once live,
     * and again in the replay buffer `TerminalManager.ensure` captures after
     * starting the terminal.
     */
    private writeNotice(mode: TerminalMode, message: string): void {
        const text = formatNotice(message);
        setImmediate(() => {
            // The session may have been closed in the meantime; recreating its
            // screen here would leak an emulator nothing will ever dispose.
            if (this.isDestroyed) return;
            this.getScreen(mode).write(text);
            if (mode === this.currentMode) {
                this.emit('data', text);
            }
        });
    }

    private handleData(mode: TerminalMode, data: string): void {
        if (mode === TerminalMode.CLAUDE) {
            this.claudeProducedOutput = true;
        }

        this.getScreen(mode).write(data);

        if (mode === this.currentMode) {
            this.emit('data', data);
        }

        this.setBusy(true);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (mode === TerminalMode.CLAUDE) {
                this.classifyScreen();
            }
            this.setBusy(false);
            this.deliverPendingPrompt();
        }, IDLE_DEBOUNCE_MS);
    }

    /** Note whether the settled screen is waiting on a keyboard confirmation. */
    private classifyScreen(): void {
        const screen = this.screens.get(TerminalMode.CLAUDE);
        if (!screen) return;

        const visible = normalizeScreen(screen.visibleText());
        const awaiting = CONFIRMATION_MARKERS.some((marker) => marker.test(visible));

        if (awaiting !== this.isAwaitingConfirmation) {
            this.isAwaitingConfirmation = awaiting;
            this.emit('awaiting-confirmation', awaiting);
        }
    }

    /** Whether the CLI is showing an empty composer, ready for input. */
    private isComposerReady(): boolean {
        const screen = this.screens.get(TerminalMode.CLAUDE);
        if (!screen) return false;

        return screen
            .visibleText()
            .split('\n')
            .some((line) => COMPOSER_READY_PATTERN.test(line));
    }

    private disposeScreen(mode: TerminalMode): void {
        this.screens.get(mode)?.dispose();
        this.screens.delete(mode);
    }

    private getScreen(mode: TerminalMode): ScreenModel {
        let screen = this.screens.get(mode);
        if (!screen) {
            screen = new ScreenModel(this.dimensions.cols, this.dimensions.rows);
            this.screens.set(mode, screen);
        }
        return screen;
    }

    /**
     * Submit a queued prompt, but never into a confirmation menu.
     *
     * Typing a prompt at the workspace trust gate or a permission request would
     * answer it — the keystrokes become menu selections — so delivery holds
     * until the user has dealt with the menu themselves.
     */
    private deliverPendingPrompt(): void {
        if (!this.pendingPrompt) return;
        if (this.currentMode !== TerminalMode.CLAUDE || !this.claudePty) return;
        if (this.isAwaitingConfirmation) return;
        if (!this.isComposerReady()) return;

        const prompt = this.pendingPrompt;
        this.pendingPrompt = null;
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

    private getActivePty(): pty.IPty | null {
        return this.currentMode === TerminalMode.SHELL ? this.shellPty : this.claudePty;
    }
}
