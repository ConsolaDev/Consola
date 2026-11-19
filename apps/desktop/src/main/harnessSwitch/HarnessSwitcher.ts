import type { Harness } from '../../shared/harness';
import type {
  HarnessSwitchMode,
  HarnessSwitchPreview,
  HarnessSwitchResult,
} from '../../shared/harnessSwitch';
import type { HarnessDriverId } from '../../shared/types';
import {
  checkoutPathForSession,
  generateUuid,
  switchedSession,
  type ConversationLink,
  type HarnessSwitchChange,
  type Session,
  type Workspace,
} from '../../shared/workspace';
import { getDriver, toHarnessConfig, toolPolicyProblem, type HarnessDriver } from '../drivers';
import { launchFieldsFor, type SessionLauncher } from '../SessionLauncher';
import type { ConversationOpening, TerminalHarnessSwitch } from '../TerminalService';
import { handoffPrompt, renderHandoff } from './handoff';
import type { HandoffStore } from './HandoffStore';
import {
  conversationSupport,
  describeSwitch,
  planHarnessSwitch,
  type HarnessSwitchPlan,
} from './plan';

export interface HarnessSwitcherDeps {
  workspaces: {
    getAll(): Workspace[];
    switchHarness(workspaceId: string, sessionId: string, change: HarnessSwitchChange): Session;
  };
  /** Every harness record, archived ones included: a session's own may be archived. */
  harnesses: { getAll(): Harness[] };
  terminals: {
    get(instanceId: string): { switchRefusal(): string | null } | undefined;
    switchHarness(instanceId: string, change: Omit<TerminalHarnessSwitch, 'attentionUrl'>): void;
    destroy(instanceId: string): void;
  };
  launcher: Pick<SessionLauncher, 'startRecorded'>;
  handoffs: Pick<HandoffStore, 'write'>;
  /**
   * Drop what attention knows about a terminal's process: the new CLI says
   * nothing about the old one's held turns or open menus, and one without
   * hooks never would.
   */
  forgetAttention(instanceId: string): void;
  driverFor?: (id?: HarnessDriverId) => HarnessDriver;
  /** When a harness can be used again by any model, if its CLI said it is at its limit. */
  limitedUntil?: (harnessId: string) => number | undefined;
  newConversationId?: () => string;
  now?: () => Date;
}

/** One session and the harness it runs on now. */
interface SwitchSides {
  workspace: Workspace;
  session: Session;
  source: Harness | undefined;
  sourceName: string;
  sourceDriver: HarnessDriver;
}

/** What preparing a switch produced: how the conversation travels, and how the next one opens. */
interface Carried {
  mode: HarnessSwitchMode;
  opening?: ConversationOpening;
  handoffPath?: string;
}

/**
 * Moves a session onto another harness, in place: the same tab carries on,
 * on the new harness, with what was said so far.
 *
 * The conversation travels the best way the two drivers allow
 * (`planHarnessSwitch`): forked natively by a CLI that can, otherwise handed
 * over as a transcript the next agent reads first. Nothing here knows which
 * CLI either side runs.
 */
export class HarnessSwitcher {
  private readonly switching = new Set<string>();
  private readonly driverFor: (id?: HarnessDriverId) => HarnessDriver;
  private readonly newConversationId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: HarnessSwitcherDeps) {
    this.driverFor = deps.driverFor ?? getDriver;
    this.newConversationId = deps.newConversationId ?? generateUuid;
    this.now = deps.now ?? (() => new Date());
  }

  /** What switching to each harness the person could pick would do. */
  public preview(workspaceId: string, sessionId: string): HarnessSwitchPreview[] {
    const sides = this.sides(workspaceId, sessionId);
    return this.deps.harnesses
      .getAll()
      .filter((harness) => isSwitchTarget(harness, sides.session))
      .map((target): HarnessSwitchPreview => {
        const plan = this.plan(sides, target);
        const limitedUntil = this.deps.limitedUntil?.(target.id);
        return plan.ok
          ? {
              harnessId: target.id,
              ok: true,
              mode: plan.mode,
              summary: describeSwitch(plan.mode, target.name),
              ...(limitedUntil !== undefined ? { limitedUntil } : {}),
            }
          : { harnessId: target.id, ok: false, reason: plan.reason };
      });
  }

  public async switch(
    workspaceId: string,
    sessionId: string,
    targetHarnessId: string,
  ): Promise<HarnessSwitchResult> {
    if (this.switching.has(sessionId))
      throw new Error('This session is already switching harness.');
    this.switching.add(sessionId);
    try {
      const sides = this.sides(workspaceId, sessionId);
      const target = this.target(sides.session, targetHarnessId);
      const plan = this.plan(sides, target);
      if (!plan.ok) throw new Error(plan.reason);
      await this.ensureStarts(target);
      const switchedAt = this.now();
      const carried = await this.carry(sides, target, plan.mode, switchedAt);
      const session = await this.commit(sides, target, carried, switchedAt);
      return {
        session,
        mode: carried.mode,
        summary: switchSummary(sides.sourceName, target.name, carried.mode),
      };
    } finally {
      this.switching.delete(sessionId);
    }
  }

  /** The harness to switch to, if the person could pick it. */
  private target(session: Session, targetHarnessId: string): Harness {
    const target = this.deps.harnesses
      .getAll()
      .find((candidate) => candidate.id === targetHarnessId);
    if (target?.id === session.harnessId)
      throw new Error(`This session already runs on ${target.name}.`);
    if (!target || !isSwitchTarget(target, session))
      throw new Error('That harness is not available to switch to.');
    return target;
  }

  /**
   * Before anything changes: a session switched onto a CLI that will not
   * start would be stranded there, its conversation on the wrong side.
   */
  private async ensureStarts(target: Harness): Promise<void> {
    const fields = launchFieldsFor(target);
    const health = await this.driverFor(fields.driverId).probeHealth(toHarnessConfig(fields));
    if (!health.available) {
      throw new Error(
        `${target.name} cannot start${health.error ? `: ${health.error}` : ''}. Check it in Settings › Harnesses.`,
      );
    }
  }

  /**
   * Get the conversation where the target can use it, writing only what
   * nothing names yet: a transcript copied under the target harness, or a
   * handoff document. A conversation that is there with nothing in it yet
   * carries nothing, and the target simply starts fresh.
   *
   * One that cannot be found at all is refused, never taken for empty: the
   * session may have run somewhere its harness record does not point, and
   * a blank start in its place would look like the history was lost.
   */
  private async carry(
    sides: SwitchSides,
    target: Harness,
    mode: HarnessSwitchMode,
    switchedAt: Date,
  ): Promise<Carried> {
    const { session, source, sourceDriver } = sides;
    const sourceConfig = toHarnessConfig(launchFieldsFor(source));
    const notFound = () =>
      new Error(
        `Consola could not find this conversation’s transcript under ${sides.sourceName}. Nothing was changed. ` +
          `If nothing has been said in it yet, start a new session on ${target.name} instead.`,
      );
    if (mode === 'native') {
      const targetConfig = toHarnessConfig(launchFieldsFor(target));
      const result = await sourceDriver.transplantConversation!(
        sourceConfig,
        targetConfig,
        session.claudeSessionId,
      );
      if (result === 'missing') throw notFound();
      return { mode: 'native', opening: { forkFrom: session.claudeSessionId } };
    }
    if (mode === 'handoff') {
      const record = await sourceDriver.readConversation!(sourceConfig, session.claudeSessionId);
      if (!record) throw notFound();
      if (record.entries.length === 0) return { mode: 'unstarted' };
      const previous = [...(session.priorConversations ?? [])]
        .reverse()
        .find((link) => link.handoffPath)?.handoffPath;
      const document = renderHandoff(record, {
        sessionName: session.name,
        from: sides.sourceName,
        to: target.name,
        folder: checkoutPathForSession(sides.workspace, session) ?? '',
        switchedAt,
        ...(previous ? { previous } : {}),
      });
      const handoffPath = await this.deps.handoffs.write(
        session.id,
        session.harnessId,
        document,
        switchedAt,
      );
      return { mode: 'handoff', handoffPath, opening: { prompt: handoffPrompt(handoffPath) } };
    }
    return { mode: 'unstarted' };
  }

  /**
   * Move the record and the process together, so the record never names a
   * conversation nothing started. Everything awaited is done; what follows
   * is checked once more, then happens in one tick. A live terminal moves
   * right after the record is written. A session with no terminal starts on
   * the target first and its record is written after, so a failed write
   * stops it and leaves the session as it was.
   */
  private async commit(
    sides: SwitchSides,
    target: Harness,
    carried: Carried,
    switchedAt: Date,
  ): Promise<Session> {
    const { workspace, session } = sides;
    const current = this.sides(workspace.id, session.id).session;
    if (
      current.claudeSessionId !== session.claudeSessionId ||
      current.harnessId !== session.harnessId
    ) {
      throw new Error('This session changed while it was being switched. Try again.');
    }
    const lateRefusal = this.sessionRefusal(current);
    if (lateRefusal) throw new Error(lateRefusal);

    const claudeSessionId = this.newConversationId();
    const left: ConversationLink | undefined =
      carried.mode === 'unstarted'
        ? undefined
        : {
            harnessId: session.harnessId,
            claudeSessionId: session.claudeSessionId,
            continuedAs: claudeSessionId,
            endedAt: switchedAt.getTime(),
            carried: carried.mode,
            ...(carried.handoffPath ? { handoffPath: carried.handoffPath } : {}),
          };
    const change = {
      harnessId: target.id,
      claudeSessionId,
      left,
      keepName: carried.mode === 'handoff',
    };

    if (this.deps.terminals.get(session.instanceId)) {
      const switched = this.deps.workspaces.switchHarness(workspace.id, session.id, {
        ...change,
        hasStarted: true,
      });
      this.deps.terminals.switchHarness(session.instanceId, {
        launch: launchFieldsFor(target),
        claudeSessionId,
        ...(carried.opening ? { opening: carried.opening } : {}),
        // Shown by a CLI that keeps the main screen; one with its own (Claude) hides it until it exits.
        notice: carried.handoffPath
          ? `${switchSummary(sides.sourceName, target.name, carried.mode)} Transcript: ${carried.handoffPath}`
          : switchSummary(sides.sourceName, target.name, carried.mode),
      });
      this.deps.forgetAttention(session.instanceId);
      return switched;
    }

    // No process, and nothing to open with: only the record moves.
    if (!carried.opening) {
      return this.deps.workspaces.switchHarness(workspace.id, session.id, {
        ...change,
        hasStarted: false,
      });
    }

    await this.deps.launcher.startRecorded(
      workspace.id,
      switchedSession(current, { ...change, hasStarted: true }),
      { resume: false, forkFrom: carried.opening.forkFrom, initialPrompt: carried.opening.prompt },
      () => {
        // A pane that opened during the await started the old conversation.
        if (this.deps.terminals.get(session.instanceId)) {
          throw new Error('This session was opened while it was being switched. Try again.');
        }
      },
    );
    try {
      return this.deps.workspaces.switchHarness(workspace.id, session.id, {
        ...change,
        hasStarted: true,
      });
    } catch (error) {
      this.deps.terminals.destroy(session.instanceId);
      throw error;
    } finally {
      this.deps.forgetAttention(session.instanceId);
    }
  }

  private sides(workspaceId: string, sessionId: string): SwitchSides {
    const workspace = this.deps.workspaces
      .getAll()
      .find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (!workspace || !session) throw new Error('That session no longer exists.');
    const source = this.deps.harnesses
      .getAll()
      .find((candidate) => candidate.id === session.harnessId);
    return {
      workspace,
      session,
      source,
      sourceName: source?.name ?? 'its previous harness',
      sourceDriver: this.driverFor(launchFieldsFor(source).driverId),
    };
  }

  /** Why this session cannot switch to any harness right now, or null. */
  private sessionRefusal(session: Session): string | null {
    if (session.kind !== 'interactive') return 'Conductor sessions stay on their harness.';
    return this.deps.terminals.get(session.instanceId)?.switchRefusal() ?? null;
  }

  /** How the conversation would reach `target`, or why it cannot go there. */
  private plan(sides: SwitchSides, target: Harness): HarnessSwitchPlan {
    const sessionRefusal = this.sessionRefusal(sides.session);
    if (sessionRefusal) return { ok: false, reason: sessionRefusal };
    const targetFields = launchFieldsFor(target);
    const policyProblem = toolPolicyProblem(targetFields, sides.session.toolPolicy);
    if (policyProblem) return { ok: false, reason: policyProblem };
    return planHarnessSwitch({
      source: conversationSupport(sides.sourceDriver),
      target: conversationSupport(this.driverFor(targetFields.driverId)),
      sourceName: sides.sourceName,
      targetName: target.name,
      hasStarted: sides.session.hasStarted,
    });
  }
}

/** A harness the person could pick for this session: in circulation, and not the one it is on. */
function isSwitchTarget(harness: Harness, session: Session): boolean {
  return harness.enabled && !harness.archived && harness.id !== session.harnessId;
}

/** What a switch did, in a line for the person. */
function switchSummary(from: string, to: string, mode: HarnessSwitchMode): string {
  switch (mode) {
    case 'native':
      return `Switched from ${from} to ${to}. The conversation continues with its full history.`;
    case 'handoff':
      return `Switched from ${from} to ${to}. It starts by reading a transcript of the conversation.`;
    case 'unstarted':
      return `Switched from ${from} to ${to}.`;
  }
}
