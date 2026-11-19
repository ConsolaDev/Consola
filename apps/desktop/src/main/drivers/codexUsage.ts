import type { HarnessLimits, UsageWindow } from '../../shared/usageLimits';

/**
 * Reading what `codex app-server` says about the signed-in account's limits,
 * and Codex's own notice that a turn stopped on one.
 *
 * The protocol's documentation is Codex's own, not a promise, so this throws on
 * an answer missing the fields it is read for, and leaves out a window whose
 * figures cannot be read rather than filling them in.
 */

/**
 * The two answers that make one reading.
 *
 * `account/read` first, because only a ChatGPT plan has limits to read: for an
 * API key, or nobody signed in, `account/rateLimits/read` answers with an
 * error whose wording is all that tells the two apart. Only the fields read
 * here are kept, so the account's email and ids never leave the reader.
 */
export interface CodexUsageAnswer {
  /** `account/read`'s `account.type`: `chatgpt`, `apiKey`, or null when signed out. */
  accountType: unknown;
  /** `account/read`'s `requiresOpenaiAuth`: false when the configured provider is not OpenAI's. */
  requiresOpenaiAuth: unknown;
  /**
   * `account/rateLimits/read`'s `rateLimits` and `rateLimitsByLimitId`, asked
   * only when a ChatGPT plan applies.
   */
  rateLimits?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether `account/read`'s answer says a ChatGPT plan's limits apply to this
 * harness. Throws when the answer does not say who is signed in at all.
 */
export function codexPlanApplies(
  answer: Pick<CodexUsageAnswer, 'accountType' | 'requiresOpenaiAuth'>,
): boolean {
  if (answer.accountType !== null && typeof answer.accountType !== 'string') {
    throw new Error('Codex answered without saying which account is signed in.');
  }
  // A provider that is not OpenAI's spends none of the plan's allowance.
  return answer.accountType === 'chatgpt' && answer.requiresOpenaiAuth !== false;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function kindFor(minutes: number): UsageWindow['kind'] {
  if (minutes >= MONTH_MINS) return 'monthly';
  if (minutes >= WEEK_MINS) return 'weekly';
  return 'session';
}

/** Codex reports a reset in epoch seconds. */
function readResetSeconds(value: unknown): number | undefined {
  const seconds = finite(value);
  return seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * `primary` and `secondary` are positions, not lengths: which allowance each
 * is depends on the plan, so the length Codex reports decides the kind. Without
 * one, `primary` is five hours — a month on the `free` and `go` plans — and
 * `secondary` a week.
 */
function positionWindow(
  id: 'primary' | 'secondary',
  raw: unknown,
  fallbackMins: number,
): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = finite(raw.usedPercent);
  if (usedPercent === undefined) return null;
  const reported = finite(raw.windowDurationMins);
  const resetsAt = readResetSeconds(raw.resetsAt);
  return {
    id,
    kind: kindFor(reported !== undefined && reported > 0 ? reported : fallbackMins),
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * Turn one reading into limits. The snapshot read is the `codex` limit's,
 * falling back to the account's default; one for another limit id (a single
 * model's) gives no windows, since it is not the allowance sessions draw on.
 */
export function mapCodexUsage(raw: unknown, checkedAt: number): HarnessLimits {
  if (!isRecord(raw)) throw new Error('Codex answered with something other than an object.');
  if (!codexPlanApplies(raw as Pick<CodexUsageAnswer, 'accountType' | 'requiresOpenaiAuth'>)) {
    return { available: false };
  }
  const result = raw.rateLimits;
  if (!isRecord(result)) throw new Error('Codex answered the rate-limit request with no result.');
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : undefined;
  const snapshot = byId?.codex ?? result.rateLimits;
  if (!isRecord(snapshot)) throw new Error('Codex answered without a rate-limit snapshot.');

  const windows: UsageWindow[] = [];
  if (snapshot.limitId === undefined || snapshot.limitId === null || snapshot.limitId === 'codex') {
    const monthlyPlan = snapshot.planType === 'free' || snapshot.planType === 'go';
    for (const window of [
      positionWindow('primary', snapshot.primary, monthlyPlan ? MONTH_MINS : SESSION_MINS),
      positionWindow('secondary', snapshot.secondary, WEEK_MINS),
    ]) {
      if (window) windows.push(window);
    }
    // Seat plans spend credits only past their plan windows, so the
    // credit cap binds only a plan that has none; elsewhere it would stop a
    // session the plan still lets run.
    const individual = snapshot.individualLimit;
    const remaining = isRecord(individual) ? finite(individual.remainingPercent) : undefined;
    if (windows.length === 0 && isRecord(individual) && remaining !== undefined) {
      const resetsAt = readResetSeconds(individual.resetsAt);
      windows.push({
        id: 'individual',
        kind: 'monthly',
        usedPercent: 100 - remaining,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  return { available: true, checkedAt, windows };
}

/**
 * Codex's notice when a turn stops on a limit, as 0.169.0 words it: "You've
 * hit your usage limit." or "You've hit your usage limit for <model>.", then
 * what to do and, when it knows, "try again at 3:37 PM." The TUI shows it as
 * an error line ("■ You've hit…").
 *
 * Only at the start of a line, after any gutter or bullet, and only that
 * exact phrase closed by a full stop or " for ": the agent's own prose about
 * limits does not start a line that way.
 */
const CODEX_LIMIT_NOTICE = /^[^\p{L}\n]*You['’]ve hit your usage limit(?:\.| for )/mu;

export function showsCodexLimitNotice(visibleText: string): boolean {
  return CODEX_LIMIT_NOTICE.test(visibleText);
}
