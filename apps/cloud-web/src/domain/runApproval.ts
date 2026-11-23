import { type CellRefusal, messageForCellRefusal } from './cell';
import type { RunApproval } from './runs';
import { agoInWords } from './runWords';
import type { WorkspaceMember } from './teams';

/**
 * Approving a run from the web: what its card says, and what every answer to an approval comes
 * to. Anyone on the factory's owning team may approve or dismiss a run that waits for it; the
 * cell decides who that is (`mayAnswer`) and records the first answer for the version. It does
 * not start or stop the run: its runner does, once it picks the answer up.
 */

/** What the person answers. */
export type ApprovalDecision = 'approve' | 'dismiss';

/** What sending an answer came to. */
export type ApproveAnswer =
  /** The cell recorded it; the approval as it holds it now. */
  | { kind: 'answered'; approval: RunApproval }
  /** The cell could not read the answer. */
  | { kind: 'invalid' }
  /** The person is not on the factory's owning team (any more). */
  | { kind: 'not-allowed' }
  /** No such run, or one the person no longer sees. */
  | { kind: 'not-found' }
  /** The run does not wait for an approval any more. */
  | { kind: 'not-waiting' }
  /** Someone answered this version first: the first answer wins. */
  | { kind: 'already-answered' }
  /** The run asks about another version of its factory than the one answered. */
  | { kind: 'version-moved' }
  | CellRefusal;

export const APPROVAL_TITLE = 'This run waits for approval';

/** Who may answer, said under what the run will do. */
export function approverWords(approval: Pick<RunApproval, 'team'>): string {
  return `Anyone on ${approval.team.name} can approve this.`;
}

/** Dismissing asks once, in place: what it does. */
export const DISMISS_QUESTION =
  'Dismiss this run? Its runner won’t start it, and nobody can approve it after.';

/** Who answered, as the receipt names them: the person, a member, or someone who left. */
function answererName(
  personId: string,
  meId: string,
  members: readonly WorkspaceMember[] | null,
): string {
  if (personId === meId) return 'you';
  if (members === null) return 'someone';
  return members.find((member) => member.id === personId)?.name ?? 'someone who left';
}

/**
 * The receipt of an answer, in one line: `Approved by you · 2m ago. It starts when its runner
 * picks it up.`, `Dismissed by Alice · 5m ago. Its runner won’t start it.`.
 */
export function receiptWords(
  answer: NonNullable<RunApproval['answer']>,
  meId: string,
  members: readonly WorkspaceMember[] | null,
  now: number,
): string {
  const who = answererName(answer.by, meId, members);
  const when = agoInWords(answer.at, now);
  return answer.decision === 'approved'
    ? `Approved by ${who} · ${when}. It starts when its runner picks it up.`
    : `Dismissed by ${who} · ${when}. Its runner won’t start it.`;
}

/** Why an answer did not go through, for the run's approval and its workspace. */
export function messageForApproveAnswer(
  answer: Exclude<ApproveAnswer, { kind: 'answered' }>,
  approval: Pick<RunApproval, 'team'>,
  workspace: { name: string; region: string },
): string {
  switch (answer.kind) {
    case 'invalid':
      return 'The region couldn’t read that answer. Reload the page and try again.';
    case 'not-allowed':
      return `Only people on ${approval.team.name} can answer this run, and you’re not on it now.`;
    case 'not-found':
      return 'This run isn’t here any more, or you no longer see it.';
    case 'not-waiting':
      return 'This run isn’t waiting for an approval any more.';
    case 'already-answered':
      return 'Someone answered this run first. Their answer is shown here now.';
    case 'version-moved':
      return 'This run now asks about another version of its factory. Read what it will run, then answer again.';
    default:
      return messageForCellRefusal(answer, workspace);
  }
}

/** A prompt's first line that says something, cut to a line's length: what an agent is asked. */
export function promptFirstLine(prompt: string | null, max = 120): string | null {
  const line = prompt
    ?.split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Whether approving lets anything run that the card can name: a request's lets none. */
export function willRunAnything(will: RunApproval['will']): boolean {
  return will.commands.length > 0 || will.agents.length > 0;
}
