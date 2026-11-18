import type { CleanupHistoryEntry } from '../../shared/worktreeCleanup';
import type { JsonStateFile } from '../state/JsonStateFile';

export const HISTORY_LIMIT = 200;
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

interface CleanupHistoryFile {
  entries: CleanupHistoryEntry[];
}

/**
 * What cleanup removed and what was rebuilt, newest first, in
 * `worktree-cleanup-log.json`. Capped by count and age.
 *
 * Loaded non-fatally, like `view-memory.json`: a lost log costs the list of
 * what happened, never anything the list described.
 */
export class CleanupHistory {
  private entries: CleanupHistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly file: JsonStateFile<CleanupHistoryFile>,
    private readonly now: () => number = Date.now,
  ) {}

  public load(): void {
    try {
      const stored = this.file.read();
      this.entries = Array.isArray(stored?.entries)
        ? stored.entries.filter(
            (entry): entry is CleanupHistoryEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof entry.at === 'number' &&
              typeof entry.tree === 'string' &&
              (entry.action === 'removed' || entry.action === 'rebuilt'),
          )
        : [];
    } catch (error) {
      console.error('Could not read the worktree cleanup history; starting empty.', error);
      this.entries = [];
    }
    this.entries = this.trimmed(this.entries);
  }

  /** Newest first. In one workspace when given, else everywhere. */
  public list(workspaceId?: string): CleanupHistoryEntry[] {
    const all = this.trimmed(this.entries);
    return workspaceId ? all.filter((entry) => entry.workspaceIds.includes(workspaceId)) : all;
  }

  public append(entry: Omit<CleanupHistoryEntry, 'id' | 'at'>): void {
    const at = this.now();
    const full: CleanupHistoryEntry = {
      ...entry,
      id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
      at,
    };
    this.entries = this.trimmed([full, ...this.entries]);
    try {
      this.file.write({ entries: this.entries });
    } catch (error) {
      // Memory stays authoritative for this run.
      console.error('Could not write the worktree cleanup history.', error);
    }
    for (const listener of [...this.listeners]) listener();
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private trimmed(entries: CleanupHistoryEntry[]): CleanupHistoryEntry[] {
    const oldest = this.now() - HISTORY_MAX_AGE_MS;
    return entries.filter((entry) => entry.at >= oldest).slice(0, HISTORY_LIMIT);
  }
}
