/**
 * A run's secret values, held in memory while it works and nowhere else:
 * read once before the step that needs them is let in, dropped as the run
 * stops working (it ends, parks or its workspace goes). One read at a time per
 * run; a read whose run was dropped meanwhile is discarded, even once a newer
 * read for the same run has started.
 */
import { describeReason } from '../steps/commandStep';
import type { SecretsRead } from './readSecrets';

export interface HeldSecrets {
  values: Record<string, string>;
  masks: string[];
  labels: Record<string, string>;
}

export class RunSecrets {
  private readonly heldByRun = new Map<string, HeldSecrets>();
  /**
   * Each run's read under way, by its token: the one its outcome must carry
   * to count. A new read and a drop each move it, so a late outcome is
   * discarded. One counter for every run, so a run's entry can go with it
   * and no token is ever handed out twice.
   */
  private readonly readingByRun = new Map<string, number>();
  private nextToken = 0;

  public held(runId: string): HeldSecrets | undefined {
    return this.heldByRun.get(runId);
  }

  public reading(runId: string): boolean {
    return this.readingByRun.has(runId);
  }

  /**
   * Starts `read` once for `runId`; on an ok outcome holds it, then calls
   * `onDone`; on a failed one calls `onDone`. While one is under way,
   * another is ignored, its function never called.
   */
  public read(
    runId: string,
    read: () => Promise<SecretsRead>,
    onDone: (outcome: SecretsRead) => void,
  ): void {
    if (this.readingByRun.has(runId)) return;
    const token = ++this.nextToken;
    this.readingByRun.set(runId, token);
    const settle = (outcome: SecretsRead) => {
      if (this.readingByRun.get(runId) !== token) return;
      this.readingByRun.delete(runId);
      if (outcome.ok) {
        this.heldByRun.set(runId, {
          values: outcome.values,
          masks: outcome.masks,
          labels: outcome.labels,
        });
      }
      onDone(outcome);
    };
    let reading: Promise<SecretsRead>;
    try {
      reading = read();
    } catch (error) {
      reading = Promise.reject(error);
    }
    reading.then(settle, (error: unknown) =>
      settle({
        ok: false,
        error: `Couldn't read this run's secrets: ${describeReason(error)}`,
        told: "Couldn't read this run's secrets",
      }),
    );
  }

  /** Lets go of the run's values, and discards what a read under way brings back. */
  public drop(runId: string): void {
    this.heldByRun.delete(runId);
    this.readingByRun.delete(runId);
  }

  public dropAll(): void {
    this.heldByRun.clear();
    this.readingByRun.clear();
  }
}
