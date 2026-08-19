import { BrowserWindow } from 'electron';
import * as path from 'path';
import type { WindowContext } from '../shared/types';

/**
 * The open windows, and which workspace each one holds.
 *
 * A workspace lives in at most one window. That rule is enforced here rather
 * than in a renderer because two windows could otherwise claim the same
 * workspace in the same tick, and the loser would render a second live view of
 * a PTY that only expects one.
 */
const contexts = new Map<number, WindowContext>();

const EMPTY_CONTEXT: WindowContext = { workspaceId: null, activeSessionId: null };

export function createWindow(context: WindowContext = EMPTY_CONTEXT): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';
    const isTest = process.env.NODE_ENV === 'test';

    const window = new BrowserWindow({
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
            // The renderer needs its workspace before the first paint, and an
            // IPC round trip would cost a frame of empty shell.
            additionalArguments: [`--consola-window=${JSON.stringify(context)}`],
        },
    });

    // Captured now, not in the handler: by the time 'closed' fires Electron has
    // destroyed webContents, and reading .id off it throws — silently, because
    // native event dispatch swallows it. The entry would leak forever.
    const windowId = window.webContents.id;
    contexts.set(windowId, { ...context });

    if (isDev) {
        window.loadURL('http://localhost:5173');
        window.webContents.openDevTools();
    } else {
        window.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    }

    window.on('closed', () => {
        // Only the view is forgotten. The PTYs this window was rendering keep
        // running, and reattach to whichever window opens the workspace next.
        contexts.delete(windowId);
    });

    return window;
}

export function getContextFor(window: BrowserWindow): WindowContext | undefined {
    // A caller can be holding a reference past the point the window closed;
    // webContents.id throws on a destroyed window, so check before reading it.
    if (window.isDestroyed()) return undefined;
    return contexts.get(window.webContents.id);
}

export function findWindowForWorkspace(workspaceId: string): BrowserWindow | null {
    for (const window of BrowserWindow.getAllWindows()) {
        if (contexts.get(window.webContents.id)?.workspaceId === workspaceId) {
            return window;
        }
    }
    return null;
}

export function assignWorkspace(window: BrowserWindow, workspaceId: string | null): void {
    // Guard against a caller racing a window's own close: webContents.id
    // throws once it's destroyed, and there is nothing useful left to assign.
    if (window.isDestroyed()) return;
    // Switching workspaces drops the session with it: an id from the old
    // workspace would name a session this window is no longer showing.
    contexts.set(window.webContents.id, { workspaceId, activeSessionId: null });
}

export function setActiveSession(window: BrowserWindow, sessionId: string | null): void {
    if (window.isDestroyed()) return;
    const existing = contexts.get(window.webContents.id);
    if (!existing) return;
    contexts.set(window.webContents.id, { ...existing, activeSessionId: sessionId });
}

/** Focus the window already holding a workspace, or open one for it. */
export function focusOrCreate(workspaceId: string): BrowserWindow {
    const existing = findWindowForWorkspace(workspaceId);
    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return existing;
    }
    return createWindow({ workspaceId, activeSessionId: null });
}

export function getAnyWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
}

/** Every open window's context and geometry, for restoring on next launch. */
export function listContexts(): Array<WindowContext & { bounds: Electron.Rectangle }> {
    return BrowserWindow.getAllWindows()
        .map((window) => {
            const context = contexts.get(window.webContents.id);
            return context ? { ...context, bounds: window.getBounds() } : null;
        })
        .filter((entry): entry is WindowContext & { bounds: Electron.Rectangle } => entry !== null);
}
