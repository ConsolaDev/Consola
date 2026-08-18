import { app } from 'electron';
import { createMainWindow } from './window-manager';
import { setupIpcHandlers, cleanupIpcHandlers } from './ipc-handlers';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
    if (require('electron-squirrel-startup')) {
        app.quit();
    }
} catch {
    // electron-squirrel-startup not installed, skip
}

app.setName('Consola');

// A dev instance gets its own profile. Sharing userData with a stable instance
// would share the persisted workspaces and session list, so a dev launch would
// resume Claude sessions that are already live in the daily driver — and two
// Chromium processes on one profile directory corrupt localStorage.
// `scripts/dev-electron.cjs` is what sets NODE_ENV.
if (process.env.NODE_ENV === 'development') {
    app.setPath('userData', `${app.getPath('userData')} Dev`);
}

app.whenReady().then(() => {
    const mainWindow = createMainWindow();
    setupIpcHandlers(mainWindow);

    app.on('activate', () => {
        // On macOS, re-create a window when dock icon is clicked
        if (require('electron').BrowserWindow.getAllWindows().length === 0) {
            const newWindow = createMainWindow();
            setupIpcHandlers(newWindow);
        }
    });
});

app.on('window-all-closed', () => {
    cleanupIpcHandlers();
    // On macOS, apps typically stay active until Cmd+Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanupIpcHandlers();
});
