import { BrowserWindow } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';
    const isTest = process.env.NODE_ENV === 'test';

    mainWindow = new BrowserWindow({
        title: 'Consola',
        width: 1000,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 10, y: 10 },
        // A test run launches the app once per test and retries failures, so a
        // visible window means a dozen of them stealing focus. The renderer still
        // runs and Playwright still drives it over CDP; it is simply never mapped.
        show: !isTest,
        webPreferences: {
            preload: path.join(__dirname, '../../../dist/preload/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Chromium throttles timers in a window it considers non-visible,
            // which would stretch the suite's waits into flakiness.
            backgroundThrottling: !isTest,
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
