/**
 * What each argument of a `uses:` call carries: written as it is, or filled
 * from paths someone else may have written. Computed once here and carried as
 * data, so the engine, the card and the run page say the same thing.
 *
 * Imports `steps.ts` (its item kinds and trusted fields), which never imports
 * this file.
 */
import { isStepsEntry, type Automation, type Trigger } from './schema';
import { itemKindOf, TRUSTED_ITEM_FIELDS, type Step } from './steps';
import { templatePaths } from './template';
import { usesTexts, type UsesStep } from './uses';

export type ArgumentTrust = 'literal' | 'trusted' | 'untrusted';

export type ValueSource =
  | { kind: 'item'; field: string; trusted: boolean }
  | { kind: 'output'; step: string; name: string; trusted: boolean }
  /** A handover, a declared artifact, or a call's or a command's `output`. */
  | { kind: 'artifact'; step: string; name: string }
  | { kind: 'previous'; step: string; name: string };

export interface CallArgument {
  name: string;
  /** As written: a literal, or text with `{{ }}`, at any depth. */
  template: unknown;
  /** `literal`: no path in it; `trusted`: every path trusted; else `untrusted`. */
  trust: ArgumentTrust;
  /** Each path in it, in order, once. */
  sources: ValueSource[];
  /** The interpreted-argument notice, when `trust` is `untrusted` and the name reads as interpreted. */
  notice?: string;
}

/** Output types whose values cannot carry instructions: what a call may take as trusted. */
const TRUSTED_OUTPUT_TYPES = ['enum', 'integer', 'number', 'boolean'];

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** Each top-level `with:` argument, in the order written. */
export function callArguments(
  step: UsesStep,
  entry: { trigger: Trigger; appliesTo?: readonly string[]; steps: readonly Step[] },
): CallArgument[] {
  const identity = itemKindOf(entry.trigger, entry.appliesTo) === 'identity';
  const texts = usesTexts(step);
  return Object.keys(step.with).map((name) => {
    const seen = new Set<string>();
    const sources: ValueSource[] = [];
    for (const { text, path } of texts) {
      if (path[1] !== name) continue;
      for (const ref of templatePaths(text)) {
        if (seen.has(ref.text)) continue;
        seen.add(ref.text);
        if (ref.root === 'item')
          sources.push({
            kind: 'item',
            field: ref.field,
            trusted: identity && TRUSTED_ITEM_FIELDS.includes(ref.field),
          });
        else if (ref.root === 'previous')
          sources.push({ kind: 'previous', step: ref.step, name: ref.name });
        else {
          const producer = entry.steps.find((candidate) => candidate.id === ref.step);
          if (producer && own(producer.outputs, ref.name))
            sources.push({
              kind: 'output',
              step: ref.step,
              name: ref.name,
              trusted: TRUSTED_OUTPUT_TYPES.includes(producer.outputs[ref.name].type),
            });
          else sources.push({ kind: 'artifact', step: ref.step, name: ref.name });
        }
      }
    }
    const trust: ArgumentTrust =
      sources.length === 0
        ? 'literal'
        : sources.every((source) => 'trusted' in source && source.trusted)
          ? 'trusted'
          : 'untrusted';
    const notice = trust === 'untrusted' ? interpretedNotice(name) : null;
    return {
      name,
      template: step.with[name],
      trust,
      sources,
      ...(notice !== null ? { notice } : {}),
    };
  });
}

/** Argument names a tool may run or open, and how it would read them. */
const INTERPRETED: ReadonlyArray<[string, string | null]> = [
  ['query', 'a query'],
  ['jql', 'a query'],
  ['sql', 'a query'],
  ['command', 'code'],
  ['script', 'code'],
  ['code', 'code'],
  ['prompt', 'instructions'],
  ['instructions', 'instructions'],
  ['url', null],
  ['path', null],
];

/** The notice for an argument `name`, or null when its name does not read as interpreted. */
export function interpretedNotice(name: string): string | null {
  const lower = name.toLowerCase();
  const found = INTERPRETED.find(([word]) => lower === word || lower.endsWith(`_${word}`));
  if (!found) return null;
  const [, as] = found;
  return as === null
    ? `\`${name}\` gets text someone else wrote; a tool may open what it names. Check that this is what you mean.`
    : `\`${name}\` gets text someone else wrote; a tool may run it as ${as} or open what it names. Check that this is what you mean.`;
}

/** Every notice the entry's calls give, each at `['steps', <index>, 'with', <name>]`. */
export function usesNotices(
  automation: Automation,
): Array<{ message: string; path: Array<string | number> }> {
  if (!isStepsEntry(automation)) return [];
  const notices: Array<{ message: string; path: Array<string | number> }> = [];
  automation.steps.forEach((step, index) => {
    if (step.kind !== 'uses') return;
    const entry = {
      trigger: automation.trigger,
      appliesTo: automation.appliesTo,
      steps: automation.steps,
    };
    for (const argument of callArguments(step, entry))
      if (argument.notice)
        notices.push({ message: argument.notice, path: ['steps', index, 'with', argument.name] });
  });
  return notices;
}
