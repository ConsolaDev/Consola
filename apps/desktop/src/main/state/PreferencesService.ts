import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/preferences';
import type { JsonStateFile } from './JsonStateFile';

/** Read stored preferences, falling back per field so one bad value costs only itself. */
export function normalizePreferences(value: unknown): Preferences {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const days = row.autoSettleDays;
  const pending = row.pendingAutoSettle;
  return {
    autoSettleDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0
        ? days
        : DEFAULT_PREFERENCES.autoSettleDays,
    hasExplainedAutoSettle: row.hasExplainedAutoSettle === true,
    pendingAutoSettle: Array.isArray(pending)
      ? pending.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

/**
 * Settings main has to read itself, in `preferences.json`.
 *
 * Deliberately a small file of its own rather than a field on `Workspace`, for
 * the same reason as `ViewMemoryService`: nothing here is worth an fsync of the
 * whole workspace list. Loaded non-fatally: a lost file means defaults, and the
 * one-time explanation would simply be given again.
 */
export class PreferencesService {
  private preferences: Preferences = { ...DEFAULT_PREFERENCES };
  private readonly listeners = new Set<(preferences: Preferences) => void>();

  constructor(private readonly file: JsonStateFile<unknown>) {}

  public load(): void {
    try {
      this.preferences = normalizePreferences(this.file.read());
    } catch (error) {
      console.error('Could not read preferences; using defaults.', error);
      this.preferences = { ...DEFAULT_PREFERENCES };
    }
  }

  public get(): Preferences {
    return { ...this.preferences, pendingAutoSettle: [...this.preferences.pendingAutoSettle] };
  }

  /** Apply a change from the person. Only the fields they can set. */
  public setAutoSettleDays(days: number): void {
    if (!Number.isFinite(days) || days < 0) return;
    this.update({ autoSettleDays: Math.floor(days) });
  }

  /** The sweeper moved these sessions and the person has not been told yet. */
  public addPendingAutoSettle(sessionIds: string[]): void {
    if (this.preferences.hasExplainedAutoSettle || sessionIds.length === 0) return;
    const pending = new Set(this.preferences.pendingAutoSettle);
    for (const id of sessionIds) pending.add(id);
    this.update({ pendingAutoSettle: [...pending] });
  }

  /** The person has seen the explanation, in whichever window. Never shown again. */
  public acknowledgeAutoSettle(): void {
    this.update({ hasExplainedAutoSettle: true, pendingAutoSettle: [] });
  }

  public onChange(listener: (preferences: Preferences) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<Preferences>): void {
    const next = { ...this.preferences, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.preferences)) return;
    this.preferences = next;
    try {
      this.file.write(next);
    } catch (error) {
      // Memory stays authoritative for this run; nothing to surface it on.
      console.error('Could not write preferences.', error);
    }
    for (const listener of [...this.listeners]) listener(this.get());
  }
}
