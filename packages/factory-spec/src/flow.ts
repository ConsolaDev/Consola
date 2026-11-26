/**
 * The parsers of what slice 3 adds to a file's control flow: a step's
 * `then:`, a gate's body, a loop's header and its `on_exhausted`, and the
 * retry, budget and checkout an entry or a step may name. Each is pure and
 * returns the parsed part, or undefined after calling `fail` with its
 * refusal, at the key it is about. `steps.ts` and `schema.ts` call them;
 * what only the whole entry can answer (does a gate show an earlier step's
 * document) is `checkSteps`'.
 */
import { branchTemplateProblem, refFormatProblem } from './branchName';
import { MAX_IF_LENGTH, parseExpression } from './expression';
import { ARTIFACT_NAME_PATTERN, parseReadRef, STEP_ID_PATTERN } from './steps';
import { parseTemplate } from './template';

export type Fail = (message: string, path?: Array<string | number>) => void;

/** The most characters a gate's question may have. */
export const MAX_GATE_ASK = 300;
/** The most documents a gate's card may show. */
export const MAX_GATE_SHOW = 5;
/** A gate's choice: an enum-like word, as a step id is written. */
export const GATE_CHOICE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;

const GATE_ASK = `A gate asks 1 to ${MAX_GATE_ASK} characters of text.`;
const GATE_SHOW = `A gate shows at most ${MAX_GATE_SHOW} documents.`;
const GATE_CHOICES = `\`choices\` lists ${MIN_CHOICES} to ${MAX_CHOICES} words of lowercase letters, digits and dashes, e.g. \`[approve, comment]\`.`;
const GATE_REJECT = '`reject` is always offered; name your choices otherwise.';
const GATE_TIMEOUT =
  'A gate waits for you for as long as it takes; timeouts arrive with waiting runs (slice 4).';
const GATE_SHAPE =
  'Write a gate as `gate: { ask: "<question>" }`, with `show` and `choices` if it needs them.';
const SHOW_ENTRY = 'Name what to show as `<step>.<artifact>`, e.g. `review.handover`.';

/** A gate has no key but these; anything else it would run, and a gate runs nothing. */
export const GATE_BODY_KEYS = ['ask', 'show', 'choices'] as const;

/** Why a gate step, or its body, cannot have `key`. */
export function gateHasNo(key: string): string {
  return `A gate has no \`${key}\`: it asks a person and runs nothing.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `then: stop`, the only value: present as `true`, never as a `then` property (Call 3). */
export function parseThen(value: unknown, fail: Fail): true | undefined {
  if (value === 'stop') return true;
  fail('`then:` takes `stop`.', ['then']);
  return undefined;
}

/**
 * A gate's body, `gate: { ask, show, choices }`: its question as written,
 * the documents its card shows (`<step>.<artifact>`, never `previous`), and
 * its choices when written. Issues land at `gate.<key>`.
 */
export function parseGateBody(
  value: unknown,
  fail: Fail,
): { ask: string; show: string[]; choices?: string[] } | undefined {
  if (!isRecord(value)) {
    fail(GATE_SHAPE, ['gate']);
    return undefined;
  }
  let ok = true;
  const bad: Fail = (message, path = []) => {
    ok = false;
    fail(message, ['gate', ...path]);
  };
  for (const key of Object.keys(value)) {
    if ((GATE_BODY_KEYS as readonly string[]).includes(key)) continue;
    bad(key === 'timeout' ? GATE_TIMEOUT : gateHasNo(key), [key]);
  }

  const ask = value.ask;
  if (typeof ask !== 'string' || !ask.trim() || ask.length > MAX_GATE_ASK) {
    bad(GATE_ASK, 'ask' in value ? ['ask'] : []);
  } else {
    const parsed = parseTemplate(ask);
    if (!parsed.ok) bad(parsed.problem[0].toUpperCase() + parsed.problem.slice(1) + '.', ['ask']);
  }

  const show: string[] = [];
  if ('show' in value) {
    const given = value.show;
    if (!Array.isArray(given)) bad(SHOW_ENTRY, ['show']);
    else if (given.length > MAX_GATE_SHOW) bad(GATE_SHOW, ['show']);
    else {
      for (const entry of given) {
        const ref = typeof entry === 'string' ? parseReadRef(entry) : null;
        if (
          !ref ||
          ref.previous ||
          !STEP_ID_PATTERN.test(ref.step) ||
          !ARTIFACT_NAME_PATTERN.test(ref.name)
        ) {
          bad(SHOW_ENTRY, ['show']);
        } else if (show.includes(entry as string)) {
          bad(`\`${entry as string}\` is listed twice.`, ['show']);
        } else show.push(entry as string);
      }
    }
  }

  let choices: string[] | undefined;
  if ('choices' in value) {
    const given = value.choices;
    const words =
      Array.isArray(given) &&
      given.length >= MIN_CHOICES &&
      given.length <= MAX_CHOICES &&
      given.every((word) => typeof word === 'string' && GATE_CHOICE_PATTERN.test(word)) &&
      new Set(given).size === given.length
        ? (given as string[])
        : undefined;
    if (!words) bad(GATE_CHOICES, ['choices']);
    else if (words.includes('reject')) bad(GATE_REJECT, ['choices']);
    else choices = [...words];
  }

  if (!ok || typeof ask !== 'string') return undefined;
  return { ask, show, ...(choices ? { choices } : {}) };
}

/** `on_exhausted` written anywhere but on a loop: on a leaf step, or on the entry. */
export const ON_EXHAUSTED_OUTSIDE = '`on_exhausted` goes on a `repeat` block.';

/** The most rounds a loop may run. */
export const MAX_ROUNDS = 10;
/** The most steps a loop may hold. */
export const MAX_LOOP_STEPS = 10;

/** How a loop ends when `until` is still not met after its last round: absent means `fail`. */
export type OnExhausted = 'fail' | 'continue' | { ask: string; show: string[] };

const REPEAT_SHAPE = 'Write a loop as `repeat: { max: 3, until: steps.review.findings == 0 }`.';
const REPEAT_NO_MAX =
  "`repeat` without `max` arrives with waiting runs (slice 4), bounded by a wait's timeout.";
const REPEAT_MAX = `\`max\` is a whole number from 1 to ${MAX_ROUNDS}.`;
const REPEAT_UNTIL = 'Say when the loop is done: `until: steps.review.findings == 0`.';
const ON_EXHAUSTED_SHAPE =
  '`on_exhausted` is `fail`, `continue`, `{ gate: "<question>" }` or `{ gate: { ask, show } }`.';

/**
 * A loop's header, `repeat: { max, until }`: `max` rounds at most, required in
 * this slice, and `until` an expression that parses (which steps it may name
 * is `checkSteps`'). Issues land at `repeat.<key>`.
 */
export function parseRepeatHeader(
  value: unknown,
  fail: Fail,
): { max: number; until: string } | undefined {
  if (!isRecord(value)) {
    fail(REPEAT_SHAPE, ['repeat']);
    return undefined;
  }
  let ok = true;
  const bad: Fail = (message, path = []) => {
    ok = false;
    fail(message, ['repeat', ...path]);
  };
  for (const key of Object.keys(value)) {
    if (key !== 'max' && key !== 'until') bad(`Unrecognized key in \`repeat\`: ${key}.`, [key]);
  }
  const max = value.max;
  if (!('max' in value)) bad(REPEAT_NO_MAX);
  else if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_ROUNDS) {
    bad(REPEAT_MAX, ['max']);
  }
  const until = value.until;
  if (typeof until !== 'string' || !until.trim()) {
    bad(REPEAT_UNTIL, 'until' in value ? ['until'] : []);
  } else if (until.length > MAX_IF_LENGTH) {
    bad(`An \`until\` is at most ${MAX_IF_LENGTH} characters.`, ['until']);
  } else {
    const parsed = parseExpression(until);
    if (!parsed.ok) {
      bad(`Cannot read this \`until\`: ${parsed.problem.replace(/\.$/, '')}.`, ['until']);
    }
  }
  if (!ok || typeof max !== 'number' || typeof until !== 'string') return undefined;
  return { max, until };
}

/**
 * A loop's `on_exhausted`: `fail`, `continue`, or a gate that asks a person
 * whether to go on (`{ gate: "<question>" }`, normalised to `{ ask, show: [] }`,
 * or `{ gate: { ask, show } }`, whose `show` is a gate's). An exhaustion gate
 * offers approve and reject only, so it takes no `choices`.
 */
export function parseOnExhausted(value: unknown, fail: Fail): OnExhausted | undefined {
  if (value === 'fail' || value === 'continue') return value;
  const at = (path: Array<string | number> = []) => ['on_exhausted', ...path];
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('gate' in value)) {
    fail(ON_EXHAUSTED_SHAPE, at());
    return undefined;
  }
  const gate = value.gate;
  if (typeof gate === 'string') {
    if (!gate.trim() || gate.length > MAX_GATE_ASK) {
      fail(GATE_ASK, at(['gate']));
      return undefined;
    }
    const parsed = parseTemplate(gate);
    if (!parsed.ok) {
      fail(parsed.problem[0].toUpperCase() + parsed.problem.slice(1) + '.', at(['gate']));
      return undefined;
    }
    return { ask: gate, show: [] };
  }
  if (!isRecord(gate) || 'choices' in gate) {
    fail(ON_EXHAUSTED_SHAPE, at(isRecord(gate) ? ['gate', 'choices'] : ['gate']));
    return undefined;
  }
  const body = parseGateBody(gate, (message, path = []) => fail(message, at(path)));
  return body ? { ask: body.ask, show: body.show } : undefined;
}

/** The most times a step, or a whole run, may start again by itself. */
export const MAX_RETRIES = 3;
/** The least and the most a run's budget may be, in US dollars. */
export const MIN_BUDGET_USD = 0.01;
export const MAX_BUDGET_USD = 1000;

const RETRY_SHAPE = `\`on_failure:\` is \`{ retry: <n> }\`, with n from 0 to ${MAX_RETRIES}.`;
const BUDGET_SHAPE = `\`budget:\` is \`{ usd: <n> }\`, with n from ${MIN_BUDGET_USD} to ${MAX_BUDGET_USD}.`;
const CHECKOUT_SHAPE =
  'Write the checkout as `checkout: { pr: item }` or `checkout: { repo: …, branch: … }`.';
/** The keys of a checkout the run owns (slice 3-B): a branch it cuts from one of `repos:`. */
const RUN_OWNED_KEYS = ['repo', 'branch', 'from'];
const NOT_BOTH = 'A checkout is `{ pr: item }` or `{ repo, branch }`, not both.';
const NAME_THE_BRANCH = 'Name the branch the run cuts: `branch: "fix/{{item.key}}"`.';
const FROM_ITEM =
  "Writing on a pull request's own head is not supported: a write step cuts its branch from one of `repos:` (invariant 9).";
const FROM_SHAPE = '`from:` names a branch of the repository, e.g. `from: main`.';

/** A repository as `owner/name`, as `repos:` and a run-owned checkout name one. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The most repositories `repos:` may list. */
export const MAX_REPOS = 50;
/** What an entry of `repos:`, or a checkout's `repo:`, that is not `owner/name` is told. */
export const REPO_ENTRY_SHAPE =
  'Each entry of `repos:` is a repository as `owner/name`, e.g. `sprocket/catalog-portal`.';

/**
 * `checkout: { repo, branch, from? }`: the run works in a checkout of its
 * own of `repo`, one of `repos:`, on a branch it cuts from `branch` (a
 * template, `branchName.ts`) off the repository's default branch, or off
 * `from`, a branch named as written.
 */
export interface RunOwnedCheckout {
  repo: string;
  branch: string;
  from?: string;
}

/** An entry's `checkout:`: 3-A's item checkout, or one the run owns. */
export type EntryCheckout = { pr: 'item' } | RunOwnedCheckout;

/** Whether an entry's checkout is one the run owns. */
export function isRunOwnedCheckout(
  checkout: EntryCheckout | undefined,
): checkout is RunOwnedCheckout {
  return checkout !== undefined && 'repo' in checkout;
}

/** Whether an entry's checkout is its item's (`{ pr: item }`). */
export function isItemCheckout(checkout: EntryCheckout | undefined): checkout is { pr: 'item' } {
  return checkout !== undefined && 'pr' in checkout;
}

/**
 * `on_failure: { retry: <n> }`, on a step or on an entry: how many times it
 * starts again by itself, 0 to 3. What may retry at all is `checkSteps`' and
 * `parseFactory`'s (a command that may have acted, an agent naming a server).
 */
export function parseRetry(value: unknown, fail: Fail): { retry: number } | undefined {
  const retry = isRecord(value) && Object.keys(value).length === 1 ? value.retry : undefined;
  if (typeof retry !== 'number' || !Number.isInteger(retry) || retry < 0 || retry > MAX_RETRIES) {
    fail(RETRY_SHAPE, ['on_failure']);
    return undefined;
  }
  return { retry };
}

/** `budget: { usd: <n> }`, an entry's spend ceiling per run, from a cent to a thousand dollars. */
export function parseBudget(value: unknown, fail: Fail): { usd: number } | undefined {
  const usd = isRecord(value) && Object.keys(value).length === 1 ? value.usd : undefined;
  if (
    typeof usd !== 'number' ||
    !Number.isFinite(usd) ||
    usd < MIN_BUDGET_USD ||
    usd > MAX_BUDGET_USD
  ) {
    fail(BUDGET_SHAPE, ['budget']);
    return undefined;
  }
  return { usd };
}

/**
 * An entry's `checkout:`: `{ pr: item }`, slice 1's read-only checkout of
 * the item's pull request, which is what an item run works in already; or
 * `{ repo, branch, from? }`, a checkout the run owns, on a branch it cuts
 * (slice 3-B). Where items can never be pull requests, and what a branch's
 * placeholders need of the items, is the entry's to say; that `repo` is one
 * of `repos:` is the folder's.
 */
export function parseEntryCheckout(value: unknown, fail: Fail): EntryCheckout | undefined {
  const at = (path: Array<string | number> = []) => ['checkout', ...path];
  if (!isRecord(value)) {
    fail(CHECKOUT_SHAPE, at());
    return undefined;
  }
  const owned = RUN_OWNED_KEYS.some((key) => key in value);
  if (owned && 'pr' in value) {
    fail(NOT_BOTH, at());
    return undefined;
  }
  if (owned) return parseRunOwnedCheckout(value, fail);
  const strangers = Object.keys(value).filter((key) => key !== 'pr');
  if (strangers.length > 0) {
    fail(`Unrecognized key in \`checkout\`: ${strangers[0]}.`, at([strangers[0]]));
    return undefined;
  }
  if (!('pr' in value)) {
    fail(CHECKOUT_SHAPE, at());
    return undefined;
  }
  if (value.pr !== 'item') {
    fail('`pr:` takes `item`.', at(['pr']));
    return undefined;
  }
  return { pr: 'item' };
}

/** `checkout: { repo, branch, from? }`, each key checked at its own path; nothing when any fails. */
function parseRunOwnedCheckout(
  value: Record<string, unknown>,
  fail: Fail,
): RunOwnedCheckout | undefined {
  const at = (key: string) => ['checkout', key];
  const strangers = Object.keys(value).filter((key) => !RUN_OWNED_KEYS.includes(key));
  if (strangers.length > 0) {
    fail(`Unrecognized key in \`checkout\`: ${strangers[0]}.`, at(strangers[0]));
    return undefined;
  }
  let ok = true;
  const refuse = (message: string, key: string) => {
    fail(message, at(key));
    ok = false;
  };
  const { repo, branch, from } = value;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) refuse(REPO_ENTRY_SHAPE, 'repo');
  if (typeof branch !== 'string' || branch.trim() === '') refuse(NAME_THE_BRANCH, 'branch');
  else {
    const problem = branchTemplateProblem(branch);
    if (problem) refuse(problem, 'branch');
  }
  if (from !== undefined) {
    if (from === 'item') refuse(FROM_ITEM, 'from');
    else if (typeof from !== 'string' || from.includes('{{') || refFormatProblem(from) !== null) {
      refuse(FROM_SHAPE, 'from');
    }
  }
  if (!ok) return undefined;
  return {
    repo: repo as string,
    branch: branch as string,
    ...(from !== undefined ? { from: from as string } : {}),
  };
}
