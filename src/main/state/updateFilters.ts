import type { Session, Workspace } from '../../shared/workspace';
import type { HarnessUpdates } from '../../shared/harness';

/**
 * Update payloads, rebuilt from an allow-list before they reach a service.
 *
 * TypeScript's `Pick<>` is gone by the time a payload crosses IPC, so a
 * renderer could otherwise set any field the service happens to spread. Two of
 * them would do real damage: rewriting a harness `id` strands every session
 * that resolves against it, and flipping `archived` back would put a retired
 * harness into circulation while its sessions still point at it.
 *
 * These live here, apart from the handlers, so the boundary can be tested
 * without standing up Electron.
 */

export function allowedWorkspaceUpdates(
    updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>
): Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>> {
    const allowed: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>> = {};
    // Both keys are required on the record: `undefined` can only ever be a bug,
    // never an intent, so absence and explicit-undefined are treated alike.
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.defaultHarnessId !== undefined) allowed.defaultHarnessId = updates.defaultHarnessId;
    return allowed;
}

export function allowedHarnessUpdates(updates: HarnessUpdates): HarnessUpdates {
    const allowed: HarnessUpdates = {};
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.accentColor !== undefined) allowed.accentColor = updates.accentColor;
    if (updates.enabled !== undefined) allowed.enabled = updates.enabled;
    if (updates.extraArgs !== undefined) allowed.extraArgs = updates.extraArgs;
    // `undefined` IS the value for these two — it means "pin nothing", which is
    // how a harness resolves the way Consola did before harnesses existed.
    // Structured clone preserves an explicitly-undefined key, so presence is
    // what separates "clear this" from "leave it alone".
    if ('binaryPath' in updates) allowed.binaryPath = updates.binaryPath;
    if ('configDir' in updates) allowed.configDir = updates.configDir;
    return allowed;
}

export type SessionUpdates = Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>;

/**
 * The one that matters most: `harnessId` is deliberately not on the list.
 *
 * A session's harness is fixed for its lifetime — the transcript lives inside
 * that harness's config directory and `--resume` only finds it there — so a
 * rewritten `harnessId` would silently orphan the conversation rather than
 * failing where anyone could see it. `id`, `workspaceId`, `instanceId` and
 * `claudeSessionId` name the session and its terminal; `createdAt` is history.
 */
export function allowedSessionUpdates(updates: SessionUpdates): SessionUpdates {
    const allowed: SessionUpdates = {};
    // All three are required on the record and none is clearable, so
    // `undefined` can only ever be a bug: absence and explicit-undefined are
    // treated alike. Contrast the harness filter, where `undefined` is a value.
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.lastActiveAt !== undefined) allowed.lastActiveAt = updates.lastActiveAt;
    if (updates.hasStarted !== undefined) allowed.hasStarted = updates.hasStarted;
    return allowed;
}
