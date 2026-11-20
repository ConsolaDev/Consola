import type { WebContents } from 'electron';
import type { BrowserTab } from '../../shared/browser';
import { isolated } from './isolated';

/**
 * How long after the person last pressed a key or a mouse button in a tab an
 * agent may not act on it, move it or close it, a dialog there is not held
 * for the agent, a tab its page opens is the person's, and a download from
 * it is theirs. It must outlast the
 * transient activation a real press leaves the page: Chromium keeps it for
 * about 5 s (`kActivationLifespan`), and a script run in that time (an
 * agent's evaluate, or a page handler an act sets off) could use the
 * person's press to open a file chooser or go fullscreen. 6 s is that 5 s
 * and a margin for the time between main hearing the press and the page
 * taking it.
 */
export const PERSON_INPUT_GUARD_MS = 6_000;

/** What `act` answers within `PERSON_INPUT_GUARD_MS` of the person's input on the tab. */
export const PERSON_USING_TAB_MESSAGE = 'The person is using this tab.';

/** Whether input at `lastInputAt` means the person is still using the tab at `now`. */
export function personIsUsing(lastInputAt: number | undefined, now: number): boolean {
  return lastInputAt !== undefined && now - lastInputAt < PERSON_INPUT_GUARD_MS;
}

/**
 * Whose hands a tab is in, for what its page does on its own: a download it
 * starts is cancelled while it is in the agent's, since an agent must not
 * put save dialogs nobody asked for in front of the person.
 */
export type TabHands = 'agent' | 'person';

/**
 * The person's last input in each tab, and whose hands each tab is in.
 *
 * An agent never takes the person's keyboard, and it gives way when the
 * person is using a tab: act, evaluate, navigate and close refuse within
 * `PERSON_INPUT_GUARD_MS` of their input there (`refusal`). Only the
 * person's input is ever recorded: what reaches a page's
 * `before-input-event` and `before-mouse-event` as a key or button going
 * down, and what they do from Consola's own controls
 * (`notePersonNavigation`): an address, back, forward, a reload or a hard
 * reload, "Continue anyway" past a certificate, a sign-in answered or
 * cancelled. Never the window's automatic retry. The relay lets an agent's
 * Playwright send nothing through the browser but a buttonless mouse move or
 * wheel (`cdpRelayProtocol`), and acts press and type inside the page
 * itself, so no act of the agent's ever arrives here as a press.
 *
 * A tab is in the hands of whoever opened it, until the other takes it: the
 * agent by moving it, acting or evaluating on it, answering its dialog, or a
 * call that has to load its page (`noteAgentUse`); the person by their input
 * on it. Looking at a
 * page takes nothing. There is no clock in this: a page the agent sent the
 * tab to can start a download long after it loads, and that is still the
 * agent's doing until the person takes the tab back. Nothing of this is
 * kept on disk, so after a restart every tab is back in its opener's hands.
 *
 * Holds two facts per tab, and drops each once it no longer matters: input
 * after the guard, a tab's hands once `tabExists` says the tab is gone.
 */
export class PersonInput {
  private readonly lastInputAt = new Map<string, number>();
  private readonly hands = new Map<string, TabHands>();
  private readonly listeners = new Set<(tabId: string) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tabExists: (tabId: string) => boolean = () => true,
  ) {}

  /** The person pressed a key or a mouse button in this tab's page: the tab is in their hands. */
  public noteInput(tabId: string): void {
    this.forgetStale();
    this.lastInputAt.set(tabId, this.now());
    this.hands.set(tabId, 'person');
    for (const listener of this.listeners) {
      isolated("A listener of the person's input", () => listener(tabId));
    }
  }

  /**
   * Calls `listener` with the tab of each input of the person's, a toolbar
   * move included (the download gate gives a session's browser back its one
   * uninvited download). Returns the unsubscribe.
   */
  public onInput(listener: (tabId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The person moved or answered for this tab from Consola's controls (an
   * address, back, forward, a reload or hard reload, "Continue anyway", a
   * sign-in answered or cancelled): their input on it, as a press in its
   * page is.
   */
  public notePersonNavigation(tabId: string): void {
    this.noteInput(tabId);
  }

  /**
   * The agent moved this tab, acted or evaluated on it, answered its dialog,
   * or a call of its loaded its page: it is in the agent's hands.
   */
  public noteAgentUse(tabId: string): void {
    this.forgetStale();
    this.hands.set(tabId, 'agent');
  }

  /** Why an agent may not act on this tab now, or null when it may. */
  public refusal(tabId: string): string | null {
    return personIsUsing(this.lastInputAt.get(tabId), this.now()) ? PERSON_USING_TAB_MESSAGE : null;
  }

  /**
   * When the person last pressed in this tab or moved it from the toolbar.
   * Undefined once it is long past (dropped some time after the guard), so
   * read it with `personIsUsing`.
   */
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
