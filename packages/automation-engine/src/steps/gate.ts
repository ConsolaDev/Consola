import {
  flatSteps,
  gateChoices,
  parseReadRef,
  parseTemplate,
  type RepeatStep,
  type RunRecord,
  type StepEntry,
  type StepRun,
} from '@consola/factory-spec';

/*
 * What a gate asks and offers, and whether an answer may be taken, decided
 * from the run's own definition and record. Pure: `AutomationService` reads
 * the documents a gate shows and writes the answer.
 */

/** The item fields a gate's question may name: the item's identity, as a prompt's (`TRUSTED_ITEM_FIELDS`). */
const TRUSTED_ITEM_FIELDS = ['key', 'url', 'repo', 'number', 'type'] as const;

const own = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/**
 * `ask` with its `{{ }}` filled from the run's trusted values: item.key,
 * .url, .repo, .number, .type, and every output whose declared type is not
 * `string` (enum, boolean, integer, number: what a prompt's check lets
 * through, review M4). Validation refuses any other path in a gate's `ask`,
 * so a path with no value here (a field the run's item lacks) is left as
 * written rather than guessed.
 */
export function renderGateAsk(ask: string, run: Pick<RunRecord, 'trigger' | 'steps'>): string {
  const parsed = parseTemplate(ask);
  if (!parsed.ok) return ask;
  const item = run.trigger.item;
  return parsed.parts
    .map((part) => {
      if (part.kind === 'text') return part.text;
      const { path } = part;
      const asWritten = `{{${path.text}}}`;
      if (path.root === 'item') {
        const field = path.field as (typeof TRUSTED_ITEM_FIELDS)[number];
        const value = TRUSTED_ITEM_FIELDS.includes(field) ? item?.[field] : undefined;
        return value === undefined ? asWritten : String(value);
      }
      if (path.root === 'steps' && !path.file) {
        const outputs = run.steps?.find((record) => record.id === path.step)?.outputs;
        return outputs && own(outputs, path.name) ? String(outputs[path.name]) : asWritten;
      }
      return asWritten;
    })
    .join('');
}

/** What a gate offers: its question as written, the documents it names, its choices, and, at a loop's exhaustion, the loop. */
export interface GateOffer {
  ask: string;
  show: string[];
  choices: string[];
  loop?: RepeatStep;
}

/**
 * What a waiting row offers: its gate step's choices (or approve), or, for a
 * loop's exhaustion gate, approve. Null when `stepId` names neither.
 */
export function gateOffer(entries: readonly StepEntry[], stepId: string): GateOffer | null {
  const step = flatSteps(entries).find((row) => row.step.id === stepId)?.step;
  if (step?.kind === 'gate')
    return { ask: step.ask, show: [...step.show], choices: gateChoices(step) };
  if (step?.kind === 'repeat' && typeof step.onExhausted === 'object')
    return {
      ask: step.onExhausted.ask,
      show: [...step.onExhausted.show],
      choices: ['approve'],
      loop: step,
    };
  return null;
}

/**
 * The documents a gate shows: its `show`, or, for an exhaustion gate without
 * one, the handovers of the loop's agent steps that completed in its last
 * round.
 */
export function gateMaterialRefs(
  entries: readonly StepEntry[],
  records: StepRun[],
  stepId: string,
): Array<{ step: string; name: string }> {
  const offer = gateOffer(entries, stepId);
  if (!offer) return [];
  if (offer.show.length > 0 || !offer.loop)
    return offer.show.flatMap((entry) => {
      const ref = parseReadRef(entry);
      return ref && !ref.previous ? [{ step: ref.step, name: ref.name }] : [];
    });
  const round = records.find((record) => record.id === stepId)?.round;
  return offer.loop.steps.flatMap((step) => {
    const record = records.find((candidate) => candidate.id === step.id);
    const handedOver =
      step.kind === 'agent' &&
      record?.status === 'completed' &&
      record.round === round &&
      (record.artifacts ?? []).some((artifact) => artifact.name === 'handover');
    return handedOver ? [{ step: step.id, name: 'handover' }] : [];
  });
}

/** The words an answer to a row that is not waiting for one is refused with. */
export function notWaitingForYou(stepId: string): string {
  return `\`${stepId}\` is not waiting for you; reload the run.`;
}

/**
 * Why an answer is refused, or null: the run is not waiting at that row's
 * gate, or the decision is neither one it offers nor `reject`. What it
 * offers is the run's own definition's, never the file's as it is now.
 */
export function gateRefusal(
  run: RunRecord,
  entries: readonly StepEntry[],
  stepId: string,
  decision: string,
): string | null {
  const row = run.steps?.find((record) => record.id === stepId);
  const offer = typeof stepId === 'string' ? gateOffer(entries, stepId) : null;
  if (run.status !== 'waiting' || row?.status !== 'waiting' || !row.gate || !offer)
    return notWaitingForYou(String(stepId));
  if (decision === 'reject' || (typeof decision === 'string' && offer.choices.includes(decision)))
    return null;
  return `\`${String(decision)}\` is not one of \`${stepId}\`'s choices (${offer.choices.join(', ')}, or reject).`;
}
