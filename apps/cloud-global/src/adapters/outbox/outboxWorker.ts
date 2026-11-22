import type { Region } from '@consola/cloud-contract';
import { deliverOutbox, type OutboxPass } from '../../application/outbox.js';
import type { CellDelivery, OutboxSigner, OutboxStore } from '../../application/ports.js';
import { cellUrlVariable } from '../../config.js';

/** How often the worker looks at the outbox when nothing wakes it sooner. */
export const OUTBOX_POLL_MS = 10_000;

export type OutboxWorker = {
  /** Starts delivering: a pass at once, then one each time it wakes or the poll comes round. */
  start(): void;
  /** Asks for a pass now, as when a change has just written a message. */
  wake(): void;
  /** Stops: no pass starts again, and the one running ends, abandoning a delivery in flight. */
  stop(): Promise<void>;
};

export type Timers = {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type OutboxLog = {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
};

const systemTimers: Timers = {
  set(run, ms) {
    const handle = setTimeout(run, ms);
    // A timer alone never keeps the process alive; `main.ts` stops the worker on shutdown.
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** An error in one line, its message cut short: no signature or key ever reaches a log here. */
function oneLine(error: unknown): string {
  if (!(error instanceof Error)) return 'an unexpected error';
  const first = error.message.split('\n')[0]?.trim().slice(0, 200);
  return first ? `${error.name}: ${first}` : error.name;
}

/**
 * Delivers the outbox in this process, a pass (`deliverOutbox`) at a time, and never two at
 * once. It runs a pass when it starts, when it is woken (a change wrote a message), when the
 * earliest retry is due, and otherwise every `pollMs`, which also catches a message whose wake
 * was missed. A wake during a pass runs another one right after it. A pass that fails (the
 * database gone, say) is logged and tried again at the next poll.
 *
 * It logs ids and statuses only: each delivery, each failure with its reason and when it is
 * tried again, and, once per region, that a region has messages and no cell to send them to.
 * Never a message's body, its signature or the key.
 *
 * It assumes it is the only worker: one `cloud-global` process delivers the outbox.
 */
export function createOutboxWorker(deps: {
  outbox: OutboxStore;
  signer: OutboxSigner;
  cells: CellDelivery;
  pollMs?: number;
  now?: () => Date;
  timers?: Timers;
  log?: OutboxLog;
}): OutboxWorker {
  const { outbox, signer, cells } = deps;
  const pollMs = deps.pollMs ?? OUTBOX_POLL_MS;
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? systemTimers;
  const log = deps.log ?? console;
  const stopping = new AbortController();
  const told = new Set<Region>();

  let started = false;
  let timer: unknown;
  let running: Promise<void> | null = null;
  let again = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    timers.clear(timer);
    timer = undefined;
  };
  const schedule = (ms: number) => {
    clearTimer();
    timer = timers.set(
      () => {
        timer = undefined;
        run();
      },
      Math.max(0, ms),
    );
  };

  function report(pass: OutboxPass) {
    for (const outcome of pass.outcomes) {
      const { workspaceId, sequence } = outcome.key;
      const which = `message ${sequence} of workspace ${workspaceId}`;
      if (outcome.kind === 'delivered') {
        log.info(
          `Outbox: delivered ${which} (status ${outcome.status}, attempt ${outcome.attempts}).`,
        );
      } else {
        const wait = outcome.nextAttemptAt.getTime() - now().getTime();
        log.warn(
          `Outbox: could not deliver ${which} (${outcome.error}); attempt ${outcome.attempts}, next in ${seconds(wait)}.`,
        );
      }
    }
    for (const region of pass.waiting) {
      if (told.has(region)) continue;
      told.add(region);
      log.warn(
        `Outbox: ${region} has messages and no cell (${cellUrlVariable(region)} is not set), so they wait.`,
      );
    }
  }

  async function pass(): Promise<void> {
    let nextDueAt: Date | null = null;
    try {
      const done = await deliverOutbox({ outbox, signer, cells }, { now, signal: stopping.signal });
      report(done);
      nextDueAt = done.nextDueAt;
    } catch (error) {
      log.error(
        `Outbox: a delivery pass failed (${oneLine(error)}); trying again in ${seconds(pollMs)}.`,
      );
    }
    running = null;
    if (stopping.signal.aborted) return;
    if (again) {
      again = false;
      schedule(0);
      return;
    }
    schedule(nextDueAt ? Math.min(pollMs, nextDueAt.getTime() - now().getTime()) : pollMs);
  }

  function run() {
    if (!started || stopping.signal.aborted) return;
    if (running) {
      again = true;
      return;
    }
    clearTimer();
    running = pass();
  }

  return {
    start() {
      if (started) return;
      started = true;
      run();
    },
    wake: run,
    async stop() {
      stopping.abort();
      clearTimer();
      await running;
    },
  };
}
