import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TerminalManager } from './TerminalManager';
import { runHeadless } from './drivers/ClaudeDriver';
import { getDriver, toHarnessConfig } from './drivers';
import { harnessCapabilitiesCache } from './HarnessCapabilitiesCache';
import { ghBroker } from './github/GhBroker';
import { GitHubService } from './github/GitHubService';
import { launchWorkItem } from './github/launchWorkItem';
import { cloneWorkspaceRepo } from './github/cloneRepo';
import { WorktreeService } from './WorktreeService';
import { getLoginEnv } from './LoginEnvironment';
import { TerminalCreateOptions, HarnessLaunchFields } from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';
import type { InboxSnapshot, WorkItemRef } from '../shared/github';
import { JsonStateFile } from './state/JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './state/WorkspaceService';
import { HarnessService, type HarnessStateFile } from './state/HarnessService';
import {
    allowedHarnessUpdates,
    allowedSessionUpdates,
    allowedWorkspaceUpdates,
    type SessionUpdates,
} from './state/updateFilters';
import type {
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Workspace,
} from '../shared/workspace';
import type { Harness, HarnessUpdates, NewHarnessFields } from '../shared/harness';
import {
    assignWorkspace,
    createWindow,
    findWindowForWorkspace,
    focusOrCreate,
    getContextFor,
    setActiveSession,
} from './window-manager';
import type { ActivateWorkspaceResult } from '../shared/types';

// One terminal per session tab, kept alive while the session is open
let terminalManager: TerminalManager | null = null;

// The single writer for workspaces and sessions, shared by every window
let workspaceService: WorkspaceService | null = null;

// The single writer for harness records, shared by every window
let harnessService: HarnessService | null = null;

// GitHub organs: one inbox fetcher, one worktree owner — both main-side. The
// broker itself is the module singleton imported above, shared with GH_PROBE.
let githubService: GitHubService | null = null;
let worktreeService: WorktreeService | null = null;
let onBrowserWindowFocus: (() => void) | null = null;

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

    // Every window renders the same records, so a change goes to all of them
    // rather than to whoever asked for it. A deleted workspace also has to be
    // dropped from any window still holding it, or that window would keep
    // pointing at an id nothing can resume.
    workspaces.onChange((all) => {
        const liveIds = new Set(all.map((workspace) => workspace.id));

        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(IPC_CHANNELS.WORKSPACE_CHANGED, all);

            const held = getContextFor(window)?.workspaceId;
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
        (_event, id: string, updates: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>>) => {
            // Filtering lives in updateFilters.ts, tested there: TypeScript's
            // `Pick<>` is gone by the time a payload crosses IPC.
            workspaces.updateWorkspace(id, allowedWorkspaceUpdates(updates));
        }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) => {
        // Read the sessions while the record still exists. Once it is gone
        // nothing can name these terminals again: their PTYs would run untended
        // until the app quits, and one parked at a permission prompt would hold
        // the dock badge up forever, pointing at a session no window can reach
        // and no UI can dismiss.
        const doomed = workspaces.getAll().find((workspace) => workspace.id === id);
        const stranded = doomed?.sessions.map((session) => session.instanceId) ?? [];

        workspaces.deleteWorkspace(id);

        // Only once the delete has reached disk — a failed write throws above
        // and leaves the workspace, and its terminals, intact. destroy() clears
        // the awaiting set and fires onAttentionChanged, so the PTY and the
        // badge close together.
        for (const instanceId of stranded) {
            terminalManager?.destroy(instanceId);
        }
    });

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_CREATE,
        (_event, workspaceId: string, fields: NewSessionFields) =>
            workspaces.createSession(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_UPDATE,
        (_event, workspaceId: string, sessionId: string, updates: SessionUpdates) => {
            // Filtering lives in updateFilters.ts, tested there: `harnessId` is
            // the field this keeps out, and `Partial<Pick<...>>` is gone by the
            // time a payload crosses IPC.
            workspaces.updateSession(workspaceId, sessionId, allowedSessionUpdates(updates));
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_DELETE,
        (_event, workspaceId: string, sessionId: string) =>
            workspaces.deleteSession(workspaceId, sessionId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_ADD_SCOPE,
        (_event, workspaceId: string, fields: NewScopeFields) =>
            workspaces.addScope(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE,
        (_event, workspaceId: string, scopeId: string) =>
            workspaces.removeScope(workspaceId, scopeId)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING,
        (_event, workspaceId: string, binding: { accountLogin: string; org?: string } | null) =>
            workspaces.setGitHubBinding(
                workspaceId,
                // Rebuilt from an allow-list, updateFilters-style: IPC can
                // deliver any shape, and this object is persisted verbatim.
                binding === null
                    ? null
                    : {
                          accountLogin: String(binding.accountLogin),
                          ...(binding.org ? { org: String(binding.org) } : {}),
                      }
            )
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_CREATE,
        (_event, workspaceId: string, fields: NewGroupFields) =>
            workspaces.createGroup(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE,
        (_event, workspaceId: string, groupId: string) =>
            workspaces.archiveGroup(workspaceId, groupId)
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

    // The gh binary, resolved once. CONSOLA_GH_PATH is the test seam: the
    // Playwright suite points it at the stub gh fixture so no network or
    // keyring is ever touched.
    let cachedGhBinary: string | null = null;
    const resolveGhBinary = async (): Promise<string> => {
        if (process.env.CONSOLA_GH_PATH) return process.env.CONSOLA_GH_PATH;
        if (!cachedGhBinary) {
            const probe = await ghBroker.probe();
            cachedGhBinary = probe.available && probe.resolvedBinary ? probe.resolvedBinary : 'gh';
        }
        return cachedGhBinary;
    };

    // Login env plus this account's token — composed here and only here, so a
    // token never crosses IPC and never lands in a renderer-bound payload.
    const composeGhEnv = async (accountLogin: string): Promise<NodeJS.ProcessEnv> => ({
        ...getLoginEnv(),
        GH_TOKEN: await ghBroker.token(accountLogin),
    });

    const worktrees = new WorktreeService(undefined, resolveGhBinary);
    worktreeService = worktrees;
    // The remote->path map is only as fresh as the scope list that feeds it.
    workspaces.onChange(() => worktrees.invalidate());

    const github = new GitHubService({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        getGitHubWorkspaceIds: () =>
            workspaces.getAll().filter((workspace) => workspace.github).map((workspace) => workspace.id),
        token: (login) => ghBroker.token(login),
        ghBinary: resolveGhBinary,
        baseEnv: () => ({ ...getLoginEnv() }),
        broadcast: (snapshot: InboxSnapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CHANNELS.GITHUB_INBOX_CHANGED, snapshot);
                }
            }
        },
    });
    githubService = github;
    github.start();
    onBrowserWindowFocus = () => github.onWindowFocus();
    app.on('browser-window-focus', onBrowserWindowFocus);

    // Cached snapshot, or null. Null also kicks a background refresh, so the
    // first Inbox open populates itself through the push channel.
    ipcMain.handle(IPC_CHANNELS.GITHUB_GET_INBOX, (_event, workspaceId: string) => {
        const snapshot = github.getSnapshot(workspaceId);
        if (!snapshot) void github.refresh(workspaceId);
        return snapshot;
    });

    ipcMain.handle(IPC_CHANNELS.GITHUB_REFRESH_INBOX, (_event, workspaceId: string) =>
        github.refresh(workspaceId)
    );

    // Which of these remote repos have a local clone in this workspace's
    // scopes — the Inbox uses it to label buttons ("Review" vs "Clone into
    // scope..."), read-only and token-free.
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_RESOLVE_REPOS,
        (_event, workspaceId: string, repos: string[]) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const resolved: Record<string, string | null> = {};
            for (const repo of repos) {
                resolved[repo] = workspace ? worktrees.resolveRepo(workspace, repo) : null;
            }
            return resolved;
        }
    );

    // One click on an Inbox item. Worktree first, record second; the spawn is
    // third and happens when the renderer mounts the session pane — the same
    // terminal-create path every session uses.
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM,
        (_event, workspaceId: string, workItem: WorkItemRef) =>
            launchWorkItem(
                {
                    getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
                    createSession: (id, fields) => workspaces.createSession(id, fields),
                    resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
                    ensureWorktree: (clonePath, item, env) =>
                        worktrees.ensureWorktree(clonePath, item, env),
                    composeEnv: composeGhEnv,
                    findItem: (id, ref) => github.findItem(id, ref),
                },
                workspaceId,
                workItem
            )
    );

    // "Clone into scope..." — the destination the user picked becomes the
    // clone's container. isGitRepo: false is load-bearing: resolveRepo only
    // scans a non-repo scope's children, and the clone lands one level down
    // (destinationDir/<repo-basename>), never at destinationDir itself.
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_CLONE_REPO,
        async (_event, workspaceId: string, repo: string, destinationDir: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            if (!workspace) return { ok: false, error: `Unknown workspace: ${workspaceId}` };
            const result = await cloneWorkspaceRepo(
                {
                    ghBinary: resolveGhBinary,
                    composeEnv: composeGhEnv,
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

    // With no windows open on macOS the app is still alive and sessions are
    // still running. The badge is the only thing that says so.
    manager.onAttentionChanged = () => {
        if (typeof app.setBadgeCount === 'function') {
            const count = manager.getAttentionCount();
            app.setBadgeCount(count > 0 ? count : 0);
        }
    };

    // Start or attach to a session's terminal. Returns buffered output so a
    // remounted view repaints without restarting the conversation.
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (event, options: TerminalCreateOptions) => {
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

        // The workspace's GitHub binding, resolved here because this file owns
        // the workspace records. TerminalService turns the login into a token
        // at spawn time; the renderer never sees either step.
        const workspace = workspaces
            .getAll()
            .find((candidate) => candidate.id === workspaceId);
        const githubAccountLogin = workspace?.github?.accountLogin;

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
            githubAccountLogin,
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
        manager.get(instanceId)?.restartClaude();
    });

    ipcMain.on(IPC_CHANNELS.TERMINAL_DESTROY, (_event, instanceId: string) => {
        manager.destroy(instanceId);
    });

    // Seed a freshly opened window from main's live state. The status channels
    // are edge-triggered, so a window that opened after the edge would
    // otherwise never learn about it.
    ipcMain.handle(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT, () => manager.statusSnapshot());

    // === Harness queries ===

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

    // === GitHub queries ===

    // Is `gh` installed, and which accounts does its keyring hold? Tokens are
    // deliberately not reachable over IPC — see GhBroker.
    ipcMain.handle(IPC_CHANNELS.GH_PROBE, () => ghBroker.probe());

    // Handle folder picker dialog (multi-select)
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDERS, async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'multiSelections'],
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


    // Handle git status
    ipcMain.handle(IPC_CHANNELS.GIT_GET_STATUS, async (_event, rootPath: string) => {
        return new Promise((resolve) => {
            // Check if directory is a git repo
            const gitDir = path.join(rootPath, '.git');
            if (!fs.existsSync(gitDir)) {
                resolve({ files: [], stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 }, isGitRepo: false, branch: null });
                return;
            }

            // Get current branch name
            exec('git rev-parse --abbrev-ref HEAD', { cwd: rootPath }, (branchErr, branchStdout) => {
                const branch = !branchErr && branchStdout ? branchStdout.trim() : null;

                // Run git status --porcelain to get file statuses
                exec('git status --porcelain -uall', { cwd: rootPath }, (statusErr, statusStdout) => {
                    const files: Array<{ path: string; status: 'staged' | 'modified' | 'untracked' | 'deleted' }> = [];

                    if (!statusErr && statusStdout) {
                        const lines = statusStdout.trimEnd().split('\n').filter(Boolean);
                        for (const line of lines) {
                            const indexStatus = line[0];
                            const workingStatus = line[1];
                            const filePath = line.slice(3).trim();

                            // Determine status based on git status output
                            // First column = index (staged), Second column = working tree
                            if (indexStatus === '?' && workingStatus === '?') {
                                files.push({ path: filePath, status: 'untracked' });
                            } else if (indexStatus === 'D' || workingStatus === 'D') {
                                files.push({ path: filePath, status: 'deleted' });
                            } else if (indexStatus !== ' ' && indexStatus !== '?') {
                                // Staged changes (A, M, R, C in index)
                                files.push({ path: filePath, status: 'staged' });
                            } else if (workingStatus === 'M') {
                                // Unstaged modifications
                                files.push({ path: filePath, status: 'modified' });
                            }
                        }
                    }

                    // Run git diff --numstat for line counts
                    exec('git diff --numstat', { cwd: rootPath }, (diffErr, diffStdout) => {
                        let addedLines = 0;
                        let removedLines = 0;

                        if (!diffErr && diffStdout) {
                            const lines = diffStdout.trim().split('\n').filter(Boolean);
                            for (const line of lines) {
                                const parts = line.split('\t');
                                const added = parseInt(parts[0], 10);
                                const removed = parseInt(parts[1], 10);
                                if (!isNaN(added)) addedLines += added;
                                if (!isNaN(removed)) removedLines += removed;
                            }
                        }

                        // Also get staged diff stats
                        exec('git diff --cached --numstat', { cwd: rootPath }, (stagedErr, stagedStdout) => {
                            if (!stagedErr && stagedStdout) {
                                const lines = stagedStdout.trim().split('\n').filter(Boolean);
                                for (const line of lines) {
                                    const parts = line.split('\t');
                                    const added = parseInt(parts[0], 10);
                                    const removed = parseInt(parts[1], 10);
                                    if (!isNaN(added)) addedLines += added;
                                    if (!isNaN(removed)) removedLines += removed;
                                }
                            }

                            resolve({
                                files,
                                stats: {
                                    modifiedCount: files.length,
                                    addedLines,
                                    removedLines
                                },
                                isGitRepo: true,
                                branch
                            });
                        });
                    });
                });
            });
        });
    });

    // Handle git diff
    ipcMain.handle(IPC_CHANNELS.GIT_GET_DIFF, async (_event, { rootPath, filePath, staged }: { rootPath: string; filePath: string; staged: boolean }) => {
        return new Promise((resolve) => {
            const absolutePath = path.join(rootPath, filePath);

            // Check if file exists for new/untracked files
            const fileExists = fs.existsSync(absolutePath);

            // For untracked files, return full content as new
            if (!staged) {
                exec(`git ls-files --error-unmatch "${filePath}" 2>/dev/null`, { cwd: rootPath }, (err) => {
                    if (err) {
                        // File is untracked - read full content
                        if (fileExists) {
                            fs.promises.readFile(absolutePath, 'utf-8').then((content) => {
                                resolve({
                                    filePath,
                                    staged: false,
                                    oldContent: '',
                                    newContent: content,
                                    hunks: [],
                                    isBinary: false,
                                    isNew: true,
                                    isDeleted: false
                                });
                            }).catch(() => {
                                resolve({
                                    filePath,
                                    staged: false,
                                    oldContent: '',
                                    newContent: '',
                                    hunks: [],
                                    isBinary: true,
                                    isNew: true,
                                    isDeleted: false
                                });
                            });
                        } else {
                            resolve({
                                filePath,
                                staged: false,
                                oldContent: '',
                                newContent: '',
                                hunks: [],
                                isBinary: false,
                                isNew: true,
                                isDeleted: true
                            });
                        }
                        return;
                    }

                    // File is tracked, get the diff
                    getDiffContent(rootPath, filePath, staged, fileExists, resolve);
                });
            } else {
                // Staged file - get the diff directly
                getDiffContent(rootPath, filePath, staged, fileExists, resolve);
            }
        });
    });

    function getDiffContent(
        rootPath: string,
        filePath: string,
        staged: boolean,
        fileExists: boolean,
        resolve: (value: unknown) => void
    ) {
        const diffCmd = staged ? `git diff --cached -- "${filePath}"` : `git diff -- "${filePath}"`;
        const absolutePath = path.join(rootPath, filePath);

        exec(diffCmd, { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 }, (diffErr, diffStdout) => {
            if (diffErr || !diffStdout) {
                // No diff available
                resolve({
                    filePath,
                    staged,
                    oldContent: '',
                    newContent: '',
                    hunks: [],
                    isBinary: false,
                    isNew: false,
                    isDeleted: !fileExists
                });
                return;
            }

            // Check for binary
            if (diffStdout.includes('Binary files')) {
                resolve({
                    filePath,
                    staged,
                    oldContent: '',
                    newContent: '',
                    hunks: [],
                    isBinary: true,
                    isNew: false,
                    isDeleted: false
                });
                return;
            }

            // Get old content (from HEAD or index)
            const showCmd = staged ? `git show HEAD:"${filePath}"` : `git show :"${filePath}"`;
            exec(showCmd, { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 }, (showErr, oldContent) => {
                // Get new content
                const getNewContent = (): Promise<string> => {
                    if (staged) {
                        // For staged, get from index
                        return new Promise((res) => {
                            exec(`git show :"${filePath}"`, { cwd: rootPath, maxBuffer: 10 * 1024 * 1024 }, (err, content) => {
                                res(err ? '' : content);
                            });
                        });
                    } else {
                        // For unstaged, read from filesystem
                        if (fileExists) {
                            return fs.promises.readFile(absolutePath, 'utf-8').catch(() => '');
                        }
                        return Promise.resolve('');
                    }
                };

                getNewContent().then((newContent) => {
                    resolve({
                        filePath,
                        staged,
                        oldContent: showErr ? '' : oldContent,
                        newContent,
                        hunks: parseDiffHunks(diffStdout),
                        isBinary: false,
                        isNew: showErr !== null,
                        isDeleted: !fileExists
                    });
                });
            });
        });
    }

    // Handle git stage file
    ipcMain.handle(IPC_CHANNELS.GIT_STAGE_FILE, async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
        return new Promise((resolve, reject) => {
            exec(`git add "${filePath}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr || err.message));
                } else {
                    resolve({ success: true });
                }
            });
        });
    });

    // Handle git unstage file
    ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE_FILE, async (_event, { rootPath, filePath }: { rootPath: string; filePath: string }) => {
        return new Promise((resolve, reject) => {
            exec(`git reset HEAD "${filePath}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                if (err) {
                    // If the file was never committed, git reset will fail
                    // Try removing from index instead
                    exec(`git rm --cached "${filePath}"`, { cwd: rootPath }, (err2, stdout2, stderr2) => {
                        if (err2) {
                            reject(new Error(stderr2 || stderr || err.message));
                        } else {
                            resolve({ success: true });
                        }
                    });
                } else {
                    resolve({ success: true });
                }
            });
        });
    });

    // Handle git commit
    ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, async (_event, { rootPath, message }: { rootPath: string; message: string }) => {
        return new Promise((resolve) => {
            // Escape double quotes in the message
            const escapedMessage = message.replace(/"/g, '\\"');
            exec(`git commit -m "${escapedMessage}"`, { cwd: rootPath }, (err, stdout, stderr) => {
                if (err) {
                    resolve({ success: false, error: stderr || err.message });
                } else {
                    resolve({ success: true });
                }
            });
        });
    });

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

    function parseDiffHunks(diffOutput: string): Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: Array<{
            type: 'context' | 'add' | 'remove';
            content: string;
            oldLineNumber?: number;
            newLineNumber?: number;
        }>;
    }> {
        const hunks: Array<{
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: Array<{
                type: 'context' | 'add' | 'remove';
                content: string;
                oldLineNumber?: number;
                newLineNumber?: number;
            }>;
        }> = [];

        const lines = diffOutput.split('\n');
        let currentHunk: typeof hunks[0] | null = null;
        let oldLine = 0;
        let newLine = 0;

        for (const line of lines) {
            // Parse hunk header: @@ -oldStart,oldLines +newStart,newLines @@
            const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (hunkMatch) {
                if (currentHunk) {
                    hunks.push(currentHunk);
                }
                currentHunk = {
                    oldStart: parseInt(hunkMatch[1], 10),
                    oldLines: parseInt(hunkMatch[2] || '1', 10),
                    newStart: parseInt(hunkMatch[3], 10),
                    newLines: parseInt(hunkMatch[4] || '1', 10),
                    lines: []
                };
                oldLine = currentHunk.oldStart;
                newLine = currentHunk.newStart;
                continue;
            }

            if (!currentHunk) continue;

            if (line.startsWith('+') && !line.startsWith('+++')) {
                currentHunk.lines.push({
                    type: 'add',
                    content: line.slice(1),
                    newLineNumber: newLine++
                });
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                currentHunk.lines.push({
                    type: 'remove',
                    content: line.slice(1),
                    oldLineNumber: oldLine++
                });
            } else if (line.startsWith(' ')) {
                currentHunk.lines.push({
                    type: 'context',
                    content: line.slice(1),
                    oldLineNumber: oldLine++,
                    newLineNumber: newLine++
                });
            }
        }

        if (currentHunk) {
            hunks.push(currentHunk);
        }

        return hunks;
    }

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
            if (!requesting) return 'focused-elsewhere';

            if (workspaceId === null) {
                return assignWorkspace(requesting, null) ? 'took' : 'focused-elsewhere';
            }

            // A dropdown rendered before another window deleted this workspace
            // still lists it, and clicking it would put an id nothing can
            // resume into the registry — which saveWindowLayout then writes out.
            // 'focused-elsewhere' is already the renderer's "you did not get it,
            // change nothing" path, so no renderer knows this case exists.
            if (!workspaces.getAll().some((workspace) => workspace.id === workspaceId)) {
                return 'focused-elsewhere';
            }

            const holder = findWindowForWorkspace(workspaceId);
            if (holder && holder !== requesting) {
                if (holder.isMinimized()) holder.restore();
                holder.focus();
                return 'focused-elsewhere';
            }

            return assignWorkspace(requesting, workspaceId) ? 'took' : 'focused-elsewhere';
        }
    );

    ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN, (_event, workspaceId: string | null) => {
        if (workspaceId) {
            focusOrCreate(workspaceId);
        } else {
            createWindow();
        }
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_SET_ACTIVE_SESSION, (event, sessionId: string | null) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) setActiveSession(window, sessionId);
    });

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

export function cleanupIpcHandlers(): void {
    workspaceService = null;
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_IMPORT);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_DELETE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SESSION_DELETE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_ADD_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_SCOPE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE);

    harnessService = null;
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_GET_SNAPSHOT);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_IMPORT);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_ADD);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_UPDATE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_ARCHIVE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_RESTORE);

    githubService?.stop();
    githubService = null;
    worktreeService = null;
    if (onBrowserWindowFocus) {
        app.removeListener('browser-window-focus', onBrowserWindowFocus);
        onBrowserWindowFocus = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_GET_INBOX);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_REFRESH_INBOX);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_RESOLVE_REPOS);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_CLONE_REPO);

    // Clean up all terminal services
    terminalManager?.destroyAll();
    terminalManager = null;

    // Remove terminal IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_PASTE);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESTART);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_DESTROY);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CREATE);
    ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_STATUS_SNAPSHOT);

    // Remove Claude CLI query handlers
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_PROBE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_SESSION_NAME);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_CAPABILITIES);

    // Remove GitHub query handlers
    ipcMain.removeHandler(IPC_CHANNELS.GH_PROBE);

    // Remove dialog IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDER);

    // Remove file IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.FILE_READ);
    ipcMain.removeHandler(IPC_CHANNELS.FILE_LIST_DIRECTORY);

    // Remove git IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_STATUS);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_DIFF);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_STAGE_FILE);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_UNSTAGE_FILE);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_COMMIT);
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_STAGED_DIFF);
    ipcMain.removeHandler(IPC_CHANNELS.GENERATE_COMMIT_MESSAGE);

    // Remove window identity IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.WINDOW_ACTIVATE_WORKSPACE);
    ipcMain.removeHandler(IPC_CHANNELS.WINDOW_OPEN);
    ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_SET_ACTIVE_SESSION);
}
