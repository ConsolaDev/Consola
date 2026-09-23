import { useEffect } from 'react';
import { driverSupportsCapabilities } from '../../shared/constants';
import type { Harness } from '../../shared/harness';
import {
    launchSignature,
    readCapabilities,
    readUnavailableReason,
    useHarnessCapabilitiesStore,
    type CapabilitiesEntry,
} from '../stores/harnessCapabilitiesStore';
import { toLaunchFields } from '../stores/harnessStore';
import type { HarnessCapabilities } from '../../shared/types';

export interface HarnessCapabilitiesView {
    /** True while the first answer for this harness is still on its way. */
    loading: boolean;
    capabilities?: HarnessCapabilities;
    /** Set when this harness cannot describe itself, with the reason why. */
    unavailable?: string;
    /** Ask again after a failure. */
    retry: () => void;
}

const NOT_ASKED: CapabilitiesEntry = { state: 'idle' };

/**
 * What a harness can offer, fetched on demand and shared between surfaces.
 *
 * Pass `enabled: false` for a surface that should display an answer someone
 * else asked for but must not trigger a probe itself. That matters because the
 * probe starts a process and runs the user's session hooks: worth it when a
 * composer is about to need the list, not worth it for a settings row that
 * merely came into view.
 */
export function useHarnessCapabilities(
    harness: Harness | undefined,
    enabled: boolean
): HarnessCapabilitiesView {
    const ensure = useHarnessCapabilitiesStore((state) => state.ensure);
    const refresh = useHarnessCapabilitiesStore((state) => state.refresh);
    const entry = useHarnessCapabilitiesStore((state) =>
        harness ? state.byHarness[harness.id] : undefined
    );

    const supported = Boolean(harness) && driverSupportsCapabilities(harness?.driverId);
    const harnessId = harness?.id;
    // Launch fields are a fresh object every render, so the effect depends on
    // a string describing them instead. Depending on the object would re-probe
    // forever; depending on the id alone would miss an edit to the harness,
    // leaving another install's commands on screen.
    const signature = harness ? launchSignature(toLaunchFields(harness)) : null;

    useEffect(() => {
        if (!enabled || !harness || !supported) return;
        void ensure(harness.id, toLaunchFields(harness));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, harnessId, signature, supported, ensure]);

    const retry = () => {
        if (!harness || !supported) return;
        void refresh(harness.id, toLaunchFields(harness));
    };

    if (!harness || !supported) {
        return { loading: false, retry };
    }

    const current = entry ?? NOT_ASKED;
    return {
        loading: current.state === 'loading' || (enabled && current.state === 'idle'),
        capabilities: readCapabilities(current),
        unavailable: readUnavailableReason(current),
        retry,
    };
}
