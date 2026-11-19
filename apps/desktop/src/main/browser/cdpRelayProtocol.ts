/**
 * The Chrome DevTools Protocol that `CdpRelay` speaks to Playwright, with no IO.
 *
 * `webContents.debugger` is a channel to one page, while Playwright's
 * `connectOverCDP` expects a whole browser: it asks which pages exist,
 * attaches to them and only then talks to a page. So this answers the
 * browser-level questions itself, presenting a browser that has exactly one
 * page, and passes everything addressed to that page (or to the page's own
 * iframes and workers) through to the debugger. Any other browser-level
 * command is refused: nothing here can open, close or list another page, or
 * reach the partition's cookies.
 *
 * Messages are plain objects handed across in the same process, never
 * serialized. Every answer is written asynchronously, after `receive` has
 * returned: Playwright registers its callback for a command only once its
 * transport's `send` returns, so an answer written inside `send` would be lost.
 *
 * The approach follows T3 Code's `apps/desktop/src/preview/CdpRelay.ts`
 * (MIT, copyright T3 Tools Inc.), which worked out which commands Playwright
 * sends; the code is written fresh for Consola.
 */

/** The session id Playwright uses for the one page. */
export const PAGE_SESSION_ID = 'consola-page';
/** Playwright requires every page to name a browser context; this one is made up. */
const BROWSER_CONTEXT_ID = 'consola-browser-context';
/**
 * How many commands may wait on the page at once. Nothing else in the relay
 * holds anything: events go to Playwright as they arrive. But each command
 * holds a callback here and in Playwright until the page answers, and a page
 * stuck in a loop answers nothing while its console output keeps Playwright
 * sending (it releases each logged object). Playwright has a few dozen in
 * flight when it attaches, so only a page that has stopped answering reaches
 * this, and the connection is ended rather than left to grow.
 */
export const MAX_COMMANDS_IN_FLIGHT = 10_000;
/** JSON-RPC's "server error", the code Chromium itself uses for a refused command. */
const CDP_ERROR = -32000;

/** The page as the debugger describes it. */
export interface PageTarget {
  targetId: string;
  url: string;
  title: string;
}

/** What the relay needs of the one page it serves. */
export interface RelayPage {
  /** Sends to the page, or to one of its iframes or workers when `sessionId` names one. */
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown>;
  targetInfo(): Promise<PageTarget>;
  /** `Browser.getVersion`'s product, e.g. `Chrome/150.0.0.0`; Playwright reads the major version from it. */
  readonly product: string;
  readonly userAgent: string;
}

export interface RelayOutput {
  write(message: Record<string, unknown>): void;
  /** The connection cannot carry on. Called once; nothing is written after it. */
  fail(reason: string): void;
}

/** One client's conversation with the page. */
export interface RelayConnection {
  /** A message from the client. Never answered before this returns. */
  receive(message: unknown): void;
  /** An event from the debugger: `sessionId` is empty for the page's own events. */
  event(method: string, params: unknown, sessionId: string | undefined): void;
  /** Stops writing; replies still in flight are dropped. */
  close(): void;
}

type Message = Record<string, unknown>;

interface Command {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommand(value: unknown): value is Command {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    typeof value.method === 'string' &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.sessionId === undefined || typeof value.sessionId === 'string')
  );
}

/** A browser-level answer, and the event that must follow it, if any. */
interface Answer {
  result: unknown;
  followUp?: Message;
}

export function createRelayConnection(
  page: RelayPage,
  output: RelayOutput,
  maxCommandsInFlight: number = MAX_COMMANDS_IN_FLIGHT,
): RelayConnection {
  let closed = false;
  // Page events wait until Playwright has been told the page exists: before
  // that it has no session to file them under.
  let announced = false;
  let announcing = false;
  let inFlight = 0;
  // The relay's own sessions. A session id not listed here belongs to one of
  // the page's iframes or workers, which Chromium attached itself.
  const sessions = new Map<string, 'browser' | 'page'>([[PAGE_SESSION_ID, 'page']]);
  let sequence = 0;

  const newSession = (kind: 'browser' | 'page') => {
    sequence += 1;
    const sessionId = `consola-${kind}-${sequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };

  const write = (message: Message) => {
    if (!closed) output.write(message);
  };

  const fail = (reason: string) => {
    if (closed) return;
    closed = true;
    output.fail(reason);
  };

  const pageInfo = async () => {
    const target = await page.targetInfo();
    return {
      targetId: target.targetId,
      // Chromium calls a <webview> guest a "webview"; Playwright drives only "page".
      type: 'page',
      title: target.title,
      url: target.url,
      attached: true,
      canAccessOpener: false,
      browserContextId: BROWSER_CONTEXT_ID,
    };
  };

  const browserCommand = async (command: Command): Promise<Answer> => {
    const params = command.params ?? {};
    switch (command.method) {
      case 'Browser.getVersion':
        return {
          result: {
            protocolVersion: '1.3',
            product: page.product,
            revision: '',
            userAgent: page.userAgent,
            jsVersion: '',
          },
        };
      case 'Target.setDiscoverTargets':
      // Playwright asks to save downloads into its own folder. Downloads are
      // main's to allow or cancel, so the request is acknowledged and ignored.
      case 'Browser.setDownloadBehavior':
        return { result: {} };
      case 'Target.getTargetInfo': {
        if (params.targetId === undefined) {
          return {
            result: {
              targetInfo: {
                targetId: 'browser',
                type: 'browser',
                title: '',
                url: '',
                attached: true,
                canAccessOpener: false,
              },
            },
          };
        }
        const info = await pageInfo();
        if (params.targetId !== info.targetId) throw new Error('No such target.');
        return { result: { targetInfo: info } };
      }
      case 'Target.getTargets':
        return { result: { targetInfos: [await pageInfo()] } };
      case 'Target.getBrowserContexts':
        return { result: { browserContextIds: [] } };
      case 'Target.setAutoAttach': {
        if (announcing) return { result: {} };
        announcing = true;
        const targetInfo = await pageInfo();
        return {
          result: {},
          followUp: {
            method: 'Target.attachedToTarget',
            params: { sessionId: PAGE_SESSION_ID, targetInfo, waitingForDebugger: false },
          },
        };
      }
      case 'Target.attachToBrowserTarget':
        return { result: { sessionId: newSession('browser') } };
      case 'Target.attachToTarget': {
        const info = await pageInfo();
        if (params.targetId !== info.targetId) {
          throw new Error('Only this tab’s page can be attached.');
        }
        return { result: { sessionId: newSession('page') } };
      }
      case 'Target.detachFromTarget': {
        const sessionId = params.sessionId;
        // The relay's page session lasts as long as the connection.
        if (sessionId === PAGE_SESSION_ID) return { result: {} };
        if (typeof sessionId !== 'string' || !sessions.delete(sessionId)) {
          throw new Error('No such session.');
        }
        return { result: {} };
      }
      default:
        throw new Error(`${command.method} is not available: this connection serves one page.`);
    }
  };

  const pageCommand = async (command: Command, child: string | undefined): Promise<Answer> => {
    // Playwright asks for focus emulation on every page it attaches to, and
    // Chromium would then treat the page as focused for as long as the agent
    // stays connected. Main turns it on itself, and only while the agent acts.
    if (command.method === 'Emulation.setFocusEmulationEnabled') return { result: {} };
    // The page was attached while running, so it is not waiting; an iframe or
    // worker attached by Chromium is, and needs the command to start.
    if (command.method === 'Runtime.runIfWaitingForDebugger' && child === undefined) {
      return { result: {} };
    }
    return { result: await page.send(command.method, command.params ?? {}, child) };
  };

  const answer = (command: Command, outcome: Promise<Answer>) => {
    const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
    // `then` runs after `receive` has returned, never inside it, and replies
    // go out as each command finishes, so a slow one holds up nothing.
    outcome
      .then(
        ({ result, followUp }) => {
          write({ id: command.id, result: result ?? {}, ...route });
          if (followUp && !closed) {
            write(followUp);
            announced = true;
          }
        },
        (cause: unknown) =>
          write({
            id: command.id,
            error: {
              code: CDP_ERROR,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      )
      .finally(() => {
        inFlight -= 1;
      });
  };

  return {
    receive(message) {
      if (closed || !isCommand(message)) return;
      inFlight += 1;
      if (inFlight > maxCommandsInFlight) {
        fail('The page stopped answering while commands kept arriving.');
        return;
      }
      const kind = message.sessionId === undefined ? 'browser' : sessions.get(message.sessionId);
      if (kind === 'browser') {
        answer(message, browserCommand(message));
        return;
      }
      answer(message, pageCommand(message, kind === 'page' ? undefined : message.sessionId));
    },

    event(method, params, sessionId) {
      if (closed || !announced) return;
      if (sessionId) {
        write({ method, params, sessionId });
        return;
      }
      for (const [id, kind] of sessions) {
        if (kind === 'page') write({ method, params, sessionId: id });
      }
    },

    close() {
      closed = true;
    },
  };
}
