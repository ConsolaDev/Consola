import { ipcMain, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TerminalService } from './TerminalService';
import { ClaudeAgentService } from './ClaudeAgentService';
import { saveSessionData, loadSessionData, deleteSessionData } from './SessionStorageService';
import { generateSessionName } from './SessionNameGenerator';
import { TerminalMode, AgentQueryOptions, AgentInputResponse, TrustModeChangeRequest } from '../shared/types';
import { IPC_CHANNELS, DEFAULT_INSTANCE_ID } from '../shared/constants';

// Map to support future multi-instance terminals
const terminalServices: Map<string, TerminalService> = new Map();

// Map for multi-instance Claude Agent services
const agentServices: Map<string, ClaudeAgentService> = new Map();

// Reference to main window for event forwarding
let mainWindowRef: BrowserWindow | null = null;

// Helper to get or create an agent service for a given instanceId
function getOrCreateAgentService(instanceId: string, cwd: string): ClaudeAgentService {
    let service = agentServices.get(instanceId);
    if (!service) {
        service = new ClaudeAgentService(cwd);
        agentServices.set(instanceId, service);
        wireAgentServiceEvents(instanceId, service);
    }
    return service;
}

// Wire up event forwarding for an agent service instance
function wireAgentServiceEvents(instanceId: string, service: ClaudeAgentService): void {
    if (!mainWindowRef) return;
    const mainWindow = mainWindowRef;

    service.on('init', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_INIT, { instanceId, ...data });
        }
    });

    service.on('assistant-message', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_ASSISTANT_MESSAGE, { instanceId, ...data });
        }
    });

    service.on('stream', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM, { instanceId, ...data });
        }
    });

    service.on('tool-pending', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_TOOL_PENDING, { instanceId, ...data });
        }
    });

    service.on('tool-complete', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_TOOL_COMPLETE, { instanceId, ...data });
        }
    });

    service.on('result', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_RESULT, { instanceId, ...data });
        }
    });

    service.on('error', (error: Error) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_ERROR, {
                instanceId,
                message: error.message
            });
        }
    });

    service.on('status-changed', (status) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_CHANGED, { instanceId, ...status });
        }
    });

    service.on('notification', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_NOTIFICATION, { instanceId, ...data });
        }
    });

    service.on('message', (message) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_MESSAGE, { instanceId, message });
        }
    });

    service.on('input-request', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_INPUT_REQUEST, { instanceId, ...data });
        }
    });

    service.on('session-end', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_SESSION_END, { instanceId, ...data });
        }
    });

    service.on('session-start', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_SESSION_START, { instanceId, ...data });
        }
    });

    service.on('trust-mode-changed', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_TRUST_MODE_CHANGED, { instanceId, ...data });
        }
    });
}

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
    mainWindowRef = mainWindow;

    // Create default terminal service
    const terminalService = new TerminalService();
    terminalServices.set(DEFAULT_INSTANCE_ID, terminalService);

    // Forward terminal data to renderer
    terminalService.on('data', (data: string) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.TERMINAL_DATA, data);
        }
    });

    // Forward mode changes to renderer
    terminalService.on('mode-changed', (mode: TerminalMode) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.MODE_CHANGED, mode);
        }
    });

    // Handle terminal exit
    terminalService.on('exit', () => {
        // When shell exits, close the app
        mainWindow.close();
    });

    // Start the terminal
    terminalService.start();

    // Handle input from renderer
    ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_event, data: string) => {
        terminalService.write(data);
    });

    // Handle resize from renderer
    ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_event, cols: number, rows: number) => {
        terminalService.resize(cols, rows);
    });

    // Handle mode switch from renderer
    ipcMain.on(IPC_CHANNELS.MODE_SWITCH, (_event, mode: TerminalMode) => {
        terminalService.switchMode(mode);
    });

    // === Claude Agent Service Command Handlers ===

    // Handle agent start from renderer
    ipcMain.on(IPC_CHANNELS.AGENT_START, async (_event, options: AgentQueryOptions) => {
        const { instanceId, cwd, additionalDirectories, ...queryOptions } = options;
        const workingDir = cwd || process.cwd();

        try {
            const service = getOrCreateAgentService(instanceId, workingDir);
            // Update cwd if it changed
            service.setCwd(workingDir);
            service.setAdditionalDirectories(additionalDirectories ?? []);
            await service.startQuery(queryOptions);
        } catch (error) {
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send(IPC_CHANNELS.AGENT_ERROR, {
                    instanceId,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }
    });

    // Handle agent interrupt from renderer
    ipcMain.on(IPC_CHANNELS.AGENT_INTERRUPT, (_event, instanceId: string) => {
        const service = agentServices.get(instanceId);
        service?.interrupt();
    });

    // Handle agent status request from renderer
    ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, (_event, instanceId: string) => {
        const service = agentServices.get(instanceId);
        return service?.getStatus() ?? {
            isRunning: false,
            sessionId: null,
            model: null,
            permissionMode: null
        };
    });

    // Handle agent instance destruction
    ipcMain.on(IPC_CHANNELS.AGENT_DESTROY_INSTANCE, (_event, instanceId: string) => {
        const service = agentServices.get(instanceId);
        if (service) {
            service.destroy();
            agentServices.delete(instanceId);
        }
    });

    // Handle user response to input/permission request
    ipcMain.on(IPC_CHANNELS.AGENT_INPUT_RESPONSE, (_event, response: AgentInputResponse) => {
        const service = agentServices.get(response.instanceId);
        if (service) {
            service.respondToPermission(response.requestId, response.action, {
                modifiedInput: response.modifiedInput,
                feedback: response.feedback,
                answers: response.answers
            });
        }
    });

    // Handle session initialization (pre-load skills/commands)
    ipcMain.handle(IPC_CHANNELS.AGENT_INITIALIZE, async (_event, { instanceId, cwd }: { instanceId: string; cwd: string }) => {
        const service = getOrCreateAgentService(instanceId, cwd);
        return service.initializeSession();
    });

    // Handle trust mode change (accept all for session)
    ipcMain.on(IPC_CHANNELS.AGENT_SET_TRUST_MODE, (_event, request: TrustModeChangeRequest) => {
        const service = agentServices.get(request.instanceId);
        if (service) {
            service.setTrustMode(request.mode);
        }
    });

    // Handle trust mode status request
    ipcMain.handle('agent:get-trust-mode', (_event, instanceId: string) => {
        const service = agentServices.get(instanceId);
        return service?.getTrustMode() ?? { mode: 'off' };
    });

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

    // === Session Storage Handlers ===

    ipcMain.handle('session:save-history', async (_event, { sessionId, data }) => {
        await saveSessionData(sessionId, data);
    });

    ipcMain.handle('session:load-history', async (_event, { sessionId }) => {
        return await loadSessionData(sessionId);
    });

    ipcMain.handle('session:delete-history', async (_event, { sessionId }) => {
        await deleteSessionData(sessionId);
    });

    ipcMain.handle(IPC_CHANNELS.SESSION_GENERATE_NAME, async (_event, { query }) => {
        const name = await generateSessionName(query);
        return { name };
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
                        const lines = statusStdout.trim().split('\n').filter(Boolean);
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
    ipcMain.handle(IPC_CHANNELS.AGENT_GENERATE_COMMIT_MESSAGE, async (_event, { rootPath, instanceId }: { rootPath: string; instanceId: string }) => {
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

        // Use the agent service to generate the message (getOrCreateAgentService
        // lazily creates the service if it doesn't exist yet, e.g. when the user
        // generates a commit message before sending any chat messages).
        const service = getOrCreateAgentService(instanceId, rootPath);

        try {
            const message = await service.generateCommitMessage(prompt);
            return { message };
        } catch (error) {
            return { message: '', error: error instanceof Error ? error.message : String(error) };
        }
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
    // Clean up all terminal services
    for (const [id, service] of terminalServices) {
        service.destroy();
        terminalServices.delete(id);
    }

    // Clean up all agent services
    for (const [id, service] of agentServices) {
        service.destroy();
        agentServices.delete(id);
    }

    mainWindowRef = null;

    // Remove terminal IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.MODE_SWITCH);

    // Remove agent IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_START);
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_INTERRUPT);
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_DESTROY_INSTANCE);
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_INPUT_RESPONSE);
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_SET_TRUST_MODE);
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_GET_STATUS);
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_INITIALIZE);
    ipcMain.removeHandler('agent:get-trust-mode');

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
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_GENERATE_COMMIT_MESSAGE);

    // Remove session storage handlers
    ipcMain.removeHandler('session:save-history');
    ipcMain.removeHandler('session:load-history');
    ipcMain.removeHandler('session:delete-history');
    ipcMain.removeHandler(IPC_CHANNELS.SESSION_GENERATE_NAME);
}
