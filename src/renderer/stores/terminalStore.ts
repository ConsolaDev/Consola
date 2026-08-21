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
    /**
     * Work finished and nobody has looked yet — the `done` dot. Set on the
     * busy→idle edge, cleared by new work or by the session's row being the
     * active one. Renderer-only: main has no notion of which session a human
     * is looking at.
     */
    completedWhileAway: boolean;
}

const INITIAL_STATE: TerminalState = {
    isBusy: false,
    isAwaitingConfirmation: false,
    hasExited: false,
    completedWhileAway: false,
};

interface TerminalStoreState {
    terminals: Record<string, TerminalState>;
    /** Prompts typed before a terminal existed, delivered once it is ready. */
    pendingPrompts: Record<string, string>;
    getState: (instanceId: string) => TerminalState;
    setState: (instanceId: string, updates: Partial<TerminalState>) => void;
    /** Record a busy-flag edge, marking a completion when work stops. */
    noteActivity: (instanceId: string, busy: boolean) => void;
    /** The session has been looked at; its completion is no longer news. */
    acknowledgeCompletion: (instanceId: string) => void;
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

    noteActivity: (instanceId, busy) => {
        const { getState, setState } = get();
        // Only a true busy→idle edge is a completion: an idle report for a
        // terminal never seen working (hydration, repaints) is not news —
        // though it must not erase a completion already standing.
        const previous = getState(instanceId);
        setState(instanceId, {
            isBusy: busy,
            completedWhileAway: busy ? false : previous.isBusy || previous.completedWhileAway,
        });
    },

    acknowledgeCompletion: (instanceId) => {
        // Guarded rather than delegated to setState, which would mint state
        // for a terminal that has none.
        if (!get().terminals[instanceId]?.completedWhileAway) return;
        get().setState(instanceId, { completedWhileAway: false });
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
        const { setState, noteActivity } = get();

        const unsubscribers = [
            terminalBridge.onActivity(({ instanceId, busy }) => {
                noteActivity(instanceId, busy);
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

/**
 * Seed the store from the main process's live terminal state.
 *
 * `activity`, `awaiting-confirmation` and `exit` are edge-triggered: main emits
 * only when a flag changes, and this store is per-renderer and starts empty. A
 * window opened after a session hit a permission prompt would therefore show no
 * attention dot at all — the session is parked and will not emit again until a
 * human answers it. Reading main's state once at startup closes that gap.
 */
export async function hydrateTerminalStatus(): Promise<void> {
    const snapshot = await terminalBridge.getStatusSnapshot();

    useTerminalStore.setState((state) => {
        const terminals = { ...state.terminals };
        for (const [instanceId, status] of Object.entries(snapshot)) {
            // The snapshot merges UNDERNEATH what is already here, not over it.
            // It is a value read at one instant; anything already in the store
            // arrived from an edge that fired later, so the store is fresher.
            // The distinction is dormant today because nothing writes terminals
            // before the first render — but it becomes load-bearing the moment
            // subscribeToEvents() moves earlier, which is the obvious way to
            // close the remaining gap between this fetch and the subscription.
            terminals[instanceId] = { ...INITIAL_STATE, ...status, ...terminals[instanceId] };
        }
        return { terminals };
    });
}
