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
 * The approach follows T3 Code's `apps/desktop/src/preview/CdpRelay.ts`
 * (MIT, copyright T3 Tools Inc.), which worked out which commands Playwright
 * sends; the code is written fresh for Consola.
 */

/** The session id Playwright uses for the one page. */
export const PAGE_SESSION_ID = 'consola-page';
/** Playwright requires every page to name a browser context; this one is made up. */
const BROWSER_CONTEXT_ID = 'consola-browser-context';
/**
 * The largest single message the relay will write. A screenshot of a large
 * page runs to tens of megabytes of base64, so the ceiling is generous; it
 * exists so one runaway answer cannot be serialized into main's memory.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
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
  write(text: string): void;
  /** The connection cannot carry on. Called once; nothing is written after it. */
  fail(reason: string): void;
}

/** One client's conversation with the page. */
export interface RelayConnection {
  /** A raw message from the client. */
  receive(raw: string): void;
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
  maxMessageBytes: number = MAX_MESSAGE_BYTES,
): RelayConnection {
  let closed = false;
  // Page events wait until Playwright has been told the page exists: before
  // that it has no session to file them under.
  let announced = false;
  let announcing = false;
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

  const write = (message: Message): boolean => {
    if (closed) return false;
    if (jsonBytesUpTo(message, maxMessageBytes) > maxMessageBytes) return false;
    output.write(JSON.stringify(message));
    return true;
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

  const pageCommand = (command: Command, child: string | undefined): Promise<unknown> => {
    // Playwright asks for focus emulation on every page it attaches to, and
    // Chromium would then treat the page as focused for as long as the agent
    // stays connected. Main turns it on itself, and only while the agent acts.
    if (command.method === 'Emulation.setFocusEmulationEnabled') return Promise.resolve({});
    // The page was attached while running, so it is not waiting; an iframe or
    // worker attached by Chromium is, and needs the command to start.
    if (command.method === 'Runtime.runIfWaitingForDebugger' && child === undefined) {
      return Promise.resolve({});
    }
    return page.send(command.method, command.params ?? {}, child);
  };

  const answer = (command: Command, outcome: Promise<Answer>) => {
    const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
    const refuse = (message: string) =>
      write({ id: command.id, error: { code: CDP_ERROR, message }, ...route });
    // Replies go out as each command finishes, so a slow one holds up nothing.
    outcome.then(
      ({ result, followUp }) => {
        if (!write({ id: command.id, result: result ?? {}, ...route })) {
          refuse('The answer is too large for the relay to carry.');
          return;
        }
        if (followUp && write(followUp)) announced = true;
      },
      (cause: unknown) => refuse(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  return {
    receive(raw) {
      if (closed) return;
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const kind = command.sessionId === undefined ? 'browser' : sessions.get(command.sessionId);
      if (kind === 'browser') {
        answer(command, browserCommand(command));
        return;
      }
      const child = kind === 'page' ? undefined : command.sessionId;
      answer(
        command,
        pageCommand(command, child).then((result) => ({ result })),
      );
    },

    event(method, params, sessionId) {
      if (closed || !announced) return;
      const messages: Message[] = sessionId
        ? [{ method, params, sessionId }]
        : [...sessions]
            .filter(([, kind]) => kind === 'page')
            .map(([id]) => ({ method, params, sessionId: id }));
      for (const message of messages) {
        // Dropping an event would leave Playwright believing something about
        // the page that is no longer true, so an oversized one ends the
        // connection instead.
        if (!write(message)) {
          fail('The page sent an event too large for the relay to carry.');
          return;
        }
      }
    },

    close() {
      closed = true;
    },
  };
}

/** JSON's printable ASCII, which `JSON.stringify` writes one byte per character. */
const PLAIN = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** UTF-8 bytes `JSON.stringify` writes for a string, quotes included. */
function stringBytes(text: string): number {
  if (PLAIN.test(text)) return text.length + 2;
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += code >= 8 && code <= 13 && code !== 11 ? 2 : 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 6; // a lone surrogate is written as \udxxx
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** Whether JSON leaves a value out of an object (and writes `null` for it in an array). */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * The UTF-8 size of `JSON.stringify(value)`, counted without building the
 * string, for plain JSON data such as the debugger delivers. The count stops
 * once it passes `limit`, answering some number above it, so a message too
 * large to send costs a partial walk rather than a string as large as itself.
 */
export function jsonBytesUpTo(value: unknown, limit: number): number {
  let total = 0;
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string') {
      // Every UTF-16 unit takes at least a byte, so a string that long cannot fit.
      if (item.length + 2 > limit - total) {
        total = limit + 1;
        return false;
      }
      total += stringBytes(item);
    } else if (typeof item === 'number') {
      total += Number.isFinite(item) ? String(item).length : 4;
    } else if (typeof item === 'boolean') {
      total += item ? 4 : 5;
    } else if (item === null) {
      total += 4;
    } else if (Array.isArray(item)) {
      total += 2 + Math.max(item.length - 1, 0);
      for (const entry of item) {
        if (isOmitted(entry)) total += 4;
        else if (!visit(entry)) return false;
      }
    } else if (typeof item === 'object') {
      total += 2;
      let first = true;
      for (const [key, entry] of Object.entries(item)) {
        if (isOmitted(entry)) continue;
        total += first ? 1 : 2; // the colon, and the comma before every key but the first
        first = false;
        if (!visit(key) || !visit(entry)) return false;
      }
    }
    return total <= limit;
  };
  visit(value);
  return total;
}
