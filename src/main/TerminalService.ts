import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as os from 'os';
import { TerminalMode, TerminalDimensions } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';
import { buildSessionArgs, getLoginEnv, resolveClaudeBinary } from './ClaudeCli';
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

function normalizeScreen(visibleText: string): string {
    return visibleText.replace(/\s+/g, ' ');
}

export interface TerminalServiceOptions {
    cwd: string;
    /** Session ID Consola assigned to this tab. */
    claudeSessionId: string;
    /** Resume the existing conversation instead of starting one. */
    resume: boolean;
    /** Explicit `claude` binary path from settings. */
    binaryOverride?: string;
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

    private readonly screens = new Map<TerminalMode, ScreenModel>();
    private idleTimer: NodeJS.Timeout | null = null;
    private isBusy = false;
    private claudeExited = false;
    private pendingPrompt: string | null = null;
    private isAwaitingConfirmation = false;

    constructor(options: TerminalServiceOptions) {
        super();
        this.dimensions = {
            cols: options.cols ?? DEFAULT_DIMENSIONS.cols,
            rows: options.rows ?? DEFAULT_DIMENSIONS.rows,
        };
        this.options = options;
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

        const binary = resolveClaudeBinary(this.options.binaryOverride);
        const args = buildSessionArgs(this.options.claudeSessionId, resume);

        try {
            this.claudePty = pty.spawn(binary, args, {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.options.cwd,
                env: getLoginEnv() as { [key: string]: string },
            });
            this.claudeExited = false;

            this.claudePty.onData((data) => this.handleData(TerminalMode.CLAUDE, data));

            this.claudePty.onExit(({ exitCode }) => {
                this.claudePty = null;
                this.claudeExited = true;
                this.setBusy(false);

                // A resume against a session Claude no longer has fails
                // immediately; retry once as a new conversation so the tab
                // stays usable.
                if (resume && exitCode !== 0) {
                    this.initClaude(false);
                    return;
                }

                this.emit('exit', { mode: TerminalMode.CLAUDE, exitCode } as TerminalExitInfo);
            });
        } catch (error) {
            console.error('Error spawning claude:', error);
            this.claudeExited = true;
            this.emit('exit', { mode: TerminalMode.CLAUDE, exitCode: 1 } as TerminalExitInfo);
        }
    }

    private initShell(): void {
        if (this.shellPty) return;

        const env = getLoginEnv();
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

    private handleData(mode: TerminalMode, data: string): void {
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
