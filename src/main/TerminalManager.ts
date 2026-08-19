import { BrowserWindow, WebContents } from 'electron';
import { TerminalService, TerminalExitInfo, TerminalServiceOptions } from './TerminalService';
import { IPC_CHANNELS } from '../shared/constants';

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

    public get(instanceId: string): TerminalService | undefined {
        return this.terminals.get(instanceId);
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
    }
}
