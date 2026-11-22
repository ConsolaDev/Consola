import type { HarnessConfig, HarnessDriver } from '../drivers';
import type { McpServerReport } from '../drivers/HarnessDriver';
import { signature } from '../HarnessCapabilitiesCache';

/** What a harness's CLI last said of its MCP servers. */
export type ServersAnswer =
  | { state: 'settled'; servers: McpServerReport[] }
  | { state: 'pending' }
  | { state: 'failed'; error: string };

/** One harness identity's answer, and the probe under way for it. */
interface Entry {
  /** The last answer that settled, a report or a failure; absent until one has. */
  settled?: Exclude<ServersAnswer, { state: 'pending' }>;
  /** The probe under way, if any; it never rejects. */
  probing?: Promise<void>;
  /** Names an agent named that a report lacked, each probed for once already. */
  tried: Set<string>;
}

/**
 * Remembers which MCP servers each harness has, as its CLI said (Calls 5
 * and 6). Unlike the capabilities cache it keeps a failure: every probe
 * starts the person's own user servers, so nothing here probes again on its
 * own after one. A harness is probed when a factory first needs its answer,
 * once more for each name an agent names that the answer lacks, and again
 * on Check again (`refresh`), never on a timer.
 *
 * Keyed by what a harness launches as (`signature`), kept for the app's
 * life, never persisted. Every settle, an answer or a failure, calls
 * `onSettled` once, so the folders that asked are checked again.
 */
export class McpServersCache {
  private entries = new Map<string, Entry>();
  /** Per harness, the names asked about before Check again, which the probe it starts answers for (review M13). */
  private readonly carried = new Map<string, Set<string>>();

  constructor(private readonly options: { onSettled(): void }) {}

  /**
   * The answer for this harness, starting a probe when it has none. A
   * failure is kept: only `refresh` probes again after one. While a probe
   * for a missing name runs, the settled report is still the answer (review M1).
   */
  public ask(driver: HarnessDriver, config: HarnessConfig): ServersAnswer {
    const entry = this.entryFor(driver, config);
    if (!entry.settled && !entry.probing) this.probe(entry, driver, config);
    return entry.settled ?? { state: 'pending' };
  }

  /** What it holds for this harness; starts nothing. Undefined when it was never asked. */
  public peek(driver: HarnessDriver, config: HarnessConfig): ServersAnswer | undefined {
    const entry = this.entries.get(signature(driver.id, config));
    if (!entry) return undefined;
    return entry.settled ?? (entry.probing ? { state: 'pending' } : undefined);
  }

  /**
   * For a launch: the report, once any probe under way has settled (one is
   * started when there is no answer at all). Rejects with a failure's words.
   */
  public async get(driver: HarnessDriver, config: HarnessConfig): Promise<McpServerReport[]> {
    for (;;) {
      const entry = this.entryFor(driver, config);
      if (!entry.settled && !entry.probing) this.probe(entry, driver, config);
      if (entry.probing) {
        // Then ask again: Check again may have replaced this entry meanwhile.
        await entry.probing;
        continue;
      }
      const answer = entry.settled;
      if (answer?.state === 'settled') return answer.servers;
      throw new Error(answer?.error);
    }
  }

  /**
   * An agent names `names`, which the settled report lacks: probe once more,
   * once per name per harness until `refresh`. A name named while such a
   * probe runs is left to it. A probe that fails keeps the settled report
   * (review M1).
   */
  public missing(driver: HarnessDriver, config: HarnessConfig, names: readonly string[]): void {
    const entry = this.entries.get(signature(driver.id, config));
    if (entry?.settled?.state !== 'settled') return;
    const fresh = names.filter((name) => !entry.tried.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) entry.tried.add(name);
    if (!entry.probing) this.probe(entry, driver, config);
  }

  /**
   * Check again: forget every answer, so the next ask probes afresh, and an
   * answer to a probe already under way is not kept. A name already asked
   * about is not asked about once more after it: the probe Check again
   * starts is its answer (review M13).
   */
  public refresh(): void {
    for (const [key, entry] of this.entries) {
      if (entry.tried.size === 0) continue;
      const carried = this.carried.get(key) ?? new Set<string>();
      for (const name of entry.tried) carried.add(name);
      this.carried.set(key, carried);
    }
    this.entries = new Map();
  }

  private entryFor(driver: HarnessDriver, config: HarnessConfig): Entry {
    const key = signature(driver.id, config);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { tried: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private probe(entry: Entry, driver: HarnessDriver, config: HarnessConfig): void {
    const key = signature(driver.id, config);
    if (!driver.probeMcpServers) {
      // Never going to change while this build runs: settled at once, and
      // told after the asker has its answer, never from inside its ask.
      entry.settled = { state: 'failed', error: `${driver.id} cannot list its MCP servers.` };
      queueMicrotask(() => this.options.onSettled());
      return;
    }
    const current = () => this.entries.get(key) === entry;
    const run: Promise<void> = driver
      .probeMcpServers(config)
      .then(
        (servers) => {
          if (!current()) return;
          entry.settled = { state: 'settled', servers };
          for (const name of this.carried.get(key) ?? []) entry.tried.add(name);
          this.carried.delete(key);
          return true;
        },
        (error: unknown) => {
          if (!current()) return;
          // A failed probe for a missing name keeps the report that settled.
          if (entry.settled?.state !== 'settled') {
            entry.settled = {
              state: 'failed',
              error: error instanceof Error ? error.message : String(error),
            };
          }
          return true;
        },
      )
      .then((kept) => {
        if (entry.probing === run) entry.probing = undefined;
        if (kept) this.options.onSettled();
      });
    entry.probing = run;
  }
}
