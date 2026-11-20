import { type BrowserTab, isAllowedPageUrl } from '../../shared/browser';
import { personIsUsing, type TabHands } from './PersonInput';

/** What `setWindowOpenHandler` is told about a window a page wants to open. */
export interface PopupRequest {
  url: string;
  disposition: string;
  /** The `window.open` features string, e.g. `width=500,height=600`. */
  features: string;
}

/** What main knows about the page that is opening it. */
export interface PopupContext {
  /** The opener is bound to a tab of a session that still exists. */
  openerKnown: boolean;
  /** The opener is itself a popup window: nothing opens from those. */
  openerIsPopup: boolean;
  /** The person clicked or typed in the opener a moment ago. */
  recentPersonInput: boolean;
  /** The opener's session already has the most tabs it may have. */
  atTabCap: boolean;
  /** A popup this opener made is still open. */
  openerHasPopup: boolean;
}

export type PopupDecision =
  | { action: 'tab'; url: string }
  | { action: 'popup'; url: string; width: number; height: number }
  | { action: 'deny'; reason: string };

export interface PopupSize {
  width: number;
  height: number;
}

const MIN_SIDE = 200;
const MAX_SIDE = 1600;
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 700;

const clampSide = (value: number) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value)));

/**
 * The size a `window.open` features string asks for, or null when it asks for
 * none. A page that names a size wants a popup window (a sign-in dialog); one
 * that does not wants a tab. A missing side takes a default, and both are kept
 * within bounds. The caller builds the window from this size alone: nothing
 * else in the features string (frame, position, always-on-top, modal, ...) is
 * ever applied to it.
 */
export function parsePopupSize(features: string): PopupSize | null {
  let width: number | undefined;
  let height: number | undefined;
  for (const part of features.split(',')) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = Number.parseFloat(rawValue ?? '');
    if (!Number.isFinite(value)) continue;
    if (key === 'width' || key === 'innerwidth') width = value;
    if (key === 'height' || key === 'innerheight') height = value;
  }
  if (width === undefined && height === undefined) return null;
  return {
    width: clampSide(width ?? DEFAULT_WIDTH),
    height: clampSide(height ?? DEFAULT_HEIGHT),
  };
}

/**
 * What a page that calls `window.open` or follows a `target=_blank` link gets.
 *
 * A link wanting a new tab becomes a tab in the opener's session, at any
 * moment: it costs a tab, capped (whose it is and whether it shows is
 * `placePopupTab`'s to say). A sized popup is the one thing a page can
 * ask for that takes over the screen, so it must follow a click or key of the
 * person's; anything else is a script opening windows on its own. Nothing
 * opens from a popup, which stops a chain of them.
 *
 * Pure: the handler applies the answer to the real guest.
 */
export function decidePopup(request: PopupRequest, context: PopupContext): PopupDecision {
  if (context.openerIsPopup) return { action: 'deny', reason: 'a popup cannot open another' };
  if (!context.openerKnown) return { action: 'deny', reason: 'the opener is not a known page' };

  const size = parsePopupSize(request.features);
  const asksForWindow =
    request.disposition === 'new-window' ||
    request.disposition === 'foreground-tab' ||
    request.disposition === 'background-tab';
  if (!asksForWindow) return { action: 'deny', reason: 'not a window the page opened' };

  if (size) {
    // The blank page is how sign-in flows start: the opener fills it in after.
    if (request.url !== 'about:blank' && !isAllowedPageUrl(request.url)) {
      return { action: 'deny', reason: 'the address is not a web address' };
    }
    if (!context.recentPersonInput) {
      return { action: 'deny', reason: 'no click or key behind the popup' };
    }
    if (context.openerHasPopup) {
      return { action: 'deny', reason: 'this page already has a popup open' };
    }
    return { action: 'popup', url: request.url, ...size };
  }

  if (!isAllowedPageUrl(request.url)) {
    return { action: 'deny', reason: 'the address is not a web address' };
  }
  if (context.atTabCap) return { action: 'deny', reason: 'the session has too many tabs' };
  return { action: 'tab', url: request.url };
}

/** What main knows about the tab a page opened a new tab from (`decidePopup`'s `tab`). */
export interface PopupTabFacts {
  /** When the person last pressed a key or a mouse button in the opener's tab (`PersonInput`). */
  personInputAt?: number;
  now: number;
  /** Who opened the opener's tab. */
  openerOpenedBy: BrowserTab['openedBy'];
  /** An agent's tool call is on the opener's tab now (its `agentActive`). */
  agentCallInFlight: boolean;
  /** Whose hands the opener's tab is in (`PersonInput.handsOf`). */
  openerHands: TabHands;
}

export interface PopupTabPlacement {
  openedBy: BrowserTab['openedBy'];
  /** The new tab becomes the session's active tab; otherwise it opens behind the one showing. */
  activate: boolean;
}

/**
 * Whose a tab a page opened is, and whether it takes the person's view.
 *
 * A page opens tabs whenever it likes, and only the person's own press
 * makes one theirs to look at: input from them in the opener within
 * `PERSON_INPUT_GUARD_MS`, the window `act` gives way to as well. Any other
 * tab opens behind the one showing, never taking the person's view, and it
 * is the agent's when
 * the opener is an agent's tab or an agent is on it: a call, or the tab in
 * the agent's hands (it moved it or acted there, and the person has not
 * pressed in it since, so what a synthetic click starts, or the page the
 * agent sent it to, is the agent's doing). Then the agent can close what it
 * caused. Otherwise it stays the person's, behind. Cost if wrong: a tab the
 * person's press opened stays behind, and they click it.
 */
export function placePopupTab(facts: PopupTabFacts): PopupTabPlacement {
  if (personIsUsing(facts.personInputAt, facts.now)) return { openedBy: 'person', activate: true };
  const agentOnOpener =
    facts.openerOpenedBy === 'agent' || facts.agentCallInFlight || facts.openerHands === 'agent';
  return { openedBy: agentOnOpener ? 'agent' : 'person', activate: false };
}

/** A click or key counts as "behind" a popup for this long. */
export const PERSON_INPUT_MS = 1_500;

/**
 * Remembers when the person last pressed something in a page. Electron does
 * not say whether a `window.open` came from a gesture, so main watches the
 * input that reached the page instead.
 *
 * Only a person's input may `touch()` this: a mouse button or a key going
 * down that the page gets (`installPopupPolicy`). An agent sends no presses
 * through the browser (the relay refuses all `Input` but a buttonless mouse
 * move or wheel), so nothing of its reaches here.
 */
export class PersonInputClock {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  public touch(): void {
    this.last = this.now();
  }

  public isRecent(): boolean {
    return this.now() - this.last <= PERSON_INPUT_MS;
  }

  /** Spends the gesture: true once per press, so one click cannot open a string of popups. */
  public consume(): boolean {
    const recent = this.isRecent();
    this.last = Number.NEGATIVE_INFINITY;
    return recent;
  }
}

/**
 * A popup's window title. The page sets its own title freely, so the title
 * always leads with the origin the popup is really showing: a sign-in window
 * cannot pose as another site.
 */
export function popupTitle(url: string, pageTitle: string): string {
  let origin = url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'null') origin = parsed.origin;
  } catch {
    // Not an address: show it as it is.
  }
  const title = pageTitle.trim();
  return title ? `${origin} — ${title}` : origin;
}
