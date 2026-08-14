import { BrowserWindow } from 'electron';
import { TerminalService, TerminalExitInfo, TerminalServiceOptions } from './TerminalService';
import { IPC_CHANNELS } from '../shared/constants';

/**
 * Owns one TerminalService per session tab and forwards its events to the
 * renderer.
 *
 * Terminals are kept alive for every open session, not just the visible one, so
 * background work keeps running and switching tabs is instant.
 */
export class TerminalManager {
    private readonly terminals = new Map<string, TerminalService>();

    constructor(private readonly window: BrowserWindow) {}

    /**
     * Get the terminal for a session, starting it if needed.
     *
     * @returns Buffered output to repaint, plus the terminal's current state.
     */
    public ensure(
        instanceId: string,
        options: TerminalServiceOptions
    ): { replay: string; exited: boolean } {
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
    }

    public destroyAll(): void {
        for (const instanceId of [...this.terminals.keys()]) {
            this.destroy(instanceId);
        }
    }

    private send(channel: string, payload: unknown): void {
        if (!this.window.isDestroyed()) {
            this.window.webContents.send(channel, payload);
        }
    }

    private wireEvents(instanceId: string, terminal: TerminalService): void {
        terminal.on('data', (data: string) => {
            this.send(IPC_CHANNELS.TERMINAL_DATA, { instanceId, data });
        });

        terminal.on('activity', (busy: boolean) => {
            this.send(IPC_CHANNELS.TERMINAL_ACTIVITY, { instanceId, busy });
        });

        terminal.on('awaiting-confirmation', (awaiting: boolean) => {
            this.send(IPC_CHANNELS.TERMINAL_AWAITING_CONFIRMATION, { instanceId, awaiting });
        });

        terminal.on('exit', (info: TerminalExitInfo) => {
            this.send(IPC_CHANNELS.TERMINAL_EXIT, { instanceId, ...info });
        });
    }
}
