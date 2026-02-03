import { BrowserWindow } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        webPreferences: {
            preload: path.join(__dirname, '../../../dist/preload/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}
