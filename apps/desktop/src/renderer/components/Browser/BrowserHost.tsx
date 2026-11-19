import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { browserPartitionFor, type BrowserTabSnapshot } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { useBrowserSlotStore } from '../../stores/browserSlotStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { BrowserError, useShownError } from './BrowserError';
import {
  autoRetryUrl,
  hostOrder,
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
  const shownSessionIds = useBrowserSlotStore((state) => state.shownSessionIds);
  const hostRef = useRef<HTMLDivElement>(null);

  const sessionIds = useMemo(
    () => new Set(workspace?.sessions.map((session) => session.id)),
    [workspace],
  );
  const live = liveTabs(shownSessionIds, sessionIds, snapshots);
  const tabs = new Map(live.map((hosted) => [hosted.tab.id, hosted.tab]));

  const [order, setOrder] = useState<string[]>([]);
  const nextOrder = hostOrder(
    order,
    live.map((hosted) => hosted.tab.id),
  );
  if (nextOrder !== order) setOrder(nextOrder);

  const visible = visibleTabId(slotSessionId, snapshots);
  useDragGuard(hostRef);

  return (
    <div ref={hostRef} className="browser-host">
      {nextOrder.map((tabId) => {
        const tab = tabs.get(tabId);
        if (!tab || !workspaceId) return null;
        return (
          <BrowserPage
            key={tabId}
            tab={tab}
            partition={browserPartitionFor(workspaceId)}
            presence={pagePresence(tabId, visible, mustKeepPainting(tab))}
          />
        );
      })}
    </div>
  );
}

interface BrowserPageProps {
  tab: BrowserTabSnapshot;
  partition: string;
  presence: PagePresence;
}

function BrowserPage({ tab, partition, presence }: BrowserPageProps) {
  // Read once. Every later navigation goes through main, never through
  // `src` (that would skip main's checks and the tab's record), and Electron
  // refuses a partition change once a page has loaded.
  const [initial] = useState(() => ({ src: tab.url || 'about:blank', partition }));
  const webviewRef = useRef<WebviewElement>(null);
  const tabId = tab.id;
  useBindToTab(webviewRef, tabId);

  const shownError = useShownError(tab);
  const retryUrl = autoRetryUrl(shownError);
  useAutoRetry(tabId, shownError, presence === 'shown' && !tab.loading ? retryUrl : null);

  const retry = () => {
    if (!shownError) return;
    if (shownError.kind === 'crashed') void browserBridge.reload(tabId);
    else void browserBridge.navigate(tabId, shownError.url);
  };

  return (
    <div className="browser-page" data-presence={presence} data-tab-id={tabId}>
      <webview
        ref={webviewRef}
        className="browser-page-webview"
        src={initial.src}
        partition={initial.partition}
      />
      {tab.loading && <div className="browser-page-loading" aria-hidden="true" />}
      {shownError && (
        <BrowserError error={shownError} retryingByItself={retryUrl !== null} onRetry={retry} />
      )}
    </div>
  );
}

/** Chromium's code for a load another navigation replaced: not a failure. */
const LOAD_ABORTED = -3;

/**
 * Binds the element to its tab, once, when its first document is ready: the
 * earliest `getWebContentsId()` answers, and `dom-ready` fires again for
 * every later document. Also closes the app's open menus whenever the page
 * takes focus.
 */
function useBindToTab(webviewRef: RefObject<WebviewElement | null>, tabId: string): void {
  const bound = useRef(false);
  const firstLoadFailed = useRef(false);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    // A first load that fails does so before main is listening, and the error
    // page Chromium puts in its place is then ready like any document: main
    // would bind a tab that looks fine. Loading it again once bound lets
    // main see the failure, and the panel show it.
    const onFailLoad = (event: Event) => {
      const { errorCode, isMainFrame } = event as Event & {
        errorCode: number;
        isMainFrame: boolean;
      };
      if (!bound.current && isMainFrame && errorCode !== LOAD_ABORTED) {
        firstLoadFailed.current = true;
      }
    };
    const onDomReady = () => {
      if (bound.current) return;
      bound.current = true;
      void browserBridge.attach(tabId, webview.getWebContentsId()).then((ok) => {
        if (ok && firstLoadFailed.current) void browserBridge.reload(tabId);
      });
    };
    webview.addEventListener('did-fail-load', onFailLoad);
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('focus', closeAppMenus);
    return () => {
      webview.removeEventListener('did-fail-load', onFailLoad);
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('focus', closeAppMenus);
    };
  }, [webviewRef, tabId]);
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
      void browserBridge.navigate(tabId, retryUrl);
    }, retryDelayMs(attempts.current.count));
    return () => clearTimeout(timer);
    // `shownError` is a new object for every failed attempt, which is what
    // schedules the next one.
  }, [tabId, shownError, retryUrl]);
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
