import type {
    TerminalCreateOptions,
    TerminalSnapshot,
    TerminalDataMessage,
    TerminalActivityMessage,
    TerminalAwaitingConfirmationMessage,
    TerminalExitMessage,
    TerminalStatusSnapshot,
} from '../../shared/types';

/**
 * Bridge to the session terminals owned by the main process.
 *
 * Every subscription returns its own unsubscribe function, so components can
 * clean up without disturbing other listeners.
 */
export const terminalBridge = {
    /** Start or attach to a session's terminal, returning output to repaint. */
    create(options: TerminalCreateOptions): Promise<TerminalSnapshot> {
        return window.terminalAPI.create(options);
    },

    sendInput(instanceId: string, data: string): void {
        window.terminalAPI.sendInput(instanceId, data);
    },

    /** Insert a block of text as a paste rather than as keystrokes. */
    paste(instanceId: string, text: string): void {
        window.terminalAPI.paste(instanceId, text);
    },

    resize(instanceId: string, cols: number, rows: number): void {
        window.terminalAPI.resize(instanceId, cols, rows);
    },

    restart(instanceId: string): void {
        window.terminalAPI.restart(instanceId);
    },

    /** Tear down the terminal. Only for sessions being closed, not unmounted. */
    destroy(instanceId: string): void {
        window.terminalAPI.destroy(instanceId);
    },

    onData(callback: (message: TerminalDataMessage) => void): () => void {
        return window.terminalAPI.onData(callback);
    },

    onActivity(callback: (message: TerminalActivityMessage) => void): () => void {
        return window.terminalAPI.onActivity(callback);
    },

    onAwaitingConfirmation(
        callback: (message: TerminalAwaitingConfirmationMessage) => void
    ): () => void {
        return window.terminalAPI.onAwaitingConfirmation(callback);
    },

    onExit(callback: (message: TerminalExitMessage) => void): () => void {
        return window.terminalAPI.onExit(callback);
    },

    /** Live status of every terminal main holds, for a window that missed the edges. */
    getStatusSnapshot(): Promise<TerminalStatusSnapshot> {
        return window.terminalAPI.getStatusSnapshot();
    },
};
