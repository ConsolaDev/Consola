import { create } from 'zustand';
import { terminalBridge } from '../services/terminalBridge';

/**
 * Per-session terminal state.
 *
 * Only what the UI outside the terminal pane needs: the sidebar's activity
 * dot and whether Claude has exited. The conversation itself lives in the PTY
 * and in Claude's own session files.
 */

export interface TerminalState {
    /** Output is flowing — Claude is working. */
    isBusy: boolean;
    /** A menu is on screen waiting for a keypress (trust gate, permissions). */
    isAwaitingConfirmation: boolean;
    /** The claude process exited; the pane offers a restart. */
    hasExited: boolean;
}

const INITIAL_STATE: TerminalState = {
    isBusy: false,
    isAwaitingConfirmation: false,
    hasExited: false,
};

interface TerminalStoreState {
    terminals: Record<string, TerminalState>;
    /** Prompts typed before a terminal existed, delivered once it is ready. */
    pendingPrompts: Record<string, string>;
    getState: (instanceId: string) => TerminalState;
    setState: (instanceId: string, updates: Partial<TerminalState>) => void;
    setPendingPrompt: (instanceId: string, prompt: string) => void;
    consumePendingPrompt: (instanceId: string) => string | undefined;
    removeInstance: (instanceId: string) => void;
    /** Subscribe to main-process terminal events. Call once at app start. */
    subscribeToEvents: () => () => void;
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
    terminals: {},
    pendingPrompts: {},

    getState: (instanceId) => get().terminals[instanceId] ?? INITIAL_STATE,

    setState: (instanceId, updates) => {
        set((state) => ({
            terminals: {
                ...state.terminals,
                [instanceId]: {
                    ...(state.terminals[instanceId] ?? INITIAL_STATE),
                    ...updates,
                },
            },
        }));
    },

    setPendingPrompt: (instanceId, prompt) => {
        set((state) => ({
            pendingPrompts: { ...state.pendingPrompts, [instanceId]: prompt },
        }));
    },

    consumePendingPrompt: (instanceId) => {
        const prompt = get().pendingPrompts[instanceId];
        if (prompt === undefined) return undefined;
        set((state) => {
            const { [instanceId]: _taken, ...rest } = state.pendingPrompts;
            return { pendingPrompts: rest };
        });
        return prompt;
    },

    removeInstance: (instanceId) => {
        set((state) => {
            const { [instanceId]: _removed, ...restTerminals } = state.terminals;
            const { [instanceId]: _removedPrompt, ...restPrompts } = state.pendingPrompts;
            return { terminals: restTerminals, pendingPrompts: restPrompts };
        });
    },

    subscribeToEvents: () => {
        const { setState } = get();

        const unsubscribers = [
            terminalBridge.onActivity(({ instanceId, busy }) => {
                setState(instanceId, { isBusy: busy });
            }),
            terminalBridge.onAwaitingConfirmation(({ instanceId, awaiting }) => {
                setState(instanceId, { isAwaitingConfirmation: awaiting });
            }),
            terminalBridge.onExit(({ instanceId }) => {
                setState(instanceId, { hasExited: true, isBusy: false });
            }),
        ];

        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
}));
