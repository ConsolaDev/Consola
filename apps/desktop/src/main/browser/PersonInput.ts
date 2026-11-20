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
  /** An agent's act is under way on the tab. */
  actInFlight: boolean;
  /** When the last act on the tab ended. */
  actEndedAt?: number;
  /** When the person last pressed a key or a mouse button in the tab. */
  personInputAt?: number;
  now: number;
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
 * no act of the agent's ever arrives here as a press.
 *
 * Holds two numbers per tab, and drops each once it no longer matters.
 */
export class PersonInput {
  private readonly lastInputAt = new Map<string, number>();
  private readonly actsInFlight = new Map<string, Set<symbol>>();
  private readonly lastActEndedAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The person pressed a key or a mouse button in this tab's page. */
  public noteInput(tabId: string): void {
    this.forgetStale();
    this.lastInputAt.set(tabId, this.now());
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
      actInFlight: (this.actsInFlight.get(tabId)?.size ?? 0) > 0,
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
  }
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
