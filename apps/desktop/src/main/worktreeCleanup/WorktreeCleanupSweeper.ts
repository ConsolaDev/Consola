/** How often the local rules (settled, run finished) are applied. */
export const LOCAL_SWEEP_MS = 5 * 60_000;
/** How often the provider is asked whether pull requests finished. */
export const PULL_REQUEST_SWEEP_MS = 30 * 60_000;
/**
 * How long the first sweep waits for a window to say what it is showing.
 * Only a fallback; see `AutoSettler`'s `FIRST_SWEEP_GRACE_MS`.
 */
export const FIRST_SWEEP_GRACE_MS = 30_000;
/** A run that just ended is swept for after this, so its session can settle first. */
export const RUN_ENDED_DEBOUNCE_MS = 30_000;

export interface SweeperDeps {
  /** Apply the rules once; `refreshPullRequests` asks the provider again. */
  sweep(options: { refreshPullRequests: boolean }): Promise<unknown>;
  /** Whether any workspace has a rule on that removes worktrees on its own. */
  anyRuleOn(): boolean;
  /** Hear the first time a window says what it is showing. Returns an unsubscribe. */
  onWindowReport(listener: () => void): () => void;
}

/**
 * When the worktree cleanup rules run: every five minutes for the local
 * rules, every thirty for pull requests, when a rule is changed, and shortly
 * after an automation run ends.
 *
 * Modelled on `AutoSettler`. Not at startup: no window has said what it is
 * showing yet, and every session reads as not shown — including the one a
 * restoring window is about to open. Does nothing at all while every rule
 * is off. Timers never keep the app alive.
 */
export class WorktreeCleanupSweeper {
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private firstSweep?: { cancel: () => void };
  private kicked?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(private readonly deps: SweeperDeps) {}

  public start(): void {
    const local = setInterval(() => this.run(false), LOCAL_SWEEP_MS);
    const pullRequests = setInterval(() => this.run(true), PULL_REQUEST_SWEEP_MS);
    local.unref?.();
    pullRequests.unref?.();
    this.timers = [local, pullRequests];

    let swept = false;
    let unsubscribe = () => {};
    let grace: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      swept = true;
      unsubscribe();
      if (grace) clearTimeout(grace);
    };
    const sweepOnce = () => {
      if (swept) return;
      cancel();
      this.started = true;
      this.run(true);
    };
    unsubscribe = this.deps.onWindowReport(sweepOnce);
    grace = setTimeout(sweepOnce, FIRST_SWEEP_GRACE_MS);
    grace.unref?.();
    this.firstSweep = { cancel };
  }

  public stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.firstSweep?.cancel();
    this.firstSweep = undefined;
    if (this.kicked) clearTimeout(this.kicked);
    this.kicked = undefined;
  }

  /**
   * Sweep soon: a rule changed, or a run ended. Coalesced, and never before
   * the first sweep — that one waits for a window on purpose.
   */
  public kick(delayMs = 0): void {
    if (!this.started) return;
    if (this.kicked) clearTimeout(this.kicked);
    this.kicked = setTimeout(() => {
      this.kicked = undefined;
      this.run(true);
    }, delayMs);
    this.kicked.unref?.();
  }

  private run(refreshPullRequests: boolean): void {
    if (!this.deps.anyRuleOn()) return;
    this.deps.sweep({ refreshPullRequests }).catch((error: unknown) => {
      console.error('Worktree cleanup sweep failed:', error);
    });
  }
}
