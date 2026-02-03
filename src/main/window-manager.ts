import { BrowserWindow, app } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 400,
        minHeight: 300,
        backgroundColor: '#1e1e1e',
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, '../../preload/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // Required for node-pty
        },
    });

    // Load the renderer HTML from source (HTML not compiled by tsc)
    mainWindow.loadFile(path.join(__dirname, '../../../src/renderer/index.html'));

    // Open DevTools in development
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}
