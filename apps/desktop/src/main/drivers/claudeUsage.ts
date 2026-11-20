import type { HarnessLimits, UsageWindow } from '../../shared/usageLimits';

/**
 * Reading Claude's `get_usage` answer, and Claude's own notice that a turn
 * stopped on a usage limit.
 *
 * Like the `/` menu this is the CLI's wire format, not a documented contract:
 * an answer without the fields that say whether there are limits at all throws,
 * and a window whose figures are missing or unreadable is left out rather than
 * filled in. Utilisation here is already 0..100.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Epoch ms of an ISO time, or undefined for anything that is not one. */
function readTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function readUtilization(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The windows every model counts against, by the field Claude reports each under. */
const PLAN_WINDOWS = [
  ['five_hour', 'session'],
  ['seven_day', 'weekly'],
] as const;

function planWindow(
  rateLimits: Record<string, unknown>,
  [field, kind]: (typeof PLAN_WINDOWS)[number],
): UsageWindow | null {
  const raw = rateLimits[field];
  if (!isRecord(raw)) return null;
  const usedPercent = readUtilization(raw.utilization);
  if (usedPercent === undefined) return null;
  const resetsAt = readTime(raw.resets_at);
  return { id: field, kind, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/**
 * A weekly allowance one model draws on ("Fable", "Opus"), named as Claude
 * displays it. That name is all there is to tell which sessions it binds.
 */
function scopedWindow(raw: unknown): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const model = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
  const usedPercent = readUtilization(raw.utilization);
  if (!model || usedPercent === undefined) return null;
  const resetsAt = readTime(raw.resets_at);
  return {
    id: `seven_day:${model.toLowerCase()}`,
    kind: 'weekly',
    usedPercent,
    model,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * Turn a `get_usage` answer into limits.
 *
 * `rate_limits_available: false` is a login with no plan limits — an API key,
 * or nobody signed in. Answers also carry `limits[].is_active`, which marks
 * the window nearest its limit rather than one that is blocking, so it is not
 * read.
 */
export function mapClaudeUsage(raw: unknown, checkedAt: number): HarnessLimits {
  if (!isRecord(raw)) {
    throw new Error('Claude answered the usage request with something other than an object.');
  }
  if (typeof raw.rate_limits_available !== 'boolean') {
    throw new Error('Claude answered the usage request without saying whether it has limits.');
  }
  if (!raw.rate_limits_available) return { available: false };
  const rateLimits = raw.rate_limits;
  if (!isRecord(rateLimits)) {
    throw new Error('Claude said it has usage limits but answered without them.');
  }
  const windows = PLAN_WINDOWS.map((entry) => planWindow(rateLimits, entry));
  const scoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
  return {
    available: true,
    checkedAt,
    windows: [...windows, ...scoped.map(scopedWindow)].filter(
      (window): window is UsageWindow => window !== null,
    ),
  };
}

/**
 * Claude's notice when a turn stops on a limit, as the CLI composes it
 * (2.1.328): "You've hit your 5-hour limit · resets 3pm (Europe/Madrid)",
 * "You've hit your limit", "You've hit your team's pooled group budget",
 * "You've reached your Fable limit for this week", "You're out of usage
 * credits". The CLI files these together as the messages that stop a turn on
 * a limit.
 *
 * Only at the start of a line, after any gutter or bullet, and for "hit your"
 * only where Claude ends it: at " · " or the end of the line. The agent's own
 * prose about limits — "if you've hit your rate limit, wait." — reads alike
 * mid-sentence or ending in a full stop, and never matches.
 */
const CLAUDE_LIMIT_NOTICE = new RegExp(
  [
    String.raw`^[^\p{L}\n]*`,
    '(?:',
    String.raw`You['’]ve hit your (?:[^\n·.]{1,40} )?(?:limit|budget)(?=[ \t]*(?:·|$))`,
    String.raw`|You['’]ve reached your [^\n·.]{1,40} limit(?=[ \t]*(?:·|$)| for this)`,
    String.raw`|You['’]re out of (?:usage credits|extra usage)\b`,
    String.raw`|Your org is out of usage\b`,
    ')',
  ].join(''),
  'mu',
);

export function showsClaudeLimitNotice(visibleText: string): boolean {
  return CLAUDE_LIMIT_NOTICE.test(visibleText);
}
