/**
 * The parsers of what slice 3 adds to a file's control flow: a step's
 * `then:`, a gate's body, a loop's header and its `on_exhausted`, and the
 * retry, budget and checkout an entry or a step may name. Each is pure and
 * returns the parsed part, or undefined after calling `fail` with its
 * refusal, at the key it is about. `steps.ts` and `schema.ts` call them;
 * what only the whole entry can answer (does a gate show an earlier step's
 * document) is `checkSteps`'.
 */
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
const CHECKOUT_CHANGES = '`checkout.changes` arrives with write steps; it is not supported yet.';
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
        if (entry === 'checkout.changes') {
          bad(CHECKOUT_CHANGES, ['show']);
          continue;
        }
        const ref = typeof entry === 'string' ? parseReadRef(entry) : null;
        if (
          !ref ||
          ref.previous ||
          !STEP_ID_PATTERN.test(ref.step) ||
          !ARTIFACT_NAME_PATTERN.test(ref.name)
        )
          bad(SHOW_ENTRY, ['show']);
        else if (show.includes(entry as string))
          bad(`\`${entry as string}\` is listed twice.`, ['show']);
        else show.push(entry as string);
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
