import type { HarnessDriverId, HarnessLaunchFields } from '../../shared/types';
import type { SessionToolPolicy } from '../../shared/workspace';
import { toHarnessConfig, type HarnessDriver } from './HarnessDriver';
import { ClaudeDriver } from './ClaudeDriver';
import { CodexDriver } from './CodexDriver';

/**
 * The agent CLIs Consola can drive.
 *
 * Supporting another CLI means adding its driver here and nothing else: the
 * terminal, IPC, and session layers all go through `getDriver`.
 */
const DRIVERS: Record<HarnessDriverId, HarnessDriver> = {
    claude: new ClaudeDriver(),
    codex: new CodexDriver(),
};

export const DEFAULT_DRIVER_ID: HarnessDriverId = 'claude';

/**
 * The driver for an id, falling back to the default rather than throwing.
 *
 * This runs on the spawn path, where an unrecognised id — a session persisted
 * by a newer build, or a hand-edited store — must not take the terminal down.
 * Falling back keeps the tab usable and the failure visible in the log.
 */
export function getDriver(id?: HarnessDriverId): HarnessDriver {
    if (!id) return DRIVERS[DEFAULT_DRIVER_ID];

    const driver = DRIVERS[id];
    if (!driver) {
        console.warn(`Unknown harness driver "${id}"; falling back to ${DEFAULT_DRIVER_ID}.`);
        return DRIVERS[DEFAULT_DRIVER_ID];
    }
    return driver;
}

/**
 * Why a session on this harness cannot run under `policy`, or null — asked
 * before anything is created, so a launch that would be refused at spawn is
 * refused before it has a worktree, a record or a tab.
 */
export function toolPolicyProblem(fields: HarnessLaunchFields, policy: SessionToolPolicy | undefined): string | null {
    return getDriver(fields.driverId).toolPolicyProblem(toHarnessConfig(fields), policy);
}

export type { HarnessDriver, HarnessConfig } from './HarnessDriver';
export { toHarnessConfig } from './HarnessDriver';
