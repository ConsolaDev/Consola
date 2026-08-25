import type { Group, Scope, SessionUpdates, Workspace } from '../../shared/workspace';
import type { HarnessUpdates } from '../../shared/harness';

// The one definition lives in shared/workspace.ts; re-exported so the
// handlers keep importing the filter and its payload type from one place.
export type { SessionUpdates } from '../../shared/workspace';

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

/**
 * `path` and `isGitRepo` are deliberately not on the list: a scope's path is
 * its identity — sessions resolve their cwd through it, and a rewritten path
 * would silently redirect future launches while running terminals kept the
 * old one. Renaming is the only edit a scope supports.
 */
export function allowedScopeUpdates(
    updates: Partial<Pick<Scope, 'name'>>
): Partial<Pick<Scope, 'name'>> {
    const allowed: Partial<Pick<Scope, 'name'>> = {};
    // Required on the record: `undefined` can only ever be a bug, never an
    // intent, so absence and explicit-undefined are treated alike.
    if (updates.name !== undefined) allowed.name = updates.name;
    return allowed;
}

/**
 * `conductorSessionId` is deliberately not on the list — only the
 * orchestration door sets it, main-side, and a renderer that could point a
 * group at an arbitrary session would corrupt conductor wiring. `archivedAt`
 * stays off too: archive and restore are named verbs with their own channels,
 * the same split allowedHarnessUpdates makes for `archived`.
 */
export function allowedGroupUpdates(
    updates: Partial<Pick<Group, 'name'>>
): Partial<Pick<Group, 'name'>> {
    const allowed: Partial<Pick<Group, 'name'>> = {};
    if (updates.name !== undefined) allowed.name = updates.name;
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

/**
 * The ones that matter most: `harnessId` — and since v6 `scopeId`, `cwd`
 * and `kind` — are deliberately not on the list.
 *
 * A session's harness is fixed for its lifetime — the transcript lives inside
 * that harness's config directory and `--resume` only finds it there — so a
 * rewritten `harnessId` would silently orphan the conversation rather than
 * failing where anyone could see it. The scope, working directory and kind
 * are the session's identity in the same way: where it belongs, where it
 * runs, what drives it. `groupId` and, since v7, `workItem` are mutable —
 * regrouping and linking are acts of organisation and triage, not identity
 * changes — and both clear by presence. `id`, `workspaceId`, `instanceId`
 * and `claudeSessionId` name the session and its terminal; `createdAt` is
 * history.
 */
export function allowedSessionUpdates(updates: SessionUpdates): SessionUpdates {
    const allowed: SessionUpdates = {};
    // These three are required on the record and none is clearable, so
    // `undefined` can only ever be a bug: absence and explicit-undefined are
    // treated alike. Contrast groupId and workItem below, where `undefined`
    // is a value.
    if (updates.name !== undefined) allowed.name = updates.name;
    // Optional on the record but set-only in practice: `undefined` never
    // means "clear the flag", so it is treated like the required fields.
    if (updates.nameIsUserSet !== undefined) allowed.nameIsUserSet = updates.nameIsUserSet;
    if (updates.lastActiveAt !== undefined) allowed.lastActiveAt = updates.lastActiveAt;
    if (updates.hasStarted !== undefined) allowed.hasStarted = updates.hasStarted;
    // `undefined` IS the value here — "leave the group", "unlink from the
    // item". Structured clone preserves an explicitly-undefined key, so
    // presence is what separates "clear this" from "leave it alone".
    if ('groupId' in updates) allowed.groupId = updates.groupId;
    if ('workItem' in updates) allowed.workItem = updates.workItem;
    return allowed;
}
