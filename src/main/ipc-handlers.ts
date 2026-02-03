import { ipcMain, BrowserWindow } from 'electron';
import { TerminalService } from './TerminalService';
import { ClaudeAgentService } from './ClaudeAgentService';
import { TerminalMode, AgentQueryOptions } from '../shared/types';
import { IPC_CHANNELS, DEFAULT_INSTANCE_ID } from '../shared/constants';

// Map to support future multi-instance terminals
const terminalServices: Map<string, TerminalService> = new Map();

// Claude Agent service instance
let agentService: ClaudeAgentService | null = null;

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
    // Create default terminal service
    const terminalService = new TerminalService();
    terminalServices.set(DEFAULT_INSTANCE_ID, terminalService);

    // Create Claude Agent service
    agentService = new ClaudeAgentService(process.cwd());

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

    // === Claude Agent Service Event Forwarding ===

    // Forward agent init to renderer
    agentService.on('init', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_INIT, data);
        }
    });

    // Forward assistant messages to renderer
    agentService.on('assistant-message', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_ASSISTANT_MESSAGE, data);
        }
    });

    // Forward stream events to renderer
    agentService.on('stream', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM, data);
        }
    });

    // Forward tool pending events to renderer
    agentService.on('tool-pending', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_TOOL_PENDING, data);
        }
    });

    // Forward tool complete events to renderer
    agentService.on('tool-complete', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_TOOL_COMPLETE, data);
        }
    });

    // Forward result events to renderer
    agentService.on('result', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_RESULT, data);
        }
    });

    // Forward errors to renderer
    agentService.on('error', (error: Error) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_ERROR, {
                message: error.message
            });
        }
    });

    // Forward status changes to renderer
    agentService.on('status-changed', (status) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_CHANGED, status);
        }
    });

    // Forward notifications to renderer
    agentService.on('notification', (data) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_NOTIFICATION, data);
        }
    });

    // Forward raw messages to renderer
    agentService.on('message', (message) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_MESSAGE, message);
        }
    });

    // === Claude Agent Service Command Handlers ===

    // Handle agent start from renderer
    ipcMain.on(IPC_CHANNELS.AGENT_START, async (_event, options: AgentQueryOptions) => {
        try {
            await agentService?.startQuery(options);
        } catch (error) {
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send(IPC_CHANNELS.AGENT_ERROR, {
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }
    });

    // Handle agent interrupt from renderer
    ipcMain.on(IPC_CHANNELS.AGENT_INTERRUPT, () => {
        agentService?.interrupt();
    });

    // Handle agent status request from renderer
    ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, () => {
        return agentService?.getStatus() ?? {
            isRunning: false,
            sessionId: null,
            model: null,
            permissionMode: null
        };
    });
}

export function cleanupIpcHandlers(): void {
    // Clean up all terminal services
    for (const [id, service] of terminalServices) {
        service.destroy();
        terminalServices.delete(id);
    }

    // Clean up agent service
    if (agentService) {
        agentService.destroy();
        agentService = null;
    }

    // Remove terminal IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.MODE_SWITCH);

    // Remove agent IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_START);
    ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_INTERRUPT);
    ipcMain.removeHandler(IPC_CHANNELS.AGENT_GET_STATUS);
}
