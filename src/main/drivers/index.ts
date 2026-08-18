import type { HarnessDriverId } from '../../shared/types';
import type { HarnessDriver } from './HarnessDriver';
import { ClaudeDriver } from './ClaudeDriver';

/**
 * The agent CLIs Consola can drive.
 *
 * Supporting another CLI means adding its driver here and nothing else: the
 * terminal, IPC, and session layers all go through `getDriver`.
 */
const DRIVERS: Record<HarnessDriverId, HarnessDriver> = {
    claude: new ClaudeDriver(),
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

export type { HarnessDriver, HarnessConfig } from './HarnessDriver';
export { toHarnessConfig } from './HarnessDriver';
