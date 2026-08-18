import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
    HarnessAccount,
    HarnessDriverId,
    HarnessLaunchFields,
} from '../../shared/types';
import { BUILT_IN_HARNESS_ID } from '../../shared/constants';
import { harnessBridge } from '../services/harnessBridge';

/**
 * Marker colours a harness can be tagged with.
 *
 * A fixed palette rather than a free colour picker: the point is telling two
 * harnesses apart at a glance in a dropdown, which a small set of
 * well-separated hues does better than arbitrary colours.
 */
export const HARNESS_ACCENT_COLORS = [
    '#4f5bd5',
    '#3b82f6',
    '#22c55e',
    '#f97316',
    '#ef4444',
    '#a855f7',
    '#14b8a6',
] as const;

export const DEFAULT_ACCENT_COLOR = HARNESS_ACCENT_COLORS[0];

/**
 * A configured instance of an agent CLI.
 *
 * Consola coordinates CLIs rather than embedding them, so a harness is
 * entirely a launch description: which binary, which config directory, which
 * extra arguments. Authentication lives in the config directory and belongs to
 * the CLI — Consola never stores a credential.
 */
export interface Harness {
    /** Routing key chosen by the user. Stable and never edited after creation. */
    id: string;
    driverId: HarnessDriverId;
    name: string;
    accentColor: string;
    /** Offered when starting a conversation. Existing sessions ignore this. */
    enabled: boolean;
    /**
     * Hidden from pickers but still resolvable.
     *
     * Deleting outright would strand every session created with this harness:
     * their transcripts live in its config directory and `--resume` only works
     * against the profile that wrote them. Archiving keeps those sessions
     * working while taking the harness out of circulation.
     */
    archived: boolean;
    /** The seeded harness representing Consola's pre-harness behavior. */
    isBuiltIn: boolean;
    /** Absent means resolve the binary from PATH. */
    binaryPath?: string;
    /** Absent means use the ambient config directory. */
    configDir?: string;
    extraArgs: string[];
    createdAt: number;
    updatedAt: number;
}

export type HarnessHealthState = 'unknown' | 'probing' | 'ok' | 'error';

export interface HarnessStatus {
    state: HarnessHealthState;
    version?: string;
    account?: HarnessAccount;
    resolvedBinary?: string;
    error?: string;
    checkedAt?: number;
}

export const HARNESS_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface HarnessState {
    harnesses: Harness[];
    /** Probe results, deliberately not persisted: health is a live fact. */
    statuses: Record<string, HarnessStatus>;

    addHarness: (
        input: Pick<Harness, 'id' | 'driverId' | 'name' | 'accentColor'> &
            Partial<Pick<Harness, 'binaryPath' | 'configDir' | 'extraArgs' | 'enabled'>>
    ) => Harness;
    updateHarness: (
        id: string,
        updates: Partial<
            Pick<
                Harness,
                'name' | 'accentColor' | 'enabled' | 'binaryPath' | 'configDir' | 'extraArgs'
            >
        >
    ) => void;
    archiveHarness: (id: string) => void;
    restoreHarness: (id: string) => void;

    getHarness: (id: string) => Harness | undefined;
    /** Launch fields for a session's harness, falling back to the built-in. */
    getLaunchFields: (harnessId: string | undefined) => HarnessLaunchFields;

    probeHarness: (id: string) => Promise<void>;
    probeAll: () => Promise<void>;
}

function now(): number {
    return Date.now();
}

/**
 * The harness every workspace starts with.
 *
 * It pins nothing — no binary, no config directory, no arguments — so it
 * resolves exactly the way Consola did before harnesses existed, including for
 * users who set CLAUDE_CONFIG_DIR in their own shell profile.
 */
function createBuiltInHarness(): Harness {
    const timestamp = now();
    return {
        id: BUILT_IN_HARNESS_ID,
        driverId: 'claude',
        name: 'Claude',
        accentColor: DEFAULT_ACCENT_COLOR,
        enabled: true,
        archived: false,
        isBuiltIn: true,
        extraArgs: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

/** Split a launch-arguments string into argv, respecting quoted spans. */
export function parseLaunchArgs(input: string): string[] {
    const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return matches.map((token) => {
        const isQuoted =
            (token.startsWith('"') && token.endsWith('"')) ||
            (token.startsWith("'") && token.endsWith("'"));
        return isQuoted ? token.slice(1, -1) : token;
    });
}

/** Render argv back into an editable string, re-quoting tokens with spaces. */
export function formatLaunchArgs(args: string[]): string {
    return args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}

/**
 * Whether a harness should be offered when starting a conversation.
 *
 * A predicate rather than a store selector on purpose: a selector returning a
 * freshly filtered array would give React a new reference on every render.
 * Components subscribe to `harnesses` and filter with this.
 */
export function isSelectableHarness(harness: Harness): boolean {
    return harness.enabled && !harness.archived;
}

/** The launch fields a harness contributes to a session's spawn. */
export function toLaunchFields(harness: Harness): HarnessLaunchFields {
    return {
        driverId: harness.driverId,
        binaryOverride: harness.binaryPath,
        configDirOverride: harness.configDir,
        extraArgs: harness.extraArgs,
    };
}

export const useHarnessStore = create<HarnessState>()(
    persist(
        (set, get) => ({
            harnesses: [createBuiltInHarness()],
            statuses: {},

            addHarness: (input) => {
                const timestamp = now();
                const harness: Harness = {
                    enabled: true,
                    extraArgs: [],
                    ...input,
                    archived: false,
                    isBuiltIn: false,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                set((state) => ({ harnesses: [...state.harnesses, harness] }));
                return harness;
            },

            updateHarness: (id, updates) => {
                set((state) => ({
                    harnesses: state.harnesses.map((harness) =>
                        harness.id === id
                            ? { ...harness, ...updates, updatedAt: now() }
                            : harness
                    ),
                }));
            },

            archiveHarness: (id) => {
                set((state) => ({
                    harnesses: state.harnesses.map((harness) =>
                        harness.id === id && !harness.isBuiltIn
                            ? { ...harness, archived: true, updatedAt: now() }
                            : harness
                    ),
                }));
            },

            restoreHarness: (id) => {
                set((state) => ({
                    harnesses: state.harnesses.map((harness) =>
                        harness.id === id
                            ? { ...harness, archived: false, updatedAt: now() }
                            : harness
                    ),
                }));
            },

            getHarness: (id) => get().harnesses.find((harness) => harness.id === id),

            getLaunchFields: (harnessId) => {
                const { harnesses } = get();
                const harness =
                    harnesses.find((candidate) => candidate.id === harnessId) ??
                    harnesses.find((candidate) => candidate.isBuiltIn);
                // An unknown id means the harness was removed by hand; the
                // built-in reproduces pre-harness behavior rather than failing.
                return harness ? toLaunchFields(harness) : {};
            },

            probeHarness: async (id) => {
                const harness = get().getHarness(id);
                if (!harness) return;

                set((state) => ({
                    statuses: {
                        ...state.statuses,
                        [id]: { ...state.statuses[id], state: 'probing' },
                    },
                }));

                try {
                    const result = await harnessBridge.probe(toLaunchFields(harness));
                    set((state) => ({
                        statuses: {
                            ...state.statuses,
                            [id]: {
                                state: result.available ? 'ok' : 'error',
                                version: result.version,
                                account: result.account,
                                resolvedBinary: result.resolvedBinary,
                                error: result.error,
                                checkedAt: now(),
                            },
                        },
                    }));
                } catch (error) {
                    set((state) => ({
                        statuses: {
                            ...state.statuses,
                            [id]: {
                                state: 'error',
                                error: error instanceof Error ? error.message : String(error),
                                checkedAt: now(),
                            },
                        },
                    }));
                }
            },

            probeAll: async () => {
                const targets = get().harnesses.filter((harness) => !harness.archived);
                await Promise.all(targets.map((harness) => get().probeHarness(harness.id)));
            },
        }),
        {
            name: 'consola-harnesses',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({ harnesses: state.harnesses }),
            // The built-in harness is what every unconfigured workspace and
            // every pre-harness session resolves to, so it has to exist even if
            // persisted state was written before it did or was edited by hand.
            merge: (persisted, current) => {
                const merged = { ...current, ...(persisted as Partial<HarnessState>) };
                const harnesses = merged.harnesses ?? [];
                return harnesses.some((harness) => harness.id === BUILT_IN_HARNESS_ID)
                    ? merged
                    : { ...merged, harnesses: [createBuiltInHarness(), ...harnesses] };
            },
        }
    )
);
