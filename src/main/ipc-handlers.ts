import { ipcMain, BrowserWindow } from 'electron';
import { TerminalService } from './TerminalService';
import { TerminalMode } from '../shared/types';
import { IPC_CHANNELS, DEFAULT_INSTANCE_ID } from '../shared/constants';

// Map to support future multi-instance terminals
const terminalServices: Map<string, TerminalService> = new Map();

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
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
}

export function cleanupIpcHandlers(): void {
    // Clean up all terminal services
    for (const [id, service] of terminalServices) {
        service.destroy();
        terminalServices.delete(id);
    }

    // Remove IPC listeners
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_INPUT);
    ipcMain.removeAllListeners(IPC_CHANNELS.TERMINAL_RESIZE);
    ipcMain.removeAllListeners(IPC_CHANNELS.MODE_SWITCH);
}
