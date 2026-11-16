import type { TerminalStatus } from '../../shared/terminalStatus';

/** How long a session must stay quiet before it counts as finished. */
export const SETTLE_MS = 4_000;

export type SettledStatus = Exclude<TerminalStatus, 'working'>;

interface Watch {
  /** A `ready` seen before any work is the state the prompt found, not a finish. */
  seenWorking: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Decides when a turn has really finished.
 *
 * A status flip is not a finish: a session blinks to `ready` between tool
 * calls. So a quiet status must hold for SETTLE_MS, and going back to
 * `working` inside that window cancels it. `exited` is final and reports at
 * once.
 *
 * Detection only. What a finish means differs by observer: the Assistant
 * counts it as unseen by the Assistant, the attention ledger as unseen by the
 * person. Those are different facts, so each keeps its own bookkeeping and
 * shares this machine.
 *
 * `persistent: false` watches only keys it was told to (`watch`) and drops one
 * after it reports. `persistent: true` watches every key it sees, and starts
 * over after each report.
 */
export class TurnSettle {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly onFinished: (key: string, status: SettledStatus) => void,
    private readonly options: { persistent: boolean }
  ) {}

  /** Start (or restart) watching a key: the next quiet only counts after it has worked. */
  public watch(key: string): void {
    this.unwatch(key);
    this.watches.set(key, { seenWorking: false });
  }

  public unwatch(key: string): void {
    const watch = this.watches.get(key);
    if (watch) this.clearTimer(watch);
    this.watches.delete(key);
  }

  public observe(key: string, status: TerminalStatus): void {
    let watch = this.watches.get(key);
    if (!watch) {
      if (!this.options.persistent) return;
      watch = { seenWorking: false };
      this.watches.set(key, watch);
    }

    if (status === 'working') {
      watch.seenWorking = true;
      this.clearTimer(watch);
    } else if (status === 'exited') {
      this.finish(key, status);
    } else if (status === 'needs-attention' || watch.seenWorking) {
      // `ready` before any work is the state the prompt found it in.
      this.clearTimer(watch);
      const armed = watch;
      armed.timer = setTimeout(() => {
        if (this.watches.get(key) === armed) this.finish(key, status);
      }, SETTLE_MS);
      armed.timer.unref?.();
    }
  }

  private finish(key: string, status: SettledStatus): void {
    this.unwatch(key);
    if (this.options.persistent) this.watches.set(key, { seenWorking: false });
    this.onFinished(key, status);
  }

  private clearTimer(watch: Watch): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = undefined;
  }
}
