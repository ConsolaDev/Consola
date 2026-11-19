import { WorkItemDetailService } from './providers/WorkItemDetailService';
import { createWorkItemAssetCache } from './providers/workItemAssets';
import { WORK_ITEM_ASSET_SCHEME } from '../shared/workItemAssets';
import { ShellManager } from './ShellManager';
import type { ShellOptions } from '../shared/shell';
import {
  checkoutPathForSession,
  scopeForSession,
  type Session,
  type WorkspaceUpdates,
} from '../shared/workspace';
import { describeError } from './describeError';
import { SessionCheckoutService } from './SessionCheckoutService';
import type { SessionCheckout } from '../shared/sessionCheckout';
import { guardedIpc as ipcMain } from './guardedIpc';
import {
  BrowserWindow,
  dialog,
  app,
  Notification,
  powerMonitor,
  protocol,
  screen as electronScreen,
  session as electronSession,
  shell,
  webContents as electronWebContents,
} from 'electron';
import type { BrowserStateFile } from '../shared/browser';
import { BrowserService } from './browser/BrowserService';
import { BrowserStateStore } from './browser/BrowserStateStore';
import { LocalServers } from './browser/LocalServers';
import { registerBrowserHandlers } from './browser/browserIpc';
import { onGuestAttached } from './browser/guestPolicy';
import { installPopupPolicy } from './browser/popupWindows';
import { isBackgroundTest } from './test-mode';
import { forwardGuestShortcuts } from './browser/guestShortcuts';
import { partitionFor } from './browser/sessionPolicy';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { TerminalManager } from './TerminalManager';
import { SessionLauncher, launchFieldsFor } from './SessionLauncher';
import { fanOut } from './fanOut';
import { listScopeRepos } from './scopeRepos';
import { runHeadless } from './drivers/ClaudeDriver';
import { getDriver, toHarnessConfig, toolPolicyProblem } from './drivers';
import { harnessCapabilitiesCache } from './HarnessCapabilitiesCache';
import { SessionNamer } from './sessionTitles/SessionNamer';
import { composeProviderEnv, getProviderDriver } from './providers';
import { InboxService } from './providers/InboxService';
import { createLaunchCoalescer, type WorkItemLaunchDeps } from './providers/launchWorkItem';
import { createRunInSessionCoalescer } from './providers/runActionInSession';
import { cloneWorkspaceRepo } from './providers/cloneRepo';
import { WorktreeService } from './WorktreeService';
import { readCheckout } from './gitCheckout';
import {
  NotificationPolicy,
  findSessionById,
  findSessionByInstanceId,
  sessionsToNotify,
} from './attention';
import { ConductorTools } from './conductor/ConductorTools';
import { SessionMcpHost, mcpConfigForSession } from './mcp/SessionMcpHost';
import { buildSessionServer } from './mcp/buildSessionServer';
import { SessionRemover } from './SessionRemover';
import { openingFor } from './harnessSwitch/handoff';
import { HandoffStore } from './harnessSwitch/HandoffStore';
import { HarnessSwitcher } from './harnessSwitch/HarnessSwitcher';
import { SessionCleanupService } from './cleanup/SessionCleanupService';
import { WorktreeCleanupService } from './worktreeCleanup';
import { WorktreeRebuilder } from './worktreeCleanup/WorktreeRebuilder';
import { CleanupHistory } from './worktreeCleanup/CleanupHistory';
import {
  RUN_ENDED_DEBOUNCE_MS,
  WorktreeCleanupSweeper,
} from './worktreeCleanup/WorktreeCleanupSweeper';
import {
  type CleanupPreviewRequest,
  describeTrigger,
  effectiveWorktreeCleanup,
  normalizeRules,
  normalizeWorkspaceOverride,
  type WorktreeCleanupRules,
} from '../shared/worktreeCleanup';
import { TERMINAL_RUN_STATUSES } from '@consola/factory-spec';
import { worktreePathLock } from './worktreeCleanup/PathLock';
import { ProcessCwdIndex } from './worktreeCleanup/ProcessCwdIndex';
import { ToolRegistry } from './tools/Tool';
import { consolaTools } from './tools/consolaTools';
import { AutomationService } from './automations/AutomationService';
import { launchAgentRun, worktreeHeld, type ItemWorktreeDeps } from './automations/launchAgentRun';
import { FactoryFile, workspaceFactoryPath } from './automations/FactoryFile';
import { readRunConversation } from './automations/runConversation';
import { startAuthoring } from './automations/authoring';
import { parseAuthoringRequest } from './automations/authoringRequest';
import { AUTOMATION_TEMPLATES } from './automations/templates';
import type { AutomationsChange } from '../shared/automations';
import { RunHistoryFiles } from './automations/RunHistoryFiles';
import { RunStore, type AutomationStateFile } from './automations/RunStore';
import { createConductor } from './conductor/createConductor';
import { scaffold } from './conductor/ConductorScaffold';
import { commit, readDiff, readStatus, stageFile, unstageFile } from './gitWorkingTree';
import type { TerminalCreateOptions, HarnessLaunchFields } from '../shared/types';
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
  allowedLabelRecord,
  allowedLabelUpdates,
  allowedScopeUpdates,
  allowedSessionUpdates,
  allowedWorkspaceUpdates,
  type SessionUpdates,
} from './state/updateFilters';
import type {
  DeletedLabel,
  Group,
  Label,
  NewGroupFields,
  NewLabelFields,
  NewScopeFields,
  NewSessionFields,
  Scope,
  Workspace,
  WorkspaceProvider,
} from '../shared/workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';
import {
  assignWorkspace,
  consolaWindows,
  createWindow,
  findWindowForWorkspace,
  focusOrCreate,
  getFocusedConsolaWindow,
  getWorkspaceFor,
  showAutomations,
  viewsFromStoredLayout,
  type ViewMemoryAccess,
} from './window-manager';
import {
  EMPTY_VIEW,
  ViewMemoryService,
  resolveRememberedView,
  type ViewMemoryStateFile,
} from './state/ViewMemoryService';
import { JsonAttentionLedger, type AttentionLedgerStateFile } from './attention/AttentionLedger';
import { TurnActivity } from './attention/TurnActivity';
import { AttentionService } from './attention/AttentionService';
import { SessionSource } from './attention/SessionSource';
import { RunSource } from './automations/RunSource';
import { AttentionEndpoint } from './attention/AttentionEndpoint';
import { HookSignals } from './attention/hookSignals';
import { SteadyStatus } from './attention/steadyStatus';
import { ViewingTracker } from './attention/ViewingTracker';
import { AutoSettler } from './attention/AutoSettler';
import { settleAndVerify, unsettleSession } from './attention/settling';
import { PreferencesService } from './state/PreferencesService';
import type { SettleMemento, SettleResult } from '../shared/preferences';
import { activityOf, type AttentionState } from '../shared/attention';
import type { ActivateWorkspaceResult, WorkspaceView } from '../shared/types';

// One terminal per session tab, kept alive while the session is open
let terminalManager: TerminalManager | null = null;
let shellManager: ShellManager | null = null;
// The in-app browser: tabs per session and the pages behind them.
let browserService: BrowserService | null = null;
let browserHandlers: { remove(): void } | null = null;

// Where each workspace was left, so returning to one lands where you were.
let viewMemoryService: ViewMemoryService | null = null;
let attentionLedgerService: JsonAttentionLedger | null = null;
let autoSettler: AutoSettler | null = null;
let worktreeSweeper: WorktreeCleanupSweeper | null = null;
let worktreeCleanupService: WorktreeCleanupService | null = null;

// The single writer for workspaces and sessions, shared by every window
let workspaceService: WorkspaceService | null = null;

// The single writer for harness records, shared by every window

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
        'directory, not in this file. Repair or move the file above, then reopen Consola.',
    );
    app.exit(1);
    return false;
  }
}

export function setupIpcHandlers(): boolean {
  const workspaceFile = new JsonStateFile<WorkspaceStateFile>(
    path.join(app.getPath('userData'), 'workspaces.json'),
  );
  const workspaces = new WorkspaceService(workspaceFile);
  if (!loadOrExit(() => workspaces.load(), 'workspaces')) return false;
  workspaceService = workspaces;

  // Not loaded through loadOrExit: an unreadable view memory costs every
  // workspace its remembered view, which is exactly what a workspace with no
  // memory already does. Halting the app over it would be the larger bug.
  const viewMemory = new ViewMemoryService(
    new JsonStateFile<ViewMemoryStateFile>(path.join(app.getPath('userData'), 'view-memory.json')),
  );
  viewMemory.load();
  // The first launch after the upgrade: carry over the sessions the previous
  // build recorded per window, so nobody's switch lands on a blank composer
  // for a workspace main already knew the answer for.
  if (viewMemory.isEmpty()) viewMemory.seed(viewsFromStoredLayout());
  viewMemoryService = viewMemory;

  // Like view memory, never fatal: a lost ledger sends every session back to
  // its creation time, which is what a session with no record shows anyway.
  const attentionLedger = new JsonAttentionLedger(
    new JsonStateFile<AttentionLedgerStateFile>(
      path.join(app.getPath('userData'), 'attention-ledger.json'),
    ),
  );
  attentionLedger.load();
  attentionLedger.prune(
    new Set(
      workspaces.getAll().flatMap((workspace) => workspace.sessions.map((session) => session.id)),
    ),
  );
  attentionLedgerService = attentionLedger;

  // Main runs the sweeper, so main owns the threshold. Never fatal: a lost
  // file means the defaults, and the one-time explanation is simply given again.
  const preferences = new PreferencesService(
    new JsonStateFile<unknown>(path.join(app.getPath('userData'), 'preferences.json')),
  );
  preferences.load();

  // The in-app browser's tabs. Not loaded through loadOrExit: the store never
  // throws, and a lost file only costs the open tabs.
  const browserStore = new BrowserStateStore(
    new JsonStateFile<BrowserStateFile>(path.join(app.getPath('userData'), 'browser-state.json')),
  );
  browserStore.load();
  const browser = new BrowserService({
    store: browserStore,
    workspaceIdForSession: (sessionId) =>
      workspaces
        .getAll()
        .find((workspace) => workspace.sessions.some((session) => session.id === sessionId))?.id,
    findWindowForWorkspace: (workspaceId) => findWindowForWorkspace(workspaceId) ?? undefined,
    send: (window, channel, payload) => window.webContents.send(channel, payload),
    // Logged and rethrown: a deleted workspace's caller already ignores the
    // rejection, while "Clear browsing data" must tell the person it failed.
    clearPartition: async (workspaceId) => {
      try {
        const target = electronSession.fromPartition(partitionFor(workspaceId));
        await target.clearStorageData();
        await target.clearCache();
        // An open connection was set up under a certificate the person may have
        // approved; reusing it would skip the check that approval no longer passes.
        await target.closeAllConnections();
        // Signed-in-by-basic-auth lives in its own cache, which neither of the
        // above empties; a deleted workspace goes through here too.
        await target.clearAuthCache();
      } catch (error) {
        console.error(`Could not clear the browser data of workspace ${workspaceId}:`, error);
        throw error;
      }
    },
  });
  browserService = browser;
  // Watch each page from the moment it attaches: the renderer binds it only
  // after dom-ready, when its first load may already have finished or failed.
  // Here rather than in `secureGuest` because only an accepted guest has a
  // host window worth forwarding to; a refused one is closed straight away.
  const stopWatchingGuests = onGuestAttached((guest, window, workspaceId, guestId) => {
    browser.noteAttached(guest, guestId);
    browser.guardGuest(guest, window, workspaceId, guestId);
    forwardGuestShortcuts(guest, window, () => browser.tabIdForGuest(guestId));
    installPopupPolicy(guest, {
      host: window,
      guestId,
      sessionIdOf: (id) => browser.sessionIdForGuest(id),
      workspaceId,
      atTabCap: (sessionId) => browser.atTabCap(sessionId),
      openTab: (sessionId, url) => void browser.openTab(sessionId, url, 'person'),
      popups: browser.popups,
      certificates: browser.certificates,
      // `webContents` is accepted by the constructor though not typed.
      createWindow: (options) =>
        new BrowserWindow(options as Electron.BrowserWindowConstructorOptions),
      maxSize: () => {
        const { width, height } = electronScreen.getDisplayNearestPoint(
          electronScreen.getCursorScreenPoint(),
        ).workArea;
        return { width, height };
      },
      hidden: isBackgroundTest,
    });
  });
  const localServers = new LocalServers();
  const registered = registerBrowserHandlers({
    ipc: ipcMain,
    service: browser,
    workspaceForSender: (sender) => {
      const window = BrowserWindow.fromWebContents(sender);
      return (window && getWorkspaceFor(window)) || undefined;
    },
    windowForSender: (sender) => BrowserWindow.fromWebContents(sender) ?? undefined,
    sessionInWorkspace: (sessionId, workspaceId) =>
      !!workspaces
        .getAll()
        .find((workspace) => workspace.id === workspaceId)
        ?.sessions.some((session) => session.id === sessionId),
    localServersFor: (sessionId) => {
      const workspace = workspaces
        .getAll()
        .find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
      const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
      // Undefined while a cleanup rule has the worktree removed: no folder, no servers.
      const folder = workspace && checkoutPathForSession(workspace, session);
      return localServers.scanFor(folder);
    },
    webContentsFromId: (id) => electronWebContents.fromId(id),
    sessionForWorkspace: (workspaceId) => electronSession.fromPartition(partitionFor(workspaceId)),
  });
  browserHandlers = {
    remove: () => {
      registered.remove();
      stopWatchingGuests();
    },
  };

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
    browser.prune(
      new Set(all.flatMap((workspace) => workspace.sessions.map((session) => session.id))),
      liveIds,
    );
    attentionLedger.prune(
      new Set(all.flatMap((workspace) => workspace.sessions.map((session) => session.id))),
    );

    for (const window of consolaWindows()) {
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_IMPORT, (_event, incoming: Workspace[], version: number) =>
    workspaces.importState(incoming, version),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CREATE,
    (_event, name: string, workspacePath: string, isGitRepo: boolean, defaultHarnessId?: string) =>
      workspaces.createWorkspace(name, workspacePath, isGitRepo, defaultHarnessId),
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE, (_event, id: string, updates: WorkspaceUpdates) => {
    // Filtering lives in updateFilters.ts, tested there: TypeScript's
    // `Pick<>` is gone by the time a payload crosses IPC.
    workspaces.updateWorkspace(id, allowedWorkspaceUpdates(updates));
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MOVE, (_event, id: string, beforeId: string | null) => {
    workspaces.moveWorkspace(id, beforeId);
  });

  // Transcripts a harness switch handed from one agent to the next.
  const handoffs = new HandoffStore(path.join(app.getPath('userData'), 'handoffs'));

  // The one way a session goes away in main. Its collaborators are built
  // further down; the closures only run once setup has finished.
  const sessionRemover = new SessionRemover({
    deleteRecord: (workspaceId, sessionId) => workspaces.deleteSession(workspaceId, sessionId),
    destroyTerminal: (instanceId) => {
      terminalManager?.destroy(instanceId);
      forgetTerminalAttention(instanceId);
    },
    destroyShell: (instanceId) => shellManager?.destroy(instanceId),
    destroyBrowser: (sessionId) => browser.destroySession(sessionId),
    // A session's endpoint would otherwise outlive its record as a
    // listening socket and a config file nothing can name again.
    releaseMcp: (sessionId) => mcpHost.unregister(sessionId),
    removeHandoffs: (sessionId) => handoffs.removeAll(sessionId),
    releaseRemovedWorktree: ({ removedWorktree: removed }) => {
      if (!removed) return;
      const stillNamed = workspaces
        .getAll()
        .some((workspace) =>
          workspace.sessions.some((session) => session.removedWorktree?.path === removed.path),
        );
      if (stillNamed) return;
      void worktrees
        .deleteKeepRef(removed.mainRepo, removed.keepRef)
        .catch((error) => console.error(`Could not delete ${removed.keepRef}:`, error));
    },
  });

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
    // the session's attention goes with it, so the PTY and the
    // badge close together; the MCP endpoint goes with them.
    stranded.forEach((session) => sessionRemover.discard(session));
    // Its tabs, history and logins go the same way: not before the delete
    // has succeeded, or a failed write would leave a workspace without them.
    browser.destroyWorkspace(
      id,
      stranded.map((session) => session.id),
    );
  });

  const sessionCheckouts = new SessionCheckoutService();
  const checkoutScope = (workspaceId: string, scopeId?: string) => {
    const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
    const scope = workspace?.scopes.find((candidate) => candidate.id === scopeId);
    if (!scope) throw new Error('The selected workspace folder is no longer available.');
    return scope;
  };
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CHECKOUT_CONTEXT,
    (_event, workspaceId: string, scopeId: string) =>
      sessionCheckouts.list(checkoutScope(workspaceId, scopeId).path),
  );
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
    },
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
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_DELETE,
    async (event, workspaceId: string, sessionId: string) => {
      const workspace = workspaces.getAll().find((w) => w.id === workspaceId);
      const session = workspace?.sessions.find((s) => s.id === sessionId);
      if (!workspace || !session) {
        workspaces.deleteSession(workspaceId, sessionId);
        return undefined;
      }
      // Record first, then the PTY, shell and MCP endpoint — in main,
      // so the delete is whole even when no renderer sends the rest. With
      // the "you delete the session" rule on, its worktree follows.
      return worktreeCleanupService!.deleteForPerson(
        workspace,
        session,
        () => sessionRemover.remove(workspaceId, session),
        (outcome) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.WORKTREE_CLEANUP_DELETED, outcome);
          }
        },
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_DELETE_PREVIEW,
    async (_event, workspaceId: string, sessionId: string) => {
      const workspace = workspaces.getAll().find((w) => w.id === workspaceId);
      const session = workspace?.sessions.find((s) => s.id === sessionId);
      if (!workspace || !session || !worktreeCleanupService) return { worktree: null };
      return worktreeCleanupService.previewDelete(workspace, session);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_ADD_SCOPE,
    (_event, workspaceId: string, fields: NewScopeFields) =>
      workspaces.addScope(workspaceId, fields),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE,
    (
      _event,
      workspaceId: string,
      scopeId: string,
      updates: Partial<Pick<Scope, 'name' | 'path'>>,
    ) => {
      // Preserve identity; the service validates folder changes.
      workspaces.updateScope(workspaceId, scopeId, allowedScopeUpdates(updates));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE,
    (_event, workspaceId: string, scopeId: string) => {
      // Stop the deleted sessions only after the entire change reaches disk.
      workspaces
        .removeScope(workspaceId, scopeId)
        .forEach((session) => sessionRemover.discard(session));
    },
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
            },
      );
    },
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
      sectionDefaults: Partial<Record<InboxSection, string>>,
    ) => workspaces.setActions(workspaceId, actions, sectionDefaults),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GROUP_CREATE,
    (_event, workspaceId: string, fields: NewGroupFields) =>
      workspaces.createGroup(workspaceId, fields),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GROUP_UPDATE,
    (
      _event,
      workspaceId: string,
      groupId: string,
      updates: Partial<Pick<Group, 'name' | 'emoji'>>,
    ) => {
      // Filtering lives in updateFilters.ts, tested there:
      // `conductorSessionId` and `archivedAt` are the fields this keeps
      // out — the first is the orchestration door's alone, the second
      // has its own archive/restore verbs.
      workspaces.updateGroup(workspaceId, groupId, allowedGroupUpdates(updates));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_LABEL_CREATE,
    (_event, workspaceId: string, fields: NewLabelFields) =>
      workspaces.createLabel(workspaceId, {
        name: fields.name,
        ...(fields.emoji !== undefined ? { emoji: fields.emoji } : {}),
        ...(fields.color !== undefined ? { color: fields.color } : {}),
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_LABEL_UPDATE,
    (
      _event,
      workspaceId: string,
      labelId: string,
      updates: Partial<Pick<Label, 'name' | 'emoji' | 'color'>>,
    ) => workspaces.updateLabel(workspaceId, labelId, allowedLabelUpdates(updates)),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_LABEL_DELETE,
    (_event, workspaceId: string, labelId: string) => workspaces.deleteLabel(workspaceId, labelId),
  );

  // Undo of the above, from the toast it raises. It takes the memento the
  // delete handed back rather than a label and a list of sessions composed
  // in a renderer: only what was actually removed can be put back.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_LABEL_RESTORE,
    (_event, workspaceId: string, removed: DeletedLabel) => {
      const label = removed?.label;
      if (!label || typeof label.id !== 'string' || typeof label.name !== 'string') {
        throw new Error('Nothing to restore.');
      }
      workspaces.restoreLabel(workspaceId, {
        label: allowedLabelRecord(label),
        index: Number.isInteger(removed.index) && removed.index >= 0 ? removed.index : 0,
        sessionIds: Array.isArray(removed.sessionIds)
          ? removed.sessionIds.filter((id): id is string => typeof id === 'string')
          : [],
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_LABEL_ASSIGN,
    (_event, workspaceId: string, sessionId: string, labelId: string) =>
      workspaces.assignLabel(workspaceId, sessionId, labelId),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_LABEL_UNASSIGN,
    (_event, workspaceId: string, sessionId: string, labelId: string) =>
      workspaces.unassignLabel(workspaceId, sessionId, labelId),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE,
    (_event, workspaceId: string, groupId: string) => workspaces.archiveGroup(workspaceId, groupId),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GROUP_RESTORE,
    (_event, workspaceId: string, groupId: string) => workspaces.restoreGroup(workspaceId, groupId),
  );

  const harnessFile = new JsonStateFile<HarnessStateFile>(
    path.join(app.getPath('userData'), 'harnesses.json'),
  );
  const harnesses = new HarnessService(harnessFile);
  if (!loadOrExit(() => harnesses.load(), 'harnesses')) return false;

  harnesses.onChange((all) => {
    for (const window of consolaWindows()) {
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
    harnesses.importState(incoming),
  );

  ipcMain.handle(IPC_CHANNELS.HARNESS_ADD, (_event, input: NewHarnessFields) =>
    harnesses.addHarness(input),
  );

  ipcMain.handle(IPC_CHANNELS.HARNESS_UPDATE, (_event, id: string, updates: HarnessUpdates) => {
    // Filtering lives in updateFilters.ts, tested there: `archived`,
    // `isBuiltIn`, `id` and `driverId` must never be settable this way, and
    // an explicit `undefined` on binaryPath/configDir must survive as a
    // real "unpin" rather than being dropped.
    harnesses.updateHarness(id, allowedHarnessUpdates(updates));
  });

  ipcMain.handle(IPC_CHANNELS.HARNESS_ARCHIVE, (_event, id: string) =>
    harnesses.archiveHarness(id),
  );

  ipcMain.handle(IPC_CHANNELS.HARNESS_RESTORE, (_event, id: string) =>
    harnesses.restoreHarness(id),
  );

  const worktrees = new WorktreeService();
  worktreeService = worktrees;
  // The remote->path map is only as fresh as the scope list that feeds it.
  workspaces.onChange(() => worktrees.invalidate());

  // A worktree a cleanup rule removed comes back, at its path and commit,
  // when its session opens — and only through here: an Inbox click or an
  // automation run that lands on that folder hands it over first.
  // What cleanup removed and what was rebuilt. Never fatal, like view memory.
  const cleanupHistory = new CleanupHistory(
    new JsonStateFile(path.join(app.getPath('userData'), 'worktree-cleanup-log.json')),
  );
  cleanupHistory.load();
  cleanupHistory.onChange(() => {
    for (const window of consolaWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.WORKTREE_CLEANUP_CHANGED);
    }
  });
  const sessionNamesAt = (worktreePath: string) => {
    const named = workspaces
      .getAll()
      .flatMap((workspace) => workspace.sessions.map((session) => ({ workspace, session })))
      .filter(
        ({ session }) =>
          session.cwd === worktreePath || session.removedWorktree?.path === worktreePath,
      );
    return {
      sessionNames: named.map(({ session }) => session.name),
      workspaceIds: [...new Set(named.map(({ workspace }) => workspace.id))],
    };
  };

  const rebuilder = new WorktreeRebuilder({
    lock: worktreePathLock,
    getWorkspaces: () => workspaces.getAll(),
    worktrees,
    clearRemoved: (worktreePath) => workspaces.clearWorktreeRemoved(worktreePath),
    rebuilt: (removed, result) =>
      cleanupHistory.append({
        action: 'rebuilt',
        tree: removed.path,
        ...sessionNamesAt(removed.path),
        trigger: removed.trigger,
        detail:
          result.kind === 'existed'
            ? 'Found in place when its session opened.'
            : `Rebuilt when its session opened${result.branch ? `, on ${result.branch}` : ', detached'}.`,
      }),
  });
  worktrees.restoreRemoved = (dir) => rebuilder.restoreAt(dir);
  /** Rebuild a removed checkout before a spawn; a failure becomes the pane's notice. */
  const rebuildForLaunch = async (
    workspace: Workspace,
    session: Session,
  ): Promise<string | undefined> => {
    if (!session.removedWorktree) return undefined;
    try {
      return (await rebuilder.ensureCheckout(workspace, session)).notice;
    } catch (error) {
      return describeError(error);
    }
  };

  const inbox = new InboxService({
    getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
    getBoundWorkspaceIds: () =>
      workspaces
        .getAll()
        .filter((workspace) => workspace.provider)
        .map((workspace) => workspace.id),
    resolveDriver: getProviderDriver,
    // Login env plus this account's token — composed in main and only in
    // main, so a token never crosses IPC and never lands in a
    // renderer-bound payload.
    composeEnv: composeProviderEnv,
    broadcast: (snapshot: InboxSnapshot) => {
      for (const window of consolaWindows()) {
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
  ipcMain.handle(IPC_CHANNELS.INBOX_DETAILS, (_event, id: string, ref: unknown) =>
    details.get(id, ref),
  );
  // Images in a work item load through main, as the workspace's account
  // (shared/workItemAssets.ts), and are remembered for the run: avatars
  // repeat on every card. Registered privileged in index.ts.
  const workItemAsset = createWorkItemAssetCache({
    getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
    resolveDriver: getProviderDriver,
    fetch,
  });
  protocol.handle(WORK_ITEM_ASSET_SCHEME, (request) => workItemAsset(request.url));
  ipcMain.handle(
    IPC_CHANNELS.INBOX_MUTATE,
    async (_event, id: string, ref: unknown, action: unknown) => {
      await details.mutate(id, ref, action);
      // A successful write must remain successful even if the subsequent read fails.
      void inbox.refresh(id);
    },
  );
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
    inbox.refresh(workspaceId),
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
    },
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
    },
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
        destinationDir,
      );
      // A fresh clone changes what resolveRepo can find, scope or not.
      if (result.ok) worktreeService?.invalidate();
      return result;
    },
  );

  terminalManager = new TerminalManager(() => consolaWindows());
  const manager = terminalManager;
  shellManager = new ShellManager();
  const shells = shellManager;
  const shellCwd = async (instanceId: string): Promise<string> => {
    let located = findSessionByInstanceId(workspaces.getAll(), instanceId);
    if (!located) throw new Error('Session no longer exists.');
    // A shell opened beside a session whose worktree was removed puts it
    // back first, as opening the session does.
    if (located.session.removedWorktree) {
      await rebuilder.ensureCheckout(located.workspace, located.session);
      located = findSessionByInstanceId(workspaces.getAll(), instanceId);
      if (!located) throw new Error('Session no longer exists.');
    }
    // Beside the agent, in whichever checkout it works — one it moved
    // itself into included — rather than where it was launched.
    const cwd = checkoutPathForSession(located.workspace, located.session);
    if (!cwd) throw new Error('Session has no working directory.');
    return cwd;
  };
  ipcMain.handle(IPC_CHANNELS.SHELL_ATTACH, async (event, options: ShellOptions) =>
    shells.attach(options, await shellCwd(options.instanceId), event.sender),
  );
  ipcMain.handle(IPC_CHANNELS.SHELL_RESTART, async (event, options: ShellOptions) =>
    shells.restart(options, await shellCwd(options.instanceId), event.sender),
  );
  ipcMain.on(IPC_CHANNELS.SHELL_INPUT, (event, id: string, data: string) =>
    shells.input(id, data, event.sender),
  );
  ipcMain.on(IPC_CHANNELS.SHELL_RESIZE, (event, id: string, cols: number, rows: number) =>
    shells.resize(id, cols, rows, event.sender),
  );

  // With no windows open on macOS the app is still alive and sessions are
  // still running. The badge is the only thing that says so.
  // One derivation of what needs the person, asked by the badge, the MCP
  // tools and (pushed, coalesced) every window. The badge counts
  // `needs-attention` only, a run waiting for approval included: a badge that
  // counted finished work would stop meaning "come here now".
  const attention = new AttentionService();
  // What an agent CLI's own hooks say, as one more input to that derivation:
  // they never write a status. The screen heuristic runs regardless.
  const hookSignals = new HookSignals();
  const attentionEndpoint = new AttentionEndpoint((instanceId, signal) =>
    hookSignals.apply(instanceId, signal),
  );
  manager.attentionEndpoint = attentionEndpoint;
  app.on('will-quit', () => attentionEndpoint.close());
  const attentionSessions = new SessionSource({
    hookInputs: (instanceId) => hookSignals.get(instanceId),
    getWorkspaces: () => workspaces.getAll(),
    terminalStatus: (instanceId) => steadySessionStatus(instanceId),
    ledger: attentionLedger,
    isViewedInFocusedWindow: (instanceId) => viewing.isViewedInFocusedWindow(instanceId),
    // An open automation run keeps the session it uses from being settled.
    heldSessionIds: () => new Set(attention.holds().keys()),
  });
  // Looking at a finished session is what clears `done`. Main decides what
  // looking means: a window must be focused as well as showing it.
  const viewing = new ViewingTracker((instanceId) => {
    const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
    if (located) attentionSessions.markSeen(located.session.id);
  });
  const watchedSenders = new Set<number>();
  const watch = (sender: Electron.WebContents) => {
    if (watchedSenders.has(sender.id)) return;
    watchedSenders.add(sender.id);
    const { id } = sender;
    sender.once('destroyed', () => {
      watchedSenders.delete(id);
      viewing.closed(id);
    });
  };
  ipcMain.handle(
    IPC_CHANNELS.ATTENTION_SNAPSHOT,
    (): AttentionState => ({
      records: attentionLedger.snapshot(),
      attention: Object.fromEntries(attention.snapshot()),
    }),
  );
  ipcMain.on(IPC_CHANNELS.ATTENTION_VIEWING, (event, instanceId: unknown) => {
    watch(event.sender);
    viewing.viewing(event.sender.id, typeof instanceId === 'string' ? instanceId : null);
  });
  ipcMain.on(IPC_CHANNELS.ATTENTION_FOCUSED, (event, focused: unknown) => {
    watch(event.sender);
    viewing.focused(event.sender.id, focused === true);
  });
  attention.register(attentionSessions);

  // Old, idle work leaves the list on its own — and the first time it does,
  // every window is told what happened (the renderer reads `pendingAutoSettle`).
  const settler = new AutoSettler({
    getWorkspaces: () => workspaces.getAll(),
    attention: () => attention.snapshot(),
    heldSessionIds: () => new Set(attention.holds().keys()),
    isShown: (instanceId) => viewing.isShown(instanceId),
    ledger: attentionLedger,
    preferences,
    changed: () => attentionSessions.refresh(),
    onWindowReport: (listener) => viewing.onReport(listener),
  });
  autoSettler = settler;
  let sweptDays = preferences.get().autoSettleDays;
  preferences.onChange((next) => {
    for (const window of consolaWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.PREFERENCES_CHANGED, next);
    }
    // A threshold the person just changed applies now, not in five minutes.
    if (next.autoSettleDays !== sweptDays) {
      sweptDays = next.autoSettleDays;
      settler.sweep();
    }
  });
  ipcMain.handle(IPC_CHANNELS.PREFERENCES_GET, () => preferences.get());
  ipcMain.handle(IPC_CHANNELS.PREFERENCES_SET_AUTO_SETTLE_DAYS, (_event, days: unknown) => {
    if (typeof days === 'number') preferences.setAutoSettleDays(days);
  });
  ipcMain.handle(IPC_CHANNELS.PREFERENCES_ACKNOWLEDGE_AUTO_SETTLE, () =>
    preferences.acknowledgeAutoSettle(),
  );
  ipcMain.handle(IPC_CHANNELS.PREFERENCES_SET_WORKTREE_CLEANUP, (_event, rules: unknown) =>
    preferences.setWorktreeCleanup(rules),
  );
  ipcMain.handle(IPC_CHANNELS.PREFERENCES_SET_TERMINAL_LINKS, (_event, rule: unknown) =>
    preferences.setTerminalLinks(rule),
  );
  /** The cleanup rules that apply in a workspace now: its own, none, or the global ones. */
  const cleanupRulesFor = (workspace: Workspace) =>
    effectiveWorktreeCleanup(preferences.get().worktreeCleanup, workspace.worktreeCleanup);

  const withWorkspace =
    <T>(empty: T, run: (workspace: Workspace, sessionId: string) => T) =>
    (_event: Electron.IpcMainInvokeEvent, workspaceId: unknown, sessionId: unknown): T => {
      if (typeof workspaceId !== 'string' || typeof sessionId !== 'string') return empty;
      const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return empty;
      const result = run(workspace, sessionId);
      attentionSessions.refresh();
      return result;
    };
  ipcMain.handle(
    IPC_CHANNELS.ATTENTION_SETTLE,
    withWorkspace<SettleResult>({ settled: false, memento: {} }, (workspace, sessionId) =>
      settleAndVerify(
        workspace,
        sessionId,
        attentionLedger,
        () => attentionSessions.read(),
        Date.now(),
      ),
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.ATTENTION_UNSETTLE,
    withWorkspace<SettleMemento>({}, (workspace, sessionId) =>
      unsettleSession(workspace, sessionId, attentionLedger, Date.now()),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.ATTENTION_RESTORE, (_event, memento: unknown) => {
    if (typeof memento !== 'object' || memento === null) return;
    attentionLedger.restore(memento as SettleMemento);
    attentionSessions.refresh();
  });
  // The steady status first: a turn boundary can release a status it was
  // holding back, and the attention read that follows should see it.
  hookSignals.subscribe((instanceId) => {
    steadyStatus.hookChanged(instanceId);
    attentionSessions.hookChanged(instanceId);
  });
  workspaces.onChange(() => attentionSessions.refresh());
  attention.onChange((change) => {
    for (const window of consolaWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.ATTENTION_CHANGED, change);
    }
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(attention.needsAttentionCount());
  });

  const notificationPolicy = new NotificationPolicy();

  // Turns starting and finishing are the activity worth remembering. The
  // terminal knows its per-launch instance; the ledger only knows sessions.
  const turnActivity = new TurnActivity(attentionLedger, (instanceId) => {
    const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
    return located
      ? { sessionId: located.session.id, workspaceId: located.workspace.id }
      : undefined;
  });
  // Attention is decided from the steady status, not the terminal's own:
  // output flow flickers, and each flicker would move a row between
  // sections and count as activity (see `SteadyStatus`). Writing
  // `finishedAt` is SessionSource's and `lastActiveAt` TurnActivity's: two
  // receivers, because they own different fields and nothing is written twice.
  const steadyStatus = new SteadyStatus({
    turn: (instanceId) => hookSignals.get(instanceId)?.turn,
    emit: (instanceId, status) => {
      turnActivity.statusChanged(instanceId, status);
      attentionSessions.statusChanged(instanceId, status);
    },
  });
  /** What attention reads for a terminal. A terminal that is gone is exited, whatever was last shown. */
  const steadySessionStatus = (instanceId: string): TerminalStatus => {
    const live = sessionStatus(instanceId);
    return live === 'exited' ? live : (steadyStatus.get(instanceId) ?? live);
  };
  // The person acting on a prompt is output starting again; that ends what a
  // hook said. Before the steady status, which reads what the hooks say.
  manager.addStatusListener((instanceId, status) => {
    hookSignals.statusChanged(instanceId, status);
    steadyStatus.observe(instanceId, status);
  });

  // Names sessions from main, so a title lands whichever pane is on screen.
  // Every edge is fed in: the namer decides which ones matter.
  const sessionNamer = new SessionNamer({
    getWorkspaces: () => workspaces.getAll(),
    getHarnesses: () => harnesses.getAll(),
    updateSession: (workspaceId, sessionId, updates) =>
      workspaces.updateSession(workspaceId, sessionId, updates),
    getDriver,
    modelInfo: async (harness, model) => {
      try {
        const result = await harnessCapabilitiesCache.get(
          getDriver(harness.driverId),
          toHarnessConfig(launchFieldsFor(harness)),
        );
        return result.supported ? result.models.find((entry) => entry.value === model) : undefined;
      } catch {
        return undefined;
      }
    },
  });
  manager.addStatusListener((instanceId, status) => sessionNamer.statusChanged(instanceId, status));

  /**
   * What every attention source knows about a terminal's current process,
   * dropped when that process is gone for good — the terminal destroyed, or
   * moved onto another harness, whose CLI says nothing about the last one's
   * held turns or open menus.
   */
  const forgetTerminalAttention = (instanceId: string) => {
    turnActivity.forget(instanceId);
    hookSignals.forget(instanceId);
    steadyStatus.forget(instanceId);
    attentionSessions.forget(instanceId);
  };

  // The fourth attention altitude: session dot → group count → switcher dot
  // → OS notification. Rings only for a session hitting needs-attention
  // while no Consola window is focused; the Inbox never notifies — only
  // terminals emit status. Clicking lands on the right window and session.
  // Driven by the attention edge, not the terminal's status: a hook can say a
  // session needs the person when its screen shows nothing recognisable, and
  // that is exactly when the person is likely to be elsewhere.
  attention.onChange((change) => {
    const ringing = sessionsToNotify(
      change,
      notificationPolicy,
      getFocusedConsolaWindow() !== null,
    );
    for (const sessionId of ringing) {
      if (!Notification.isSupported()) continue;

      const located = findSessionById(workspaces.getAll(), sessionId);
      if (!located) continue;

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
    }
  });

  // An automation session's unattended turn ending is its run finishing:
  // the findings are there, or the reason it stopped is.
  manager.addExitListener((instanceId, info) => {
    if (!info.unattended) return;
    const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
    if (!located) return;
    const ended = automationService?.turnEnded(located.session.id, {
      exitCode: info.exitCode,
      lastLine: info.lastLine,
      stopped: info.stopped,
    });
    // Work that completed is a result nobody has looked at: the session is done, not merely exited.
    if (ended?.completed) attentionSessions.runCompleted(instanceId);
    // "Its automation run ended" may now apply; a little later, once it has settled.
    worktreeSweeper?.kick(RUN_ENDED_DEBOUNCE_MS);
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
  launcher.prepareCheckout = (workspace, session) => rebuilder.ensureCheckout(workspace, session);

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
      if (
        typeof workspaceId !== 'string' ||
        typeof sessionId !== 'string' ||
        typeof actionId !== 'string'
      ) {
        return { ok: false, message: 'Invalid request.' };
      }
      return runActionInSession(workspaceId, sessionId, actionId);
    },
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

  // Removing Consola's worktrees: one decision and one executor behind the
  // cleanup tools, the sweep and the delete dialog.
  const worktreeCleanup = new WorktreeCleanupService({
    getWorkspaces: () => workspaces.getAll(),
    status: sessionStatus,
    isShown: (instanceId) => viewing.isShown(instanceId),
    heldSessionIds: () => new Set(attention.holds().keys()),
    lastActiveAt: (session) => activityOf(session, attentionLedger.get(session.id)),
    ownProcessIds: (sessions) => {
      const agents = new Set<number>();
      const shellPids = new Set<number>();
      for (const session of sessions) {
        const agent = manager.get(session.instanceId)?.pid();
        const shell = shells.pid(session.instanceId);
        if (agent !== undefined) agents.add(agent);
        if (shell !== undefined) shellPids.add(shell);
      }
      return { agents, shells: shellPids };
    },
    worktrees,
    processes: new ProcessCwdIndex(),
    lock: worktreePathLock,
    stop: (session) => sessionRemover.stop(session),
    recordRemoved: (entries) => workspaces.recordWorktreesRemoved(entries),
    clearRemoved: (worktreePath) => workspaces.clearWorktreeRemoved(worktreePath),
    rules: {
      rulesFor: cleanupRulesFor,
      // The shelf's own clock: when it went there, if it reads settled now.
      settledAt: (session) =>
        attention.get(session.id) === 'settled'
          ? (attentionLedger.get(session.id)?.settledAt ?? null)
          : null,
      runEndedAt: (session) => {
        const run = session.automation && runStore.get(session.automation.runId);
        if (!run) return undefined;
        if (!TERMINAL_RUN_STATUSES.includes(run.status)) return null;
        const ended = Date.parse(run.finishedAt ?? run.updatedAt);
        return Number.isFinite(ended) ? ended : null;
      },
    },
    pullRequests: {
      driverFor: (workspace) => {
        if (!workspace.provider) return null;
        try {
          return getProviderDriver(workspace.provider.id);
        } catch {
          return null;
        }
      },
      composeEnv: (workspace) =>
        composeProviderEnv(
          getProviderDriver(workspace.provider!.id),
          workspace.provider!.accountLogin,
        ),
    },
    removed: (execution) =>
      cleanupHistory.append({
        action: 'removed',
        tree: execution.verdict.tree,
        ...sessionNamesAt(execution.verdict.tree),
        trigger: execution.verdict.trigger,
        branch: execution.branch,
        detail: `${describeTrigger(execution.verdict.trigger)}.${
          execution.branch === 'deleted'
            ? ` Branch ${execution.inspection.branch} deleted.`
            : execution.branch === 'kept'
              ? ` Branch ${execution.inspection.branch} kept.`
              : ''
        }`,
      }),
    now: () => Date.now(),
  });

  worktreeCleanupService = worktreeCleanup;

  // The rules run on their own: every five minutes, when one changes, and
  // shortly after an automation run ends. Nothing at all while all are off.
  const sweeper = new WorktreeCleanupSweeper({
    sweep: (options) => worktreeCleanup.sweep(options),
    anyRuleOn: () => worktreeCleanup.anySweepRuleOn(cleanupRulesFor),
    onWindowReport: (listener) => viewing.onReport(listener),
  });
  worktreeSweeper = sweeper;
  let sweptRules = JSON.stringify(preferences.get().worktreeCleanup);
  preferences.onChange((next) => {
    const rules = JSON.stringify(next.worktreeCleanup);
    if (rules === sweptRules) return;
    sweptRules = rules;
    sweeper.kick();
  });
  const overridesOf = (all: Workspace[]) =>
    JSON.stringify(all.map((workspace) => [workspace.id, workspace.worktreeCleanup ?? null]));
  let sweptOverrides = overridesOf(workspaces.getAll());
  workspaces.onChange((all) => {
    const overrides = overridesOf(all);
    if (overrides === sweptOverrides) return;
    sweptOverrides = overrides;
    sweeper.kick();
  });

  /** The rules a preview is asked to judge by: the stored ones, or the ones about to be chosen. */
  const proposedRules = (request: CleanupPreviewRequest | undefined) => {
    if (!request?.global && !request?.override) return undefined;
    const global: WorktreeCleanupRules = request.global
      ? normalizeRules(request.global)
      : preferences.get().worktreeCleanup;
    const override = request.override;
    const overrideValue =
      override && override.value !== null ? normalizeWorkspaceOverride(override.value) : undefined;
    return (workspace: Workspace) =>
      effectiveWorktreeCleanup(
        global,
        override && workspace.id === override.workspaceId
          ? overrideValue
          : workspace.worktreeCleanup,
      );
  };
  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP_PREVIEW, (_event, request: unknown) => {
    const asked = (
      typeof request === 'object' && request !== null ? request : {}
    ) as CleanupPreviewRequest;
    const rulesFor = proposedRules(asked);
    return worktreeCleanup.scan({
      ...(typeof asked.workspaceId === 'string' ? { workspaceId: asked.workspaceId } : {}),
      ...(rulesFor ? { rulesFor } : {}),
    });
  });
  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP_RUN, (_event, workspaceId: unknown) =>
    worktreeCleanup.sweep({
      refreshPullRequests: true,
      ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CLEANUP_IS_MANAGED,
    (_event, dir: unknown) => typeof dir === 'string' && worktrees.managedTreeOf(dir) !== null,
  );
  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP_HISTORY, (_event, workspaceId: unknown) =>
    cleanupHistory.list(typeof workspaceId === 'string' ? workspaceId : undefined),
  );

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
      composeProviderEnv(
        getProviderDriver(workspace.provider!.id),
        workspace.provider!.accountLogin,
      ),
    worktrees,
    cleanup: worktreeCleanup,
    remover: sessionRemover,
  });

  // Consola's own tools — one registry, three callers: agents (MCP),
  // automations (factory.yml) and the app.
  const tools = new ToolRegistry();
  consolaTools({
    cleanup: sessionCleanup,
    getWorkspaces: () => workspaces.getAll(),
    status: sessionStatus,
    attention: (sessionId) => attention.get(sessionId),
    isManagedPath: (dir) => worktrees.isManagedPath(dir),
    automations: () => automations,
    // Fetched here, with the token only main holds: a read-only session
    // has none, and this is how it reads the item it is about.
    workItemContext: async (sessionId) => {
      const workspace = workspaces
        .getAll()
        .find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
      const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
      const workItem = session?.workItem;
      if (!workspace || !workItem)
        throw new Error('This session is not about a pull request or an issue.');
      if (workspace.provider?.id !== workItem.provider) {
        throw new Error(
          `This workspace has no ${workItem.provider} account bound to fetch it with.`,
        );
      }
      const driver = getProviderDriver(workspace.provider.id);
      if (!driver.describeWorkItem)
        throw new Error(`Consola cannot describe ${workItem.provider} items yet.`);
      return driver.describeWorkItem(
        workItem,
        await composeProviderEnv(driver, workspace.provider.accountLogin),
      );
    },
    inbox: (workspaceId) => inbox.getSnapshot(workspaceId),
    launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
  }).forEach((tool) => tools.register(tool));

  // Every session's private MCP endpoint (see SessionMcpHost): the Consola
  // tools for all, plus the group tools for conductors.
  const mcpHost = new SessionMcpHost({
    // In the packaged app the shim must be a real file on disk — the
    // claude CLI, an outside process, spawns it. Hence asarUnpack.
    shimEntryPath: () =>
      path.join(__dirname, 'conductor/conductorShim.js').replace('app.asar', 'app.asar.unpacked'),
    configDir: () => path.join(app.getPath('userData'), 'session-mcp'),
    buildServer: (sessionId) =>
      buildSessionServer(sessionId, {
        registry: tools,
        approvals: {
          request: (toolName, args, caller) => automations.requestApproval(toolName, args, caller),
        },
        conductorTools,
        getWorkspaces: () => workspaces.getAll(),
      }),
  });
  launcher.mcpHost = mcpHost;
  app.on('will-quit', () => mcpHost.dispose());

  // What preparing a work item's worktree needs: one chain per item, git hooks off.
  const itemWorktreeDeps: ItemWorktreeDeps = {
    resolveDriver: getProviderDriver,
    resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
    worktreePathFor: (workItem) => worktrees.worktreePathFor(workItem),
    ensureWorktree: (clonePath, workItem, env) =>
      worktrees.ensureWorktree(clonePath, workItem, env),
    refreshWorktree: (dir, workItem, env) => worktrees.refreshPullRequest(dir, workItem, env),
    worktreeInUse: (dir) =>
      worktreeHeld(
        workspaces.getAll().flatMap((workspace) => workspace.sessions),
        dir,
        (session) => manager.get(session.instanceId)?.hasClaudeExited() === false,
      ),
    composeEnv: composeProviderEnv,
  };
  const runStore = new RunStore(
    new JsonStateFile<AutomationStateFile>(
      path.join(app.getPath('userData'), 'automation-runs.json'),
    ),
    new RunHistoryFiles(path.join(app.getPath('userData'), 'automation-runs')),
  );
  // Runs waiting for a person are rows beside the sessions, and an open run
  // holds the session it uses. Every run change is a broadcast, so that is
  // when the source's answer may differ.
  const attentionRuns = new RunSource(() => runStore.runs());
  attention.register(attentionRuns);
  const automations = new AutomationService({
    fileFor: (workspaceId) => new FactoryFile(workspaceFactoryPath(workspaceId)),
    store: runStore,
    registry: tools,
    getWorkspaces: () => workspaces.getAll(),
    now: () => new Date(),
    newId: () => randomUUID(),
    notify: (notice) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: notice.title, body: notice.body });
      // Lands on what the notice is about: the session a run started, or
      // else that workspace's Automations dashboard with the run open, in
      // the window holding it.
      notification.on('click', () => {
        if (notice.sessionId) focusOrCreate(notice.workspaceId, viewMemoryPort(), notice.sessionId);
        else showAutomations(notice.workspaceId, notice.runId, viewMemoryPort());
      });
      notification.show();
    },
    broadcast: (workspaceId, snapshot) => {
      attentionRuns.refresh();
      const change: AutomationsChange = { workspaceId, snapshot };
      for (const window of consolaWindows()) {
        if (!window.isDestroyed())
          window.webContents.send(IPC_CHANNELS.AUTOMATIONS_CHANGED, change);
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
        request,
      ),
    // A turn Consola quit in the middle of picks up in its own session.
    resumeAgent: (session, prompt) =>
      launcher.resumeUnattended(session.workspaceId, session.id, prompt),
    hasLiveTerminal: (session) => manager.get(session.instanceId)?.hasClaudeExited() === false,
    agentHarness: (workspaceId) => {
      const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
      const harness = harnesses
        .getAll()
        .find((candidate) => candidate.id === workspace?.defaultHarnessId);
      return {
        name: harness?.name ?? 'Claude',
        problem: toolPolicyProblem(launchFieldsFor(harness), 'read-only'),
      };
    },
    stopAgent: (session, reason) =>
      manager.get(session.instanceId)?.stopUnattendedTurn(reason) ?? false,
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
    automations.snapshot(String(workspaceId)),
  );
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_RUN_NOW, (_event, workspaceId: string, name: string) => {
    if (typeof name !== 'string') throw new Error('Automation name required.');
    return automations.trigger(String(workspaceId), name);
  });
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_APPROVE, (_event, runId: string) =>
    automations.approve(String(runId)),
  );
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_DISMISS, (_event, runId: string) =>
    automations.dismiss(String(runId)),
  );
  // Creates the file from a commented template first, so "Open" always
  // lands in an editor rather than an error.
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_ADD_ASSIGNED_REVIEWS, (_event, workspaceId: string) =>
    automations.addAssignedReviews(String(workspaceId)),
  );
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_GET_RUN, (_event, runId: string) => {
    if (typeof runId !== 'string') throw new Error('Run id required.');
    return automations.getRun(runId);
  });
  // Reads the transcript from disk; an unknown run is simply unreadable.
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_READ_CONVERSATION, async (_event, runId: string) => {
    if (typeof runId !== 'string') throw new Error('Run id required.');
    const run = automations.getRun(runId);
    if (!run) return { readable: false };
    return readRunConversation(run, {
      harnesses: () => harnesses.getAll(),
      sessions: (workspaceId) =>
        workspaces.getAll().find((candidate) => candidate.id === workspaceId)?.sessions ?? [],
    });
  });
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_STOP, (_event, runId: string) => {
    if (typeof runId !== 'string') throw new Error('Run id required.');
    automations.stop(runId);
  });
  ipcMain.handle(
    IPC_CHANNELS.AUTOMATIONS_ADD_TEMPLATE,
    (_event, workspaceId: string, templateId: string) => {
      if (typeof workspaceId !== 'string' || typeof templateId !== 'string') {
        throw new Error('Workspace id and template id required.');
      }
      return automations.addTemplate(workspaceId, templateId);
    },
  );
  ipcMain.handle(IPC_CHANNELS.AUTOMATIONS_START_AUTHORING, (_event, raw: unknown) =>
    startAuthoring(
      {
        getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
        launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
        filePath: (workspaceId) => workspaceFactoryPath(workspaceId),
        basisEntry: async (workspaceId, basis) => {
          if ('automation' in basis) return automations.entryText(workspaceId, basis.automation);
          const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
          const template = AUTOMATION_TEMPLATES.find(
            (candidate) => candidate.id === basis.template,
          );
          return workspace && template ? template.entry(workspace) : null;
        },
      },
      parseAuthoringRequest(raw),
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.AUTOMATIONS_ACKNOWLEDGE,
    (_event, workspaceId: string, name: string) => {
      if (typeof workspaceId !== 'string' || typeof name !== 'string') {
        throw new Error('Workspace id and automation name required.');
      }
      automations.acknowledge(workspaceId, name);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.AUTOMATIONS_GET_ENTRY,
    (_event, workspaceId: string, name: string) => {
      if (typeof workspaceId !== 'string' || typeof name !== 'string') {
        throw new Error('Workspace id and automation name required.');
      }
      return automations.entryText(workspaceId, name);
    },
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
        createLabel: (workspaceId, fields) => workspaces.createLabel(workspaceId, fields),
        deleteLabel: (workspaceId, labelId) => workspaces.deleteLabel(workspaceId, labelId),
        updateGroup: (workspaceId, groupId, updates) =>
          workspaces.updateGroup(workspaceId, groupId, updates),
        launchSession: (workspaceId, fields) => launcher.launchSession(workspaceId, fields),
      },
      request,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.SESSION_FAN_OUT, (_event, intent: SessionFanOutIntent) =>
    fanOut({ workspaces, launcher }, intent),
  );

  // A read-only session's restriction is never lifted in place: the person
  // continues its conversation in a fork of their own.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_FORK,
    (_event, workspaceId: string, sessionId: string) =>
      launcher.forkWithFullTools(workspaceId, sessionId),
  );

  // A session carried on by another harness, in the same tab. Main decides
  // what a switch would do, so the renderer never reasons about drivers.
  const harnessSwitcher = new HarnessSwitcher({
    workspaces,
    harnesses,
    terminals: manager,
    launcher,
    handoffs,
    forgetAttention: forgetTerminalAttention,
  });
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_PREVIEW,
    (_event, workspaceId: string, sessionId: string) =>
      harnessSwitcher.preview(String(workspaceId), String(sessionId)),
  );
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_HARNESS,
    (_event, workspaceId: string, sessionId: string, harnessId: string) =>
      harnessSwitcher.switch(String(workspaceId), String(sessionId), String(harnessId)),
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SESSION_REGENERATE_TITLE,
    (_event, workspaceId: string, sessionId: string) =>
      sessionNamer.regenerate(String(workspaceId), String(sessionId)),
  );

  ipcMain.handle(IPC_CHANNELS.SCOPE_LIST_REPOS, (_event, workspaceId: string, scopeId: string) => {
    const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
    const scope = workspace?.scopes.find((candidate) => candidate.id === scopeId);
    return scope ? listScopeRepos(scope) : [];
  });

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
    const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
    const providerId = workspace?.provider?.id;
    const providerAccountLogin = workspace?.provider?.accountLogin;

    // Every session gets its Consola tools back on every relaunch: the
    // config file references this run's socket, so it is (re)generated
    // before the PTY spawns. The renderer never sees the path.
    const record = workspaces
      .getAll()
      .flatMap((candidate) => candidate.sessions)
      .find((session) => session.instanceId === instanceId);
    const mcpConfigPath = record ? await mcpConfigForSession(record, mcpHost) : undefined;
    // A worktree a cleanup rule removed is rebuilt before the spawn, at the
    // folder the session launches in (never `agentCwd`), and the pane says
    // so. A rebuild that fails is said instead, and the spawn then fails on
    // the missing folder the way it always has.
    let launchCwd = cwd;
    let launchNotice: string | undefined;
    if (record?.removedWorktree && workspace) {
      launchNotice = await rebuildForLaunch(workspace, record);
      launchCwd = record.cwd ?? scopeForSession(workspace, record)?.path ?? cwd;
    }
    // The awaits above are a window: a session deleted during them must not
    // get a PTY that nothing can name again.
    if (
      record &&
      !workspaces
        .getAll()
        .some((candidate) => candidate.sessions.some((session) => session.id === record.id))
    ) {
      throw new Error('Session was deleted before its terminal started.');
    }

    return manager.ensure(
      instanceId,
      {
        cwd: launchCwd,
        launchNotice,
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
        // So a conversation a harness switch began, never yet spoken in,
        // opens the way it began rather than blank.
        opening: record && openingFor(record),
      },
      event.sender,
    );
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_event, instanceId: string, data: string) => {
    manager.get(instanceId)?.write(data);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_PASTE, (_event, instanceId: string, text: string) => {
    manager.get(instanceId)?.paste(text);
  });

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (_event, instanceId: string, cols: number, rows: number) => {
      manager.get(instanceId)?.resize(cols, rows);
    },
  );

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESTART, (_event, instanceId: string) => {
    void (async () => {
      const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
      const notice = located
        ? await rebuildForLaunch(located.workspace, located.session)
        : undefined;
      const cwd =
        located &&
        (located.session.cwd ?? scopeForSession(located.workspace, located.session)?.path);
      manager.get(instanceId)?.restartClaude(cwd ?? undefined, notice);
    })();
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_DESTROY, (_event, instanceId: string) => {
    manager.destroy(instanceId);
    forgetTerminalAttention(instanceId);
  });

  // Seed a freshly opened window from main's live state. The status channels
  // are edge-triggered, so a window that opened after the edge would
  // otherwise never learn about it.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT, () => manager.statusSnapshot());

  // === Harness queries ===

  ipcMain.handle(
    IPC_CHANNELS.HARNESS_SESSION_MODEL,
    (_event, sessionId: string, fields: HarnessLaunchFields) =>
      getDriver(fields?.driverId).getSessionModel?.(toHarnessConfig(fields), sessionId) ?? null,
  );

  // Is this harness's binary present, and who is it signed in as?
  ipcMain.handle(IPC_CHANNELS.HARNESS_PROBE, (_event, fields: HarnessLaunchFields) => {
    return getDriver(fields?.driverId).probeHealth(toHarnessConfig(fields));
  });

  // What this harness's CLI can offer a composer: its slash commands, agents
  // and models. Cached in main, so the probe — which starts a real process
  // and runs the user's session hooks — happens once per harness rather than
  // once per window.
  ipcMain.handle(IPC_CHANNELS.HARNESS_CAPABILITIES, (_event, fields: HarnessLaunchFields) => {
    return harnessCapabilitiesCache.get(getDriver(fields?.driverId), toHarnessConfig(fields));
  });

  // Handle folder picker dialog (multi-select)
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDERS, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      title: 'Select Project Folders',
    });
    if (result.canceled) return [];

    // Check each folder for .git
    return result.filePaths.map((folderPath) => ({
      path: folderPath,
      name: path.basename(folderPath),
      isGitRepo: fs.existsSync(path.join(folderPath, '.git')),
    }));
  });

  // Handle single folder picker dialog (for workspace creation)
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Workspace Folder',
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
      throw new Error(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
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
        .map((entry) => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          isDirectory: entry.isDirectory(),
        }));
    } catch (error) {
      throw new Error(
        `Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // Which checkout a folder is. Anything but an absolute path is answered
  // as no checkout rather than resolved against main's own cwd.
  ipcMain.handle(IPC_CHANNELS.GIT_GET_CHECKOUT, async (_event, dir: unknown) =>
    typeof dir === 'string' && path.isAbsolute(dir) ? readCheckout(dir) : { kind: 'none' },
  );

  // Status, diffs, staging and commits live in gitWorkingTree, which never
  // hands a file name or a commit message to a shell.
  ipcMain.handle(IPC_CHANNELS.GIT_GET_STATUS, (_event, rootPath: string) => readStatus(rootPath));

  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_DIFF,
    (
      _event,
      { rootPath, filePath, staged }: { rootPath: string; filePath: string; staged: boolean },
    ) => readDiff(rootPath, filePath, staged),
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_STAGE_FILE,
    async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
      await stageFile(rootPath, filePath);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_UNSTAGE_FILE,
    async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
      await unstageFile(rootPath, filePath);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT,
    (_event, { rootPath, message }: { rootPath: string; message: string }) =>
      commit(rootPath, message),
  );

  // Handle get staged diff (for AI commit message generation)
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_STAGED_DIFF,
    async (_event, { rootPath }: { rootPath: string }) => {
      return new Promise((resolve) => {
        // Get list of staged files
        exec('git diff --cached --name-only', { cwd: rootPath }, (err, stagedFilesOutput) => {
          if (err || !stagedFilesOutput.trim()) {
            resolve({ stagedFiles: [], diff: '' });
            return;
          }

          const stagedFiles = stagedFilesOutput.trim().split('\n').filter(Boolean);

          // Get the full diff
          exec(
            'git diff --cached',
            { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 },
            (diffErr, diffOutput) => {
              resolve({
                stagedFiles,
                diff: diffErr ? '' : diffOutput,
              });
            },
          );
        });
      });
    },
  );

  // Handle commit message generation using Claude
  ipcMain.handle(
    IPC_CHANNELS.GENERATE_COMMIT_MESSAGE,
    async (_event, { rootPath }: { rootPath: string }) => {
      // Get staged diff first
      const stagedResult = await new Promise<{ stagedFiles: string[]; diff: string }>((resolve) => {
        exec('git diff --cached --name-only', { cwd: rootPath }, (err, stagedFilesOutput) => {
          if (err || !stagedFilesOutput.trim()) {
            resolve({ stagedFiles: [], diff: '' });
            return;
          }

          const stagedFiles = stagedFilesOutput.trim().split('\n').filter(Boolean);

          exec(
            'git diff --cached',
            { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 },
            (diffErr, diffOutput) => {
              resolve({
                stagedFiles,
                diff: diffErr ? '' : diffOutput,
              });
            },
          );
        });
      });

      if (stagedResult.stagedFiles.length === 0) {
        return { message: '', error: 'No staged files' };
      }

      // Truncate diff if too long (to avoid token limits)
      const maxDiffLength = 8000;
      const truncatedDiff =
        stagedResult.diff.length > maxDiffLength
          ? stagedResult.diff.slice(0, maxDiffLength) + '\n\n... (diff truncated)'
          : stagedResult.diff;

      // Build prompt for Claude
      const prompt = `Generate a concise git commit message for the following changes.
Follow conventional commits format (feat:, fix:, refactor:, docs:, style:, test:, chore:).
Keep the first line under 72 characters.
Only output the commit message, nothing else.

Staged files:
${stagedResult.stagedFiles.map((f) => `- ${f}`).join('\n')}

Diff:
${truncatedDiff}`;

      // A one-shot headless CLI call: this only transforms the diff into text
      // and runs with tools disabled, so it never touches the repository.
      const result = await runHeadless(prompt, { cwd: rootPath });

      if (result.isError || !result.text) {
        return { message: '', error: 'Could not generate a commit message' };
      }
      return { message: result.text };
    },
  );

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

      // A window that leaves its workspace stops showing its pages: its
      // webviews unmount, and main lets go of them (the tabs stay).
      const before = getWorkspaceFor(requesting);
      const letGoOfPages = () => {
        if (before && before !== workspaceId) browser.detachWindow(requesting);
      };

      if (workspaceId === null) {
        // Home shows no workspace, so there is nothing remembered to
        // hand back — but the window did take the change.
        if (!assignWorkspace(requesting, null)) return { verdict: 'focused-elsewhere' };
        letGoOfPages();
        return { verdict: 'took', view: EMPTY_VIEW };
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
      letGoOfPages();
      // Answered in the same round trip the claim rides on: asking
      // separately would paint the blank composer and correct it a
      // frame later, on every switch.
      return { verdict: 'took', view: rememberedView(workspaceId) };
    },
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
    },
  );

  // Last: start() arms the sweep against state defined further up — every
  // session's terminal status, and the windows' own reports. The first sweep
  // itself waits for a window to say what it is showing, so a session a
  // restoring window is about to open is not settled out from under it.
  autoSettler?.start();
  worktreeSweeper?.start();

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
  // The one thing debounced: a quit inside the window must not lose it.
  attentionLedgerService?.flush();
  attentionLedgerService = null;
  autoSettler?.stop();
  autoSettler = null;
  worktreeSweeper?.stop();
  worktreeSweeper = null;
  worktreeCleanupService = null;
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_DELETE_PREVIEW);
  ipcMain.removeHandler(IPC_CHANNELS.PREFERENCES_SET_WORKTREE_CLEANUP);
  ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_PREVIEW);
  ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_RUN);
  ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_HISTORY);
  ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_IS_MANAGED);
  ipcMain.removeHandler(IPC_CHANNELS.ATTENTION_SETTLE);
  ipcMain.removeHandler(IPC_CHANNELS.ATTENTION_UNSETTLE);
  ipcMain.removeHandler(IPC_CHANNELS.ATTENTION_RESTORE);
  ipcMain.removeHandler(IPC_CHANNELS.PREFERENCES_GET);
  ipcMain.removeHandler(IPC_CHANNELS.PREFERENCES_SET_AUTO_SETTLE_DAYS);
  ipcMain.removeHandler(IPC_CHANNELS.PREFERENCES_ACKNOWLEDGE_AUTO_SETTLE);
  ipcMain.removeHandler(IPC_CHANNELS.ATTENTION_SNAPSHOT);
  ipcMain.removeAllListeners(IPC_CHANNELS.ATTENTION_VIEWING);
  ipcMain.removeAllListeners(IPC_CHANNELS.ATTENTION_FOCUSED);
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
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_PREVIEW);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_SWITCH_HARNESS);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_REGENERATE_TITLE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_ADD_SCOPE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_UPDATE_SCOPE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_ACTIONS);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_RESTORE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_LABEL_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_LABEL_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_LABEL_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_LABEL_RESTORE);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_LABEL_ASSIGN);
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_LABEL_UNASSIGN);

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
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_GET_RUN);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_READ_CONVERSATION);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_ADD_TEMPLATE);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_START_AUTHORING);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_ACKNOWLEDGE);
  ipcMain.removeHandler(IPC_CHANNELS.AUTOMATIONS_GET_ENTRY);

  // Clean up all terminal services
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_ATTACH);
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_RESTART);
  ipcMain.removeAllListeners(IPC_CHANNELS.SHELL_INPUT);
  ipcMain.removeAllListeners(IPC_CHANNELS.SHELL_RESIZE);
  shellManager?.destroyAll();
  shellManager = null;
  browserHandlers?.remove();
  browserHandlers = null;
  browserService?.destroyAll();
  browserService = null;
  terminalManager?.destroyAll();
  terminalManager = null;

  // Remove terminal IPC listeners
  ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
  ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_PASTE);
  ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
  ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESTART);
  ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_DESTROY);
  ipcMain.removeHandler(IPC_CHANNELS.CONDUCTOR_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_FAN_OUT);
  ipcMain.removeHandler(IPC_CHANNELS.SCOPE_LIST_REPOS);

  ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT);

  // Remove Claude CLI query handlers
  ipcMain.removeHandler(IPC_CHANNELS.HARNESS_PROBE);
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
