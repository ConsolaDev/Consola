import type { Debugger, WebContents } from 'electron';
import type { Browser, ConnectOverCDPTransport, Page } from 'playwright-core';
import type { AgentCall } from './AgentPages';
import { CdpRelay, type CdpRelayOptions, type RelayGuest } from './CdpRelay';
import { type ConsoleError, type FailedRequest, readPageEvent } from './pageEvents';
import { RingBuffer } from './RingBuffer';

/** The newest console errors a tab keeps between snapshots. */
export const CONSOLE_ERRORS_KEPT = 200;
/** The newest failed requests a tab keeps between snapshots. */
export const FAILED_REQUESTS_KEPT = 100;
/** Console calls between two releases of the objects they logged, when no snapshot does it. */
export const RELEASE_CONSOLE_EVERY = 200;
/** How long Playwright may take to connect to a page. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** How long one Playwright step on a page may take, unless a caller says otherwise. */
export const PAGE_CALL_TIMEOUT_MS = 10_000;
/**
 * How long one call may run on its page in all, unless its caller allows
 * longer (`CallOptions.deadlineMs`). A backstop for a step with no bound of
 * its own, such as an `evaluate` or a page that stops answering: every
 * bounded step of a snapshot fits within it (three at `PAGE_CALL_TIMEOUT_MS`),
 * so only a stuck call meets it.
 */
export const CALL_DEADLINE_MS = 40_000;
/**
 * The longest any call may run on its page, whatever its caller asks: a
 * `wait_for` at its longest fits, and Node's timers fire at once past 2^31 - 1
 * ms, so an unbounded wish would have the opposite effect.
 */
export const MAX_CALL_DEADLINE_MS = 120_000;

/** What a call stopped at its deadline answers. */
export function pastDeadlineMessage(deadlineMs: number): string {
  return `A call on this tab's page did not finish within ${deadlineMs / 1000} seconds, so it was stopped.`;
}

/** What a call answers when another call on its page ran past its deadline and closed the connection they shared. */
export const ANOTHER_CALL_PAST_DEADLINE_MESSAGE =
  "Another call on this tab's page ran past its deadline, so the connection it was using was closed; try again.";

/** A caller's deadline, held to a finite range (`CALL_DEADLINE_MS` when none or not a number). */
export function clampDeadline(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined || Number.isNaN(deadlineMs)) return CALL_DEADLINE_MS;
  return Math.min(Math.max(Math.round(deadlineMs), 1), MAX_CALL_DEADLINE_MS);
}

/** This call's own deadline, told apart from a connection another call's deadline closed. */
class PastDeadlineError extends Error {}

/**
 * Reading the page itself failed, for a reason Playwright gives in its own
 * words (`cause`), which can echo the page's: the caller words it as page
 * text (`pageStepFailure`), never as Consola's.
 */
export class PageStepError extends Error {
  constructor(public readonly cause: unknown) {
    super(messageOf(cause));
  }
}

const NO_PAGE_MESSAGE = "Could not reach the tab's page.";
const PAGE_GONE_MESSAGE = "The tab's page went away.";
const NEW_PAGE_MESSAGE = 'The tab loaded a new page.';
const CLOSING_MESSAGE = 'Consola is closing.';

/** What the driver needs of a relay; `CdpRelay` is one. */
export interface DriverRelay extends ConnectOverCDPTransport {
  readonly isClosed: boolean;
  close(reason?: string): void;
  setFocusEmulation(enabled: boolean): Promise<void>;
}

/** What a call may do to the page besides what Playwright does, and what it is told. */
export interface PageControl {
  /**
   * Main's switch for focus emulation (`CdpRelay.setFocusEmulation`), for
   * this call. Turned on only for as long as the agent acts: whatever the
   * call does, the driver turns it off as the call ends (without waiting for
   * the page, which answers it only once any dialog it shows is closed), and
   * overlapping calls on the page share it, so it stays on while any of them
   * wants it. A page the person is not looking at must not believe it has
   * focus for longer than that.
   */
  setFocusEmulation(enabled: boolean): Promise<void>;
  /**
   * Aborted once the call is given up on at its deadline, its connection
   * ends, or the call has ended. A promise cannot be cancelled, so a step the
   * call has not started yet must check it: past this point the call no
   * longer holds the tab.
   */
  readonly signal: AbortSignal;
}

export interface CallOptions {
  /**
   * How long the call may run once its page is reached; `CALL_DEADLINE_MS`
   * unless given, and never more than `MAX_CALL_DEADLINE_MS`. A call that
   * waits on purpose (a `wait_for` with its own timeout) asks for more than
   * that wait.
   */
  deadlineMs?: number;
}

export interface PageSnapshot {
  /** The page's address and title as it is now. */
  url: string;
  title: string;
  /**
   * Playwright's accessibility outline for AI (`page.ariaSnapshot({ mode:
   * 'ai' })`): one YAML-like line per element, an element the agent can act
   * on carrying `[ref=eN]` (`f<n>eN` inside a frame). The ref stays the
   * element's for as long as its role and name do, and
   * `page.locator('aria-ref=eN')` finds it, against this tab's latest
   * snapshot.
   */
  outline: string;
  /** Since the previous snapshot of this tab, oldest first. */
  consoleErrors: ConsoleError[];
  failedRequests: FailedRequest[];
  /** How many fell off the rings unread since the previous snapshot. */
  dropped: { consoleErrors: number; failedRequests: number };
  /** The page as it paints, when asked for and it could be taken. */
  png?: Buffer;
  /** Why the image asked for could not be taken. */
  screenshotError?: string;
}

export interface PageDriverDeps {
  calls: { beginToolCall(tabId: string): Promise<AgentCall> };
  /** Tests replace it; `CdpRelay.open` otherwise. */
  openRelay?(guest: RelayGuest, options: CdpRelayOptions): DriverRelay;
  /** Tests replace it; Playwright's `connectOverCDP` otherwise. */
  connect?(relay: DriverRelay): Promise<Browser>;
  now?(): number;
  /** Tests replace it: calls `fire` after `ms` unless the stop it answers is called first. */
  startTimer?(ms: number, fire: () => void): () => void;
  /** An agent's connection to this page has ended, for whatever reason. */
  disconnected?(guest: WebContents): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

/** Whether a `Log.entryAdded` names objects of the page's. */
function hasArgs(params: unknown): boolean {
  const entry = (params as { entry?: { args?: unknown } } | null)?.entry;
  return Array.isArray(entry?.args) && entry.args.length > 0;
}

async function connectPlaywright(relay: DriverRelay): Promise<Browser> {
  // Loaded on first use: Playwright is large, and most launches never drive a page.
  const { chromium } = await import('playwright-core');
  return chromium.connectOverCDP(relay, { timeout: CONNECT_TIMEOUT_MS });
}

interface ConnectionOptions {
  openRelay(guest: RelayGuest, options: CdpRelayOptions): DriverRelay;
  connect(relay: DriverRelay): Promise<Browser>;
  now(): number;
  /** Entries dated at or before this were already reported for the tab. */
  reportedUntil(): number;
  closed(connection: Connection): void;
}

/**
 * One Playwright connection to one guest page, over its own relay, with the
 * page's problems collected beside it.
 *
 * The problems are read from the debugger's own events, not from
 * Playwright's, and become plain text in two fixed-size rings, each entry
 * cut to a copy of its own (`pageEvents`). Playwright never hears them: it
 * would keep a page's last 200 console messages and errors with their whole
 * values, and the relay keeps those events from it (`cdpRelayProtocol`).
 * What the page's own inspector keeps for the console (the objects a page
 * logged) is freed in the page by releasing the `console` object group (as
 * T3 Code does), after a snapshot and every `RELEASE_CONSOLE_EVERY` logged
 * calls.
 */
class Connection {
  public readonly ready: Promise<Page>;
  private readonly relay: DriverRelay;
  /**
   * The page's debugger, read once as the connection opens: a destroyed page
   * throws on `.debugger`, and its connection is closed just then.
   */
  private readonly pageDebugger: Debugger;
  private closedReason: string | null = null;
  private readonly closing = new AbortController();
  /** Calls on this page that have focus emulation on. */
  private focusHolders = 0;
  private readonly consoleErrors = new RingBuffer<ConsoleError>(CONSOLE_ERRORS_KEPT);
  private readonly failedRequests = new RingBuffer<FailedRequest>(FAILED_REQUESTS_KEPT);
  /** Sessions that logged since the last release ('' is the page itself). */
  private readonly loggingSessions = new Set<string>();
  private loggedSinceRelease = 0;

  constructor(
    public readonly guest: WebContents,
    private readonly options: ConnectionOptions,
  ) {
    this.pageDebugger = guest.debugger;
    // Listening starts before Playwright enables the page's domains, since
    // enabling them replays what the page logged before anyone connected.
    this.pageDebugger.on('message', this.onMessage);
    try {
      this.relay = options.openRelay(guest, { onClose: (reason) => this.onRelayClosed(reason) });
    } catch (error) {
      this.pageDebugger.removeListener('message', this.onMessage);
      throw error;
    }
    this.ready = this.connect();
    // Every caller awaits it; this only keeps a failure nobody waits on quiet.
    this.ready.catch(() => {});
  }

  public get isOpen(): boolean {
    return this.closedReason === null;
  }

  /** Aborted, with the reason, once the connection has ended. */
  public get closedSignal(): AbortSignal {
    return this.closing.signal;
  }

  /** One more call wants focus emulation: the first turns it on. */
  public async holdFocus(): Promise<void> {
    this.focusHolders += 1;
    if (this.focusHolders === 1) await this.relay.setFocusEmulation(true);
  }

  /** One call is done with focus emulation: the last turns it off, unless the connection is gone (detaching ended it). */
  public async releaseFocus(): Promise<void> {
    if (this.focusHolders === 0) return;
    this.focusHolders -= 1;
    if (this.focusHolders === 0 && this.isOpen) await this.relay.setFocusEmulation(false);
  }

  public close(reason: string): void {
    this.relay.close(reason);
  }

  /** What a failed step means: the connection's end, if it ended, explains it best. */
  public explain(error: unknown): unknown {
    return this.closedReason ? new Error(this.closedReason) : error;
  }

  /** Throws the reason the connection ended, if it has. */
  public ensureOpen(): void {
    if (this.closedReason) throw new Error(this.closedReason);
  }

  public drain(): Pick<PageSnapshot, 'consoleErrors' | 'failedRequests' | 'dropped'> {
    const consoleErrors = this.consoleErrors.drain();
    const failedRequests = this.failedRequests.drain();
    return {
      consoleErrors: consoleErrors.items,
      failedRequests: failedRequests.items,
      dropped: { consoleErrors: consoleErrors.dropped, failedRequests: failedRequests.dropped },
    };
  }

  /** Lets the page free the objects it logged: nothing here reads them. */
  public releaseLoggedObjects(): void {
    const sessions = [...this.loggingSessions];
    this.loggingSessions.clear();
    this.loggedSinceRelease = 0;
    if (!this.isOpen) return;
    const { pageDebugger } = this;
    const params = { objectGroup: 'console' };
    for (const sessionId of sessions) {
      const sent = sessionId
        ? pageDebugger.sendCommand('Runtime.releaseObjectGroup', params, sessionId)
        : pageDebugger.sendCommand('Runtime.releaseObjectGroup', params);
      // A frame or worker that has gone has nothing left to free.
      sent.catch(() => {});
    }
  }

  private async connect(): Promise<Page> {
    let browser: Browser;
    try {
      browser = await this.options.connect(this.relay);
    } catch (error) {
      const reason = this.closedReason;
      // Playwright closes the transport itself when it fails; this makes sure.
      this.close(`Could not connect to the page: ${messageOf(error)}`);
      throw reason ? new Error(reason) : error;
    }
    if (this.closedReason) throw new Error(this.closedReason);
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page) {
      this.close(NO_PAGE_MESSAGE);
      throw new Error(NO_PAGE_MESSAGE);
    }
    context.setDefaultTimeout(PAGE_CALL_TIMEOUT_MS);
    return page;
  }

  /** The relay closed, whoever closed it: DevTools, the page, a flood, or main. */
  private onRelayClosed(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.pageDebugger.removeListener('message', this.onMessage);
    this.closing.abort(new Error(reason));
    this.options.closed(this);
  }

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId: string,
  ): void => {
    // A log entry can carry objects too (Playwright released them when it heard them).
    if (method === 'Runtime.consoleAPICalled' || (method === 'Log.entryAdded' && hasArgs(params))) {
      this.loggingSessions.add(sessionId ?? '');
      this.loggedSinceRelease += 1;
      if (this.loggedSinceRelease >= RELEASE_CONSOLE_EVERY) this.releaseLoggedObjects();
    }
    const event = readPageEvent(method, params, this.options.now());
    if (!event || event.entry.at <= this.options.reportedUntil()) return;
    if (event.kind === 'console-error') this.consoleErrors.push(event.entry);
    else this.failedRequests.push(event.entry);
  };
}

/**
 * Drives the in-app browser's pages for an agent's tools, with Playwright.
 *
 * Every call goes through `withPage` (or `snapshot`, built on it): it starts
 * an agent call on the tab (`AgentPages.beginToolCall`, which holds the tab
 * and waits for its live page), connects Playwright to that page if it is not
 * connected yet, runs the caller's steps, and ends the call however they
 * finish. One connection per live tab, each over its own `CdpRelay`: Ruling O
 * hands the relay to `chromium.connectOverCDP` in process, so nothing listens
 * on any port.
 *
 * A connection lasts until the tab's page goes (`forget`, from
 * `BrowserService.onGuestGone`), the tab gets another page, the app quits
 * (`closeAll`), or its relay closes itself: when the person opens DevTools on
 * the page (the person wins, and the next call is refused while DevTools
 * stays open), the page stops answering, or a call on it runs past its
 * deadline.
 *
 * What it keeps for a tab belongs to one page of it, the connection and what
 * was reported alike, so news that arrives after the tab moved on to another
 * page, or after a call was given up on, changes nothing.
 *
 * Nothing here focuses anything or brings a page to the front (Invariant 6).
 */
export class PageDriver {
  private readonly connections = new Map<string, Connection>();
  /**
   * Per tab, the page a snapshot last reported on and the newest entry it
   * reported, so a reconnect's replay of that page is not reported twice.
   */
  private readonly reported = new Map<string, { guest: WebContents; until: number }>();
  private readonly openRelay: (guest: RelayGuest, options: CdpRelayOptions) => DriverRelay;
  private readonly connect: (relay: DriverRelay) => Promise<Browser>;
  private readonly now: () => number;
  private readonly startTimer: (ms: number, fire: () => void) => () => void;

  constructor(private readonly deps: PageDriverDeps) {
    this.openRelay = deps.openRelay ?? ((guest, options) => CdpRelay.open(guest, options));
    this.connect = deps.connect ?? connectPlaywright;
    this.now = deps.now ?? Date.now;
    this.startTimer = deps.startTimer ?? startTimer;
  }

  /**
   * Runs `use` on the tab's page during one agent call, and returns what it
   * returns. Refuses as `AgentPages` does (no window, a blank tab, DevTools
   * open on the page, a page that does not start). A step cut off because the
   * connection ended fails with the reason it ended, and a call still running
   * at its deadline (`options.deadlineMs`, `CALL_DEADLINE_MS` by default)
   * fails with `pastDeadlineMessage`.
   */
  public withPage<T>(
    tabId: string,
    use: (page: Page, control: PageControl) => Promise<T>,
    options: CallOptions = {},
  ): Promise<T> {
    return this.run(tabId, (page, _connection, control) => use(page, control), options.deadlineMs);
  }

  /**
   * The page as an agent reads it: its outline with element refs, the
   * console errors and failed requests since the last snapshot, and, when
   * asked, a PNG of it. A screenshot that fails still answers with the rest.
   */
  public snapshot(tabId: string, options: { screenshot?: boolean } = {}): Promise<PageSnapshot> {
    return this.run(
      tabId,
      async (page, connection) => {
        // A page the call just mounted is usually still loading. Its document
        // is worth the wait; a page that never finishes parsing is read as is.
        await page
          .waitForLoadState('domcontentloaded', { timeout: PAGE_CALL_TIMEOUT_MS })
          .catch(() => {});
        let outline: string;
        try {
          outline = await page.ariaSnapshot({ mode: 'ai', timeout: PAGE_CALL_TIMEOUT_MS });
        } catch (error) {
          // A connection that ended explains it in Consola's words (`run`).
          throw connection.isOpen ? new PageStepError(error) : error;
        }
        let png: Buffer | undefined;
        let screenshotError: string | undefined;
        if (options.screenshot) {
          try {
            // CSS pixels: the page as laid out, at a size an agent can take in.
            png = await page.screenshot({
              type: 'png',
              scale: 'css',
              timeout: PAGE_CALL_TIMEOUT_MS,
            });
          } catch (error) {
            if (!connection.isOpen) throw error;
            screenshotError = messageOf(error);
          }
        }
        // A call given up on at its deadline, or whose connection ended while
        // it waited, reports nothing: what it collected stays unreported, and
        // the next connection's replay still carries it.
        connection.ensureOpen();
        const report = connection.drain();
        this.noteReported(tabId, connection.guest, [
          ...report.consoleErrors,
          ...report.failedRequests,
        ]);
        connection.releaseLoggedObjects();
        return {
          url: page.url(),
          // From main, at once: Playwright's `page.title()` is a round trip
          // to the page with no timeout of its own.
          title: connection.guest.getTitle(),
          outline,
          ...report,
          ...(png ? { png } : {}),
          ...(screenshotError ? { screenshotError } : {}),
        };
      },
      CALL_DEADLINE_MS,
    );
  }

  /** Whether an agent's connection is open on this page now. */
  public isConnected(guest: WebContents): boolean {
    for (const connection of this.connections.values()) {
      if (connection.guest === guest && connection.isOpen) return true;
    }
    return false;
  }

  /** The tabs an agent's connection is open on now. */
  public connectedTabs(): string[] {
    return [...this.connections]
      .filter(([, connection]) => connection.isOpen)
      .map(([tabId]) => tabId);
  }

  /**
   * Closes the agent's connection to a tab's page, for `reason` (its session
   * may no longer use the browser): a call still on the page fails with it,
   * and the debugger is free again, for the person's DevTools among others.
   */
  public disconnect(tabId: string, reason: string): void {
    this.connections.get(tabId)?.close(reason);
  }

  /**
   * The tab's page `guest` is gone: its connection closes, and the tab's
   * report starts afresh. News of a page the tab has since replaced changes
   * nothing.
   */
  public forget(tabId: string, guest: WebContents): void {
    if (this.reported.get(tabId)?.guest === guest) this.reported.delete(tabId);
    const connection = this.connections.get(tabId);
    if (connection?.guest === guest) connection.close(PAGE_GONE_MESSAGE);
  }

  /** The app is quitting. */
  public closeAll(): void {
    for (const connection of [...this.connections.values()]) connection.close(CLOSING_MESSAGE);
    this.connections.clear();
    this.reported.clear();
  }

  private async run<T>(
    tabId: string,
    use: (page: Page, connection: Connection, control: PageControl) => Promise<T>,
    requestedDeadlineMs: number | undefined,
  ): Promise<T> {
    const deadlineMs = clampDeadline(requestedDeadlineMs);
    const call = await this.deps.calls.beginToolCall(tabId);
    const ended = new AbortController();
    let connection: Connection | undefined;
    let holdsFocus = false;
    try {
      const current = this.connectionFor(tabId, call.guest);
      connection = current;
      const page = await current.ready;
      const control: PageControl = {
        signal: AbortSignal.any([ended.signal, current.closedSignal]),
        setFocusEmulation: async (enabled) => {
          // A step left running after its call ended must not switch it back on for nobody.
          if (enabled) ended.signal.throwIfAborted();
          if (enabled === holdsFocus) return;
          holdsFocus = enabled;
          await (enabled ? current.holdFocus() : current.releaseFocus());
        },
      };
      try {
        return await this.beforeDeadline(current, deadlineMs, ended, () =>
          use(page, current, control),
        );
      } catch (error) {
        throw error instanceof PastDeadlineError ? error : current.explain(error);
      }
    } finally {
      ended.abort(new Error('The call has ended.'));
      // Never waited on: a page showing a dialog answers it only once the
      // dialog is closed, and the call must not hold the tab until then.
      if (holdsFocus) connection?.releaseFocus().catch(() => {});
      call.end();
    }
  }

  /**
   * What `work` answers, unless `deadlineMs` pass first. A promise cannot be
   * cancelled, so giving up tells the call (`ended`) and closes the
   * connection the work runs on: every step still pending there fails at
   * once instead of acting on the page after its call has let go of the tab,
   * and the next call connects anew. Only that connection: if the tab has
   * moved on to another, it stays. A connection that had already ended
   * explains the call better than its deadline does.
   */
  private async beforeDeadline<T>(
    connection: Connection,
    deadlineMs: number,
    ended: AbortController,
    work: () => Promise<T>,
  ): Promise<T> {
    let stop = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      stop = this.startTimer(deadlineMs, () => {
        const failure = connection.isOpen
          ? new PastDeadlineError(pastDeadlineMessage(deadlineMs))
          : connection.explain(new Error(pastDeadlineMessage(deadlineMs)));
        ended.abort(failure);
        try {
          connection.close(ANOTHER_CALL_PAST_DEADLINE_MESSAGE);
        } catch (error) {
          console.warn('Could not close a page connection past its deadline:', messageOf(error));
        } finally {
          reject(failure);
        }
      });
    });
    try {
      const running = work();
      // Once given up on, what it does is nobody's concern.
      running.catch(() => {});
      return await Promise.race([running, deadline]);
    } finally {
      stop();
    }
  }

  /** The tab's open connection to this page, or a new one (throws when the relay cannot open). */
  private connectionFor(tabId: string, guest: WebContents): Connection {
    const current = this.connections.get(tabId);
    if (current?.guest === guest && current.isOpen) return current;
    current?.close(NEW_PAGE_MESSAGE);
    if (this.reported.get(tabId)?.guest !== guest) this.reported.delete(tabId);
    const connection = new Connection(guest, {
      openRelay: this.openRelay,
      connect: this.connect,
      now: this.now,
      reportedUntil: () => this.reportedUntil(tabId, guest),
      closed: (closed) => {
        if (this.connections.get(tabId) === closed) this.connections.delete(tabId);
        this.deps.disconnected?.(closed.guest);
      },
    });
    this.connections.set(tabId, connection);
    return connection;
  }

  /** The newest entry already reported for this page of the tab. */
  private reportedUntil(tabId: string, guest: WebContents): number {
    const reported = this.reported.get(tabId);
    return reported?.guest === guest ? reported.until : Number.NEGATIVE_INFINITY;
  }

  private noteReported(
    tabId: string,
    guest: WebContents,
    entries: ReadonlyArray<{ at: number }>,
  ): void {
    let until = this.reportedUntil(tabId, guest);
    for (const entry of entries) until = Math.max(until, entry.at);
    if (until > Number.NEGATIVE_INFINITY) this.reported.set(tabId, { guest, until });
  }
}
