import { BrowserWindow, app, screen, shell } from 'electron';
import * as path from 'path';
import type { WindowContext, WorkspaceView } from '../shared/types';
import { JsonStateFile } from './state/JsonStateFile';
import { IPC_CHANNELS } from '../shared/constants';

/**
 * The open windows, and which workspace each one holds.
 *
 * A workspace lives in at most one window. That rule is enforced here rather
 * than in a renderer because two windows could otherwise claim the same
 * workspace in the same tick, and the loser would render a second live view of
 * a PTY that only expects one.
 *
 * Only the workspace is tracked. What that workspace is *showing* is keyed by
 * workspace, not by window, and lives in the view memory this module is handed
 * — keeping a second copy here would be one fact recorded twice, on two
 * schedules, free to disagree.
 */
const contexts = new Map<number, { workspaceId: string | null }>();

const EMPTY_CONTEXT: WindowContext = {
    workspaceId: null,
    activeSessionId: null,
    isInboxOpen: false,
};

/**
 * The view memory, as this module needs it.
 *
 * A port rather than the service itself, for the same reason
 * `restoreWindowLayout` takes a set of ids rather than reaching for
 * WorkspaceService: this file stays free of the record shapes, and every
 * function below can be exercised with a plain object.
 */
export interface ViewMemoryAccess {
    get(workspaceId: string): WorkspaceView;
    set(workspaceId: string, view: WorkspaceView): void;
}

/**
 * The workspace the last window to hold one was showing when it closed.
 *
 * `contexts` is emptied as each window closes, so on macOS — where closing
 * every window leaves the app and its PTYs running — this is the only
 * surviving record of where the user was. Without it the dock icon reopens an
 * empty Home window and the sessions that are still running become invisible.
 * What that workspace was showing does not need remembering here: the view
 * memory is keyed by workspace and outlives the window.
 */
let lastHeldWorkspaceId: string | null = null;

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

    // "Open on GitHub" and every other external link leaves the app: the OS
    // browser gets the URL and no second Electron window ever opens.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://') || url.startsWith('http://')) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Captured now, not in the handler: by the time 'closed' fires Electron has
    // destroyed webContents, and reading .id off it throws — silently, because
    // native event dispatch swallows it. The entry would leak forever.
    const windowId = window.webContents.id;
    contexts.set(windowId, { workspaceId: context.workspaceId });

    if (isDev) {
        window.loadURL('http://localhost:5173');
        window.webContents.openDevTools();
    } else {
        window.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    }

    window.on('closed', () => {
        // Only the view is forgotten. The PTYs this window was rendering keep
        // running, and reattach to whichever window opens the workspace next.
        const closing = contexts.get(windowId);
        // A Home window is worth nothing to remember: reopening into one is
        // already what happens with nothing remembered at all.
        if (closing?.workspaceId) lastHeldWorkspaceId = closing.workspaceId;
        contexts.delete(windowId);
    });

    return window;
}

/** Which workspace a window holds, or undefined if it is not in the registry. */
export function getWorkspaceFor(window: BrowserWindow): string | null | undefined {
    // A caller can be holding a reference past the point the window closed;
    // webContents.id throws on a destroyed window, so check before reading it.
    if (window.isDestroyed()) return undefined;
    return contexts.get(window.webContents.id)?.workspaceId;
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
    // No session to clear alongside it: the registry tracks the workspace and
    // nothing else, and what each workspace shows is remembered per workspace.
    contexts.set(window.webContents.id, { workspaceId });
    return true;
}

/**
 * Focus the window already holding a workspace, or open one for it.
 *
 * `forcedSessionId` names a session to land on regardless of what the
 * workspace was showing — how a notification click reaches the right pane.
 * It is written into the memory as well as applied, because a click is a
 * choice: it is where the user now wants to be when they next come back.
 * Without one, the remembered view is read and never written; merely opening
 * a window is navigation, not a new decision.
 */
export function focusOrCreate(
    workspaceId: string,
    viewMemory: ViewMemoryAccess,
    forcedSessionId?: string
): BrowserWindow {
    let view = viewMemory.get(workspaceId);
    if (forcedSessionId) {
        view = { activeSessionId: forcedSessionId, isInboxOpen: false };
        viewMemory.set(workspaceId, view);
    }

    const existing = findWindowForWorkspace(workspaceId);
    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        if (forcedSessionId) {
            // Pushed to the renderer for right now; the memory above is what
            // makes it survive — the two views of one fact.
            existing.webContents.send(IPC_CHANNELS.WINDOW_ACTIVATE_SESSION, forcedSessionId);
        }
        return existing;
    }
    // A fresh window learns its view the way every restored window does:
    // through the context injected at construction.
    return createWindow({ workspaceId, ...view });
}

export function getAnyWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
}

/**
 * Strip a workspace id that no longer names anything.
 *
 * A window never holds a dead id.
 *
 * Pure and exported so both restore paths can be exercised without a window.
 */
export function resolveWorkspaceId(
    workspaceId: string | null,
    knownWorkspaceIds: Set<string>
): string | null {
    return workspaceId && knownWorkspaceIds.has(workspaceId) ? workspaceId : null;
}

/**
 * The full context to open a window on, workspace and view together.
 *
 * The view is read only once the workspace has survived resolution: a view
 * remembered for a workspace that no longer exists names nothing.
 */
function contextFor(
    workspaceId: string | null,
    knownWorkspaceIds: Set<string>,
    viewMemory: ViewMemoryAccess
): WindowContext {
    const resolved = resolveWorkspaceId(workspaceId, knownWorkspaceIds);
    if (!resolved) return EMPTY_CONTEXT;
    return { workspaceId: resolved, ...viewMemory.get(resolved) };
}

/** Where to reopen when the dock icon is clicked with no windows left. */
export function contextToReopen(
    knownWorkspaceIds: Set<string>,
    viewMemory: ViewMemoryAccess
): WindowContext {
    return contextFor(lastHeldWorkspaceId, knownWorkspaceIds, viewMemory);
}

type StoredWindow = { workspaceId: string | null; bounds: Electron.Rectangle };

/** Every open window's workspace and geometry, for restoring on next launch. */
export function listContexts(): StoredWindow[] {
    return BrowserWindow.getAllWindows()
        .map((window) => {
            const context = contexts.get(window.webContents.id);
            return context ? { workspaceId: context.workspaceId, bounds: window.getBounds() } : null;
        })
        .filter((entry): entry is StoredWindow => entry !== null);
}

interface WindowLayoutFile {
    windows: StoredWindow[];
}

function layoutFile(): JsonStateFile<WindowLayoutFile> {
    return new JsonStateFile<WindowLayoutFile>(path.join(app.getPath('userData'), 'windows.json'));
}

/**
 * The views implied by a layout file written before view memory existed.
 *
 * Builds up to this one recorded the active session per *window*, which for
 * the window that held a workspace is the same fact this feature keys by
 * workspace. Reading it once, on the launch that first creates the view
 * memory, is what keeps the upgrade invisible: without it everyone's first
 * switch afterwards would land on the blank composer even though the previous
 * build knew exactly where they were.
 *
 * Reads raw rather than through `isStoredWindow`, which no longer looks at the
 * key at all.
 */
export function viewsFromStoredLayout(): Record<string, WorkspaceView> {
    const views: Record<string, WorkspaceView> = {};
    let stored: { windows?: unknown } | null = null;
    try {
        stored = layoutFile().read() as { windows?: unknown } | null;
    } catch {
        // No layout to carry over is the same as nothing to remember.
        return views;
    }

    if (!Array.isArray(stored?.windows)) return views;

    for (const entry of stored.windows) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { workspaceId, activeSessionId } = entry as Record<string, unknown>;
        if (typeof workspaceId !== 'string' || typeof activeSessionId !== 'string') continue;
        // The Inbox was never recorded per window, so it starts closed —
        // the one detail an upgrade cannot carry over.
        views[workspaceId] = { activeSessionId, isInboxOpen: false };
    }
    return views;
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
 * Whether a saved rectangle still lands on a display that exists.
 *
 * Bounds are saved per window and restored on the next launch, but the
 * monitor they were saved on may be gone — a laptop that was docked is the
 * ordinary case. Restoring those coordinates makes a window that is running,
 * badging, and completely invisible, recoverable only through the OS. Taking
 * the default placement instead loses the position and keeps the window.
 *
 * Pure and exported so it can be exercised without a display attached.
 */
export function boundsAreVisible(
    bounds: Electron.Rectangle,
    displays: Array<{ workArea: Electron.Rectangle }>
): boolean {
    return displays.some(({ workArea }) => {
        const overlapsHorizontally =
            bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x;
        const overlapsVertically =
            bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y;
        return overlapsHorizontally && overlapsVertically;
    });
}

/**
 * Whether a stored entry is shaped the way we wrote it.
 *
 * `windows.json` is an ordinary file: a user can edit it and a crash can
 * truncate it. Parsing as JSON says nothing about the shape, and the restore
 * below reads `entry.bounds.x` — one entry missing its rectangle used to throw
 * inside `whenReady().then()`, an unhandled rejection with no window, no
 * dialog and no message at all.
 *
 * A file written by a build that still recorded `activeSessionId` per window
 * carries an extra key, which is ignored rather than rejected — the view now
 * comes from the view memory, seeded from exactly those values on the first
 * launch after the upgrade.
 *
 * Pure and exported so the malformed cases can be exercised without a window.
 */
export function isStoredWindow(entry: unknown): entry is StoredWindow {
    if (typeof entry !== 'object' || entry === null) return false;
    const { workspaceId, bounds } = entry as Record<string, unknown>;

    if (workspaceId != null && typeof workspaceId !== 'string') return false;
    if (typeof bounds !== 'object' || bounds === null) return false;

    const rectangle = bounds as Record<string, unknown>;
    return (['x', 'y', 'width', 'height'] as const).every((side) =>
        Number.isFinite(rectangle[side])
    );
}

/**
 * Reopen the windows from last launch, or one empty window on a first run.
 *
 * A saved workspace that has since been deleted opens on Home rather than
 * failing: a window must never hold an id that names nothing.
 *
 * Nothing in a layout file is worth more than having a window at all, so every
 * step of the restore is inside the guard — reading it, resolving it, and
 * opening from it. This runs inside `whenReady().then()`, where anything that
 * escapes is an unhandled rejection and the user gets a running app with no
 * window and no explanation.
 */
export function restoreWindowLayout(
    knownWorkspaceIds: Set<string>,
    viewMemory: ViewMemoryAccess
): void {
    try {
        openStoredWindows(knownWorkspaceIds, viewMemory);
    } catch {
        // Fall through to the default window below.
    }

    // Checked rather than assumed: a failure part-way through the loop has
    // already opened windows, and a blank extra one on top would be its own
    // small bug.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
}

function openStoredWindows(knownWorkspaceIds: Set<string>, viewMemory: ViewMemoryAccess): void {
    // Read back as `unknown`: the declared type describes what we write, not
    // what a hand-edited or truncated file actually holds.
    const stored = layoutFile().read() as { windows?: unknown } | null;
    const entries = stored?.windows;
    // Malformed entries are skipped one at a time rather than aborting the
    // restore: one bad rectangle should not cost you the other three windows.
    const windows = Array.isArray(entries) ? entries.filter(isStoredWindow) : [];
    if (windows.length === 0) return;

    // Read once per restore, not once per window: displays don't change
    // between one createWindow call and the next in this loop.
    const displays = screen.getAllDisplays();

    // Resolve dead workspace ids to Home first, then dedupe: two entries that
    // both point at a since-deleted workspace are two ordinary Home windows,
    // not a duplicate worth collapsing.
    const resolved = windows.map((entry) => ({
        ...contextFor(entry.workspaceId, knownWorkspaceIds, viewMemory),
        // A rectangle that lands on no attached display is worth nothing:
        // restoring it would create a window that runs, badges, and can never
        // be seen. Dropping it here — not clamping — falls back to
        // createWindow's own default placement instead of guessing at a
        // position the window was never actually at.
        bounds: boundsAreVisible(entry.bounds, displays) ? entry.bounds : undefined,
    }));

    for (const entry of dedupeByWorkspace(resolved)) {
        const { bounds, ...context } = entry;
        createWindow(context, bounds);
    }
}
