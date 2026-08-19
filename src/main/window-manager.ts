import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import type { WindowContext } from '../shared/types';
import { JsonStateFile } from './state/JsonStateFile';

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

export function createWindow(
    context: WindowContext = EMPTY_CONTEXT,
    bounds?: Electron.Rectangle
): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';
    const isTest = process.env.NODE_ENV === 'test';

    const window = new BrowserWindow({
        title: 'Consola',
        width: bounds?.width ?? 1000,
        height: bounds?.height ?? 700,
        ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
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

/**
 * Point a window at a workspace, or back it out to none.
 *
 * Returns whether the assignment actually happened. A caller that ignored
 * this — treating a silent no-op the same as success — would tell a renderer
 * it holds a workspace that main has no record of: exactly the two windows,
 * one workspace failure this registry exists to prevent. So `false` has to
 * propagate all the way back to the renderer as "you did not get it".
 */
export function assignWorkspace(window: BrowserWindow, workspaceId: string | null): boolean {
    // Guard against a caller racing a window's own close: webContents.id
    // throws once it's destroyed, and there is nothing useful left to assign.
    if (window.isDestroyed()) return false;
    // Switching workspaces drops the session with it: an id from the old
    // workspace would name a session this window is no longer showing.
    contexts.set(window.webContents.id, { workspaceId, activeSessionId: null });
    return true;
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

interface WindowLayoutFile {
    windows: Array<WindowContext & { bounds: Electron.Rectangle }>;
}

function layoutFile(): JsonStateFile<WindowLayoutFile> {
    return new JsonStateFile<WindowLayoutFile>(path.join(app.getPath('userData'), 'windows.json'));
}

export function saveWindowLayout(): void {
    const windows = listContexts();
    if (windows.length === 0) return;
    layoutFile().write({ windows });
}

/**
 * Keep only the first entry for each non-null workspace id.
 *
 * A hand-edited or otherwise corrupted layout file could name the same
 * workspace twice. Restoring both entries as-is would open two windows on one
 * workspace before either had a chance to call assignWorkspace — the very
 * failure `contexts` exists to prevent, just reached at startup instead of
 * through a race. Entries with no workspace are left alone: several windows
 * sitting on Home is normal, not corruption.
 */
export function dedupeByWorkspace<T extends { workspaceId: string | null }>(entries: T[]): T[] {
    const seen = new Set<string>();
    return entries.filter((entry) => {
        if (entry.workspaceId === null) return true;
        if (seen.has(entry.workspaceId)) return false;
        seen.add(entry.workspaceId);
        return true;
    });
}

/**
 * Reopen the windows from last launch, or one empty window on a first run.
 *
 * A saved workspace that has since been deleted opens on Home rather than
 * failing: a window must never hold an id that names nothing.
 */
export function restoreWindowLayout(knownWorkspaceIds: Set<string>): void {
    let stored: WindowLayoutFile | null = null;
    try {
        stored = layoutFile().read();
    } catch {
        // A layout we cannot read is worth nothing; a fresh window costs a click.
        stored = null;
    }

    const windows = stored?.windows ?? [];
    if (windows.length === 0) {
        createWindow();
        return;
    }

    // Resolve dead workspace ids to Home first, then dedupe: two entries that
    // both point at a since-deleted workspace are two ordinary Home windows,
    // not a duplicate worth collapsing.
    const resolved = windows.map((entry) => {
        const workspaceId =
            entry.workspaceId && knownWorkspaceIds.has(entry.workspaceId) ? entry.workspaceId : null;
        return {
            workspaceId,
            activeSessionId: workspaceId ? entry.activeSessionId : null,
            bounds: entry.bounds,
        };
    });

    for (const entry of dedupeByWorkspace(resolved)) {
        createWindow({ workspaceId: entry.workspaceId, activeSessionId: entry.activeSessionId }, entry.bounds);
    }
}
