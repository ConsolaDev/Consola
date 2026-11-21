import type { RunRecord } from '@consola/factory-spec';
import type { Attention } from '../../shared/attention';
import type { AttentionSource } from '../attention/AttentionSource';
import { OPEN_STATUSES, runAttention } from '@consola/automation-engine';

/** The key a run's entry has. */
export const runKey = (runId: string): string => `run:${runId}`;

/**
 * Automation runs as attention entries, beside the sessions.
 *
 * `read()` emits only runs that want the person (`runAttention`), so a running
 * run stays represented by its session. `holds()` is wider: every open run
 * that has a session holds it, whether or not it has a row, so the sweeper
 * never settles a session an automation is still using.
 */
export class RunSource implements AttentionSource {
  public readonly kind = 'run';
  private readonly subscribers = new Set<() => void>();

  constructor(private readonly runs: () => readonly RunRecord[]) {}

  public read(): Map<string, Attention> {
    const entries = new Map<string, Attention>();
    for (const run of this.runs()) {
      const attention = runAttention(run);
      if (attention !== null) entries.set(runKey(run.id), attention);
    }
    return entries;
  }

  public holds(): Map<string, string[]> {
    const held = new Map<string, string[]>();
    for (const run of this.runs()) {
      if (!run.sessionId || !OPEN_STATUSES.includes(run.status)) continue;
      held.set(run.sessionId, [...(held.get(run.sessionId) ?? []), runKey(run.id)]);
    }
    return held;
  }

  public subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** A run changed: say `read()` may now answer differently. */
  public refresh(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}
