import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TerminalManager } from './TerminalManager';
import { runHeadless } from './drivers/ClaudeDriver';
import { getDriver, toHarnessConfig } from './drivers';
import { TerminalCreateOptions, HarnessLaunchFields } from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';
import { JsonStateFile } from './state/JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './state/WorkspaceService';
import type { NewSessionFields, Session, Workspace } from '../shared/workspace';

// One terminal per session tab, kept alive while the session is open
let terminalManager: TerminalManager | null = null;

// The single writer for workspaces and sessions, shared by every window
let workspaceService: WorkspaceService | null = null;

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
    const workspaceFile = new JsonStateFile<WorkspaceStateFile>(
        path.join(app.getPath('userData'), 'workspaces.json')
    );
    const workspaces = new WorkspaceService(workspaceFile);
    workspaces.load();
    workspaceService = workspaces;

    // Every window renders the same records, so a change goes to all of them
    // rather than to whoever asked for it.
    workspaces.onChange((all) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.WORKSPACE_CHANGED, all);
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
            // Whitelisted rather than passed through: `Partial<Pick<...>>` is a
            // compile-time contract only, and an extra key from a stale or
            // untrusted renderer would be absorbed by the service's `{ ...ws,
            // ...updates }` spread with no runtime check.
            const allowed: Partial<Pick<Workspace, 'name' | 'defaultHarnessId'>> = {};
            if ('name' in updates) allowed.name = updates.name;
            if ('defaultHarnessId' in updates) allowed.defaultHarnessId = updates.defaultHarnessId;
            workspaces.updateWorkspace(id, allowed);
        }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, id: string) =>
        workspaces.deleteWorkspace(id)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_CREATE,
        (_event, workspaceId: string, fields: NewSessionFields) =>
            workspaces.createSession(workspaceId, fields)
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_UPDATE,
        (
            _event,
            workspaceId: string,
            sessionId: string,
            updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
        ) => {
            // Whitelisted rather than passed through: `harnessId` is deliberately
            // excluded. A session's harness is fixed for its lifetime — the
            // transcript lives inside that harness's config directory, and
            // `--resume` only finds it there, so accepting a rewritten
            // `harnessId` from the IPC payload would silently orphan the
            // conversation. `Partial<Pick<...>>` only enforces this at compile
            // time; a stale or untrusted caller could still send the key.
            const allowed: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>> = {};
            if ('name' in updates) allowed.name = updates.name;
            if ('lastActiveAt' in updates) allowed.lastActiveAt = updates.lastActiveAt;
            if ('hasStarted' in updates) allowed.hasStarted = updates.hasStarted;
            workspaces.updateSession(workspaceId, sessionId, allowed);
        }
    );

    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_DELETE,
        (_event, workspaceId: string, sessionId: string) =>
            workspaces.deleteSession(workspaceId, sessionId)
    );

    terminalManager = new TerminalManager(mainWindow);
    const manager = terminalManager;

    // Start or attach to a session's terminal. Returns buffered output so a
    // remounted view repaints without restarting the conversation.
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, (_event, options: TerminalCreateOptions) => {
        const {
            instanceId,
            cwd,
            claudeSessionId,
            resume,
            cols,
            rows,
            initialPrompt,
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
        } = options;
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
            // Absent for the built-in harness, which launches exactly as
            // Consola did before harnesses existed.
            driverId,
            binaryOverride,
            configDirOverride,
            extraArgs,
        });
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

    // Remove Claude CLI query handlers
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_PROBE);
    ipcMain.removeHandler(IPC_CHANNELS.HARNESS_SESSION_NAME);

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
}
