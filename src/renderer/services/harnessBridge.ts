import type { HarnessLaunchFields, HarnessProbeResult } from '../../shared/types';

/**
 * Bridge to harness inspection in the main process.
 *
 * Consola stores no credentials: probing a harness means asking the main
 * process to look at the binary and config directory that harness points at,
 * and report back what the CLI itself says.
 */
export const harnessBridge = {
    /** Binary availability, version, and signed-in account for a harness. */
    probe(fields: HarnessLaunchFields): Promise<HarnessProbeResult> {
        return window.harnessAPI.probe(fields);
    },

    /**
     * A session's name from its harness's own transcripts.
     *
     * Resolves to null both while the transcript is still being written and
     * for drivers whose transcripts Consola cannot read at all.
     */
    getSessionName(sessionId: string, fields: HarnessLaunchFields): Promise<string | null> {
        return window.harnessAPI.getSessionName(sessionId, fields);
    },
};
