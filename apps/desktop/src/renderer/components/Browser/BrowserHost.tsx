import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { browserPartitionFor, type BrowserTabSnapshot } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { useBrowserSlotStore } from '../../stores/browserSlotStore';
import { forgetBrowser, loadBrowser, useBrowserStore } from '../../stores/browserStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { BrowserAuthDialog } from './BrowserAuthDialog';
import { BrowserError, useShownError } from './BrowserError';
import {
  autoRetryUrl,
  hostOrder,
  pageKey,
  liveTabs,
  pagePresence,
  retryDelayMs,
  visibleTabId,
  type PagePresence,
} from './browserView';
import './styles.css';

/** A press on one of these starts a drag that a page must not swallow. */
const DRAG_HANDLES = '[data-separator], .resize-handle, .sidebar-resize-handle';

/** The parts of Electron's `<webview>` element the host calls. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

/**
 * A page an agent is reading or capturing has to keep producing frames even
 * while nobody can see it.
 */
function mustKeepPainting(tab: BrowserTabSnapshot): boolean {
  return tab.agentActive;
}

/** A failed page action leaves the page as it was: nothing to undo, only to note. */
function noteFailure(action: Promise<unknown>): void {
  action.catch((error: unknown) => console.warn('In-app browser action failed:', error));
}

/** Tabs main refused to bind while this window held `workspaceId`. */
interface RefusedTabs {
  workspaceId: string | null;
  tabIds: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Every page of the workspace this window holds, mounted once at the layout's
 * root and drawn over the browser panel's slot.
 *
 * A `<webview>` loses its page when its element moves, so the elements never
 * live in the panel (which unmounts with every overlay and re-renders with
 * every session switch): they live here, in one parent, in the order they
 * were created (`hostOrder`), and are only ever added or removed. Each keeps
 * the address and partition it was created with; every later navigation goes
 * through main.
 */
export function BrowserHost() {
  const workspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId),
  );
  const snapshots = useBrowserStore((state) => state.snapshots);
  const slotSessionId = useBrowserSlotStore((state) => state.sessionId);
  const hostRef = useRef<HTMLDivElement>(null);

  const sessionIds = useMemo(
    () => new Set(workspace?.sessions.map((session) => session.id)),
    [workspace],
  );

  // A page main refused to bind is taken down rather than left running
  // unbound, and stays down until the window next changes workspace: mounting
  // it again from the same answer would only be refused again.
  const [refused, setRefused] = useState<RefusedTabs>({ workspaceId, tabIds: NONE });
  const refusedHere = refused.workspaceId === workspaceId ? refused.tabIds : NONE;
  const refuse = useCallback(
    (tabId: string, sessionId: string) => {
      setRefused((previous) => ({
        workspaceId,
        tabIds: new Set(previous.workspaceId === workspaceId ? previous.tabIds : NONE).add(tabId),
      }));
      // The tab may be gone, or have moved on since the snapshot that mounted it.
      noteFailure(loadBrowser(sessionId));
    },
    [workspaceId],
  );

  const live = liveTabs(sessionIds, snapshots).filter((hosted) => !refusedHere.has(hosted.tab.id));
  const tabs = new Map(live.map((hosted) => [pageKey(hosted.tab), hosted]));

  // Main pushes a session's changes only to the window holding its
  // workspace, so what is held for any other session (one of a workspace this
  // window left, or a deleted one) goes out of date unseen. It is dropped
  // rather than trusted on the way back: a page mounted from it would start
  // at an old address and bind over main's newer one.
  useEffect(() => {
    for (const sessionId of Object.keys(snapshots)) {
      if (!sessionIds.has(sessionId)) forgetBrowser(sessionId);
    }
  }, [sessionIds, snapshots]);

  const [order, setOrder] = useState<string[]>([]);
  const nextOrder = hostOrder(
    order,
    live.map((hosted) => pageKey(hosted.tab)),
  );
  if (nextOrder !== order) setOrder(nextOrder);

  const visible = visibleTabId(slotSessionId, snapshots);
  useReportVisible(slotSessionId, visible);
  useDragGuard(hostRef);

  return (
    <div ref={hostRef} className="browser-host">
      {nextOrder.map((key) => {
        const hosted = tabs.get(key);
        if (!hosted || !workspaceId) return null;
        return (
          <BrowserPage
            key={key}
            sessionId={hosted.sessionId}
            tab={hosted.tab}
            partition={browserPartitionFor(workspaceId)}
            presence={pagePresence(hosted.tab.id, visible, mustKeepPainting(hosted.tab))}
            onRefused={refuse}
          />
        );
      })}
      <BrowserAuthDialog />
    </div>
  );
}

interface BrowserPageProps {
  sessionId: string;
  tab: BrowserTabSnapshot;
  partition: string;
  presence: PagePresence;
  /** Main would not bind this page to its tab. */
  onRefused: (tabId: string, sessionId: string) => void;
}

function BrowserPage({ sessionId, tab, partition, presence, onRefused }: BrowserPageProps) {
  // Read once. Every later navigation goes through main, never through
  // `src` (that would skip main's checks and the tab's record), and Electron
  // refuses a partition change once a page has loaded.
  const [initial] = useState(() => ({ src: tab.url || 'about:blank', partition }));
  const webviewRef = useRef<WebviewElement>(null);
  const tabId = tab.id;
  useBindToTab(webviewRef, tabId, sessionId, onRefused);

  const shownError = useShownError(tab);
  const retryUrl = autoRetryUrl(shownError);
  useAutoRetry(tabId, shownError, presence === 'shown' && !tab.loading ? retryUrl : null);

  const retry = () => {
    if (!shownError) return;
    noteFailure(
      shownError.kind === 'crashed'
        ? browserBridge.reload(tabId)
        : browserBridge.navigate(tabId, shownError.url),
    );
  };

  return (
    <div className="browser-page" data-presence={presence} data-tab-id={tabId}>
      <webview
        ref={webviewRef}
        className="browser-page-webview"
        src={initial.src}
        partition={initial.partition}
        // Tells Electron this guest may ask for windows, which main's popup
        // policy then decides. A string, not `true`: React drops a boolean
        // on an element it does not know, and the typings only allow one.
        {...({ allowpopups: 'true' } as object)}
      />
      {tab.loading && <div className="browser-page-loading" aria-hidden="true" />}
      {shownError && (
        <BrowserError
          error={shownError}
          retryingByItself={retryUrl !== null}
          onRetry={retry}
          onBack={tab.canGoBack ? () => noteFailure(browserBridge.back(tabId)) : undefined}
          onContinue={() => noteFailure(browserBridge.continueCertificate(tabId))}
        />
      )}
    </div>
  );
}

/**
 * `did-attach` can arrive a moment before the element learns its page's id
 * (both come from main, as separate messages), so reading it is retried this
 * often, this many times, before leaving it to `dom-ready`.
 */
const BIND_RETRY_MS = 16;
const BIND_ATTEMPTS = 30;

/**
 * Binds the element to its tab, once, as soon as its page exists: on
 * `did-attach`, before the first load has gone anywhere, so a slow first load
 * already shows as loading, can be stopped, and gives way to an address typed
 * meanwhile. `dom-ready` is the last resort. Also closes the app's open menus
 * whenever the page takes focus.
 */
function useBindToTab(
  webviewRef: RefObject<WebviewElement | null>,
  tabId: string,
  sessionId: string,
  onRefused: (tabId: string, sessionId: string) => void,
): void {
  const bound = useRef(false);

  // Before paint, so the listeners are in place before main can report the attach.
  useLayoutEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const bind = (attempt: number) => {
      clearTimeout(retry);
      if (bound.current) return;
      let webContentsId: number;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        if (attempt < BIND_ATTEMPTS) retry = setTimeout(() => bind(attempt + 1), BIND_RETRY_MS);
        return;
      }
      bound.current = true;
      browserBridge.attach(tabId, webContentsId).then(
        (ok) => {
          if (!ok) onRefused(tabId, sessionId);
        },
        () => onRefused(tabId, sessionId),
      );
    };
    const onAttach = () => bind(0);
    const onDomReady = () => bind(BIND_ATTEMPTS);
    webview.addEventListener('did-attach', onAttach);
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('focus', closeAppMenus);
    return () => {
      clearTimeout(retry);
      webview.removeEventListener('did-attach', onAttach);
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('focus', closeAppMenus);
    };
  }, [webviewRef, tabId, sessionId, onRefused]);
}

/**
 * Retries a page on this machine that could not be reached, while it is on
 * screen and not already loading: a dev server that is still starting comes
 * up by itself. Waits 1 s, 2 s, 4 s and so on up to 10 s between attempts,
 * and starts over once a load succeeds or the address changes.
 */
function useAutoRetry(
  tabId: string,
  shownError: ReturnType<typeof useShownError>,
  retryUrl: string | null,
): void {
  const attempts = useRef({ url: '', count: 0 });
  useEffect(() => {
    if (!shownError) attempts.current = { url: '', count: 0 };
    if (!retryUrl) return;
    if (attempts.current.url !== retryUrl) attempts.current = { url: retryUrl, count: 0 };
    const timer = setTimeout(() => {
      attempts.current.count += 1;
      noteFailure(browserBridge.navigate(tabId, retryUrl));
    }, retryDelayMs(attempts.current.count));
    return () => clearTimeout(timer);
    // `shownError` is a new object for every failed attempt, which is what
    // schedules the next one.
  }, [tabId, shownError, retryUrl]);
}

/**
 * Tells main which tab the person is looking at, whenever that changes: a
 * page stays live while shown and is unloaded by main's rule once hidden for
 * long, so main has to know. Nothing (null) when the panel is closed, an
 * overlay covers it. (A window that moves to another workspace is let go of
 * by main itself.)
 */
function useReportVisible(sessionId: string | null, tabId: string | null): void {
  useEffect(() => {
    noteFailure(browserBridge.setVisible(tabId ? sessionId : null, tabId));
  }, [sessionId, tabId]);
}

/**
 * A click inside a page never reaches this document, so a menu open in the
 * app would stay open over it. When a page takes focus, tell the document a
 * press happened outside every menu: Radix closes its layers on `pointerdown`.
 */
function closeAppMenus(): void {
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

/**
 * A page swallows pointer events, so a drag stalls the moment the pointer
 * crosses it: a panel separator, the sidebar's edge, or a native drag of a
 * session or a file. While one is under way every page lets the pointer
 * through (`data-dragging`, read by the stylesheet).
 */
function useDragGuard(hostRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const start = () => {
      host.dataset.dragging = '';
    };
    const end = () => {
      delete host.dataset.dragging;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(DRAG_HANDLES)) start();
    };
    // A drag that ended where this document could not see it (dropped
    // outside the window) leaves no event behind. The next pointer move with
    // no button held is the first sign it is over.
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons === 0 && 'dragging' in host.dataset) end();
    };
    const listeners: Array<[EventTarget, string, EventListener]> = [
      [document, 'pointerdown', onPointerDown as EventListener],
      [window, 'pointerup', end],
      [window, 'pointercancel', end],
      [window, 'pointermove', onPointerMove as EventListener],
      [document, 'dragstart', start],
      [document, 'dragenter', start],
      [document, 'dragend', end],
      [document, 'drop', end],
    ];
    for (const [target, type, listener] of listeners) {
      target.addEventListener(type, listener, true);
    }
    return () => {
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener, true);
      }
    };
  }, [hostRef]);
}
