import { app } from 'electron';
import { createMainWindow } from './window-manager';
import { setupIpcHandlers, cleanupIpcHandlers } from './ipc-handlers';
import { closeSessionDatabase } from './database/SessionDatabase';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
    if (require('electron-squirrel-startup')) {
        app.quit();
    }
} catch {
    // electron-squirrel-startup not installed, skip
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
    closeSessionDatabase();
});
