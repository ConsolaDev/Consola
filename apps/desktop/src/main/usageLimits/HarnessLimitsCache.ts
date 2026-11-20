import type { HarnessLimits } from '../../shared/usageLimits';
import type { HarnessConfig, HarnessDriver } from '../drivers';
import { signature } from '../HarnessCapabilitiesCache';

/** What a harness last said about its limits, and when. */
export interface KnownLimits {
  limits: HarnessLimits;
  /** When the answer arrived. */
  at: number;
}

/**
 * What each harness's CLI last said about its usage limits.
 *
 * Keyed by what a harness launches as, like `HarnessCapabilitiesCache`, so
 * two records for one profile share one answer and an edited harness asks
 * afresh. Unlike capabilities, limits change, so every `ask` asks the CLI;
 * this only coalesces asks in flight and keeps the last good answer. A failed
 * ask is never remembered and never replaces one: no answer is not an answer
 * of "no limits". Not persisted.
 *
 * Asked only when something happened: a session stopped on a limit, a known
 * reset passed, or the Switch harness dialog opened. Never on a timer.
 */
export class HarnessLimitsCache {
  private readonly known = new Map<string, KnownLimits>();
  private readonly pending = new Map<string, Promise<HarnessLimits | undefined>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Ask the CLI now. Undefined when it has nothing to say (no reporting) or did not answer. */
  public ask(driver: HarnessDriver, config: HarnessConfig): Promise<HarnessLimits | undefined> {
    const reporting = driver.usageLimits;
    if (!reporting) return Promise.resolve(undefined);
    const key = signature(driver.id, config);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const asking = reporting
      .read(config)
      .then(
        (limits) => {
          this.known.set(key, { limits, at: this.now() });
          return limits;
        },
        (error: unknown) => {
          console.warn(
            `Could not read ${driver.id}'s usage limits:`,
            error instanceof Error ? error.message : error,
          );
          return undefined;
        },
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, asking);
    return asking;
  }

  /** The last good answer, however old. */
  public last(driver: HarnessDriver, config: HarnessConfig): KnownLimits | undefined {
    return this.known.get(signature(driver.id, config));
  }

  /**
   * An answer no older than `maxAgeMs`, asking when there is none, but
   * waiting at most `waitMs` for it: a dialog opening must not hang on a CLI.
   */
  public async fresh(
    driver: HarnessDriver,
    config: HarnessConfig,
    { maxAgeMs, waitMs }: { maxAgeMs: number; waitMs: number },
  ): Promise<KnownLimits | undefined> {
    const known = this.last(driver, config);
    if (known && this.now() - known.at <= maxAgeMs) return known;
    if (!driver.usageLimits) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), waitMs);
      timer.unref?.();
    });
    await Promise.race([this.ask(driver, config), timeout]);
    if (timer) clearTimeout(timer);
    return this.last(driver, config);
  }
}
