import { launchFieldsFor, type Harness } from '../../shared/harness';
import { resolveTitleSource, titleCallOptions, type TitleSource } from '../../shared/sessionTitles';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { HarnessDriverId, HarnessModel } from '../../shared/types';
import {
  scopeForSession,
  type Session,
  type SessionUpdates,
  type Workspace,
} from '../../shared/workspace';
import { findSessionByInstanceId } from '../attention';
import { describeError } from '../describeError';
import {
  toHarnessConfig,
  type HarnessConfig,
  type HarnessDriver,
  type TextGenerationRequest,
} from '../drivers/HarnessDriver';
import {
  TITLE_SCHEMA,
  buildInitialTitlePrompt,
  buildRegenerateTitlePrompt,
  formatConversationForTitle,
} from './titlePrompts';
import { isAwaitingName, sanitizeTitle, standInName } from './titleText';

type NameUpdates = Pick<SessionUpdates, 'name' | 'nameIsUserSet'>;
type ReadySource = Extract<TitleSource, { kind: 'ready' }>;

export interface SessionNamerDeps {
  getWorkspaces(): Workspace[];
  getHarnesses(): Harness[];
  /** WorkspaceService.updateSession. May throw. */
  updateSession(workspaceId: string, sessionId: string, updates: NameUpdates): void;
  getDriver(id: HarnessDriverId | undefined): HarnessDriver;
  /** What the harness's CLI says about one of its models; undefined when unknown. Never rejects. */
  modelInfo(harness: Harness, model: string): Promise<HarnessModel | undefined>;
  /** Defaults to a setTimeout promise; tests inject one. */
  delay?(ms: number): Promise<void>;
}

/**
 * When to look for a first message again after a `working` edge found none,
 * counted from that edge: the transcript write lands just after Enter, so the
 * stand-in shows about a second in.
 */
export const FIRST_PROMPT_RETRY_MS: readonly number[] = [400, 1200];
/** Waits before the second and third tries of a first title. */
export const TITLE_RETRY_MS: readonly number[] = [2000, 4000];

/** What the namer remembers about one session's current conversation. */
interface Tracker {
  conversationId: string;
  /** The checks running now, including any rerun they owe. */
  running?: Promise<void>;
  /** An edge arrived while checks were running. */
  runAgain: boolean;
  /** One of those edges was `working`. */
  againWorking: boolean;
  /** Where the next CLI-name read starts. */
  cliPosition: number;
  /** The CLI name last seen; undefined until there is a baseline. */
  lastCliName: string | null | undefined;
  /** Set on the first check: the conversation began here, unnamed, so any CLI name in it is a rename. */
  fresh?: boolean;
  /** First-prompt retries are pending. */
  retryScheduled: boolean;
}

interface Located {
  workspace: Workspace;
  session: Session;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The `title` of a structured answer, which can be any JSON value. */
function titleOf(answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return undefined;
  return (answer as { title?: unknown }).title;
}

/**
 * Names sessions from main. A session still called "New Session" gets a
 * stand-in from its first real message, then a generated title written by
 * compare-and-set, so any rename made meanwhile wins. A name given inside
 * the CLI is adopted as the person's own. Regenerate replaces a name on
 * request, typed or not.
 *
 * Fed by terminal status edges. Nothing here types into a terminal: every
 * read is of the CLI's own transcript, and every title is one throwaway call.
 */
export class SessionNamer {
  private readonly trackers = new Map<string, Tracker>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: SessionNamerDeps) {}

  statusChanged(instanceId: string, status: TerminalStatus): void {
    const found = findSessionByInstanceId(this.deps.getWorkspaces(), instanceId);
    if (!found || found.session.kind === 'assistant') return;
    void this.request(found.session, status === 'working');
  }

  /** Throws an Error worded for the person. */
  async regenerate(workspaceId: string, sessionId: string): Promise<void> {
    const workspace = this.deps.getWorkspaces().find((w) => w.id === workspaceId);
    const session = workspace?.sessions.find((s) => s.id === sessionId);
    if (!workspace || !session) throw new Error('This session no longer exists.');
    if (session.kind === 'assistant') throw new Error('The Assistant’s name is fixed.');
    const previous = { name: session.name, nameIsUserSet: session.nameIsUserSet === true };

    const harnesses = this.deps.getHarnesses();
    const source = resolveTitleSource(workspace, harnesses);
    if (source.kind === 'off') throw new Error('Titles are off for this workspace.');
    if (source.kind === 'unavailable') throw new Error(source.reason);
    const titleDriver = this.deps.getDriver(source.harness.driverId);
    if (!titleDriver.generateText) {
      throw new Error(`${source.harness.name} can’t write titles.`);
    }

    const { driver, config } = this.driverFor(session, harnesses);
    const record = driver.readConversation
      ? await driver.readConversation(config, session.claudeSessionId)
      : null;
    const conversation = record ? formatConversationForTitle(record) : '';
    if (!conversation) throw new Error('This session has no conversation to title yet.');

    const call = await this.titleCall(
      source,
      buildRegenerateTitlePrompt({
        conversation,
        previousTitle: session.name,
        scopeName: scopeForSession(workspace, session)?.name ?? '',
        instructions: source.instructions,
      }),
    );
    let answer: unknown;
    try {
      answer = await titleDriver.generateText(call.config, call.request);
    } catch (error) {
      throw new Error(describeError(error));
    }
    const title = sanitizeTitle(titleOf(answer));
    if (!title) throw new Error('The title model returned no title.');

    // A rename during the call wins; the person sees their own name.
    const current = this.unchanged(sessionId, previous.name, previous.nameIsUserSet);
    if (current) this.write(current, { name: title });
  }

  /** Resolves once nothing is in flight (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  /**
   * Runs the checks for one edge, or folds the edge into the checks already
   * running. Resolves when the checks that cover this edge are done.
   */
  private request(session: Session, working: boolean): Promise<void> {
    let tracker = this.trackers.get(session.id);
    // A new conversation (a harness switch, a fresh start) is read from its start.
    if (!tracker || tracker.conversationId !== session.claudeSessionId) {
      tracker = {
        conversationId: session.claudeSessionId,
        runAgain: false,
        againWorking: false,
        cliPosition: 0,
        lastCliName: undefined,
        retryScheduled: false,
      };
      this.trackers.set(session.id, tracker);
    }
    if (tracker.running) {
      tracker.runAgain = true;
      tracker.againWorking ||= working;
      return tracker.running;
    }
    const running = this.runChecks(session.id, tracker, working);
    tracker.running = running;
    this.track(running);
    return running;
  }

  private async runChecks(sessionId: string, tracker: Tracker, working: boolean): Promise<void> {
    let edgeWorking = working;
    try {
      for (;;) {
        await this.check(sessionId, tracker, edgeWorking);
        if (!tracker.runAgain) return;
        edgeWorking = tracker.againWorking;
        tracker.runAgain = false;
        tracker.againWorking = false;
      }
    } finally {
      // Cleared in the same step that last read `runAgain`, so no edge falls between.
      tracker.running = undefined;
    }
  }

  private async check(sessionId: string, tracker: Tracker, working: boolean): Promise<void> {
    const found = this.find(sessionId);
    if (!found) return;
    const { driver, config } = this.driverFor(found.session, this.deps.getHarnesses());

    try {
      await this.adoptCliName(found.session, tracker, driver, config);
    } catch (error) {
      console.error(`Could not read session ${sessionId}'s name from its CLI.`, error);
    }
    try {
      await this.writeStandIn(sessionId, tracker, driver, config, working);
    } catch (error) {
      console.error(`Could not read session ${sessionId}'s first message.`, error);
    }
  }

  /**
   * Adopts a name given inside the CLI (`/rename`) as the person's own. A name
   * already there when Consola first reads a conversation it did not see
   * begin — a fork's copied title, a rename made before — is a baseline, not
   * a rename.
   */
  private async adoptCliName(
    session: Session,
    tracker: Tracker,
    driver: HarnessDriver,
    config: HarnessConfig,
  ): Promise<void> {
    if (!driver.readCliNameSince) return;
    tracker.fresh ??= isAwaitingName(session);
    const read = await driver.readCliNameSince(config, tracker.conversationId, tracker.cliPosition);
    if (!read) return;
    tracker.cliPosition = read.next;

    if (tracker.lastCliName === undefined && !tracker.fresh) {
      tracker.lastCliName = read.name;
      return;
    }
    if (read.name === null || read.name === tracker.lastCliName) return;
    tracker.lastCliName = read.name;

    const title = sanitizeTitle(read.name);
    const current = this.find(session.id);
    if (title && current) this.write(current, { name: title, nameIsUserSet: true });
  }

  private async writeStandIn(
    sessionId: string,
    tracker: Tracker,
    driver: HarnessDriver,
    config: HarnessConfig,
    working: boolean,
  ): Promise<void> {
    const found = this.find(sessionId);
    if (!found || !isAwaitingName(found.session) || !driver.readFirstPrompt) return;

    const message = await driver.readFirstPrompt(config, tracker.conversationId);
    if (!message) {
      if (working && !tracker.retryScheduled) this.retryFirstPrompt(sessionId, tracker);
      return;
    }

    const current = this.find(sessionId);
    if (!current || !isAwaitingName(current.session)) return;
    const name = standInName(message);
    // A message reading "New Session" would leave it awaiting a name, and every
    // later edge would start another title call.
    if (isAwaitingName({ ...current.session, name })) return;
    if (!this.write(current, { name })) return;
    this.track(this.writeInitialTitle(sessionId, name, message));
  }

  /**
   * Looks again at each `FIRST_PROMPT_RETRY_MS` mark, counted from the edge.
   * Every wait runs out before this resolves, so `idle()` leaves no timer.
   */
  private retryFirstPrompt(sessionId: string, tracker: Tracker): void {
    tracker.retryScheduled = true;
    const marks = FIRST_PROMPT_RETRY_MS.map((ms) => this.wait(ms));
    const retries = async (): Promise<void> => {
      try {
        for (const mark of marks) {
          await mark;
          const found = this.find(sessionId);
          if (found && isAwaitingName(found.session)) await this.request(found.session, false);
        }
      } finally {
        tracker.retryScheduled = false;
      }
    };
    this.track(retries());
  }

  /**
   * The first generated title, written only while the session still carries
   * the stand-in it was asked for. Fails quietly: the stand-in stays.
   */
  private async writeInitialTitle(
    sessionId: string,
    standIn: string,
    message: string,
  ): Promise<void> {
    const found = this.find(sessionId);
    if (!found || found.session.name !== standIn) return;
    const { workspace, session } = found;
    const nameIsUserSet = session.nameIsUserSet === true;

    const source = resolveTitleSource(workspace, this.deps.getHarnesses());
    if (source.kind !== 'ready') return;
    const driver = this.deps.getDriver(source.harness.driverId);
    if (!driver.generateText) return;

    const call = await this.titleCall(
      source,
      buildInitialTitlePrompt({
        message,
        scopeName: scopeForSession(workspace, session)?.name ?? '',
        instructions: source.instructions,
      }),
    );

    let answer: unknown;
    for (let attempt = 0; ; attempt += 1) {
      // A rename has already won; another try would only spend tokens.
      if (!this.unchanged(sessionId, standIn, nameIsUserSet)) return;
      try {
        answer = await driver.generateText(call.config, call.request);
        break;
      } catch (error) {
        console.warn(
          `Title call for session ${sessionId} failed (try ${attempt + 1} of ${TITLE_RETRY_MS.length + 1}): ${describeError(error)}`,
        );
        const wait = TITLE_RETRY_MS[attempt];
        if (wait === undefined) return;
        await this.wait(wait);
      }
    }

    const title = sanitizeTitle(titleOf(answer));
    if (!title) return;
    const current = this.unchanged(sessionId, standIn, nameIsUserSet);
    if (current) this.write(current, { name: title });
  }

  /** One title call as the title harness makes it, with only the options its model supports. */
  private async titleCall(
    source: ReadySource,
    prompt: string,
  ): Promise<{ config: HarnessConfig; request: TextGenerationRequest }> {
    const model = await this.deps.modelInfo(source.harness, source.model);
    return {
      config: toHarnessConfig(launchFieldsFor(source.harness)),
      request: {
        prompt,
        schema: TITLE_SCHEMA,
        model: source.model,
        ...titleCallOptions(source, model),
      },
    };
  }

  /** The session, while its name and `nameIsUserSet` are still what a call started from. */
  private unchanged(sessionId: string, name: string, nameIsUserSet: boolean): Located | null {
    const found = this.find(sessionId);
    if (!found) return null;
    const { session } = found;
    return session.name === name && (session.nameIsUserSet === true) === nameIsUserSet
      ? found
      : null;
  }

  /** Writes through `updateSession`, which may throw; false when it did. */
  private write({ workspace, session }: Located, updates: NameUpdates): boolean {
    try {
      this.deps.updateSession(workspace.id, session.id, updates);
      return true;
    } catch (error) {
      console.error(`Could not rename session ${session.id}.`, error);
      return false;
    }
  }

  private find(sessionId: string): Located | null {
    for (const workspace of this.deps.getWorkspaces()) {
      const session = workspace.sessions.find((s) => s.id === sessionId);
      if (session) return { workspace, session };
    }
    return null;
  }

  /** The session's own driver and config. A harness with no record runs as the built-in. */
  private driverFor(
    session: Session,
    harnesses: Harness[],
  ): { driver: HarnessDriver; config: HarnessConfig } {
    const harness = harnesses.find((h) => h.id === session.harnessId);
    return {
      driver: this.deps.getDriver(harness?.driverId),
      config: toHarnessConfig(launchFieldsFor(harness)),
    };
  }

  private wait(ms: number): Promise<void> {
    return this.deps.delay ? this.deps.delay(ms) : sleep(ms);
  }

  /** Keeps background work visible to `idle()`; a failure is logged, never thrown. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error) => console.error('Session naming failed.', error))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}
