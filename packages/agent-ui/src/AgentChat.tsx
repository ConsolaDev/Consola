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
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Duration from 'effect/Duration';
import type * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import * as Stream from 'effect/Stream';
import { type JSX, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ChatView from '~/components/ChatView';
import { getThemeSnapshot, setAppearanceMode } from '~/hooks/useTheme';
import { connectionAtomRuntime } from '~/connection/runtime';
import { I18nProvider } from '~/i18n/I18nProvider';
import { startI18n } from '~/i18n/runtime';
import { AppAtomRegistryProvider, appAtomRegistry } from '~/rpc/atomRegistry';

// Every module above has run, t3's included: t3 may write the document again only through
// `sparingThePage`.
releaseImportHold();

export interface AgentChatProps {
  /** The host's address, `http(s)://host:port`. Its socket is `ws(s)://host:port/ws`. */
  readonly hostUrl: string;
  /** The session pass: the only credential the host takes. */
  readonly pass: string;
  /** The session the host serves; t3's environment and thread are both named by it. */
  readonly sessionId: string;
  /**
   * Called when the host refuses the pass (it expired); the chat reconnects with the pass it
   * answers. Without it, a refused pass leaves t3's own state for an environment it cannot
   * reach (with no thread to show, its empty state).
   */
  readonly onPassExpired?: () => Promise<string>;
}

/** The connection id of the host's registration, under which t3 keeps its credential. */
const connectionIdFor = (sessionId: string) => `consola-host:${sessionId}`;

/**
 * The host, as t3 registers a backend on an origin of its own that a bearer token lets in (a
 * desktop's secondary backend, `apps/web/src/connection/platform.ts`): the pass is that token.
 */
const hostRegistration = (hostUrl: string, sessionId: string, pass: string) => {
  const environmentId = EnvironmentId.make(sessionId);
  const connectionId = connectionIdFor(sessionId);
  const httpBaseUrl = new URL(hostUrl).origin;
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

/** The connection runtime's services, once t3's runtime has built them. */
const connectionServices = (): Promise<Context.Context<EnvironmentRegistry.EnvironmentRegistry>> =>
  new Promise((resolve, reject) => {
    const unsubscribe = appAtomRegistry.subscribe(
      connectionAtomRuntime,
      (result) => {
        if (result._tag === 'Success') {
          queueMicrotask(() => unsubscribe());
          resolve(result.value as Context.Context<EnvironmentRegistry.EnvironmentRegistry>);
        } else if (result._tag === 'Failure') {
          queueMicrotask(() => unsubscribe());
          reject(Cause.squash(result.cause));
        }
      },
      { immediate: true },
    );
  });

const runInConnection = <A, E>(
  effect: Effect.Effect<A, E, EnvironmentRegistry.EnvironmentRegistry>,
): Promise<Exit.Exit<A, E>> =>
  connectionServices().then((services) =>
    Effect.runPromiseExit(Effect.provideContext(effect, services)),
  );

/**
 * The hosts the mounted chats register, by session. t3's `reconcilePlatform` replaces every
 * platform registration at once, so each change hands it all of them: two chats on one page keep
 * both.
 */
const registered = new Map<string, BearerConnectionRegistration>();

const reconcileHosts = () => {
  const registrations = [...registered.values()];
  return runInConnection(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.reconcilePlatform(registrations);
    }),
  );
};

/** The host refused the pass: t3's resolver maps the host's `401` to this. */
const passRefused = (state: SupervisorConnectionState): boolean =>
  state.phase === 'blocked' &&
  state.lastFailure?._tag === 'ConnectionBlockedError' &&
  state.lastFailure.reason === 'authentication';

/**
 * Keeps the host registered with t3's connection while mounted, with the newest pass, and asks
 * for a new pass when the host refuses one. Unmounting removes the registration, which removes
 * the pass t3 stored for it.
 */
function useHostConnection(props: AgentChatProps) {
  const { hostUrl, sessionId, onPassExpired } = props;
  const [pass, setPass] = useState(props.pass);
  const onPassExpiredRef = useRef(onPassExpired);
  onPassExpiredRef.current = onPassExpired;
  // The last pass `onPassExpired` answered.
  const answeredPass = useRef<string | null>(null);

  useEffect(() => setPass(props.pass), [props.pass]);

  useEffect(() => {
    registered.set(sessionId, hostRegistration(hostUrl, sessionId, pass));
    void reconcileHosts();
  }, [hostUrl, sessionId, pass]);

  // t3's connection runtime stays up until the registration is removed, which removes its pass.
  useEffect(() => {
    const release = appAtomRegistry.mount(connectionAtomRuntime);
    return () => {
      registered.delete(sessionId);
      void reconcileHosts().finally(release);
    };
  }, [sessionId]);

  // A refusal counts only once t3 has tried this pass: the state it reports first can still be
  // the refusal of the pass this one replaced. A pass `onPassExpired` just answered that is
  // refused before it ever connects is not asked about again, so a page whose passes are all
  // refused leaves t3's own state in place instead of asking without end.
  useEffect(() => {
    const environmentId = EnvironmentId.make(sessionId);
    const answered = answeredPass.current === pass;
    let tried = false;
    let connected = false;
    let asked = false;
    let fiber: Fiber.Fiber<unknown, unknown> | undefined;
    let stopped = false;
    void connectionServices().then((services) => {
      if (stopped) return;
      const watch = Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.stateChanges(environmentId).pipe(
          // Until the registration lands the environment is unknown: look again shortly.
          Stream.retry(Schedule.spaced(Duration.millis(100))),
          Stream.runForEach((state) =>
            Effect.sync(() => {
              if (state.phase === 'connecting') tried = true;
              if (state.phase === 'connected') connected = true;
              const ask = onPassExpiredRef.current;
              if (!tried || asked || !passRefused(state) || ask === undefined) return;
              if (answered && !connected) return;
              asked = true;
              ask().then(
                (next) => {
                  answeredPass.current = next;
                  setPass(next);
                },
                () => {},
              );
            }),
          ),
        );
      });
      fiber = Effect.runFork(Effect.provideContext(watch, services));
    });
    return () => {
      stopped = true;
      if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [sessionId, pass]);
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
    const update = () => setDark(readDark(root.current));
    update();
    return subscribeColorScheme(update);
  }, [root]);
  useLayoutEffect(() => keepT3Appearance(dark), [dark]);
  return dark;
}

/**
 * t3's popups/ are Base UI portals at the end of `<body>`, outside the chat. While the chat is
 * mounted, each is marked as the chat's (`styles.css` styles inside it) and given the chat's
 * theme. A page that uses Base UI itself would see its own portals marked too.
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

function SessionChat(props: AgentChatProps) {
  useHostConnection(props);
  const router = useChatRouter(props.sessionId);
  return <RouterProvider router={router} />;
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
