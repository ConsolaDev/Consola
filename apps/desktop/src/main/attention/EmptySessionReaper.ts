import type { Attention } from '../../shared/attention';
import { isBlankPageUrl } from '../../shared/browser';
import type { Session, Workspace } from '../../shared/workspace';
import { isAwaitingName } from '../sessionTitles/titleText';

export interface EmptySessionReaperDeps {
  getWorkspaces(): Workspace[];
  /** What main derived for every session right now. */
  attention(): ReadonlyMap<string, Attention>;
  /** Whether any window is showing this terminal, focused or not. */
  isShown(instanceId: string): boolean;
  /**
   * Whether the session's conversation holds a first message, read from its
   * CLI's own transcript (`readFirstPrompt`). Null when the CLI cannot say,
   * which keeps the session.
   */
  hasFirstMessage(session: Session): Promise<boolean | null>;
  /** Delete the session the way a person's delete does, worktree rules included. */
  remove(workspace: Workspace, session: Session): Promise<void>;
  /**
   * The session's browser tabs, as main holds them. Null when they cannot be
   * read, which keeps the session.
   */
  browserTabs(session: Session): readonly { url: string }[] | null;
}

/**
 * Whether a session may never have had a message: Consola never named it
 * from one, and no earlier conversation was carried into it.
 *
 * Necessary, not sufficient: the transcript decides. The name is what makes
 * the transcript's word safe to act on. Claude writes no transcript until the
 * first message, so for an empty session "none found" is the normal answer,
 * and it is also the answer for a transcript the harness record no longer
 * points at. A session that ever had a message was named from it
 * (`SessionNamer`), so it never gets this far, whatever the transcript says.
 * A name anyone chose keeps the session too, as does a fork, which is born
 * with its source's name.
 */
export function mayBeEmpty(session: Session): boolean {
  return isAwaitingName(session) && (session.priorConversations?.length ?? 0) === 0;
}

/**
 * Whether the session's browser was used: a tab holds an address, whoever
 * opened it. A person who only browsed in a session never typed to its
 * agent, and removing it would close their pages without a word. A blank tab
 * holds nothing to come back to. Tabs that cannot be read (null) count as
 * used, so nothing is thrown away unseen.
 */
export function browsedIn(tabs: readonly { url: string }[] | null): boolean {
  return tabs === null || tabs.some((tab) => !isBlankPageUrl(tab.url));
}

/**
 * Deletes settled sessions that never got a message, rather than keeping
 * them on the Settled shelf. Such a session holds nothing to come back to,
 * so shelving it only keeps an empty row.
 *
 * Runs after every auto-settle sweep, over everything settled, and right
 * after the person settles something by hand, over what they settled. The
 * sweep leaves alone a session a window is showing, since the person may be
 * about to type into it; a hand settle does not, because settling it was the
 * person's own gesture. Neither removes a session whose browser was used
 * (`browsedIn`).
 */
export class EmptySessionReaper {
  /** One pass at a time, so two never delete the same session. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EmptySessionReaperDeps) {}

  /** Every settled session no window is showing. Returns the ids removed. */
  public sweep(): Promise<string[]> {
    return this.enqueue(() => this.reap(undefined, false));
  }

  /** These sessions, just settled by the person. Returns the ids removed. */
  public settled(sessionIds: readonly string[]): Promise<string[]> {
    if (sessionIds.length === 0) return Promise.resolve([]);
    return this.enqueue(() => this.reap(new Set(sessionIds), true));
  }

  private enqueue(pass: () => Promise<string[]>): Promise<string[]> {
    const next = this.queue.then(pass, pass);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reap(only: ReadonlySet<string> | undefined, evenShown: boolean): Promise<string[]> {
    const eligible = (session: Session, attention: ReadonlyMap<string, Attention>) =>
      (only === undefined || only.has(session.id)) &&
      mayBeEmpty(session) &&
      attention.get(session.id) === 'settled' &&
      (evenShown || !this.deps.isShown(session.instanceId)) &&
      !this.browsed(session);

    const attention = this.deps.attention();
    const candidates = this.deps
      .getWorkspaces()
      .flatMap((workspace) => workspace.sessions.filter((session) => eligible(session, attention)));

    const removed: string[] = [];
    for (const candidate of candidates) {
      let hasMessage: boolean | null;
      try {
        hasMessage = await this.deps.hasFirstMessage(candidate);
      } catch (error) {
        console.error(`Could not read the transcript of session ${candidate.id}:`, error);
        hasMessage = null;
      }
      if (hasMessage !== false) continue;

      // Asked again after the wait: a first message, a rename or a window
      // opening it in between keeps it.
      const current = this.locate(candidate.id);
      if (!current || !eligible(current.session, this.deps.attention())) continue;
      try {
        await this.deps.remove(current.workspace, current.session);
        removed.push(current.session.id);
      } catch (error) {
        console.error(`Could not remove empty session ${candidate.id}:`, error);
      }
    }
    return removed;
  }

  /** `browsedIn`, keeping the session when its tabs cannot be read. */
  private browsed(session: Session): boolean {
    try {
      return browsedIn(this.deps.browserTabs(session));
    } catch (error) {
      console.error(`Could not read the browser tabs of session ${session.id}:`, error);
      return true;
    }
  }

  private locate(sessionId: string): { workspace: Workspace; session: Session } | undefined {
    for (const workspace of this.deps.getWorkspaces()) {
      const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
      if (session) return { workspace, session };
    }
    return undefined;
  }
}
