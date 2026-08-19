import { create } from 'zustand';
import type { HarnessLaunchFields } from '../../shared/types';
import type {
    Harness,
    HarnessStatus,
    HarnessUpdates,
    NewHarnessFields,
} from '../../shared/harness';
import { harnessBridge } from '../services/harnessBridge';
import { harnessBridgeState } from '../services/harnessBridgeState';

export type { Harness, HarnessHealthState, HarnessStatus } from '../../shared/harness';
export {
    HARNESS_ACCENT_COLORS,
    DEFAULT_ACCENT_COLOR,
    HARNESS_ID_PATTERN,
} from '../../shared/harness';

interface HarnessState {
    harnesses: Harness[];
    /** Probe results, deliberately not persisted: health is a live fact. */
    statuses: Record<string, HarnessStatus>;

    addHarness: (input: NewHarnessFields) => Promise<Harness>;
    updateHarness: (id: string, updates: HarnessUpdates) => Promise<void>;
    archiveHarness: (id: string) => Promise<void>;
    restoreHarness: (id: string) => Promise<void>;

    getHarness: (id: string) => Harness | undefined;
    /** Launch fields for a session's harness, falling back to the built-in. */
    getLaunchFields: (harnessId: string | undefined) => HarnessLaunchFields;

    probeHarness: (id: string) => Promise<void>;
    probeAll: () => Promise<void>;
}

function now(): number {
    return Date.now();
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

/**
 * A read-through cache over the records the main process owns.
 *
 * Reads are synchronous against the last snapshot main pushed, so every
 * component that selects `harnesses` is unchanged. Writes are intents: main
 * applies them and broadcasts, and this store replaces its snapshot wholesale.
 *
 * `statuses`, `probeHarness`, and `probeAll` are untouched by this move:
 * health is a live fact about the machine, deliberately never persisted, and
 * has no business travelling with the records.
 */
export const useHarnessStore = create<HarnessState>()((set, get) => ({
    harnesses: [],
    statuses: {},

    addHarness: (input) => harnessBridgeState.addHarness(input),
    updateHarness: (id, updates) => harnessBridgeState.updateHarness(id, updates),
    archiveHarness: (id) => harnessBridgeState.archiveHarness(id),
    restoreHarness: (id) => harnessBridgeState.restoreHarness(id),

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
}));

const LEGACY_HARNESS_KEY = 'consola-harnesses';

/**
 * The records as zustand's persist middleware left them.
 *
 * Read raw rather than through the middleware because the middleware is gone:
 * this is an archaeology function, and it runs once.
 */
function readLegacyHarnesses(): Harness[] | null {
    const raw = localStorage.getItem(LEGACY_HARNESS_KEY);
    if (!raw) return null;
    try {
        const envelope = JSON.parse(raw) as { state?: { harnesses?: Harness[] } };
        return Array.isArray(envelope.state?.harnesses) ? envelope.state.harnesses : null;
    } catch {
        // A localStorage blob we cannot parse is not worth failing launch over:
        // main starts empty, and the raw value stays on disk to look at.
        return null;
    }
}

/**
 * Load the records from main, importing localStorage the first time.
 *
 * Called before the first render so no component ever sees an empty list it
 * would mistake for "no harnesses yet". The localStorage copy is deliberately
 * left in place after a successful import — it is the fallback for one release.
 */
export async function hydrateHarnessStore(): Promise<void> {
    let snapshot = await harnessBridgeState.getSnapshot();

    if (snapshot.needsImport) {
        const legacy = readLegacyHarnesses();
        if (legacy) {
            await harnessBridgeState.importState(legacy);
            snapshot = await harnessBridgeState.getSnapshot();
        }
    }

    useHarnessStore.setState({ harnesses: snapshot.harnesses });

    harnessBridgeState.onChanged((harnesses) => {
        useHarnessStore.setState({ harnesses });
    });
}
