/**
 * GitHub pull-request events: reading the webhook's payload, and which of a team's automations
 * one fires. Only `provider: github` with one of `PULL_REQUEST_EVENTS` can match for now; any
 * other trigger parses and never matches.
 */
import type {
  AgentTeam,
  ListFilter,
  PullRequestEvent,
  TeamAutomation,
  TeamTriggerFilter,
} from './types';

/** Warp's pull-request event names, and the webhook `pull_request` events each stands for. */
export const PULL_REQUEST_EVENTS: Readonly<Record<string, (event: PullRequestEvent) => boolean>> = {
  pull_request_opened: (event) => event.action === 'opened',
  pull_request_ready: (event) => event.action === 'ready_for_review',
  pull_request_reopened: (event) => event.action === 'reopened',
  pull_request_synchronized: (event) => event.action === 'synchronize',
  pull_request_labeled: (event) => event.action === 'labeled',
  pull_request_review_requested: (event) => event.action === 'review_requested',
  pull_request_merged: (event) => event.action === 'closed' && event.merged === true,
  pull_request_closed: (event) => event.action === 'closed' && event.merged !== true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function readEvent(payload: unknown): PullRequestEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const { pull_request: pr, repository: repo } = payload;
  if (!isRecord(pr) || !isRecord(repo)) return undefined;
  const user = isRecord(pr.user) ? pr.user : undefined;
  const head = isRecord(pr.head) ? pr.head : undefined;
  const base = isRecord(pr.base) ? pr.base : undefined;
  const number = typeof pr.number === 'number' ? pr.number : payload.number;

  const action = text(payload.action);
  const repository = text(repo.full_name);
  const url = text(pr.html_url);
  const author = text(user?.login);
  const headSha = text(head?.sha);
  const headRef = text(head?.ref);
  const baseRef = text(base?.ref);
  if (
    !action ||
    !repository ||
    !url ||
    !author ||
    !headSha ||
    !headRef ||
    !baseRef ||
    typeof pr.title !== 'string' ||
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return undefined;
  }
  const labels = Array.isArray(pr.labels)
    ? pr.labels.flatMap((label) =>
        isRecord(label) && text(label.name) ? [label.name as string] : [],
      )
    : [];
  const event: PullRequestEvent = {
    action,
    repository,
    number,
    url,
    title: pr.title,
    author,
    authorIsBot: user?.type === 'Bot' || author.endsWith('[bot]'),
    draft: pr.draft === true,
    headSha,
    headRef,
    baseRef,
    labels,
  };
  if (typeof pr.merged === 'boolean') event.merged = pr.merged;
  return event;
}

/**
 * Reads GitHub's `pull_request` webhook payload (the JSON body GitHub POSTs) into the facts
 * above; undefined when it is not one or lacks a field. Never throws.
 */
export function pullRequestEventOf(payload: unknown): PullRequestEvent | undefined {
  try {
    return readEvent(payload);
  } catch {
    return undefined;
  }
}

/** Whether `values` pass a list filter, comparing with `same`. */
function passes(
  filter: ListFilter | undefined,
  values: readonly string[],
  same: (a: string, b: string) => boolean,
): boolean {
  if (!filter) return true;
  const any = (list: readonly string[]) =>
    values.some((value) => list.some((wanted) => same(value, wanted)));
  if (filter.in && filter.in.length > 0 && !any(filter.in)) return false;
  if (filter.not_in && filter.not_in.length > 0 && any(filter.not_in)) return false;
  return true;
}

const exact = (a: string, b: string) => a === b;
const anyCase = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function filterPasses(filter: TeamTriggerFilter, event: PullRequestEvent): boolean {
  const skipBots = filter.skip_bots ?? 'all';
  if (skipBots === 'all' && (event.authorIsBot === true || event.author.endsWith('[bot]'))) {
    return false;
  }
  return (
    passes(filter.repos, [event.repository], anyCase) &&
    passes(filter.base_branches, [event.baseRef], exact) &&
    passes(filter.labels, event.labels, anyCase) &&
    passes(filter.authors, [event.author], anyCase)
  );
}

/** The team's automations this event fires, in file order. */
export function matchPullRequestAutomations(
  team: AgentTeam,
  event: PullRequestEvent,
): TeamAutomation[] {
  return team.automations.filter(
    (automation) =>
      automation.enabled &&
      automation.triggers.some((trigger) => {
        if (trigger.provider.toLowerCase() !== 'github') return false;
        const fires = Object.prototype.hasOwnProperty.call(PULL_REQUEST_EVENTS, trigger.event)
          ? PULL_REQUEST_EVENTS[trigger.event]
          : undefined;
        return fires?.(event) === true && filterPasses(trigger.filter, event);
      }),
  );
}
