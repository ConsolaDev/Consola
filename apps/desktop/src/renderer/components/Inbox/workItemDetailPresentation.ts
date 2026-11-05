import type { WorkItemComment, WorkItemDetails } from '../../../shared/workItemDetails';
import type { WorkItemRef } from '../../../shared/workItems';
import { formatAge } from './inboxPresentation';

type WorkItemType = WorkItemRef['type'];

/**
 * Presentation for the remote detail panel: how GitHub's raw states read,
 * and which semantic colour each one takes. Pure, so the wording is tested
 * once here rather than asserted through the DOM.
 *
 * A tone names a theme token, never a colour: `neutral` is secondary text,
 * `merged` is the one hue GitHub reserves for merged and completed work.
 */
export type Tone = 'success' | 'error' | 'warning' | 'merged' | 'accent' | 'neutral';

export interface Meta {
  label: string;
  tone: Tone;
}

type Check = WorkItemDetails['checks'][number];
export type CheckOutcome = 'failing' | 'pending' | 'passing' | 'skipped';

/** The states that offer "Fix failing checks in a session". */
const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const SKIPPED = new Set(['NEUTRAL', 'SKIPPED', 'STALE']);

export function isFailingCheck(state: string): boolean {
  return FAILING.has(state);
}

/** Anything GitHub has not finished deciding reads as pending, new states included. */
export function checkOutcome(state: string): CheckOutcome {
  if (FAILING.has(state)) return 'failing';
  if (state === 'SUCCESS') return 'passing';
  if (SKIPPED.has(state)) return 'skipped';
  return 'pending';
}

export const OUTCOME_TONE: Record<CheckOutcome, Tone> = {
  failing: 'error',
  pending: 'warning',
  passing: 'success',
  skipped: 'neutral',
};

const CHECK_LABELS: Record<string, string> = {
  SUCCESS: 'Passed',
  FAILURE: 'Failed',
  ERROR: 'Errored',
  STARTUP_FAILURE: 'Failed to start',
};

/** `IN_PROGRESS` → "In progress". */
function sentence(state: string): string {
  const words = state.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function checkLabel(state: string): string {
  return CHECK_LABELS[state] ?? sentence(state);
}

export interface CheckSummary {
  failing: number;
  pending: number;
  passing: number;
  skipped: number;
  total: number;
}

export function summarizeChecks(checks: Check[]): CheckSummary {
  const summary: CheckSummary = { failing: 0, pending: 0, passing: 0, skipped: 0, total: checks.length };
  for (const check of checks) summary[checkOutcome(check.state)]++;
  return summary;
}

const OUTCOME_ORDER: CheckOutcome[] = ['failing', 'pending', 'passing', 'skipped'];

/** Failing first, as github.com lists them; stable within a group. */
export function sortChecks(checks: Check[]): Check[] {
  return checks
    .map((check, index) => ({ check, index, rank: OUTCOME_ORDER.indexOf(checkOutcome(check.state)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ check }) => check);
}

export function checksSentence(summary: CheckSummary): string {
  if (summary.total === 0) return 'No checks';
  const parts = [
    summary.failing && `${summary.failing} failing`,
    summary.pending && `${summary.pending} pending`,
    summary.passing && `${summary.passing} passed`,
    summary.skipped && `${summary.skipped} skipped`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export type StatusKind = 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed' | 'issue-open' | 'issue-closed';

/** The state badge. A completed issue is purple on GitHub, not red. */
export function itemStatus(type: WorkItemType, state: string, isDraft: boolean): Meta & { kind: StatusKind } {
  if (type === 'issue') {
    return state === 'open'
      ? { label: 'Open', tone: 'success', kind: 'issue-open' }
      : { label: 'Closed', tone: 'merged', kind: 'issue-closed' };
  }
  if (state === 'merged') return { label: 'Merged', tone: 'merged', kind: 'pr-merged' };
  if (state === 'closed') return { label: 'Closed', tone: 'error', kind: 'pr-closed' };
  if (isDraft) return { label: 'Draft', tone: 'neutral', kind: 'pr-draft' };
  return { label: 'Open', tone: 'success', kind: 'pr-open' };
}

/** Same words as the Inbox row (reviewStateLabel), so the two never disagree. */
export function reviewMeta(decision: string | undefined): Meta {
  switch (decision) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'success' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', tone: 'error' };
    case 'REVIEW_REQUIRED':
      return { label: 'Awaiting approval', tone: 'warning' };
    default:
      return { label: 'No review yet', tone: 'neutral' };
  }
}

/** GitHub's mergeStateStatus, in words a reviewer acts on. */
export function mergeStateMeta(state: string, baseBranch: string | undefined): Meta {
  switch (state) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { label: 'Ready to merge', tone: 'success' };
    case 'UNSTABLE':
      return { label: 'Mergeable, but checks are not passing', tone: 'warning' };
    case 'BLOCKED':
      return { label: 'Blocked until requirements pass', tone: 'warning' };
    case 'BEHIND':
      return { label: `Behind ${baseBranch ?? 'the base branch'}`, tone: 'warning' };
    case 'DIRTY':
      return { label: 'Merge conflicts', tone: 'error' };
    case 'UNKNOWN':
      return { label: 'Checking mergeability', tone: 'neutral' };
    default:
      return { label: sentence(state), tone: 'neutral' };
  }
}

/**
 * GitHub's merge button for a mergeStateStatus, which GitHub keeps for us.
 *
 * - `go`: green, nothing stands in the way (CLEAN, HAS_HOOKS).
 * - `plain`: allowed, but not green -- only optional checks are failing
 *   (UNSTABLE), so GitHub merges on request without endorsing it.
 * - `disabled`: GitHub would refuse. Blocked by requirements, behind a base
 *   that must be merged in, conflicted, a draft, or still being worked out.
 *
 * `canQueue` is whether auto-merge can wait out the refusal instead, as
 * GitHub offers "Enable auto-merge" in place of the disabled button. Only
 * requirements can be waited out: conflicts need a person, and a PR that
 * can merge now has nothing to wait for. Unrecognised and absent states are
 * refused, since green must never promise a merge GitHub will reject.
 */
export interface MergeGate {
  button: 'go' | 'plain' | 'disabled';
  canQueue: boolean;
}

export function mergeGate(state: string | undefined): MergeGate {
  switch (state) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { button: 'go', canQueue: false };
    case 'UNSTABLE':
      return { button: 'plain', canQueue: false };
    case 'BLOCKED':
    case 'BEHIND':
      return { button: 'disabled', canQueue: true };
    default:
      return { button: 'disabled', canQueue: false };
  }
}

/** "ellen-sprocket requested changes". Only verdicts carry a colour. */
export function commentVerb(comment: WorkItemComment): { verb: string; tone?: Tone } {
  if (comment.kind === 'inline') return { verb: 'commented on' };
  if (comment.kind === 'comment') return { verb: 'commented' };
  switch (comment.state) {
    case 'APPROVED':
      return { verb: 'approved these changes', tone: 'success' };
    case 'CHANGES_REQUESTED':
      return { verb: 'requested changes', tone: 'error' };
    case 'DISMISSED':
      return { verb: 'left a review, since dismissed' };
    default:
      return { verb: 'reviewed' };
  }
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** "3h ago" for recent activity, a date once relative time stops helping. */
export function commentAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  if (now - at < MONTH_MS) return formatAge(at, now);
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  /** The raw line, sign included, so copying a diff copies the diff. */
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified-diff patch as rows, each side numbered from its hunk header. */
export function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of lines) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text });
    } else if (text.startsWith('\\')) {
      rows.push({ kind: 'note', text });
    } else if (text.startsWith('+')) {
      rows.push({ kind: 'add', text, newLine: newLine++ });
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'del', text, oldLine: oldLine++ });
    } else {
      rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return rows;
}

/** GitHub's five-square diffstat: the split between added and removed lines. */
export function diffBlocks(additions: number, deletions: number): ('add' | 'del' | 'none')[] {
  const total = additions + deletions;
  if (total === 0) return Array(5).fill('none');
  let added = Math.round((5 * additions) / total);
  if (additions > 0 && added === 0) added = 1;
  if (deletions > 0 && added === 5) added = 4;
  return Array.from({ length: 5 }, (_, index) => (index < added ? 'add' : 'del'));
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function fileStatus(status: string): Meta {
  switch (status) {
    case 'added':
      return { label: 'Added', tone: 'success' };
    case 'removed':
      return { label: 'Deleted', tone: 'error' };
    case 'renamed':
      return { label: 'Renamed', tone: 'accent' };
    case 'copied':
      return { label: 'Copied', tone: 'accent' };
    case 'unchanged':
      return { label: 'Unchanged', tone: 'neutral' };
    default:
      return { label: 'Modified', tone: 'warning' };
  }
}

/** One letter for the avatar: the first one a login has. */
export function initial(login: string): string {
  return (login.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
}
