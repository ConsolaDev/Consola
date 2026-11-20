import type { WebContents } from 'electron';
import type { BrowserTab } from '../../shared/browser';

/** How long after the person last pressed a key or a mouse button in a tab an agent may not act on it. */
export const PERSON_INPUT_GUARD_MS = 3_000;

/** What `act` answers within `PERSON_INPUT_GUARD_MS` of the person's input on the tab. */
export const PERSON_USING_TAB_MESSAGE = 'The person is using this tab.';

/** Whether input at `lastInputAt` means the person is still using the tab at `now`. */
export function personIsUsing(lastInputAt: number | undefined, now: number): boolean {
  return lastInputAt !== undefined && now - lastInputAt < PERSON_INPUT_GUARD_MS;
}

/**
 * Whose hands a tab is in, for what its page does on its own (Ruling PP):
 * a download it starts is cancelled while it is in the agent's.
 */
export type TabHands = 'agent' | 'person';

/**
 * The person's last input in each tab, and whose hands each tab is in.
 *
 * An agent never takes the person's keyboard, and it gives way when the
 * person is using a tab: `act` refuses within `PERSON_INPUT_GUARD_MS` of
 * their input there (`refusal`). Only the person's input is ever recorded:
 * what reaches a page's `before-input-event` and `before-mouse-event` as a
 * key or button going down, and the tab moves they make from Consola's own
 * toolbar (`notePersonNavigation`). The relay lets an agent's Playwright send
 * nothing through the browser but mouse moves and the wheel
 * (`cdpRelayProtocol`), and acts press and type inside the page itself, so
 * no act of the agent's ever arrives here as a press.
 *
 * A tab is in the hands of whoever opened it, until the other takes it: the
 * agent by moving it, acting on it or answering its dialog (`noteAgentUse`),
 * the person by pressing in it or moving it from the toolbar. Looking at a
 * page takes nothing. There is no clock in this: a page the agent sent the
 * tab to can start a download long after it loads, and that is still the
 * agent's doing until the person takes the tab back. Only what differs from
 * a tab's opener is kept, so a tab nobody touched since a restart is in its
 * opener's hands.
 *
 * Holds two facts per tab, and drops each once it no longer matters: input
 * after the guard, a tab's hands once `tabExists` says the tab is gone.
 */
export class PersonInput {
  private readonly lastInputAt = new Map<string, number>();
  private readonly hands = new Map<string, TabHands>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tabExists: (tabId: string) => boolean = () => true,
  ) {}

  /** The person pressed a key or a mouse button in this tab's page: the tab is in their hands. */
  public noteInput(tabId: string): void {
    this.forgetStale();
    this.lastInputAt.set(tabId, this.now());
    this.hands.set(tabId, 'person');
  }

  /**
   * The person sent this tab somewhere from Consola's toolbar (an address,
   * back, forward, a reload): their input on it, as a press in its page is.
   */
  public notePersonNavigation(tabId: string): void {
    this.noteInput(tabId);
  }

  /** The agent moved this tab, acted on it, or answered its dialog: it is in the agent's hands. */
  public noteAgentUse(tabId: string): void {
    this.forgetStale();
    this.hands.set(tabId, 'agent');
  }

  /** Why an agent may not act on this tab now, or null when it may. */
  public refusal(tabId: string): string | null {
    return personIsUsing(this.lastInputAt.get(tabId), this.now()) ? PERSON_USING_TAB_MESSAGE : null;
  }

  /** When the person last pressed in this tab or moved it from the toolbar, while that counts. */
  public lastInput(tabId: string): number | undefined {
    return this.lastInputAt.get(tabId);
  }

  /** Whose hands the tab is in: whoever last took it, or else whoever opened it. */
  public handsOf(tabId: string, openedBy: BrowserTab['openedBy']): TabHands {
    return this.hands.get(tabId) ?? openedBy;
  }

  /** How many tabs it holds anything for. */
  public size(): number {
    return new Set([...this.lastInputAt.keys(), ...this.hands.keys()]).size;
  }

  private forgetStale(): void {
    const now = this.now();
    for (const [tabId, at] of this.lastInputAt) {
      if (now - at >= PERSON_INPUT_GUARD_MS) this.lastInputAt.delete(tabId);
    }
    for (const tabId of this.hands.keys()) {
      if (!this.tabExists(tabId)) this.hands.delete(tabId);
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
