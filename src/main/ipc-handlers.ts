import { ipcMain, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { TerminalService } from './TerminalService';
import { ClaudeAgentService } from './ClaudeAgentService';
import { TerminalMode, AgentQueryOptions } from '../shared/types';
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
        const { instanceId, cwd, ...queryOptions } = options;
        const workingDir = cwd || process.cwd();

        try {
            const service = getOrCreateAgentService(instanceId, workingDir);
            // Update cwd if it changed
            service.setCwd(workingDir);
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

    // Handle folder picker dialog
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

    // Handle file read
    ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content;
        } catch (error) {
            throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
        }
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
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_GET_STATUS);

    // Remove dialog IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);

    // Remove file IPC handlers
    ipcMain.removeHandler(IPC_CHANNELS.FILE_READ);
}
