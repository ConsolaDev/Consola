import { ipcMain, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TerminalService } from './TerminalService';
import { ClaudeAgentService } from './ClaudeAgentService';
import { saveSessionData, loadSessionData, deleteSessionData } from './SessionStorageService';
import { generateSessionName } from './SessionNameGenerator';
import { TerminalMode, AgentQueryOptions, AgentInputResponse } from '../shared/types';
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
                exec('git status --porcelain', { cwd: rootPath }, (statusErr, statusStdout) => {
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
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_GET_STATUS);
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_INITIALIZE);

    // Remove dialog IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDER);

    // Remove file IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.FILE_READ);
    ipcMain.removeHandler(IPC_CHANNELS.FILE_LIST_DIRECTORY);

    // Remove git IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.GIT_GET_STATUS);

    // Remove session storage handlers
    ipcMain.removeHandler('session:save-history');
    ipcMain.removeHandler('session:load-history');
    ipcMain.removeHandler('session:delete-history');
    ipcMain.removeHandler(IPC_CHANNELS.SESSION_GENERATE_NAME);
}
