import { BUILT_IN_HARNESS_ID } from './constants';
import type { HarnessAccount, HarnessDriverId } from './types';

export type NewHarnessFields = Pick<Harness, 'id' | 'driverId' | 'name' | 'accentColor'> &
    Partial<Pick<Harness, 'binaryPath' | 'configDir' | 'extraArgs' | 'enabled'>>;

export type HarnessUpdates = Partial<
    Pick<Harness, 'name' | 'accentColor' | 'enabled' | 'binaryPath' | 'configDir' | 'extraArgs'>
>;

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
export function createBuiltInHarness(): Harness {
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
