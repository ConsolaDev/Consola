import { create } from 'zustand';
import type { HarnessCapabilitiesResult, HarnessLaunchFields } from '../../shared/types';
import { harnessBridge } from '../services/harnessBridge';

/**
 * What each harness said it can offer, for the composer to filter.
 *
 * A store of its own rather than another field on `harnessStore`: this data
 * has a different shape, a different cost, and different consumers than the
 * harness records and their health. Like `statuses`, it is never persisted.
 *
 * The real cache lives in the main process, which is what keeps the probe to
 * once per harness across every window. This side only remembers what has
 * arrived so components can render a loading state instead of an empty menu.
 */

export type CapabilitiesLoadState = 'idle' | 'loading' | 'ready';

export interface CapabilitiesEntry {
    state: CapabilitiesLoadState;
    /** Present once a probe has answered, whether or not it succeeded. */
    result?: HarnessCapabilitiesResult;
    /** What the harness launched as when this was probed. */
    signature?: string;
}

const IDLE: CapabilitiesEntry = { state: 'idle' };

/**
 * What a harness launches as, so an edit to it can be noticed.
 *
 * Main caches by the same shape, which is what lets an edited harness re-probe
 * with nothing to invalidate. That only works if this side actually asks
 * again: keying on the harness id alone would short-circuit before the IPC
 * call and serve another install's commands, models and account indefinitely.
 */
export function launchSignature(fields: HarnessLaunchFields): string {
    return JSON.stringify([
        fields.driverId ?? null,
        fields.binaryOverride ?? null,
        fields.configDirOverride ?? null,
        fields.extraArgs ?? [],
    ]);
}

interface HarnessCapabilitiesState {
    byHarness: Record<string, CapabilitiesEntry>;
    /** Read what is known now, without asking for it. */
    get: (harnessId: string) => CapabilitiesEntry;
    /** Ask, unless the answer is already here. */
    ensure: (harnessId: string, fields: HarnessLaunchFields) => Promise<void>;
    /** Ask again regardless, for a retry the user asked for. */
    refresh: (harnessId: string, fields: HarnessLaunchFields) => Promise<void>;
}

export const useHarnessCapabilitiesStore = create<HarnessCapabilitiesState>()((set, get) => {
    const probe = async (harnessId: string, fields: HarnessLaunchFields): Promise<void> => {
        const signature = launchSignature(fields);
        set((state) => ({
            byHarness: {
                ...state.byHarness,
                [harnessId]: { ...state.byHarness[harnessId], state: 'loading', signature },
            },
        }));

        // The bridge resolves an unavailable harness rather than rejecting, so
        // a rejection here means the IPC call itself failed. Reported the same
        // way regardless: the composer only ever needs a reason to show.
        const result = await harnessBridge.getCapabilities(fields).catch(
            (error: unknown): HarnessCapabilitiesResult => ({
                supported: false,
                reason: error instanceof Error ? error.message : String(error),
            })
        );

        set((state) => ({
            byHarness: { ...state.byHarness, [harnessId]: { state: 'ready', result, signature } },
        }));
    };

    return {
        byHarness: {},

        get: (harnessId) => get().byHarness[harnessId] ?? IDLE,

        ensure: async (harnessId, fields) => {
            const entry = get().byHarness[harnessId];
            const signature = launchSignature(fields);
            // A harness that now launches differently is a different install,
            // and possibly a different account, so nothing already held for it
            // counts as an answer.
            const current = entry?.signature === signature;
            if (current && entry?.state === 'loading') return;
            // Only a settled, successful answer stops another ask. A failed
            // probe is worth retrying on the next natural occasion — reopening
            // the composer, switching harness — since the cause is usually
            // temporary.
            if (current && entry?.state === 'ready' && entry.result?.supported) return;
            await probe(harnessId, fields);
        },

        refresh: async (harnessId, fields) => {
            if (get().byHarness[harnessId]?.state === 'loading') return;
            await probe(harnessId, fields);
        },
    };
});

/** The capabilities themselves, or undefined while loading or unavailable. */
export function readCapabilities(entry: CapabilitiesEntry) {
    return entry.result?.supported ? entry.result : undefined;
}

/** Why a harness could not describe itself, if that is what happened. */
export function readUnavailableReason(entry: CapabilitiesEntry): string | undefined {
    return entry.result && !entry.result.supported ? entry.result.reason : undefined;
}
