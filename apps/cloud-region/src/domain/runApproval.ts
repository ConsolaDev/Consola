import { flatSteps } from '@consola/factory-spec';
import type { Automation, AutomationMode } from '@consola/factory-spec';
import type { RunStatus } from './run.js';
import type { Team } from './team.js';

/*
 * A run that waits for a person's approval (`needs-approval`): an automation in `confirm` mode,
 * one whose version has not been approved to run on its own, or a request whose orchestrator's
 * version has not been. Anyone on the factory's owning team may answer it (decided 2026-11-23),
 * literally its members, whatever their workspace role, and nobody else: an owner or admin who
 * sees every run answers only the runs of the teams they are in. The first answer for a version
 * is the one kept.
 *
 * The cell records the answer and never changes the run: its runner is the authority on the run,
 * and acts on the answer once it reads it (epic 21, CON-94).
 */

/** How a run's request to be approved was answered. */
export const APPROVAL_DECISIONS = ['approved', 'dismissed'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** What a person sends: approve the run, or dismiss it. */
export type ApprovalChoice = 'approve' | 'dismiss';

export const DECISION_OF: Record<ApprovalChoice, ApprovalDecision> = {
  approve: 'approved',
  dismiss: 'dismissed',
};

/** An answer, as the cell keeps it. */
export type RunAnswer = {
  readonly decision: ApprovalDecision;
  /** The global id of the person who answered. */
  readonly by: string;
  readonly at: string;
};

/** What approving lets run: each command, and each agent step, as the definition writes them. */
export type WillRun = {
  commands: Array<{ step: string; command: string }>;
  agents: Array<{ step: string; agent: string | null; prompt: string | null }>;
};

/** A run's request to be approved, as its page shows it. */
export type RunApproval = {
  /** The version an answer applies to: the run's factory version. */
  readonly version: number;
  readonly reason: string;
  /** Who may answer: anyone on this team. */
  readonly team: { readonly id: string; readonly name: string };
  /** Whether the caller is on that team. */
  readonly mayAnswer: boolean;
  readonly will: WillRun;
  readonly answer: RunAnswer | null;
};

/** The run an approval is about, as much of it as the approval says. */
export type ApprovalRun = {
  readonly kind: 'request' | 'automation';
  readonly status: RunStatus;
  readonly automation: string | null;
  readonly version: number;
};

/**
 * Why a run asks, in one plain sentence. `mode` is its automation's at the run's version, null
 * when that version does not define it (the reason is then the version's).
 */
export function approvalReason(run: ApprovalRun, mode: AutomationMode | null): string {
  if (run.kind === 'request') {
    return "This factory's orchestrator hasn't been approved at this version yet.";
  }
  const name = run.automation ?? 'This automation';
  if (mode === 'confirm') return `${name} asks before every run.`;
  return `Version ${run.version} of ${name} hasn't been approved to run on its own yet.`;
}

/**
 * What approving the automation's run lets run, step by step, the steps a loop repeats
 * included; nothing for none. A loop's block runs only its steps, and a gate runs nothing: a
 * person decides it.
 */
export function willRun(automation: Automation | null): WillRun {
  const will: WillRun = { commands: [], agents: [] };
  for (const { step } of flatSteps(automation?.steps ?? [])) {
    if (step.kind === 'run') will.commands.push({ step: step.id, command: step.run });
    else if (step.kind === 'agent') {
      will.agents.push({ step: step.id, agent: step.agent ?? null, prompt: step.prompt ?? null });
    }
  }
  return will;
}

/** Whether `personId` may answer a run of a factory `team` owns: whether they are on it. */
export function mayAnswer(team: Team, personId: string): boolean {
  return team.memberIds.includes(personId);
}

/**
 * A run's approval, or null for a run that neither waits for one nor was answered at its
 * version: it shows while the run needs approval, and once it is answered.
 */
export function approvalOf(input: {
  run: ApprovalRun;
  automation: Automation | null;
  team: Team;
  personId: string;
  answer: RunAnswer | null;
}): RunApproval | null {
  const { run, automation, team, answer } = input;
  if (run.status !== 'needs-approval' && answer === null) return null;
  return {
    version: run.version,
    reason: approvalReason(run, automation?.mode ?? null),
    team: { id: team.id, name: team.name },
    mayAnswer: mayAnswer(team, input.personId),
    will: run.kind === 'request' ? { commands: [], agents: [] } : willRun(automation),
    answer,
  };
}

/**
 * Whether the caller may answer the run now, in the order the route answers: on the factory's
 * team (`not-allowed`), the run waiting for approval (`not-waiting`), and the version they were
 * shown still the run's (`version-moved`). Whether the version was answered already is the
 * store's, which keeps the first answer.
 */
export function judgeAnswer(
  run: ApprovalRun,
  team: Team,
  personId: string,
  version: number,
): 'allowed' | 'not-allowed' | 'not-waiting' | 'version-moved' {
  if (!mayAnswer(team, personId)) return 'not-allowed';
  if (run.status !== 'needs-approval') return 'not-waiting';
  if (version !== run.version) return 'version-moved';
  return 'allowed';
}
