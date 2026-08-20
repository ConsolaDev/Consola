import type { GhProbeResult } from '../../shared/github';

/**
 * Bridge to GitHub probing in the main process.
 *
 * Consola stores no GitHub credentials: the `gh` CLI owns the keyring, and
 * this bridge only ever learns which accounts exist — never their tokens.
 */
export const githubBridge = {
    /** Whether `gh` is installed, its version, and the keyring accounts. */
    probe(): Promise<GhProbeResult> {
        return window.githubAPI.probe();
    },
};
