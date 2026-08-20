import type { HarnessCapabilitiesResult } from '../shared/types';
import type { HarnessConfig, HarnessDriver } from './drivers';

/**
 * Remembers what each harness said it can offer.
 *
 * Caching policy belongs here rather than inside any one driver, because none
 * of it is CLI-specific: coalesce callers asking the same question at once,
 * keep an answer for the app's lifetime, and never persist it. A driver only
 * has to know how to ask its own CLI.
 *
 * It matters more than a usual cache would, because the probe is not free of
 * side effects — it starts a real process, which runs the user's SessionStart
 * hooks. Living in the main process is what makes that a once-per-harness
 * cost: a renderer-side cache would repeat it for every window.
 */
export class HarnessCapabilitiesCache {
    private readonly settled = new Map<string, HarnessCapabilitiesResult>();
    private readonly pending = new Map<string, Promise<HarnessCapabilitiesResult>>();

    public async get(
        driver: HarnessDriver,
        config: HarnessConfig
    ): Promise<HarnessCapabilitiesResult> {
        const key = signature(driver.id, config);

        const settled = this.settled.get(key);
        if (settled) return settled;

        const pending = this.pending.get(key);
        if (pending) return pending;

        const probe = this.probe(driver, config, key);
        this.pending.set(key, probe);
        return probe;
    }

    /** Forget every answer, so the next ask re-probes. */
    public clear(): void {
        this.settled.clear();
    }

    private async probe(
        driver: HarnessDriver,
        config: HarnessConfig,
        key: string
    ): Promise<HarnessCapabilitiesResult> {
        try {
            if (!driver.probeCapabilities) {
                // Not a failure and never going to change while this build
                // runs, so it is worth remembering rather than re-deciding.
                const unsupported: HarnessCapabilitiesResult = {
                    supported: false,
                    reason: `${driver.id} cannot describe its own commands.`,
                };
                this.settled.set(key, unsupported);
                return unsupported;
            }

            const capabilities = await driver.probeCapabilities(config);
            const result: HarnessCapabilitiesResult = { supported: true, ...capabilities };
            this.settled.set(key, result);
            return result;
        } catch (error) {
            // Deliberately not remembered. A failure here is usually temporary
            // — the CLI mid-upgrade, a hook that flaked, a path being edited —
            // and caching it would leave the composer permanently empty until
            // the app restarted.
            return {
                supported: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        } finally {
            this.pending.delete(key);
        }
    }
}

/**
 * Identify a harness by what it actually launches, not by its record id.
 *
 * Two harness records pointing at the same binary and profile get the same
 * answer, so they share one probe; editing a harness's path changes the
 * signature and re-probes on its own, with no invalidation to remember.
 *
 * The working directory is deliberately absent: what comes back is scoped to
 * the config directory, so the same harness answers identically from every
 * workspace.
 */
function signature(driverId: string, config: HarnessConfig): string {
    return JSON.stringify([
        driverId,
        config.binaryPath ?? null,
        config.configDir ?? null,
        config.extraArgs,
    ]);
}

export const harnessCapabilitiesCache = new HarnessCapabilitiesCache();
