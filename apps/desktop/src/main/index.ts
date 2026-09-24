import { BrowserWindow, Menu, MenuItem, app } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import { setupAppUpdates } from './appUpdates';
import { isBackgroundTest } from './test-mode';
import {
    contextToReopen,
    createWindow,
    getAnyWindow,
    restoreWindowLayout,
    saveWindowLayout,
} from './window-manager';
import {
    setupIpcHandlers,
    cleanupIpcHandlers,
    getKnownWorkspaceIds,
    viewMemoryPort,
} from './ipc-handlers';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
    if (require('electron-squirrel-startup')) {
        app.quit();
    }
} catch {
    // electron-squirrel-startup not installed, skip
}

app.setName('Consola');

// Hiding the Dock after ready is too late to prevent launch activation.
// Hidden renderers remain available to Playwright without activating macOS.
if (isBackgroundTest && process.platform === 'darwin') {
    app.setActivationPolicy('prohibited');
}

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
        const existingWindow = getAnyWindow();
        if (!existingWindow) return;
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.focus();
    });
}

let cleanupAppUpdates: (() => void) | undefined;

app.whenReady().then(() => {
    // Handlers are registered once for the process, not once per window: they
    // are ipcMain-global, and a second registration throws.
    //
    // A false return means a state file was unreadable and loadOrExit already
    // showed the error dialog and called app.exit(1) — exit() doesn't halt the
    // rest of this synchronous tick, so without this guard a window would still
    // open on top of an app that's already tearing itself down.
    if (!setupIpcHandlers()) return;
    const appUpdates = setupAppUpdates();
    cleanupAppUpdates = appUpdates.dispose;
    // getKnownWorkspaceIds() has to run after setupIpcHandlers() returned true:
    // that's the call that loads workspaceService, and before it every saved
    // workspace id would look dead and every window would fall back to Home.
    restoreWindowLayout(getKnownWorkspaceIds(), viewMemoryPort());

    if (process.platform === 'darwin') {
        const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([
            { role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' },
            { role: 'viewMenu' }, { role: 'windowMenu' },
        ]);
        const applicationMenu = menu.items[0]?.submenu;
        if (applicationMenu) {
            const showSettings = (section?: 'updates') => {
                const existing = BrowserWindow.getFocusedWindow() ?? getAnyWindow();
                const target = existing ?? createWindow(contextToReopen(getKnownWorkspaceIds(), viewMemoryPort()));
                const openSettings = () => target.webContents.send(IPC_CHANNELS.WINDOW_OPEN_SETTINGS, section);
                if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', openSettings);
                else openSettings();
                if (target.isMinimized()) target.restore();
                if (!isBackgroundTest) { target.show(); target.focus(); }
            };
            applicationMenu.insert(1, new MenuItem({
                id: 'check-for-updates',
                label: 'Check for Updates…',
                click: () => {
                    showSettings('updates');
                    void appUpdates.check();
                },
            }));
            applicationMenu.insert(3, new MenuItem({
                id: 'application-settings',
                label: 'Settings…',
                accelerator: 'Command+,',
                click: () => showSettings(),
            }));
            applicationMenu.insert(4, new MenuItem({ type: 'separator' }));
            Menu.setApplicationMenu(menu);
        }
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            // Reopen where the user left off, not on an empty Home. The window
            // registry was emptied as each window closed and the layout file is
            // only written at quit, so the last workspace a window held is all
            // that survives — and it is the affordance that makes "the sessions
            // are still running" visible rather than merely true.
            createWindow(contextToReopen(getKnownWorkspaceIds(), viewMemoryPort()));
        }
    });
});

app.on('window-all-closed', () => {
    // Deliberately does not tear anything down on macOS. Closing a window is
    // closing a view; the PTYs keep running and the dock icon reopens one.
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    try {
        // Read the layout while the windows still exist — by the time cleanup
        // runs they are gone and there is nothing left to record.
        saveWindowLayout();
    } catch {
        // Losing the window positions is a small cost. Throwing out of this
        // listener would skip cleanupIpcHandlers() entirely, including
        // destroyAll(), and give up the one chance at a graceful shutdown.
    }
    cleanupIpcHandlers();
    cleanupAppUpdates?.();
});
