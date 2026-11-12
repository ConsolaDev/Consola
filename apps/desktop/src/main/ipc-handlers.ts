import { WorkItemDetailService } from './providers/WorkItemDetailService';
import { createWorkItemAssetCache } from './providers/workItemAssets';
import { WORK_ITEM_ASSET_SCHEME } from '../shared/workItemAssets';
import { ShellManager } from './ShellManager';
import type { ShellOptions } from '../shared/shell';
import { checkoutPathForSession, scopeForSession, type WorkspaceUpdates } from '../shared/workspace';
import { SessionCheckoutService } from './SessionCheckoutService';
import type { SessionCheckout } from '../shared/sessionCheckout';
import { ipcMain, BrowserWindow, dialog, app, Notification, powerMonitor, protocol, shell } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TerminalManager } from './TerminalManager';
import { SessionLauncher, launchFieldsFor } from './SessionLauncher';
import { fanOut } from './fanOut';
import { listScopeRepos } from './scopeRepos';
import { runHeadless } from './drivers/ClaudeDriver';
import { getDriver, toHarnessConfig, toolPolicyProblem } from './drivers';
import { harnessCapabilitiesCache } from './HarnessCapabilitiesCache';
import { composeProviderEnv, getProviderDriver } from './providers';
import { InboxService } from './providers/InboxService';
import { createLaunchCoalescer, type WorkItemLaunchDeps } from './providers/launchWorkItem';
import { createRunInSessionCoalescer } from './providers/runActionInSession';
import { cloneWorkspaceRepo } from './providers/cloneRepo';
import { WorktreeService } from './WorktreeService';
import { readCheckout } from './gitCheckout';
import { NotificationPolicy, findSessionByInstanceId } from './attention';
import { ConductorTools } from './conductor/ConductorTools';
import { SessionMcpHost, mcpConfigForSession } from './mcp/SessionMcpHost';
import { buildSessionServer } from './mcp/buildSessionServer';
import { SessionRemover } from './SessionRemover';
import { AssistantActivity } from './assistant/AssistantActivity';
import { AssistantService } from './assistant/AssistantService';
import { AssistantTools } from './assistant/AssistantTools';
import { ensureAssistantHome } from './assistant/assistantHome';
import { recentRepliesFor } from './assistant/recentReplies';
import { startAssistantSession } from './assistant/startSession';
import { SessionCleanupService } from './cleanup/SessionCleanupService';
import { ToolRegistry } from './tools/Tool';
import { consolaTools } from './tools/consolaTools';
import { AutomationService } from './automations/AutomationService';
import { launchAgentRun, refreshIdleWorktree, worktreeHeld, type ItemWorktreeDeps } from './automations/launchAgentRun';
import { FactoryFile, workspaceFactoryPath } from './automations/FactoryFile';
import type { AutomationsChange } from '../shared/automations';
import { RunHistoryFiles } from './automations/RunHistoryFiles';
import { RunStore, type AutomationStateFile } from './automations/RunStore';
import { createConductor } from './conductor/createConductor';
import { scaffold } from './conductor/ConductorScaffold';
import { commit, readDiff, readStatus, stageFile, unstageFile } from './gitWorkingTree';
import { TerminalCreateOptions, HarnessLaunchFields } from '../shared/types';
import type { ConductorCreateRequest, SessionFanOutIntent } from '../shared/types';
import { deriveTerminalStatus, type TerminalStatus } from '../shared/terminalStatus';
import { IPC_CHANNELS } from '../shared/constants';
import type { InboxSection } from '../shared/inboxSections';
import { isGitProviderId, type GitProviderId } from '../shared/providers';
import type { WorkItemAction } from '../shared/workItemActions';
import {
    isValidWorkItemLaunchAction,
    isValidWorkItemRef,
    toWorkItemRef,
    type InboxSnapshot,
    type WorkItemLaunchAction,
    type WorkItemRef,
} from '../shared/workItems';
import { JsonStateFile } from './state/JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './state/WorkspaceService';
import { HarnessService, type HarnessStateFile } from './state/HarnessService';
import {
    allowedGroupUpdates,
    allowedHarnessUpdates,
    allowedScopeUpdates,
    allowedSessionUpdates,
    allowedWorkspaceUpdates,
    type SessionUpdates,
} from './state/updateFilters';
import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Workspace,
    WorkspaceProvider,
} from '../shared/workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';
import {
    assignWorkspace,
    createWindow,
    findWindowForWorkspace,
    focusOrCreate,
    getWorkspaceFor,
    showWorkspaceSettings,
    viewsFromStoredLayout,
    type ViewMemoryAccess,
} from './window-manager';
import {
    EMPTY_VIEW,
    ViewMemoryService,
    resolveRememberedView,
    type ViewMemoryStateFile,
} from './state/ViewMemoryService';
import type { ActivateWorkspaceResult, WorkspaceView } from '../shared/types';

// One terminal per session tab, kept alive while the session is open
let terminalManager: TerminalManager | null = null;
let shellManager: ShellManager | null = null;

// Where each workspace was left, so returning to one lands where you were.
let viewMemoryService: ViewMemoryService | null = null;

// The single writer for workspaces and sessions, shared by every window
let workspaceService: WorkspaceService | null = null;

// The single writer for harness records, shared by every window
let harnessService: HarnessService | null = null;

// Provider organs: one inbox fetcher, one worktree owner — both main-side.
// The drivers themselves live in the registry under ./providers.
let inboxService: InboxService | null = null;
let worktreeService: WorktreeService | null = null;
let onBrowserWindowFocus: (() => void) | null = null;

// Personal automations (one factory.yml per workspace), run while the app is open.
let automationService: AutomationService | null = null;
let onPowerResume: (() => void) | null = null;

/**
 * Load a state service, or refuse to start.
 *
 * Booting with empty state looks identical to total data loss and would orphan
 * every transcript, so a state file that cannot be recovered is fatal. Refusing
 * silently is not acceptable either — name the file, and say where the
 * conversations actually live, so this is recoverable by hand.
 *
 * @returns false when the app is exiting; callers must return immediately.
 */
function loadOrExit(load: () => void, what: string): boolean {
    try {
        load();
        return true;
    } catch (error) {
        dialog.showErrorBox(
            `Consola cannot read its ${what}`,
            `${String(error)}\n\n` +
                "Your conversations are safe: they live in the CLI's own configuration " +
                'directory, not in this file. Repair or move the file above, then reopen Consola.'
        );
        app.exit(1);
        return false;
    }
}

export function setupIpcHandlers(): boolean {
    const workspaceFile = new JsonStateFile<WorkspaceStateFile>(
        path.join(app.getPath('userData'), 'workspaces.json')
    );
    const workspaces = new WorkspaceService(workspaceFile);
    if (!loadOrExit(() => workspaces.load(), 'workspaces')) return false;
    workspaceService = workspaces;

    // Not loaded through loadOrExit: an unreadable view memory costs every
    // workspace its remembered view, which is exactly what a workspace with no
    // memory already does. Halting the app over it would be the larger bug.
    const viewMemory = new ViewMemoryService(
        new JsonStateFile<ViewMemoryStateFile>(
            path.join(app.getPath('userData'), 'view-memory.json')
        )
    );
    viewMemory.load();
    // The first launch after the upgrade: carry over the sessions the previous
    // build recorded per window, so nobody's switch lands on a blank composer
    // for a workspace main already knew the answer for.
    if (viewMemory.isEmpty()) viewMemory.seed(viewsFromStoredLayout());
    viewMemoryService = viewMemory;

    // Every window renders the same records, so a change goes to all of them
    // rather than to whoever asked for it. A deleted workspace also has to be
    // dropped from any window still holding it, or that window would keep
    // pointing at an id nothing can resume.
    workspaces.onChange((all) => {
        const liveIds = new Set(all.map((workspace) => workspace.id));
        // A deleted workspace's remembered view names nothing. Resolution
        // already refuses to surface it, so this is housekeeping rather than
        // correctness — it stops the file growing forever.
        viewMemory.prune(liveIds);

        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(IPC_CHANNELS.WORKSPACE_CHANGED, all);

            const held = getWorkspaceFor(window);
            if (held && !liveIds.has(held)) {
                assignWorkspace(window, null);
                window.webContents.send(IPC_CHANNELS.WINDOW_WORKSPACE_CHANGED, null);
            }
        }
    });

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT, () => ({
        workspaces: workspaces.getAll(),
        needsImport: !workspaces.hasState(),
    }));

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_IMPORT,
        (_event, incoming: Workspace[], version: number) => workspaces.importState(incoming, version)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_CREATE,
        (_event, name: string, workspacePath: string, isGitRepo: boolean, defaultHarnessId?: string) =>
            workspaces.createWorkspace(name, workspacePath, isGitRepo, defaultHarnessId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_UPDATE,
        (_event, id: string, updates: WorkspaceUpdates) => {
            // Filtering lives in updateFilters.ts, tested there: TypeScript's
            // `Pick<>` is gone by the time a payload crosses IPC.
            workspaces.updateWorkspace(id, allowedWorkspaceUpdates(updates));
        }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_MOVE, (_event, id: string, beforeId: string | null) => {
        workspaces.moveWorkspace(id, beforeId);
    });

    // The one way a session goes away in main. Its collaborators are built
    // further down; the closures only run once setup has finished.
    const sessionRemover = new SessionRemover({
        deleteRecord: (workspaceId, sessionId) => workspaces.deleteSession(workspaceId, sessionId),
        destroyTerminal: (instanceId) => {
            terminalManager?.destroy(instanceId);
            notificationPolicy.forget(instanceId);
        },
        destroyShell: (instanceId) => shellManager?.destroy(instanceId),
        // A session's endpoint would otherwise outlive its record as a
        // listening socket and a config file nothing can name again.
        releaseMcp: (sessionId) => mcpHost.unregister(sessionId),
    });

    const assistants = new AssistantService({
        workspaces,
        ensureHome: ensureAssistantHome,
        stop: (session) => sessionRemover.stop(session),
    });
    ipcMain.handle(IPC_CHANNELS.ASSISTANT_OPEN, (_event, workspaceId: string) =>
        assistants.open(String(workspaceId))
    );
    ipcMain.handle(IPC_CHANNELS.ASSISTANT_START_FRESH, (_event, workspaceId: string) =>
        assistants.startFresh(String(workspaceId))
    );
    // Only a running Assistant is ever told: a stopped one has no terminal to
    // queue into, and nothing here may start a process.
    const assistantActivity = new AssistantActivity({
        getWorkspaces: () => workspaces.getAll(),
        queuePrompt: (instanceId, prompt) => {
            const terminal = terminalManager?.get(instanceId);
            if (!terminal || terminal.hasClaudeExited()) return false;
            terminal.queuePrompt(prompt);
            return true;
        },
        broadcast: (workspaceId, activity) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CHANNELS.ASSISTANT_ACTIVITY_CHANGED, { workspaceId, activity });
                }
            }
        },
    });
    ipcMain.handle(IPC_CHANNELS.ASSISTANT_GET_ACTIVITY, (_event, workspaceId: string) =>
        assistantActivity.snapshot(String(workspaceId))
    );
    ipcMain.handle(IPC_CHANNELS.ASSISTANT_MARK_SEEN, (_event, workspaceId: string) =>
        assistantActivity.markSeen(String(workspaceId))
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) => {
        // Read the sessions while the record still exists. Once it is gone
        // nothing can name these terminals again: their PTYs would run untended
        // until the app quits, and one parked at a permission prompt would hold
        // the dock badge up forever, pointing at a session no window can reach
        // and no UI can dismiss.
        const doomed = workspaces.getAll().find((workspace) => workspace.id === id);
        const stranded = doomed?.sessions ?? [];

        workspaces.deleteWorkspace(id);

        // Only once the delete has reached disk — a failed write throws above
        // and leaves the workspace, and its terminals, intact. destroy() clears
        // the awaiting set and fires onAttentionChanged, so the PTY and the
        // badge close together; the MCP endpoint goes with them.
        stranded.forEach((session) => sessionRemover.stop(session));
    });

    const sessionCheckouts = new SessionCheckoutService();
    const checkoutScope = (workspaceId: string, scopeId?: string) => {
        const workspace = workspaces.getAll().find(candidate => candidate.id === workspaceId);
        const scope = workspace?.scopes.find(candidate => candidate.id === scopeId);
        if (!scope) throw new Error('The selected workspace folder is no longer available.');
        return scope;
    };
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_CHECKOUT_CONTEXT,
        (_event, workspaceId: string, scopeId: string) =>
            sessionCheckouts.list(checkoutScope(workspaceId, scopeId).path));
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_CREATE,
        async (_event, workspaceId: string, payload: NewSessionFields, checkout?: SessionCheckout) => {
            // Where a session came from and what its agent may do are main's
            // to set, when an automation launches one; a window never does.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { toolPolicy, automation, ...fields } = payload ?? ({} as NewSessionFields);
            if (!checkout) return workspaces.createSession(workspaceId, fields);
            const scope = checkoutScope(workspaceId, fields.scopeId);
            const cwd = await sessionCheckouts.prepare(scope.path, checkout);
            // A failed record write leaves a usable checkout, discoverable on retry.
            checkoutScope(workspaceId, fields.scopeId);
            return workspaces.createSession(workspaceId, { ...fields, cwd });
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_UPDATE,
        (_event, workspaceId: string, sessionId: string, updates: SessionUpdates) => {
            // Filtering lives in updateFilters.ts, tested there: `harnessId` is
            // the field this keeps out, and `Partial<Pick<...>>` is gone by the
            // time a payload crosses IPC. A link carries a whole object, so its
            // shape is checked here too — the service assumes a real ref.
            // `workItem: undefined` (unlink) passes straight through.
            const allowed = allowedSessionUpdates(updates);
            if ('workItem' in allowed && allowed.workItem !== undefined) {
                if (!isValidWorkItemRef(allowed.workItem)) {
                    throw new Error('Invalid work item reference.');
                }
                // Rebuilt from the same four-field allow-list setActions and
                // setProviderBinding use — a validated shape can still carry
                // stray keys the renderer sent alongside it into workspaces.json.
                allowed.workItem = toWorkItemRef(allowed.workItem);
            }
            workspaces.updateSession(workspaceId, sessionId, allowed);
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_DELETE,
        (_event, workspaceId: string, sessionId: string) => {
            const session = workspaces.getAll().find(w => w.id === workspaceId)?.sessions.find(s => s.id === sessionId);
            if (session?.kind === 'assistant') {
                throw new Error('The Assistant is not deleted; start a fresh conversation from its ⋯ menu.');
            }
            // Record first, then the PTY, shell and MCP endpoint — in main,
            // so the delete is whole even when no renderer sends the rest.
            if (session) sessionRemover.remove(workspaceId, session);
            else workspaces.deleteSession(workspaceId, sessionId);
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_ADD_SCOPE,
        (_event, workspaceId: string, fields: NewScopeFields) =>
            workspaces.addScope(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE,
        (_event, workspaceId: string, scopeId: string, updates: Partial<Pick<Scope, 'name' | 'path'>>) => {
            // Preserve identity; the service validates folder changes.
            workspaces.updateScope(workspaceId, scopeId, allowedScopeUpdates(updates));
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE,
        (_event, workspaceId: string, scopeId: string) => {
            // Stop the deleted sessions only after the entire change reaches disk.
            workspaces.removeScope(workspaceId, scopeId).forEach((session) => sessionRemover.stop(session));
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING,
        (_event, workspaceId: string, binding: WorkspaceProvider | null) => {
            // Rebuilt from an allow-list, updateFilters-style: IPC can deliver
            // any shape, and this object is persisted verbatim. `!binding`
            // guards the property reads below — IPC's declared type doesn't
            // stop a caller from actually sending `undefined`, which used to
            // reach `binding.id` directly and throw a raw TypeError instead
            // of this message.
            if (binding !== null && (!binding || !isGitProviderId(binding.id))) {
                throw new Error(`Unknown git provider "${String(binding?.id)}".`);
            }
            // `String(binding.accountLogin)` would happily turn a missing
            // login into the literal text "undefined" and persist that.
            if (
                binding !== null &&
                !(typeof binding.accountLogin === 'string' && binding.accountLogin.length > 0)
            ) {
                throw new Error(`Missing account login for provider "${binding.id}".`);
            }
            workspaces.setProviderBinding(
                workspaceId,
                binding === null
                    ? null
                    : {
                          id: binding.id,
                          accountLogin: binding.accountLogin,
                          ...(binding.org ? { org: String(binding.org) } : {}),
                      }
            );
        }
    );

    // One validated write for actions and their section defaults. The
    // service rebuilds the records and rejects the whole payload on the
    // first problem, so the panel can show the message inline.
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_ACTIONS,
        (
            _event,
            workspaceId: string,
            actions: WorkItemAction[],
            sectionDefaults: Partial<Record<InboxSection, string>>
        ) => workspaces.setActions(workspaceId, actions, sectionDefaults)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_CREATE,
        (_event, workspaceId: string, fields: NewGroupFields) =>
            workspaces.createGroup(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_UPDATE,
        (_event, workspaceId: string, groupId: string, updates: Partial<Pick<Group, 'name' | 'emoji'>>) => {
            // Filtering lives in updateFilters.ts, tested there:
            // `conductorSessionId` and `archivedAt` are the fields this keeps
            // out — the first is the orchestration door's alone, the second
            // has its own archive/restore verbs.
            workspaces.updateGroup(workspaceId, groupId, allowedGroupUpdates(updates));
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE,
        (_event, workspaceId: string, groupId: string) =>
            workspaces.archiveGroup(workspaceId, groupId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_RESTORE,
        (_event, workspaceId: string, groupId: string) =>
            workspaces.restoreGroup(workspaceId, groupId)
    );

    const harnessFile = new JsonStateFile<HarnessStateFile>(
        path.join(app.getPath('userData'), 'harnesses.json')
    );
    const harnesses = new HarnessService(harnessFile);
    if (!loadOrExit(() => harnesses.load(), 'harnesses')) return false;
    harnessService = harnesses;

    harnesses.onChange((all) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.HARNESS_CHANGED, all);
            }
        }
    });

    ipcMain.handle(IPC_CHANNELS.HARNESS_GET_SNAPSHOT, () => ({
        harnesses: harnesses.getAll(),
        needsImport: !harnesses.hasState(),
    }));

    ipcMain.handle(IPC_CHANNELS.HARNESS_IMPORT, (_event, incoming: Harness[]) =>
        harnesses.importState(incoming)
    );

    ipcMain.handle(IPC_CHANNELS.HARNESS_ADD, (_event, input: NewHarnessFields) =>
        harnesses.addHarness(input)
    );

    ipcMain.handle(IPC_CHANNELS.HARNESS_UPDATE, (_event, id: string, updates: HarnessUpdates) => {
        // Filtering lives in updateFilters.ts, tested there: `archived`,
        // `isBuiltIn`, `id` and `driverId` must never be settable this way, and
        // an explicit `undefined` on binaryPath/configDir must survive as a
        // real "unpin" rather than being dropped.
        harnesses.updateHarness(id, allowedHarnessUpdates(updates));
    });

    ipcMain.handle(IPC_CHANNELS.HARNESS_ARCHIVE, (_event, id: string) => harnesses.archiveHarness(id));

    ipcMain.handle(IPC_CHANNELS.HARNESS_RESTORE, (_event, id: string) => harnesses.restoreHarness(id));

    const worktrees = new WorktreeService();
    worktreeService = worktrees;
    // The remote->path map is only as fresh as the scope list that feeds it.
    workspaces.onChange(() => worktrees.invalidate());

    const inbox = new InboxService({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        getBoundWorkspaceIds: () =>
            workspaces.getAll().filter((workspace) => workspace.provider).map((workspace) => workspace.id),
        resolveDriver: getProviderDriver,
        // Login env plus this account's token — composed in main and only in
        // main, so a token never crosses IPC and never lands in a
        // renderer-bound payload.
        composeEnv: composeProviderEnv,
        broadcast: (snapshot: InboxSnapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CHANNELS.INBOX_CHANGED, snapshot);
                }
            }
            // The event source: what changed since the last good fetch fires
            // event automations. The poll is the Inbox's own — checking
            // costs no tokens, and no agent ever polls.
            automationService?.observeInbox(snapshot);
        },
    });
    const details = new WorkItemDetailService({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        resolveDriver: getProviderDriver,
        composeEnv: composeProviderEnv,
    });
    ipcMain.handle(IPC_CHANNELS.INBOX_DETAILS, (_event, id: string, ref: unknown) => details.get(id, ref));
    // Images in a work item load through main, as the workspace's account
    // (shared/workItemAssets.ts), and are remembered for the run: avatars
    // repeat on every card. Registered privileged in index.ts.
    const workItemAsset = createWorkItemAssetCache({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        resolveDriver: getProviderDriver,
        fetch,
    });
    protocol.handle(WORK_ITEM_ASSET_SCHEME, (request) => workItemAsset(request.url));
    ipcMain.handle(IPC_CHANNELS.INBOX_MUTATE, async (_event, id: string, ref: unknown, action: unknown) => {
        await details.mutate(id, ref, action);
        // A successful write must remain successful even if the subsequent read fails.
        void inbox.refresh(id);
    });
    inboxService = inbox;
    inbox.start();
    onBrowserWindowFocus = () => inbox.onWindowFocus();
    app.on('browser-window-focus', onBrowserWindowFocus);

    // Cached snapshot, or null. Null also kicks a background refresh, so the
    // first Inbox open populates itself through the push channel.
    ipcMain.handle(IPC_CHANNELS.INBOX_GET, (_event, workspaceId: string) => {
        const snapshot = inbox.getSnapshot(workspaceId);
        if (!snapshot) void inbox.refresh(workspaceId);
        return snapshot;
    });

    ipcMain.handle(IPC_CHANNELS.INBOX_REFRESH, (_event, workspaceId: string) =>
        inbox.refresh(workspaceId)
    );

    // Is the provider's CLI installed, and which accounts does its keyring
    // hold? Tokens are deliberately not reachable over IPC. An id this build
    // does not know degrades to an unavailable result, never a rejection —
    // the binding panel renders it like a missing binary.
    ipcMain.handle(IPC_CHANNELS.PROVIDER_PROBE, (_event, id: GitProviderId) => {
        if (!isGitProviderId(id)) {
            return { available: false, accounts: [], error: `Unknown git provider "${String(id)}".` };
        }
        return getProviderDriver(id).probe();
    });

    // Which of these remote repos have a local clone in this workspace's
    // scopes — the Inbox uses it to label buttons ("Review" vs "Clone into
    // scope..."), read-only and token-free.
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_RESOLVE_REPOS,
        (_event, workspaceId: string, repos: string[]) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const resolved: Record<string, string | null> = {};
            for (const repo of repos) {
                resolved[repo] = workspace ? worktrees.resolveRepo(workspace, repo) : null;
            }
            return resolved;
        }
    );

    // Start a session from an action. Worktree first, record second; the
    // spawn is third and happens when the renderer mounts the session pane —
    // the same terminal-create path every session uses.
    const launchWorkItemDeps: WorkItemLaunchDeps = {
        getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
        resolveDriver: getProviderDriver,
        createSession: (id, fields) => workspaces.createSession(id, fields),
        resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
        ensureWorktree: (clonePath, item, env) => worktrees.ensureWorktree(clonePath, item, env),
        composeEnv: composeProviderEnv,
        findItem: (id, ref) => inbox.findItem(id, ref),
        restoreGroup: (id, groupId) => workspaces.restoreGroup(id, groupId),
    };
    // Coalesced (not just called directly) so two overlapping launches of the
    // same item and action can never mint two sessions for it — see
    // createLaunchCoalescer's doc comment.
    const launchWorkItem = createLaunchCoalescer(launchWorkItemDeps);
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM,
        (_event, workspaceId: string, workItem: WorkItemRef, action: WorkItemLaunchAction) => {
            // Shape-validated like WORKSPACE_SESSION_UPDATE's link payload:
            // this one persists workItem into the session record too, and
            // derives a worktree directory name from repo.
            if (!isValidWorkItemRef(workItem)) {
                return { ok: false, reason: 'error', message: 'Invalid work item reference.' };
            }
            // Cheap shape check on the action too — the renderer sends one of
            // two variants and IPC has already stripped TypeScript's types.
            // Exactly one of id/customPrompt, string-typed: the same
            // discriminant resolveAction and workItemActionKey use.
            if (!isValidWorkItemLaunchAction(action)) {
                return { ok: false, reason: 'error', message: 'Invalid launch action.' };
            }
            return launchWorkItem(workspaceId, toWorkItemRef(workItem), action);
        }
    );

    // "Clone into scope..." — the destination the user picked becomes the
    // clone's container. isGitRepo: false is load-bearing: resolveRepo only
    // scans a non-repo scope's children, and the clone lands one level down
    // (destinationDir/<repo-basename>), never at destinationDir itself.
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_CLONE_REPO,
        async (_event, workspaceId: string, repo: string, destinationDir: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            if (!workspace) return { ok: false, error: `Unknown workspace: ${workspaceId}` };
            const result = await cloneWorkspaceRepo(
                {
                    resolveDriver: getProviderDriver,
                    composeEnv: composeProviderEnv,
                    addScope: (id, dirPath) => {
                        workspaces.addScope(id, {
                            name: path.basename(dirPath),
                            path: dirPath,
                            isGitRepo: false,
                        });
                    },
                },
                workspace,
                repo,
                destinationDir
            );
            // A fresh clone changes what resolveRepo can find, scope or not.
            if (result.ok) worktreeService?.invalidate();
            return result;
        }
    );

    terminalManager = new TerminalManager(() => BrowserWindow.getAllWindows());
    const manager = terminalManager;
    shellManager = new ShellManager();
    const shells = shellManager;
    const shellCwd = (instanceId: string): string => {
        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        if (!located) throw new Error('Session no longer exists.');
        // Beside the agent, in whichever checkout it works — one it moved
        // itself into included — rather than where it was launched.
        const cwd = checkoutPathForSession(located.workspace, located.session);
        if (!cwd) throw new Error('Session has no working directory.');
        return cwd;
    };
    ipcMain.handle(IPC_CHANNELS.SHELL_ATTACH, (event, options: ShellOptions) =>
        shells.attach(options, shellCwd(options.instanceId), event.sender));
    ipcMain.handle(IPC_CHANNELS.SHELL_RESTART, (event, options: ShellOptions) =>
        shells.restart(options, shellCwd(options.instanceId), event.sender));
    ipcMain.on(IPC_CHANNELS.SHELL_INPUT, (event, id: string, data: string) => shells.input(id, data, event.sender));
    ipcMain.on(IPC_CHANNELS.SHELL_RESIZE, (event, id: string, cols: number, rows: number) => shells.resize(id, cols, rows, event.sender));

    // With no windows open on macOS the app is still alive and sessions are
    // still running. The badge is the only thing that says so.
    manager.onAttentionChanged = () => {
        if (typeof app.setBadgeCount === 'function') {
            const count = manager.getAttentionCount();
            app.setBadgeCount(count > 0 ? count : 0);
        }
    };

    const notificationPolicy = new NotificationPolicy();

    // The fourth attention altitude: session dot → group count → switcher dot
    // → OS notification. Rings only for a session hitting needs-attention
    // while no Consola window is focused; the Inbox never notifies — only
    // terminals emit status. Clicking lands on the right window and session.
    manager.addStatusListener((instanceId, status) => assistantActivity.statusChanged(instanceId, status));
    manager.addStatusListener((instanceId, status) => {
        const anyWindowFocused = BrowserWindow.getFocusedWindow() !== null;
        if (!notificationPolicy.shouldNotify(instanceId, status, anyWindowFocused)) return;
        if (!Notification.isSupported()) return;

        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        if (!located) return;

        // An automation's session waits for nothing but the person: say who
        // started it. Consola never answers a menu itself.
        const started = located.session.automation;
        const notification = new Notification({
            title: `${located.session.name || 'A session'} needs you — ${located.workspace.name}`,
            body: started
                ? `${started.name} started it, and it is waiting for you. Click to open it in Consola.`
                : 'Click to open it in Consola.',
        });
        notification.on('click', () => {
            focusOrCreate(located.workspace.id, viewMemoryPort(), located.session.id);
        });
        notification.show();
    });

    // An automation session's unattended turn ending is its run finishing:
    // the findings are there, or the reason it stopped is.
    manager.addExitListener((instanceId, info) => {
        if (!info.unattended) return;
        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        if (!located) return;
        automationService?.turnEnded(located.session.id, {
            exitCode: info.exitCode,
            lastLine: info.lastLine,
            stopped: info.stopped,
        });
    });

    // An agent can move itself into another checkout (Claude's EnterWorktree)
    // and git state belongs to the checkout it edits, so the record follows
    // wherever its CLI says it went.
    manager.onWorkingDirectory = (instanceId, cwd) => {
        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        if (!located) return;
        try {
            workspaces.recordAgentCwd(located.workspace.id, located.session.id, cwd);
        } catch (error) {
            // Runs from a terminal's poll, where a throw would be uncaught.
            // The record keeps its last checkout; the next move tries again.
            console.error('Could not record where a session works:', error);
        }
    };

    // Sessions born without a pane: fan-out (and, in Phase 3, conductors).
    const launcher = new SessionLauncher(workspaces, harnesses, manager);

    // An action run in a work-item session that already exists — a follow-up
    // pass on the same job, in the same tab. Coalesced per session and
    // action, so a double-click cannot replace a conversation twice.
    const runActionInSession = createRunInSessionCoalescer({
        getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
        resolveDriver: getProviderDriver,
        findItem: (id, ref) => inbox.findItem(id, ref),
        runInSession: (workspaceId, sessionId, prompt, conversation) =>
            launcher.runInSession(workspaceId, sessionId, prompt, conversation),
    });
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_RUN_ACTION_IN_SESSION,
        (_event, workspaceId: unknown, sessionId: unknown, actionId: unknown) => {
            if (typeof workspaceId !== 'string' || typeof sessionId !== 'string' || typeof actionId !== 'string') {
                return { ok: false, message: 'Invalid request.' };
            }
            return runActionInSession(workspaceId, sessionId, actionId);
        }
    );

    // The same derivation the terminal:status event promotes, from the same
    // flags — so what a tool sees and what the fleet UI shows can never
    // disagree. A terminal that is gone (never mounted, or closed) is exited.
    const sessionStatus = (instanceId: string): TerminalStatus => {
        const terminal = manager.get(instanceId);
        if (!terminal) return 'exited';
        return deriveTerminalStatus({
            busy: terminal.busy(),
            awaitingConfirmation: terminal.awaitingConfirmation(),
            exited: terminal.hasClaudeExited(),
        });
    };

    // A conductor's group tools: spawn, prompt and observe its workers.
    const conductorTools = new ConductorTools({
        getWorkspaces: () => workspaces.getAll(),
        launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
        queuePrompt: (instanceId, prompt) => {
            const terminal = manager.get(instanceId);
            if (!terminal || terminal.hasClaudeExited()) return false;
            terminal.queuePrompt(prompt);
            return true;
        },
        getStatus: sessionStatus,
    });

    // Finished-PR cleanup and single deletes: one service behind the MCP
    // tools, automations and Settings alike.
    const sessionCleanup = new SessionCleanupService({
        getWorkspaces: () => workspaces.getAll(),
        status: sessionStatus,
        driverFor: (workspace) => {
            if (!workspace.provider) return null;
            try {
                return getProviderDriver(workspace.provider.id);
            } catch {
                return null; // A provider this build lacks.
            }
        },
        // Token composed here and only here, like the Inbox: never on IPC.
        composeEnv: (workspace) =>
            composeProviderEnv(getProviderDriver(workspace.provider!.id), workspace.provider!.accountLogin),
        worktrees,
        remover: sessionRemover,
    });

    // Consola's own tools — one registry, three callers: agents (MCP),
    // automations (factory.yml) and the app.
    const tools = new ToolRegistry();
    consolaTools({
        cleanup: sessionCleanup,
        getWorkspaces: () => workspaces.getAll(),
        status: sessionStatus,
        isManagedPath: (dir) => worktrees.isManagedPath(dir),
        automations: () => automations,
        // Fetched here, with the token only main holds: a read-only session
        // has none, and this is how it reads the item it is about.
        workItemContext: async (sessionId) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
            const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
            const workItem = session?.workItem;
            if (!workspace || !workItem) throw new Error('This session is not about a pull request or an issue.');
            if (workspace.provider?.id !== workItem.provider) {
                throw new Error(`This workspace has no ${workItem.provider} account bound to fetch it with.`);
            }
            const driver = getProviderDriver(workspace.provider.id);
            if (!driver.describeWorkItem) throw new Error(`Consola cannot describe ${workItem.provider} items yet.`);
            return driver.describeWorkItem(workItem, await composeProviderEnv(driver, workspace.provider.accountLogin));
        },
        inbox: (workspaceId) => inbox.getSnapshot(workspaceId),
        launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
    }).forEach((tool) => tools.register(tool));

    // Every session's private MCP endpoint (see SessionMcpHost): the Consola
    // tools for all, plus the group tools for conductors and the workspace
    // tools for the Assistant.
    const mcpHost = new SessionMcpHost({
        // In the packaged app the shim must be a real file on disk — the
        // claude CLI, an outside process, spawns it. Hence asarUnpack.
        shimEntryPath: () =>
            path
                .join(__dirname, 'conductor/conductorShim.js')
                .replace('app.asar', 'app.asar.unpacked'),
        configDir: () => path.join(app.getPath('userData'), 'session-mcp'),
        buildServer: (sessionId) =>
            buildSessionServer(sessionId, {
                registry: tools,
                approvals: {
                    request: (toolName, args, caller) => automations.requestApproval(toolName, args, caller),
                },
                conductorTools,
                assistantTools,
                getWorkspaces: () => workspaces.getAll(),
            }),
    });
    launcher.mcpHost = mcpHost;
    app.on('will-quit', () => mcpHost.dispose());

    // What preparing a work item's worktree needs, shared by automations and
    // the Assistant so both take the same chain and keep git hooks off.
    const itemWorktreeDeps: ItemWorktreeDeps = {
        resolveDriver: getProviderDriver,
        resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
        worktreePathFor: (workItem) => worktrees.worktreePathFor(workItem),
        ensureWorktree: (clonePath, workItem, env) => worktrees.ensureWorktree(clonePath, workItem, env),
        refreshWorktree: (dir, workItem, env) => worktrees.refreshPullRequest(dir, workItem, env),
        worktreeInUse: (dir) =>
            worktreeHeld(
                workspaces.getAll().flatMap((workspace) => workspace.sessions),
                dir,
                (session) => manager.get(session.instanceId)?.hasClaudeExited() === false
            ),
        composeEnv: composeProviderEnv,
    };
    // A re-run of a read-only review reads the PR as it is now.
    launcher.beforeRerun = (workspace, session) => refreshIdleWorktree(itemWorktreeDeps, workspace, session);

    // The Assistant's workspace tools: prompt, read and start its sessions,
    // and hear back when each settles. mcpHost's buildServer reads it only
    // when a session connects, which is after this setup has run.
    const assistantTools = new AssistantTools({
        getWorkspaces: () => workspaces.getAll(),
        status: sessionStatus,
        deliverPrompt: (workspaceId, sessionId, prompt) => launcher.deliverPrompt(workspaceId, sessionId, prompt),
        recentReplies: (session, count) =>
            recentRepliesFor(
                harnesses.getAll().find((harness) => harness.id === session.harnessId),
                session,
                count
            ),
        // An exited terminal's screen is a stale one.
        screenText: (instanceId) => {
            const terminal = manager.get(instanceId);
            return terminal && !terminal.hasClaudeExited() ? terminal.screenText() : null;
        },
        start: (workspace, request) =>
            startAssistantSession(
                {
                    ...itemWorktreeDeps,
                    restoreGroup: (id, groupId) => workspaces.restoreGroup(id, groupId),
                    launchSession: (id, fields) => launcher.launchSession(id, fields),
                },
                workspace,
                request
            ),
        watch: (assistantSessionId, targetSessionId) => assistantActivity.watch(assistantSessionId, targetSessionId),
    });

    const automations = new AutomationService({
        fileFor: (workspaceId) => new FactoryFile(workspaceFactoryPath(workspaceId)),
        store: new RunStore(
            new JsonStateFile<AutomationStateFile>(path.join(app.getPath('userData'), 'automation-runs.json')),
            new RunHistoryFiles(path.join(app.getPath('userData'), 'automation-runs'))
        ),
        registry: tools,
        getWorkspaces: () => workspaces.getAll(),
        now: () => new Date(),
        newId: () => randomUUID(),
        notify: (notice) => {
            if (!Notification.isSupported()) return;
            const notification = new Notification({ title: notice.title, body: notice.body });
            // Lands on what the notice is about: the session a run started,
            // or else that workspace's Automations panel, in the window
            // holding it.
            notification.on('click', () =>
                notice.sessionId
                    ? focusOrCreate(notice.workspaceId, viewMemoryPort(), notice.sessionId)
                    : showWorkspaceSettings(notice.workspaceId, 'automations', viewMemoryPort())
            );
            notification.show();
        },
        broadcast: (workspaceId, snapshot) => {
            const change: AutomationsChange = { workspaceId, snapshot };
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.AUTOMATIONS_CHANGED, change);
            }
        },
        every: (ms, run) => {
            const timer = setInterval(run, ms);
            timer.unref?.();
            return () => clearInterval(timer);
        },
        inboxSnapshot: (workspaceId) => inbox.getSnapshot(workspaceId),
        refreshInbox: (workspaceId) => inbox.refresh(workspaceId),
        launchAgent: (request) =>
            launchAgentRun(
                {
                    getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
                    ...itemWorktreeDeps,
                    restoreGroup: (id, groupId) => workspaces.restoreGroup(id, groupId),
                    launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
                },
                request
            ),
        // A turn Consola quit in the middle of picks up in its own session.
        resumeAgent: (session, prompt) => launcher.resumeUnattended(session.workspaceId, session.id, prompt),
        hasLiveTerminal: (session) => manager.get(session.instanceId)?.hasClaudeExited() === false,
        agentHarness: (workspaceId) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const harness = harnesses.getAll().find((candidate) => candidate.id === workspace?.defaultHarnessId);
            return {
                name: harness?.name ?? 'Claude',
                problem: toolPolicyProblem(launchFieldsFor(harness), 'read-only'),
            };
        },
        stopAgent: (session, reason) => manager.get(session.instanceId)?.stopUnattendedTurn(reason) ?? false,
    });
    automationService = automations;
    void automations.start().catch((error) => console.error('Automations failed to start.', error));
    // A workspace's file is read from when it appears, and let go when it is deleted.
    workspaces.onChange(() => void automations.syncWorkspaces());
    // An edited harness re-resolves the entries that run on it.
    harnesses.onChange(() => void automations.syncWorkspaces());
    // A laptop asleep at 09:00 wakes into a due run: check right away rather
    // than at the next tick.
    onPowerResume = () => void automations.tick();
    powerMonitor.on('resume', onPowerResume);

    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_GET_SNAPSHOT, (_event, workspaceId: string) =>
        automations.snapshot(String(workspaceId))
    );
    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_RUN_NOW, (_event, workspaceId: string, name: string) => {
        if (typeof name !== 'string') throw new Error('Automation name required.');
        return automations.trigger(String(workspaceId), name);
    });
    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_APPROVE, (_event, runId: string) => automations.approve(String(runId)));
    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_DISMISS, (_event, runId: string) => automations.dismiss(String(runId)));
    // Creates the file from a commented template first, so "Open" always
    // lands in an editor rather than an error.
    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_ADD_ASSIGNED_REVIEWS, (_event, workspaceId: string) =>
        automations.addAssignedReviews(String(workspaceId))
    );
    ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_OPEN_FILE, async (_event, workspaceId: string) => {
        const failure = await shell.openPath(await automations.ensureFile(String(workspaceId)));
        if (failure) throw new Error(failure);
    });

    ipcMain.handle(IPC_CHANNELS.CONDUCTOR_CREATE, (_event, request: ConductorCreateRequest) =>
        createConductor(
            {
                getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
                scaffold,
                createGroup: (workspaceId, fields) => workspaces.createGroup(workspaceId, fields),
                updateGroup: (workspaceId, groupId, updates) =>
                    workspaces.updateGroup(workspaceId, groupId, updates),
                launchSession: (workspaceId, fields) =>
                    launcher.launchSession(workspaceId, fields),
            },
            request
        )
    );

    ipcMain.handle(IPC_CHANNELS.SESSION_FAN_OUT, (_event, intent: SessionFanOutIntent) =>
        fanOut({ workspaces, launcher }, intent)
    );

    // A read-only session's restriction is never lifted in place: the person
    // continues its conversation in a fork of their own.
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_SESSION_FORK, (_event, workspaceId: string, sessionId: string) =>
        launcher.forkWithFullTools(workspaceId, sessionId)
    );

    ipcMain.handle(
        IPC_CHANNELS.SCOPE_LIST_REPOS,
        (_event, workspaceId: string, scopeId: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const scope = workspace?.scopes.find((candidate) => candidate.id === scopeId);
            return scope ? listScopeRepos(scope) : [];
        }
    );

    // Start or attach to a session's terminal. Returns buffered output so a
    // remounted view repaints without restarting the conversation.
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (event, options: TerminalCreateOptions) => {
        const {
            instanceId,
            workspaceId,
            cwd,
            claudeSessionId,
            resume,
            cols,
            rows,
            initialPrompt,
            model,
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
        } = options;

        // The workspace's provider binding, resolved here because this file
        // owns the workspace records. TerminalService turns the login into a
        // token at spawn time, under the driver's variable; the renderer
        // never sees either step.
        const workspace = workspaces
            .getAll()
            .find((candidate) => candidate.id === workspaceId);
        const providerId = workspace?.provider?.id;
        const providerAccountLogin = workspace?.provider?.accountLogin;

        // Every session gets its Consola tools back on every relaunch: the
        // config file references this run's socket, so it is (re)generated
        // before the PTY spawns. The renderer never sees the path.
        const record = workspaces
            .getAll()
            .flatMap((candidate) => candidate.sessions)
            .find((session) => session.instanceId === instanceId);
        const mcpConfigPath = record
            ? await mcpConfigForSession(record, mcpHost)
            : undefined;
        // The await above is a window: a session deleted during it must not
        // get a PTY that nothing can name again.
        if (
            record &&
            !workspaces.getAll().some((candidate) => candidate.sessions.some((session) => session.id === record.id))
        ) {
            throw new Error('Session was deleted before its terminal started.');
        }

        return manager.ensure(instanceId, {
            cwd,
            claudeSessionId,
            // Resume whenever this tab has run before. Claude is the authority
            // on whether the conversation still exists, and TerminalService
            // falls back to a fresh session if it does not.
            resume,
            cols,
            rows,
            initialPrompt,
            // Pinned when the session chose a model, absent when it did not —
            // in which case the CLI picks its own default, as before.
            model,
            // Absent for the built-in harness, which launches exactly as
            // Consola did before harnesses existed.
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
            providerId,
            providerAccountLogin,
            mcpConfigPath,
            // From the record, never the window: a relaunch after a restart
            // comes through here, and must stay as restricted as the launch.
            toolPolicy: record?.toolPolicy,
        }, event.sender);
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_event, instanceId: string, data: string) => {
        manager.get(instanceId)?.write(data);
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_PASTE, (_event, instanceId: string, text: string) => {
        manager.get(instanceId)?.paste(text);
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_event, instanceId: string, cols: number, rows: number) => {
        manager.get(instanceId)?.resize(cols, rows);
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_RESTART, (_event, instanceId: string) => {
        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        const cwd = located && (located.session.cwd ?? scopeForSession(located.workspace, located.session)?.path);
        manager.get(instanceId)?.restartClaude(cwd ?? undefined);
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_DESTROY, (_event, instanceId: string) => {
        manager.destroy(instanceId);
        notificationPolicy.forget(instanceId);
    });

    // Seed a freshly opened window from main's live state. The status channels
    // are edge-triggered, so a window that opened after the edge would
    // otherwise never learn about it.
    ipcMain.handle(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT, () => manager.statusSnapshot());

    // === Harness queries ===

    ipcMain.handle(
        IPC_CHANNELS.HARNESS_SESSION_MODEL,
        (_event, sessionId: string, fields: HarnessLaunchFields) =>
            getDriver(fields?.driverId).getSessionModel?.(toHarnessConfig(fields), sessionId) ?? null
    );

    // Is this harness's binary present, and who is it signed in as?
    ipcMain.handle(IPC_CHANNELS.HARNESS_PROBE, (_event, fields: HarnessLaunchFields) => {
        return getDriver(fields?.driverId).probeHealth(toHarnessConfig(fields));
    });

    // A session's name, read from its own harness's transcripts. Drivers whose
    // transcript format Consola cannot read simply have no answer.
    ipcMain.handle(
        IPC_CHANNELS.HARNESS_SESSION_NAME,
        (_event, sessionId: string, fields: HarnessLaunchFields) => {
            const driver = getDriver(fields?.driverId);
            return driver.getSessionDisplayName?.(toHarnessConfig(fields), sessionId) ?? null;
        }
    );

    // What this harness's CLI can offer a composer: its slash commands, agents
    // and models. Cached in main, so the probe — which starts a real process
    // and runs the user's session hooks — happens once per harness rather than
    // once per window.
    ipcMain.handle(IPC_CHANNELS.HARNESS_CAPABILITIES, (_event, fields: HarnessLaunchFields) => {
        return harnessCapabilitiesCache.get(
            getDriver(fields?.driverId),
            toHarnessConfig(fields)
        );
    });

    // Handle folder picker dialog (multi-select)
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDERS, async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'multiSelections', 'createDirectory'],
            title: 'Select Project Folders'
        });
        if (result.canceled) return [];

        // Check each folder for .git
        return result.filePaths.map(folderPath => ({
            path: folderPath,
            name: path.basename(folderPath),
            isGitRepo: fs.existsSync(path.join(folderPath, '.git'))
        }));
    });

    // Handle single folder picker dialog (for workspace creation)
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select Workspace Folder'
        });
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        const selectedPath = result.filePaths[0];
        const folderName = path.basename(selectedPath);
        const isGitRepo = fs.existsSync(path.join(selectedPath, '.git'));
        return { path: selectedPath, name: folderName, isGitRepo };
    });

    // Handle file read
    ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content;
        } catch (error) {
            throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Handle directory listing
    ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIRECTORY, async (_event, dirPath: string) => {
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            return entries
                .sort((a, b) => {
                    // Directories first, then alphabetical
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.name.localeCompare(b.name);
                })
                .map(entry => ({
                    name: entry.name,
                    path: path.join(dirPath, entry.name),
                    isDirectory: entry.isDirectory()
                }));
        } catch (error) {
            throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
        }
    });


    // Which checkout a folder is. Anything but an absolute path is answered
    // as no checkout rather than resolved against main's own cwd.
    ipcMain.handle(IPC_CHANNELS.GIT_GET_CHECKOUT, async (_event, dir: unknown) =>
        typeof dir === 'string' && path.isAbsolute(dir) ? readCheckout(dir) : { kind: 'none' }
    );

    // Status, diffs, staging and commits live in gitWorkingTree, which never
    // hands a file name or a commit message to a shell.
    ipcMain.handle(IPC_CHANNELS.GIT_GET_STATUS, (_event, rootPath: string) => readStatus(rootPath));

    ipcMain.handle(IPC_CHANNELS.GIT_GET_DIFF, (_event, { rootPath, filePath, staged }: { rootPath: string; filePath: string; staged: boolean }) =>
        readDiff(rootPath, filePath, staged)
    );

    ipcMain.handle(IPC_CHANNELS.GIT_STAGE_FILE, async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
        await stageFile(rootPath, filePath);
        return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE_FILE, async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
        await unstageFile(rootPath, filePath);
        return { success: true };
    });

    ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, (_event, { rootPath, message }: { rootPath: string; message: string }) =>
        commit(rootPath, message)
    );

    // Handle get staged diff (for AI commit message generation)
    ipcMain.handle(IPC_CHANNELS.GIT_GET_STAGED_DIFF, async (_event, { rootPath }: { rootPath: string }) => {
        return new Promise((resolve) => {
            // Get list of staged files
            exec('git diff --cached --name-only', { cwd: rootPath }, (err, stagedFilesOutput) => {
                if (err || !stagedFilesOutput.trim()) {
                    resolve({ stagedFiles: [], diff: '' });
                    return;
                }

                const stagedFiles = stagedFilesOutput.trim().split('\n').filter(Boolean);

                // Get the full diff
                exec('git diff --cached', { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 }, (diffErr, diffOutput) => {
                    resolve({
                        stagedFiles,
                        diff: diffErr ? '' : diffOutput
                    });
                });
            });
        });
    });

    // Handle commit message generation using Claude
    ipcMain.handle(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE, async (_event, { rootPath }: { rootPath: string }) => {
        // Get staged diff first
        const stagedResult = await new Promise<{ stagedFiles: string[]; diff: string }>((resolve) => {
            exec('git diff --cached --name-only', { cwd: rootPath }, (err, stagedFilesOutput) => {
                if (err || !stagedFilesOutput.trim()) {
                    resolve({ stagedFiles: [], diff: '' });
                    return;
                }

                const stagedFiles = stagedFilesOutput.trim().split('\n').filter(Boolean);

                exec('git diff --cached', { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 }, (diffErr, diffOutput) => {
                    resolve({
                        stagedFiles,
                        diff: diffErr ? '' : diffOutput
                    });
                });
            });
        });

        if (stagedResult.stagedFiles.length === 0) {
            return { message: '', error: 'No staged files' };
        }

        // Truncate diff if too long (to avoid token limits)
        const maxDiffLength = 8000;
        const truncatedDiff = stagedResult.diff.length > maxDiffLength
            ? stagedResult.diff.slice(0, maxDiffLength) + '\n\n... (diff truncated)'
            : stagedResult.diff;

        // Build prompt for Claude
        const prompt = `Generate a concise git commit message for the following changes.
Follow conventional commits format (feat:, fix:, refactor:, docs:, style:, test:, chore:).
Keep the first line under 72 characters.
Only output the commit message, nothing else.

Staged files:
${stagedResult.stagedFiles.map(f => `- ${f}`).join('\n')}

Diff:
${truncatedDiff}`;

        // A one-shot headless CLI call: this only transforms the diff into text
        // and runs with tools disabled, so it never touches the repository.
        const result = await runHeadless(prompt, { cwd: rootPath });

        if (result.isError || !result.text) {
            return { message: '', error: 'Could not generate a commit message' };
        }
        return { message: result.text };
    });

    // A workspace lives in at most one window, and main is the only thing that
    // can say so without two renderers racing to claim it in the same tick.
    //
    // `assignWorkspace` reports whether it actually recorded the assignment —
    // it silently no-ops on a window that's mid-close. Reporting 'took' when
    // it returned false would tell a renderer it holds a workspace main has no
    // record of, which is exactly the two-windows-one-workspace failure this
    // handler exists to prevent. 'focused-elsewhere' is the honest verdict for
    // that case too: from the renderer's point of view it did not get the
    // workspace, and the safe reaction to "did not get it" is to leave its
    // current workspace alone.
    ipcMain.handle(
        IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE,
        (event, workspaceId: string | null): ActivateWorkspaceResult => {
            const requesting = BrowserWindow.fromWebContents(event.sender);
            if (!requesting) return { verdict: 'focused-elsewhere' };

            if (workspaceId === null) {
                // Home shows no workspace, so there is nothing remembered to
                // hand back — but the window did take the change.
                return assignWorkspace(requesting, null)
                    ? { verdict: 'took', view: EMPTY_VIEW }
                    : { verdict: 'focused-elsewhere' };
            }

            // A dropdown rendered before another window deleted this workspace
            // still lists it, and clicking it would put an id nothing can
            // resume into the registry — which saveWindowLayout then writes out.
            // 'focused-elsewhere' is already the renderer's "you did not get it,
            // change nothing" path, so no renderer knows this case exists.
            if (!workspaces.getAll().some((workspace) => workspace.id === workspaceId)) {
                return { verdict: 'focused-elsewhere' };
            }

            const holder = findWindowForWorkspace(workspaceId);
            if (holder && holder !== requesting) {
                if (holder.isMinimized()) holder.restore();
                holder.focus();
                return { verdict: 'focused-elsewhere' };
            }

            if (!assignWorkspace(requesting, workspaceId)) {
                return { verdict: 'focused-elsewhere' };
            }
            // Answered in the same round trip the claim rides on: asking
            // separately would paint the blank composer and correct it a
            // frame later, on every switch.
            return { verdict: 'took', view: rememberedView(workspaceId) };
        }
    );

    ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN, (_event, workspaceId: string | null) => {
        if (workspaceId) {
            focusOrCreate(workspaceId, viewMemoryPort());
        } else {
            createWindow();
        }
    });

    ipcMain.on(
        IPC_CHANNELS.WINDOW_SET_VIEW,
        (event, workspaceId: string | null, view: WorkspaceView) => {
            const window = BrowserWindow.fromWebContents(event.sender);
            const held = window ? getWorkspaceFor(window) : undefined;
            // A window on Home has no workspace to remember this against.
            if (!workspaceId) return;
            // Checked against the registry rather than trusted, because a
            // report is composed in the renderer and delivered a round trip
            // later. One that raced a workspace switch still names the
            // workspace it was composed against; filing it under the one this
            // window now holds would overwrite that workspace's memory with a
            // session from the old one, and silently cost it its real view.
            if (workspaceId !== held) return;
            viewMemory.set(workspaceId, view);
        }
    );

    return true;
}

/**
 * The ids restoreWindowLayout may point a window at.
 *
 * Only valid once setupIpcHandlers() has returned true — before that,
 * workspaceService is null and every saved window falls back to Home, which
 * is the same as an empty workspace list here.
 */
export function getKnownWorkspaceIds(): Set<string> {
    return new Set((workspaceService?.getAll() ?? []).map((workspace) => workspace.id));
}

/**
 * What a workspace should show, narrowed to what it can actually show.
 *
 * The one read path. Resolving here rather than at write time is what lets
 * every other path stay simple: a session deleted from another window, a
 * provider unbound, a workspace removed — none needs to reach into the memory,
 * because the next read catches it.
 */
function rememberedView(workspaceId: string): WorkspaceView {
    if (!viewMemoryService) return EMPTY_VIEW;
    const workspace = workspaceService?.getAll().find((entry) => entry.id === workspaceId);
    return resolveRememberedView(viewMemoryService.get(workspaceId), workspace);
}

/**
 * The view memory as window-manager needs it, resolved on the way out.
 *
 * Handed to the window manager rather than the service itself so that file
 * keeps knowing nothing about workspace records — the same reason
 * restoreWindowLayout takes a set of ids instead of a WorkspaceService.
 */
export function viewMemoryPort(): ViewMemoryAccess {
    return {
        get: rememberedView,
        set: (workspaceId, view) => viewMemoryService?.set(workspaceId, view),
    };
}

export function cleanupIpcHandlers(): void {
    workspaceService = null;
    // Every view reached disk as it was set, so there is nothing to flush —
    // only the reference to drop, alongside the other services.
    viewMemoryService = null;
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_IMPORT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_DELETE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_MOVE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_CHECKOUT_CONTEXT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_DELETE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_FORK);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_ADD_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_ACTIONS);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_RESTORE);

    harnessService = null;
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_IMPORT);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_ADD);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_ARCHIVE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_RESTORE);

    inboxService?.stop();
    inboxService = null;
    worktreeService = null;
    if (onBrowserWindowFocus) {
        app.removeListener('browser-window-focus', onBrowserWindowFocus);
        onBrowserWindowFocus = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_DETAILS);
    if (protocol.isProtocolHandled(WORK_ITEM_ASSET_SCHEME)) protocol.unhandle(WORK_ITEM_ASSET_SCHEME);
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_MUTATE);
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_GET);
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_REFRESH);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_PROBE);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_RESOLVE_REPOS);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_RUN_ACTION_IN_SESSION);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_CLONE_REPO);

    automationService?.shutdown();
    automationService = null;
    if (onPowerResume) {
        powerMonitor.removeListener('resume', onPowerResume);
        onPowerResume = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_RUN_NOW);
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_APPROVE);
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_DISMISS);
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_OPEN_FILE);
    ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_ADD_ASSIGNED_REVIEWS);

    // Clean up all terminal services
    ipcMain.removeHandler(IPC_CHANNELS.SHELL_ATTACH);
    ipcMain.removeHandler(IPC_CHANNELS.SHELL_RESTART);
    ipcMain.removeAllListeners(IPC_CHANNELS.SHELL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.SHELL_RESIZE);
    shellManager?.destroyAll();
    shellManager = null;
    terminalManager?.destroyAll();
    terminalManager = null;

    // Remove terminal IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_PASTE);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESTART);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_DESTROY);
    ipcMain.removeHandler(IPC_CHANNELS.CONDUCTOR_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.ASSISTANT_OPEN);
    ipcMain.removeHandler(IPC_CHANNELS.ASSISTANT_START_FRESH);
    ipcMain.removeHandler(IPC_CHANNELS.ASSISTANT_GET_ACTIVITY);
    ipcMain.removeHandler(IPC_CHANNELS.ASSISTANT_MARK_SEEN);
    ipcMain.removeHandler(IPC_CHANNELS.SESSION_FAN_OUT);
    ipcMain.removeHandler(IPC_CHANNELS.SCOPE_LIST_REPOS);

    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT);

    // Remove Claude CLI query handlers
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_PROBE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_SESSION_NAME);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_SESSION_MODEL);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_CAPABILITIES);

    // Remove dialog IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDER);

    // Remove file IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.FILE_READ);
    ipcMain.removeHandler(IPC_CHANNELS.FILE_LIST_DIRECTORY);

    // Remove git IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_STATUS);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_CHECKOUT);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_DIFF);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_STAGE_FILE);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_UNSTAGE_FILE);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_COMMIT);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_STAGED_DIFF);
    ipcMain.removeHandler(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE);

    // Remove window identity IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE);
    ipcMain.removeHandler(IPC_CHANNELS.WINDOW_OPEN);
    ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_SET_VIEW);
}
