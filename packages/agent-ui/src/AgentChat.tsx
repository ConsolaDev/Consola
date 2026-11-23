// First, so it runs before any of t3's modules: t3's theme module writes the document at import.
import { releaseImportHold, sparingThePage } from './t3Document.ts';
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from '@t3tools/client-runtime/connection';
import { EnvironmentId, ThreadId } from '@t3tools/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Duration from 'effect/Duration';
import * as Fiber from 'effect/Fiber';
import * as Stream from 'effect/Stream';
import { type JSX, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ChatView from '~/components/ChatView';
import { getThemeSnapshot, setAppearanceMode } from '~/hooks/useTheme';
import { connectionAtomRuntime } from '~/connection/runtime';
import {
  connectionIdFor,
  connectionServices,
  forgetStoredSession,
  restoreStoredPass,
  runInConnection,
} from './connection.ts';
import { hostHttpOrigin } from './hostAddress.ts';
import { copyInjectedStyles } from './injectedStyles.ts';
import { forgetUnheldSessions, heldByAnotherPage, holdSession } from './storedSessions.ts';
import { I18nProvider } from '~/i18n/I18nProvider';
import { startI18n } from '~/i18n/runtime';
import { AppAtomRegistryProvider, appAtomRegistry } from '~/rpc/atomRegistry';

// Every module above has run, t3's included: t3 may write the document again only through
// `sparingThePage`.
releaseImportHold();

export interface AgentChatProps {
  /**
   * The host's address, `http(s)://host:port` (or its socket's, `ws(s)://host:port`, read as
   * the same host over `http(s)://`). Its socket is `ws(s)://host:port/ws`.
   */
  readonly hostUrl: string;
  /** The session pass: the only credential the host takes. */
  readonly pass: string;
  /** The session the host serves; t3's environment and thread are both named by it. */
  readonly sessionId: string;
  /**
   * Called when the host refuses the pass (it expired); the chat reconnects with the pass it
   * answers. Without it, or when it fails (logged) or answers a pass the host refuses too, the
   * chat says its pass was refused.
   */
  readonly onPassExpired?: () => Promise<string>;
}

/**
 * The host, as t3 registers a backend on an origin of its own that a bearer token lets in (a
 * desktop's secondary backend, `apps/web/src/connection/platform.ts`): the pass is that token.
 */
const hostRegistration = (hostUrl: string, sessionId: string, pass: string) => {
  const environmentId = EnvironmentId.make(sessionId);
  const connectionId = connectionIdFor(sessionId);
  const httpBaseUrl = hostHttpOrigin(hostUrl);
  const ws = new URL(httpBaseUrl);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  const label = 'Consola';
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: ws.origin,
    }),
    credential: new BearerConnectionCredential({ token: pass }),
  });
};

/**
 * The hosts the mounted chats register, by session. t3's `reconcilePlatform` replaces every
 * platform registration at once, so each change hands it all of them: two chats on one page keep
 * both.
 */
const registered = new Map<
  string,
  Array<{ readonly owner: object; readonly registration: BearerConnectionRegistration }>
>();

/**
 * Two chats can show one session, and t3 keeps one registration (and one stored pass) per
 * session, so the chats share it, counted by owner. The newest pass wins: a chat that registers
 * (mounting, or renewing its pass) goes last, and the last one is what t3 is handed. Removing a
 * chat leaves the others' registration in place, and t3 drops the session (and its stored pass)
 * only when its last chat goes. A chat left on an older pass that the host refuses renews it
 * through its own `onPassExpired`.
 */
const addRegistration = (
  sessionId: string,
  owner: object,
  registration: BearerConnectionRegistration,
) => {
  const rest = (registered.get(sessionId) ?? []).filter((entry) => entry.owner !== owner);
  registered.set(sessionId, [...rest, { owner, registration }]);
};

/** Returns the registration the chat held, if any. */
const removeRegistration = (sessionId: string, owner: object) => {
  const entries = registered.get(sessionId) ?? [];
  const removed = entries.find((entry) => entry.owner === owner);
  const rest = entries.filter((entry) => entry.owner !== owner);
  if (rest.length === 0) registered.delete(sessionId);
  else registered.set(sessionId, rest);
  return removed?.registration;
};

/** Hands t3 the registrations of every mounted chat. Fails with t3's cause, as text. */
const reconcileHosts = async (): Promise<void> => {
  const registrations = [...registered.values()].map(
    (entries) => entries[entries.length - 1]!.registration,
  );
  const exit = await runInConnection(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.reconcilePlatform(registrations);
    }),
  );
  if (exit._tag === 'Failure') throw new Error(Cause.pretty(exit.cause));
};

const passOf = ({ credential }: BearerConnectionRegistration): string[] =>
  credential._tag === 'BearerConnectionCredential' ? [credential.token] : [];

/** The passes of every mounted chat's registration. */
const registeredPasses = (): string[] =>
  [...registered.values()].flatMap((entries) =>
    entries.flatMap(({ registration }) => passOf(registration)),
  );

/**
 * Logs a failure of the chat's own, which the page would otherwise never see, with `passes`
 * taken out: a cause from t3 can quote the registration it failed on.
 */
const logFailure = (message: string, error: unknown, passes: Iterable<string>) => {
  let detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const pass of passes) if (pass !== '') detail = detail.replaceAll(pass, '[pass]');
  console.error(`@consola/agent-ui: ${message}`, detail);
};

/**
 * Once per page, at its first registration: what t3 still keeps for sessions no page shows (a
 * window that closed without unmounting its chat), `storedSessions.ts`.
 */
let unheldSessionsForgotten = false;
const forgetUnheldSessionsOnce = () => {
  if (unheldSessionsForgotten) return;
  unheldSessionsForgotten = true;
  forgetUnheldSessions(async (sessionId) => {
    const exit = await runInConnection(forgetStoredSession(sessionId));
    if (exit._tag === 'Failure') throw new Error(Cause.pretty(exit.cause));
  }).then(
    (failures) => {
      for (const { sessionId, error } of failures) {
        logFailure(
          `could not remove what t3 keeps for session ${sessionId}.`,
          error,
          registeredPasses(),
        );
      }
    },
    (error) => logFailure('could not look for passes no page shows.', error, registeredPasses()),
  );
};

/** The host refused the pass: t3's resolver maps the host's `401` to this. */
const passRefused = (state: SupervisorConnectionState): boolean =>
  state.phase === 'blocked' &&
  state.lastFailure?._tag === 'ConnectionBlockedError' &&
  state.lastFailure.reason === 'authentication';

/**
 * How long the chat waits for its environment to show in t3's registry before it says it could
 * not connect: the registration lands within one reconcile, which is local, unless the page's hold
 * waits on another window removing the session's pass (`storedSessions.ts`). The chat keeps
 * watching after that, and the notice goes once t3 connects.
 */
const REGISTRATION_WAIT = Duration.seconds(10);

/**
 * Why the chat shows no conversation, when it is the chat's own doing rather than t3's: t3 shows
 * a host that went away (its offline banner), never a pass it was refused or a connection that
 * could not be set up.
 */
type ChatProblem =
  /** The host refused the pass, and no new one is coming. */
  | { readonly kind: 'pass-refused' }
  /** The host refused the pass, and `onPassExpired` failed (logged). */
  | { readonly kind: 'new-pass-failed' }
  /** The chat could not set up its connection to the host (logged). */
  | { readonly kind: 'connection-failed' };

/**
 * Keeps the host registered with t3's connection while mounted, with the newest pass, and asks
 * for a new pass when the host refuses one. Unmounting removes the registration, which removes
 * the pass t3 stored for it. Returns what keeps the conversation from showing, if anything.
 */
function useHostConnection(props: AgentChatProps): ChatProblem | null {
  const { hostUrl, sessionId, onPassExpired } = props;
  const [pass, setPass] = useState(props.pass);
  const [problem, setProblem] = useState<ChatProblem | null>(null);
  const onPassExpiredRef = useRef(onPassExpired);
  onPassExpiredRef.current = onPassExpired;
  // The last pass `onPassExpired` answered.
  const answeredPass = useRef<string | null>(null);
  // Whether this page holds the session (`storedSessions.ts`): it registers it only then.
  const [held, setHeld] = useState(false);
  // Which chat owns a registration of the session, when another chat shows it too.
  const owner = useRef({}).current;

  useEffect(() => setPass(props.pass), [props.pass]);

  useEffect(() => {
    if (!held) return;
    let registration: BearerConnectionRegistration;
    try {
      registration = hostRegistration(hostUrl, sessionId, pass);
    } catch (error) {
      logFailure(`the host address ${JSON.stringify(hostUrl)} is not a URL.`, error, [pass]);
      setProblem({ kind: 'connection-failed' });
      return;
    }
    addRegistration(sessionId, owner, registration);
    forgetUnheldSessionsOnce();
    reconcileHosts().catch((error) => {
      logFailure("could not register the host with t3's connection.", error, registeredPasses());
      setProblem({ kind: 'connection-failed' });
    });
  }, [held, hostUrl, sessionId, pass, owner]);

  // t3's connection runtime, and the page's hold on the session, stay until the registration is
  // removed, which removes its pass.
  useEffect(() => {
    const releaseRuntime = appAtomRegistry.mount(connectionAtomRuntime);
    let unmounted = false;
    let releaseSession: () => void = () => {};
    holdSession(sessionId).then(
      (release) => {
        if (unmounted) release();
        else {
          releaseSession = release;
          setHeld(true);
        }
      },
      (error) => {
        logFailure(`could not hold session ${sessionId} for this page.`, error, []);
        if (!unmounted) setProblem({ kind: 'connection-failed' });
      },
    );
    return () => {
      unmounted = true;
      const removed = removeRegistration(sessionId, owner);
      const passes = [...registeredPasses(), ...(removed === undefined ? [] : passOf(removed))];
      // The last chat of the session in this page: t3 is about to delete the pass, which is stored
      // for the whole origin. Another window that shows the session still needs it, so it is
      // asked before this page lets go (the page's own hold is still there).
      const lastOfSession = removed !== undefined && !registered.has(sessionId);
      const keptBy = lastOfSession
        ? heldByAnotherPage(sessionId).catch(() => false)
        : Promise.resolve(false);
      reconcileHosts()
        .then(async () => {
          const [token] = removed === undefined ? [] : passOf(removed);
          if (token === undefined || !(await keptBy)) return;
          const exit = await runInConnection(restoreStoredPass(sessionId, token));
          if (exit._tag === 'Failure') throw new Error(Cause.pretty(exit.cause));
        })
        .catch((error) =>
          logFailure("could not remove the host from t3's connection.", error, passes),
        )
        .finally(() => {
          releaseSession();
          releaseRuntime();
        });
    };
  }, [sessionId, owner]);

  // A refusal counts only once t3 has tried this pass: the state it reports first can still be
  // the refusal of the pass this one replaced. A pass `onPassExpired` just answered that is
  // refused before it ever connects is not asked about again, so a page whose passes are all
  // refused shows the refusal instead of asking without end.
  useEffect(() => {
    const environmentId = EnvironmentId.make(sessionId);
    const answered = answeredPass.current === pass;
    let tried = false;
    let connected = false;
    let asked = false;
    let fiber: Fiber.Fiber<unknown, unknown> | undefined;
    let stopped = false;
    const onState = (state: SupervisorConnectionState) => {
      if (state.phase === 'connecting') tried = true;
      if (state.phase === 'connected') {
        connected = true;
        setProblem(null);
      }
      if (!tried || asked || !passRefused(state)) return;
      const ask = onPassExpiredRef.current;
      if (ask === undefined || (answered && !connected)) {
        setProblem({ kind: 'pass-refused' });
        return;
      }
      asked = true;
      ask().then(
        (next) => {
          if (stopped) return;
          answeredPass.current = next;
          setPass(next);
        },
        (error) => {
          logFailure('onPassExpired failed, so the refused pass was not replaced.', error, [pass]);
          if (!stopped) setProblem({ kind: 'new-pass-failed' });
        },
      );
    };
    connectionServices().then(
      (services) => {
        if (stopped) return;
        const watch = Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          let shown = false;
          // t3's registry shows nothing of an environment until it is registered, then its state.
          const states = registry.stateChanges(environmentId).pipe(
            Stream.runForEach((state) =>
              Effect.sync(() => {
                shown = true;
                onState(state);
              }),
            ),
          );
          const deadline = Effect.sleep(REGISTRATION_WAIT).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (shown || stopped) return;
                logFailure(
                  "t3's connection has not shown the host's state after 10 seconds; still waiting.",
                  new Error("The host is not registered with t3's connection yet."),
                  [pass],
                );
                setProblem({ kind: 'connection-failed' });
              }),
            ),
          );
          yield* Effect.all([states, deadline], { concurrency: 'unbounded', discard: true });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (stopped) return;
              logFailure(
                "t3's connection never showed the host's state.",
                new Error(Cause.pretty(cause)),
                [pass],
              );
              setProblem({ kind: 'connection-failed' });
            }),
          ),
        );
        fiber = Effect.runFork(Effect.provideContext(watch, services));
      },
      (error) => {
        if (stopped) return;
        logFailure("t3's connection runtime did not start.", error, [pass]);
        setProblem({ kind: 'connection-failed' });
      },
    );
    return () => {
      stopped = true;
      if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [sessionId, pass]);

  return problem;
}

const PROBLEM_TEXT: Record<ChatProblem['kind'], { title: string; detail: string }> = {
  'pass-refused': {
    title: "The host refused this chat's pass",
    detail: 'It has expired or was revoked. Open the chat again to get a new one.',
  },
  'new-pass-failed': {
    title: "The host refused this chat's pass",
    detail: 'A new pass could not be fetched. Open the chat again to try once more.',
  },
  'connection-failed': {
    title: 'The chat could not connect to its host',
    detail: 'Something went wrong setting up the connection; the console says what.',
  },
};

/** What `AgentChat` shows over t3's view when the conversation cannot show (`styles.css`). */
function ChatProblemNotice({ problem }: { readonly problem: ChatProblem }) {
  const { title, detail } = PROBLEM_TEXT[problem.kind];
  return (
    <div className="consola-agent-ui-notice" role="alert">
      <p className="consola-agent-ui-notice-title">{title}</p>
      <p className="consola-agent-ui-notice-detail">{detail}</p>
    </div>
  );
}

/** Whether the chat is dark: the nearest `[data-theme]` (Consola's) says, else the system. */
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');
const readDark = (element: HTMLElement | null): boolean => {
  const theme = element?.closest('[data-theme]')?.getAttribute('data-theme');
  return theme === 'dark' || (theme !== 'light' && darkQuery().matches);
};
const subscribeColorScheme = (onChange: () => void) => {
  const query = darkQuery();
  query.addEventListener('change', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
    subtree: true,
  });
  return () => {
    query.removeEventListener('change', onChange);
    observer.disconnect();
  };
};

/**
 * t3's own code reads its appearance from its theme module (code highlighting, diffs), which
 * follows the system unless told otherwise. It is kept on the chat's theme instead, so it never
 * follows the system (and never applies the system's change to the document), and the change is
 * made without letting t3 write the page (`t3Document.ts`). t3 has one appearance per page.
 */
const keepT3Appearance = (dark: boolean) => {
  const mode = dark ? 'dark' : 'light';
  if (getThemeSnapshot().appearanceMode === mode) return;
  sparingThePage(() => setAppearanceMode(mode));
};

/** The chat's theme, read once it is in the page and whenever the page or the system changes. */
function useChatDark(root: RefObject<HTMLElement | null>): boolean {
  const [dark, setDark] = useState(() => readDark(null));
  useLayoutEffect(() => {
    // t3's appearance follows the value read from the page, never the first render's guess.
    const update = () => {
      const next = readDark(root.current);
      keepT3Appearance(next);
      setDark(next);
    };
    update();
    return subscribeColorScheme(update);
  }, [root]);
  return dark;
}

/**
 * t3's popups are Base UI portals at the end of `<body>`, outside the chat. While the chat is
 * mounted, each is marked as the chat's (`styles.css` styles inside it) and given the chat's
 * theme. A page that uses Base UI itself would see its own portals marked too, and then they
 * would be styled as the chat's, under its guard: none of the page's own CSS would reach them.
 */
function useMarkedPortals(dark: boolean) {
  useEffect(() => {
    const mark = () => {
      for (const portal of document.body.querySelectorAll(':scope > [data-base-ui-portal]')) {
        portal.classList.add('consola-agent-ui-portal');
        portal.classList.toggle('dark', dark);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [dark]);
}

/**
 * The one router t3's links and navigation hooks need, in memory: a root route that always shows
 * this session's chat, as t3's own tests render without routes (`apps/web/test/render.tsx`).
 */
function useChatRouter(sessionId: string) {
  const [router] = useState(() => {
    const environmentId = EnvironmentId.make(sessionId);
    const threadId = ThreadId.make(sessionId);
    return createRouter({
      routeTree: createRootRoute({
        component: () => (
          <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
        ),
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  });
  return router;
}

/**
 * One session's chat. `AgentChat` keys it by host and session, so a new `sessionId` (or
 * `hostUrl`) on a mounted chat starts it again: the old session's registration goes, and the new
 * one's hold, pass and registration start from nothing, so it is registered only once this page
 * holds it, and with the new pass (`AgentChat.sessionChange.browser.test.tsx`).
 */
function SessionChat(props: AgentChatProps) {
  const problem = useHostConnection(props);
  const router = useChatRouter(props.sessionId);
  return (
    <>
      <RouterProvider router={router} />
      {problem === null ? null : <ChatProblemNotice problem={problem} />}
    </>
  );
}

/** t3's language setup (`appInit.tsx` `startAppServices`), once per page. */
let i18nStarted = false;
const startI18nOnce = () => {
  if (i18nStarted) return;
  i18nStarted = true;
  startI18n();
};

/**
 * t3's chat for one `@consola/host` session. Everything inside is t3's, copied unchanged;
 * `import '@consola/agent-ui/styles.css'` styles it, and nothing outside this element.
 */
export function AgentChat(props: AgentChatProps): JSX.Element {
  startI18nOnce();
  const root = useRef<HTMLDivElement>(null);
  const dark = useChatDark(root);
  useMarkedPortals(dark);
  // Before the first paint, so the composer never shows a frame without its editor styles.
  useLayoutEffect(copyInjectedStyles, []);
  return (
    <div ref={root} className="consola-agent-ui">
      <div className={dark ? 'consola-agent-ui-theme dark' : 'consola-agent-ui-theme'}>
        <I18nProvider>
          <AppAtomRegistryProvider>
            <SessionChat key={`${props.hostUrl}|${props.sessionId}`} {...props} />
          </AppAtomRegistryProvider>
        </I18nProvider>
      </div>
    </div>
  );
}
