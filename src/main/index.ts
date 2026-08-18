import { app } from 'electron';
import { createMainWindow, getMainWindow } from './window-manager';
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

// Only the installed app gets the plain profile. Sharing userData with it would
// share the persisted workspaces and session list, so a dev or test launch would
// resume Claude sessions that are already live in the daily driver — and two
// Chromium processes on one profile directory corrupt localStorage between them.
// `scripts/dev-electron.cjs` sets development; tests/e2e/helpers/electron.ts sets
// test, which otherwise runs the suite against real workspaces.
const PROFILE_SUFFIX: Record<string, string> = { development: ' Dev', test: ' Test' };
const profileSuffix = PROFILE_SUFFIX[process.env.NODE_ENV ?? ''];
if (profileSuffix) {
    app.setPath('userData', `${app.getPath('userData')}${profileSuffix}`);
}

// The lock is scoped to the userData directory, so it can only be taken once
// that directory is settled -- ask any earlier and a dev launch would claim the
// installed app's lock and then quit itself. Within one profile, a second
// launch hands focus to the window that already exists rather than opening a
// rival process on top of the same workspaces and localStorage.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const existingWindow = getMainWindow();
        if (!existingWindow) return;
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.focus();
    });
}

app.whenReady().then(() => {
    // The hidden test window still registers an app that bounces in the Dock and
    // takes focus on launch. Tests need neither.
    if (process.env.NODE_ENV === 'test') {
        app.dock?.hide();
    }

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
