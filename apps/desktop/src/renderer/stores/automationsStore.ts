import { create } from 'zustand';
import type { AuthoringBasis, AutomationsSnapshot } from '../../shared/automations';
import { automationsBridge } from '../services/automationsBridge';

export type AutomationsTab = 'activity' | 'automations' | 'templates';

/** The one panel open beside the dashboard; opening another replaces it. */
export type AutomationsPanel =
    | { kind: 'run'; runId: string }
    | { kind: 'automation'; name: string }
    | { kind: 'new'; basis?: AuthoringBasis };

const SEEN_KEY = 'consola-automations-seen';

/** With nothing stored for a workspace, "since you last looked" counts from here. */
export const WINDOW_LOADED_AT = new Date().toISOString();

function readSeen(): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
        if (typeof parsed !== 'object' || parsed === null) return {};
        return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'string'));
    } catch {
        return {};
    }
}

function writeSeen(seen: Record<string, string>): void {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
        // A full or blocked store only means the next window starts from its own load time.
    }
}

interface AutomationsState {
    /** Per-workspace snapshots, fed by main's pushes. */
    snapshots: Record<string, AutomationsSnapshot>;
    tab: AutomationsTab;
    panel: AutomationsPanel | null;
    /** ISO time the person last looked at each workspace's Activity; persisted. */
    lastSeen: Record<string, string>;
    load: (workspaceId: string) => Promise<void>;
    /** Subscribe to main's pushes. Call once near the app root. */
    subscribe: () => () => void;
    setTab: (tab: AutomationsTab) => void;
    openPanel: (panel: AutomationsPanel) => void;
    closePanel: () => void;
    markActivitySeen: (workspaceId: string, at: string) => void;
}

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
    snapshots: {},
    tab: 'activity',
    panel: null,
    lastSeen: readSeen(),

    load: async (workspaceId) => {
        try {
            const snapshot = await automationsBridge.getSnapshot(workspaceId);
            if (snapshot) set((state) => ({ snapshots: { ...state.snapshots, [workspaceId]: snapshot } }));
        } catch (error) {
            // Called fire-and-forget; the next push repairs it.
            console.error('automationsStore.load failed:', error);
        }
    },

    subscribe: () =>
        automationsBridge.onChanged(({ workspaceId, snapshot }) =>
            set((state) => ({ snapshots: { ...state.snapshots, [workspaceId]: snapshot } })),
        ),

    setTab: (tab) => set({ tab }),
    openPanel: (panel) => set({ panel }),
    closePanel: () => set({ panel: null }),

    markActivitySeen: (workspaceId, at) => {
        const lastSeen = { ...get().lastSeen, [workspaceId]: at };
        set({ lastSeen });
        writeSeen(lastSeen);
    },
}));
