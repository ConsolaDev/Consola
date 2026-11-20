import type { WebContents } from 'electron';

/** How long after the person last pressed a key or a mouse button in a tab an agent may not act on it. */
export const PERSON_INPUT_GUARD_MS = 3_000;

/**
 * How long an act counts as just done after it returns. What a click starts
 * reaches main after the click itself has returned: a download a probe's
 * click started arrived the very millisecond its call ended.
 */
export const ACT_AFTERMATH_MS = 3_000;

/** What `act` answers within `PERSON_INPUT_GUARD_MS` of the person's input on the tab. */
export const PERSON_USING_TAB_MESSAGE = 'The person is using this tab.';

/** Whether input at `lastInputAt` means the person is still using the tab at `now`. */
export function personIsUsing(lastInputAt: number | undefined, now: number): boolean {
  return lastInputAt !== undefined && now - lastInputAt < PERSON_INPUT_GUARD_MS;
}

/** What a download's decision reads about the tab it came from. */
export interface DownloadFacts {
  /** An agent's act is under way on the tab, or the load an agent's move started has not settled. */
  actInFlight: boolean;
  /** When the last act on the tab ended. */
  actEndedAt?: number;
  /** When the person last pressed a key or a mouse button in the tab, or navigated it from the toolbar. */
  personInputAt?: number;
  /** An agent opened the tab (its `openedBy`; the gate adds it from the tab's record). */
  openedByAgent?: boolean;
  now: number;
}

/** Whether an agent's act is under way on the tab, or ended within `ACT_AFTERMATH_MS`. */
export function agentActing(
  facts: Pick<DownloadFacts, 'actInFlight' | 'actEndedAt' | 'now'>,
): boolean {
  return (
    facts.actInFlight ||
    (facts.actEndedAt !== undefined && facts.now - facts.actEndedAt < ACT_AFTERMATH_MS)
  );
}

/**
 * The person's last input in each tab, and the agent's acts on each.
 *
 * An agent never takes the person's keyboard, and it gives way when the
 * person is using a tab: `act` refuses within `PERSON_INPUT_GUARD_MS` of
 * their input there (`refusal`). Only the person's input is ever recorded:
 * what reaches a page's `before-input-event` and `before-mouse-event` as a
 * key or button going down. The relay lets an agent's Playwright send
 * nothing through the browser but mouse moves and the wheel
 * (`cdpRelayProtocol`), and acts press and type inside the page itself, so
 * no act of the agent's ever arrives here as a press. The person sending a
 * tab somewhere from Consola's own toolbar counts too
 * (`notePersonNavigation`); an agent's move never does.
 *
 * An agent's move of a tab (`noteAgentMove`) makes the tab's next load the
 * agent's: it counts as an act in flight until that load settles
 * (`noteLoadSettled`), however long that is. A tab with no page loads its
 * new address only when it is next shown or read, and a download from that
 * load is still the agent's doing.
 *
 * Holds a few facts per tab, and drops each once it no longer matters:
 * `tabExists` says when a tab with a move still pending is gone.
 */
export class PersonInput {
  private readonly lastInputAt = new Map<string, number>();
  private readonly actsInFlight = new Map<string, Set<symbol>>();
  private readonly lastActEndedAt = new Map<string, number>();
  /** Tabs whose next load an agent's move chose, until it settles. */
  private readonly movesPending = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tabExists: (tabId: string) => boolean = () => true,
  ) {}

  /** The person pressed a key or a mouse button in this tab's page. */
  public noteInput(tabId: string): void {
    this.forgetStale();
    this.lastInputAt.set(tabId, this.now());
  }

  /**
   * The person sent this tab somewhere from Consola's toolbar (an address,
   * back, forward, a reload): their input on it, as a press in its page is,
   * and its next load theirs rather than an agent's move.
   */
  public notePersonNavigation(tabId: string): void {
    this.noteInput(tabId);
    this.movesPending.delete(tabId);
  }

  /** An agent moved this tab: its next load is the agent's until it settles. */
  public noteAgentMove(tabId: string): void {
    this.forgetStale();
    this.movesPending.add(tabId);
  }

  /** The tab's page stopped loading: a move's load that settles counts as an act just ended. */
  public noteLoadSettled(tabId: string): void {
    if (!this.movesPending.delete(tabId)) return;
    this.forgetStale();
    this.lastActEndedAt.set(tabId, this.now());
  }

  /** Why an agent may not act on this tab now, or null when it may. */
  public refusal(tabId: string): string | null {
    return personIsUsing(this.lastInputAt.get(tabId), this.now()) ? PERSON_USING_TAB_MESSAGE : null;
  }

  /** An act starts on this tab; the returned function ends it (idempotent). */
  public beginAct(tabId: string): () => void {
    const token = Symbol(tabId);
    const acts = this.actsInFlight.get(tabId) ?? new Set<symbol>();
    acts.add(token);
    this.actsInFlight.set(tabId, acts);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const current = this.actsInFlight.get(tabId);
      if (current?.delete(token) && current.size === 0) this.actsInFlight.delete(tabId);
      this.forgetStale();
      this.lastActEndedAt.set(tabId, this.now());
    };
  }

  /** What a download from this tab is decided by (`decideDownload`). */
  public downloadFacts(tabId: string): DownloadFacts {
    const personInputAt = this.lastInputAt.get(tabId);
    const actEndedAt = this.lastActEndedAt.get(tabId);
    return {
      actInFlight: (this.actsInFlight.get(tabId)?.size ?? 0) > 0 || this.movesPending.has(tabId),
      ...(actEndedAt !== undefined ? { actEndedAt } : {}),
      ...(personInputAt !== undefined ? { personInputAt } : {}),
      now: this.now(),
    };
  }

  /** How many tabs it holds anything for. */
  public size(): number {
    return new Set([
      ...this.lastInputAt.keys(),
      ...this.actsInFlight.keys(),
      ...this.lastActEndedAt.keys(),
      ...this.movesPending,
    ]).size;
  }

  private forgetStale(): void {
    const now = this.now();
    for (const [tabId, at] of this.lastInputAt) {
      if (now - at >= PERSON_INPUT_GUARD_MS) this.lastInputAt.delete(tabId);
    }
    for (const [tabId, at] of this.lastActEndedAt) {
      if (now - at >= ACT_AFTERMATH_MS) this.lastActEndedAt.delete(tabId);
    }
    for (const tabId of this.movesPending) {
      if (!this.tabExists(tabId)) this.movesPending.delete(tabId);
    }
  }
}

/**
 * Hears a guest's page stop loading (`did-stop-loading`), for the tab the
 * page is bound to: what settles an agent's move (`noteLoadSettled`).
 */
export function watchLoadsSettling(
  guest: WebContents,
  tabIdOf: () => string | null,
  settled: (tabId: string) => void,
): void {
  guest.on('did-stop-loading', () => {
    const tabId = tabIdOf();
    if (tabId) settled(tabId);
  });
}

/**
 * Hears the person's input in a guest's page: a key going down
 * (`before-input-event`) or a mouse button going down (`before-mouse-event`),
 * for the tab the page is bound to. A page not bound yet is nobody's to count.
 * It only listens: the page gets its input as ever.
 */
export function watchPersonInput(
  guest: WebContents,
  tabIdOf: () => string | null,
  pressed: (tabId: string) => void,
): void {
  const heard = () => {
    const tabId = tabIdOf();
    if (tabId) pressed(tabId);
  };
  guest.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') heard();
  });
  guest.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') heard();
  });
}
