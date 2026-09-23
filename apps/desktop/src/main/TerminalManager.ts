import { BrowserWindow, WebContents } from 'electron';
import { TerminalService, TerminalExitInfo, TerminalServiceOptions } from './TerminalService';
import { IPC_CHANNELS } from '../shared/constants';
import type { TerminalStatusSnapshot } from '../shared/types';
import type { TerminalStatus } from '../shared/terminalStatus';

/**
 * Owns one TerminalService per session tab and forwards its events.
 *
 * Terminals are kept alive for every open session, not just the visible one, so
 * background work keeps running and switching tabs is instant. A window is a
 * view over that: closing one orphans its terminals without stopping them, and
 * the next window to open the workspace reattaches and repaints from the
 * replay buffer.
 */
export class TerminalManager {
    private readonly terminals = new Map<string, TerminalService>();
    /** Where this instance's output goes. Reassigned on every reattach. */
    private readonly owners = new Map<string, WebContents>();
    /** Instances showing a menu that wants a keypress. Drives the dock badge. */
    private readonly awaiting = new Set<string>();

    constructor(private readonly getWindows: () => BrowserWindow[]) {}

    /** Called whenever getAttentionCount() may have changed. */
    public onAttentionChanged?: () => void;

    /** Called on every status transition, after the broadcast. Drives OS notifications. */
    public onStatusChanged?: (instanceId: string, status: TerminalStatus) => void;

    /** How many sessions are waiting on a human, across every workspace. */
    public getAttentionCount(): number {
        return this.awaiting.size;
    }

    /**
     * Get the terminal for a session, starting it if needed.
     *
     * @returns Buffered output to repaint, plus the terminal's current state.
     */
    public ensure(
        instanceId: string,
        options: TerminalServiceOptions,
        owner: WebContents
    ): { replay: string; exited: boolean } {
        // Set before starting: a terminal that emits during start() would
        // otherwise have nowhere to send its first bytes.
        this.owners.set(instanceId, owner);

        let terminal = this.terminals.get(instanceId);

        if (!terminal) {
            terminal = new TerminalService(options);
            this.terminals.set(instanceId, terminal);
            this.wireEvents(instanceId, terminal);
            terminal.start();
        } else if (options.initialPrompt) {
            // Terminal already running — queue the prompt rather than dropping it.
            terminal.queuePrompt(options.initialPrompt);
        }

        return {
            replay: terminal.getReplayBuffer(),
            exited: terminal.hasClaudeExited(),
        };
    }

    /**
     * Start a session's terminal with no view attached.
     *
     * Fan-out and conductors create sessions before any pane exists. This is
     * ensure() minus the owner: output lands in the ScreenModel, status
     * broadcasts to every window, and the first pane to mount goes through
     * ensure(), takes ownership, and repaints from the replay buffer.
     * "Terminals outlive their views" gains "…and can be born without one."
     */
    public startHeadless(instanceId: string, options: TerminalServiceOptions): void {
        const existing = this.terminals.get(instanceId);
        if (existing) {
            // Already running — the start is idempotent, but a prompt that
            // rode in with the call must not be dropped.
            if (options.initialPrompt) existing.queuePrompt(options.initialPrompt);
            return;
        }
        const terminal = new TerminalService(options);
        this.terminals.set(instanceId, terminal);
        this.wireEvents(instanceId, terminal);
        terminal.start();
    }

    public get(instanceId: string): TerminalService | undefined {
        return this.terminals.get(instanceId);
    }

    /**
     * The current status of every live terminal.
     *
     * The three status channels are edge-triggered — they fire on change and
     * never repeat — so a window born after an edge has no way to learn about
     * it. A session parked at a permission prompt is the case that hurts: it
     * will not emit again until a human answers, so without this the new
     * window would show no attention dot for exactly as long as it matters.
     */
    public statusSnapshot(): TerminalStatusSnapshot {
        const snapshot: TerminalStatusSnapshot = {};
        for (const [instanceId, terminal] of this.terminals) {
            snapshot[instanceId] = {
                isBusy: terminal.busy(),
                isAwaitingConfirmation: terminal.awaitingConfirmation(),
                hasExited: terminal.hasClaudeExited(),
            };
        }
        return snapshot;
    }

    public destroy(instanceId: string): void {
        const terminal = this.terminals.get(instanceId);
        if (!terminal) return;
        terminal.destroy();
        this.terminals.delete(instanceId);
        this.owners.delete(instanceId);
        // destroy() kills the terminal and removes its listeners in the same
        // tick, so the 'exit' handler above never runs for it — the count has
        // to be reconciled here instead, or a session deleted mid-prompt would
        // leave a phantom badge behind.
        if (this.awaiting.delete(instanceId)) {
            this.onAttentionChanged?.();
        }
    }

    public destroyAll(): void {
        for (const instanceId of [...this.terminals.keys()]) {
            this.destroy(instanceId);
        }
    }

    /** Output goes only to the window rendering this pane. */
    private sendToOwner(instanceId: string, channel: string, payload: unknown): void {
        const owner = this.owners.get(instanceId);
        if (owner && !owner.isDestroyed()) {
            owner.send(channel, payload);
        }
    }

    /**
     * Status goes to every window.
     *
     * A window scoped to one workspace still has to show that a session in
     * another one is waiting on a keypress, and these three flags are the only
     * way it can know. They are small enough that broadcasting costs nothing.
     */
    private broadcast(channel: string, payload: unknown): void {
        for (const window of this.getWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(channel, payload);
            }
        }
    }

    private wireEvents(instanceId: string, terminal: TerminalService): void {
        terminal.on('data', (data: string) => {
            this.sendToOwner(instanceId, IPC_CHANNELS.TERMINAL_DATA, { instanceId, data });
        });

        terminal.on('activity', (busy: boolean) => {
            this.broadcast(IPC_CHANNELS.TERMINAL_ACTIVITY, { instanceId, busy });
        });

        terminal.on('awaiting-confirmation', (awaiting: boolean) => {
            if (awaiting) {
                this.awaiting.add(instanceId);
            } else {
                this.awaiting.delete(instanceId);
            }
            this.broadcast(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, { instanceId, awaiting });
            this.onAttentionChanged?.();
        });

        terminal.on('exit', (info: TerminalExitInfo) => {
            // A dead process is not waiting for anything.
            this.awaiting.delete(instanceId);
            this.broadcast(IPC_CHANNELS.TERMINAL_EXIT, { instanceId, ...info });
            this.onAttentionChanged?.();
        });

        terminal.on('status', (status: TerminalStatus) => {
            // Light state, per the windows design: any window may need it for
            // group counts and attention dots, so it goes to all of them.
            this.broadcast(IPC_CHANNELS.TERMINAL_STATUS, { instanceId, status });
            this.onStatusChanged?.(instanceId, status);
        });
    }
}
