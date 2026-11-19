import {
  MAX_HISTORY_PER_WORKSPACE,
  MAX_TABS_PER_SESSION,
  type BrowserHistoryEntry,
  type BrowserStateFile,
  type BrowserTab,
  type SessionBrowser,
} from '../../shared/browser';

/** The slice of `JsonStateFile` the store needs, so tests can use a fake. */
export interface BrowserStateIO {
  read(): unknown;
  write(value: BrowserStateFile): void;
}

/** Writes are held back this long: tabs change at click rate, the file need not. */
export const WRITE_DEBOUNCE_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTab(value: unknown): BrowserTab | null {
  if (!isRecord(value)) return null;
  const { id, url, title, openedBy } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof url !== 'string' || typeof title !== 'string') return null;
  // An unknown origin is dropped rather than guessed: "person" would hide
  // that an agent opened the page.
  if (openedBy !== 'person' && openedBy !== 'agent') return null;
  return { id, url, title, openedBy };
}

/**
 * Read a stored session as the tabs it describes, or null when nothing in it
 * is usable. The cap is enforced here because the file is an ordinary file a
 * person can edit: more tabs than a session may hold would keep too many
 * guests alive. A dangling `activeTabId` falls to the first tab, so a session
 * with tabs always has one showing.
 */
export function normalizeSessionBrowser(value: unknown): SessionBrowser | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const tabs: BrowserTab[] = [];
  const seen = new Set<string>();
  for (const raw of value.tabs) {
    const tab = normalizeTab(raw);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
    if (tabs.length === MAX_TABS_PER_SESSION) break;
  }
  if (tabs.length === 0) return null;
  const active = value.activeTabId;
  return {
    tabs,
    activeTabId: typeof active === 'string' && seen.has(active) ? active : tabs[0].id,
  };
}

function normalizeHistory(value: unknown): BrowserHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: BrowserHistoryEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const { url, title, at } = raw;
    if (typeof url !== 'string' || typeof title !== 'string') continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    entries.push({ url, title, at });
    if (entries.length === MAX_HISTORY_PER_WORKSPACE) break;
  }
  return entries;
}

/** Never throws: one malformed entry costs only itself. */
export function normalizeBrowserState(value: unknown): BrowserStateFile {
  const state: BrowserStateFile = { sessions: {}, history: {} };
  if (!isRecord(value)) return state;
  if (isRecord(value.sessions)) {
    for (const [sessionId, entry] of Object.entries(value.sessions)) {
      const session = normalizeSessionBrowser(entry);
      if (session) state.sessions[sessionId] = session;
    }
  }
  if (isRecord(value.history)) {
    for (const [workspaceId, entries] of Object.entries(value.history)) {
      const history = normalizeHistory(entries);
      if (history.length > 0) state.history[workspaceId] = history;
    }
  }
  return state;
}

/**
 * Where each session's tabs, and each workspace's recent pages, are kept
 * between launches (`browser-state.json`).
 *
 * Modelled on `ViewMemoryService`: not a field on the `Workspace` record,
 * because every write there fsyncs the whole list and wakes every window,
 * and loading a page is far too frequent for that. Writes are debounced and
 * `flush` runs at shutdown. A failed write keeps the in-memory state, which
 * every read goes through; the file only has to be right at the next launch.
 * History is newest first.
 */
export class BrowserStateStore {
  private sessions = new Map<string, SessionBrowser>();
  private history = new Map<string, BrowserHistoryEntry[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: BrowserStateIO) {}

  /** Never fatal: losing this file costs open tabs, not transcripts. */
  public load(): void {
    let stored: unknown;
    try {
      stored = this.file.read();
    } catch {
      return;
    }
    const state = normalizeBrowserState(stored);
    this.sessions = new Map(Object.entries(state.sessions));
    this.history = new Map(Object.entries(state.history));
  }

  public sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  public getSession(sessionId: string): SessionBrowser | undefined {
    return this.sessions.get(sessionId);
  }

  /** An empty session is removed rather than stored. */
  public setSession(sessionId: string, session: SessionBrowser): void {
    if (session.tabs.length === 0) {
      this.deleteSession(sessionId);
      return;
    }
    this.sessions.set(sessionId, session);
    this.scheduleWrite();
  }

  public deleteSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.scheduleWrite();
  }

  public getHistory(workspaceId: string): BrowserHistoryEntry[] {
    return this.history.get(workspaceId) ?? [];
  }

  /** A revisit of the latest page updates that entry instead of repeating it. */
  public addHistory(workspaceId: string, entry: BrowserHistoryEntry): void {
    const current = this.history.get(workspaceId) ?? [];
    const rest = current[0]?.url === entry.url ? current.slice(1) : current;
    this.history.set(workspaceId, [entry, ...rest].slice(0, MAX_HISTORY_PER_WORKSPACE));
    this.scheduleWrite();
  }

  public deleteHistory(workspaceId: string): void {
    if (this.history.delete(workspaceId)) this.scheduleWrite();
  }

  /** Drop what belongs to a session or workspace that no longer exists. */
  public prune(liveSessionIds: Set<string>, liveWorkspaceIds: Set<string>): void {
    let removed = false;
    for (const id of [...this.sessions.keys()]) {
      if (!liveSessionIds.has(id)) {
        this.sessions.delete(id);
        removed = true;
      }
    }
    for (const id of [...this.history.keys()]) {
      if (!liveWorkspaceIds.has(id)) {
        this.history.delete(id);
        removed = true;
      }
    }
    if (removed) this.scheduleWrite();
  }

  /** Write now if anything is waiting; for shutdown. */
  public flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private scheduleWrite(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, WRITE_DEBOUNCE_MS);
    // A pending write must not keep the process alive; quit flushes it.
    this.timer.unref?.();
  }

  private write(): void {
    try {
      this.file.write({
        sessions: Object.fromEntries(this.sessions),
        history: Object.fromEntries(this.history),
      });
    } catch {
      // Nothing to report it on; the next change tries again.
    }
  }
}
