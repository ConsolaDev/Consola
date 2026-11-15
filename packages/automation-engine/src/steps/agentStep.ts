import { parseTemplate, renderTemplate, type AgentStep, type RunRecord, type StepRun } from '@consola/factory-spec';
import type { AgentLaunchRequest } from '../ports';
import type { ItemSource } from '../sources/itemSource';
import { fillActionPlaceholders } from '../support';
import type { ItemRef } from '../views';
import type { RunDefinition } from './definition';
import { joinNames } from './sequence';
import { renderStepPrompt, type StepPromptInput } from './stepPrompt';

/*
 * An agent step's launch, decided from its run's record and definition alone,
 * and what a clean exit left undone. Pure: `AutomationService` launches what
 * this returns and records what it says.
 */

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The item a run is about, as the host names one; undefined when its snapshot lacks what that takes. */
export function itemRefOf(run: RunRecord): ItemRef | undefined {
    const { item, connection } = run.trigger;
    if (!item || !connection || item.repo === undefined || item.number === undefined || item.type === undefined) return undefined;
    return { provider: connection, repo: item.repo, type: item.type, number: item.number };
}

/** What the step reads from earlier steps, as its prompt lists them: only documents their records say were written. */
function readsOf(step: AgentStep, records: StepRun[]): StepPromptInput['reads'] {
    return step.reads.flatMap((ref) => {
        const dot = ref.indexOf('.');
        const producer = ref.slice(0, dot);
        const written = records.find((record) => record.id === producer)?.artifacts?.find((artifact) => artifact.name === ref.slice(dot + 1));
        return written ? [{ ref, step: producer, bytes: written.bytes }] : [];
    });
}

/**
 * A prompt step's text with its `{{ }}` filled. Validation lets a prompt name
 * only trusted values: the item's identity fields, and outputs whose schema
 * constrains them. Anything else has no value here.
 */
function fillPrompt(
    text: string,
    run: RunRecord,
    source: ItemSource | undefined,
    polled: Record<string, unknown> | undefined
): { ok: true; text: string } | { ok: false; error: string } {
    const parsed = parseTemplate(text);
    if (!parsed.ok) return { ok: false, error: parsed.problem };
    const item = run.trigger.item;
    const rendered = renderTemplate(parsed.parts, (path) => {
        if (path.root === 'item') {
            const value = item && source ? source.itemValue(item, path.field, polled) : undefined;
            return value === undefined ? undefined : String(value);
        }
        if (path.file) return undefined;
        const outputs = run.steps?.find((record) => record.id === path.step)?.outputs;
        return outputs && own(outputs, path.name) ? String(outputs[path.name]) : undefined;
    });
    return rendered.ok ? rendered : { ok: false, error: `${rendered.missing.text} has no value` };
}

export type AgentStepLaunch = { ok: true; request: AgentLaunchRequest } | { ok: false; error: string };

/**
 * The launch of an agent step's current attempt, in the folder the run
 * prepared: its session's name, its prompt (north-star §6.2), and, for an
 * item run, the item it is about, labelled with the step's action (or the
 * automation, for a prompt step) and landing in the action's group.
 *
 * The run's first agent step, when it is an action of a run a trigger fired
 * (an event or a poll; never a run on demand, which the person chose),
 * asks the host to look for the same review started by hand
 * (`startedByHandSince`) until the run is retried: the checkout's lock is
 * let go once it is prepared, and an Inbox click may land between the two.
 *
 * `source` is the run's own (`runItemSource`), and `polled` a poll run's
 * `item.json`: what its header, fence and item fields come from.
 */
export function agentStepLaunch(input: {
    workspaceId: string;
    run: RunRecord;
    definition: RunDefinition;
    stepId: string;
    checkout: { cwd: string; scopeId: string };
    source: ItemSource | undefined;
    polled: Record<string, unknown> | undefined;
}): AgentStepLaunch {
    const { workspaceId, run, definition, stepId, checkout, source, polled } = input;
    const { steps } = definition.automation;
    const index = steps.findIndex((candidate) => candidate.id === stepId);
    const step = steps[index];
    const record = run.steps?.find((candidate) => candidate.id === stepId);
    if (step?.kind !== 'agent' || !record) return { ok: false, error: `Its definition has no agent step ${stepId}.` };

    const automation = run.automationId;
    const item = run.trigger.item;
    const workItem = itemRefOf(run);
    const action = definition.actions[step.id];

    let body: string;
    if (action) {
        if (!item || !workItem) return { ok: false, error: `${action.name} is an action, and this run has no item for it.` };
        // The title is the author's: the body points at it, the fence holds it.
        body = fillActionPlaceholders(action.body, { workItem, title: 'the title quoted below', url: item.url });
    } else {
        const filled = fillPrompt(step.prompt ?? '', run, source, polled);
        if (!filled.ok) return filled;
        body = filled.text;
    }

    const prompt = renderStepPrompt({
        automation,
        runId: run.id,
        step,
        index: index + 1,
        count: steps.length,
        body,
        ...(source && item ? { item: { header: source.describeItemHeader(item), fence: source.fenceItem(item, polled) } } : {}),
        ...(definition.automation.scope ? { scope: definition.automation.scope } : {}),
        reads: readsOf(step, run.steps ?? []),
        outputs: step.outputs,
        artifacts: step.artifacts,
        handover: step.handover,
    });
    const name = `${item ? item.title : automation} · ${step.id}`;
    const firstAgentStep = steps.find((candidate) => candidate.kind === 'agent')?.id === step.id;
    // Only while the run is as its trigger fired it: a retry, or a restart's next attempt, leaves an earlier attempt in some
    // step's `previous`, and from then on the run is the person's click, whichever step that was.
    const retried = (run.steps ?? []).some((candidate) => (candidate.previous?.length ?? 0) > 0);
    const fired = run.trigger.kind === 'event' || run.trigger.kind === 'poll';
    const askByHand = fired && firstAgentStep && action !== undefined && !retried;
    return {
        ok: true,
        request: {
            workspaceId,
            run: { id: run.id, automation },
            prompt,
            step: { id: step.id, attempt: record.attempt, cwd: checkout.cwd, scopeId: checkout.scopeId, name },
            ...(item && workItem
                ? {
                      item: {
                          workItem,
                          title: item.title,
                          label: action?.name ?? automation,
                          ...(action?.groupId ? { groupId: action.groupId } : {}),
                          ...(askByHand ? { startedByHandSince: run.createdAt } : {}),
                      },
                  }
                : {}),
        },
    };
}

/** What a step whose turn exited cleanly left undone, as its error; null when nothing is missing. */
export function endedWithout(missing: { outputs: string[]; artifacts: string[] }): string | null {
    const parts = [
        ...(missing.outputs.length > 0 ? [`setting ${joinNames(missing.outputs)}`] : []),
        ...(missing.artifacts.length > 0 ? [`writing ${joinNames(missing.artifacts)}`] : []),
    ];
    return parts.length > 0 ? `ended without ${parts.join(', and without ')}` : null;
}
