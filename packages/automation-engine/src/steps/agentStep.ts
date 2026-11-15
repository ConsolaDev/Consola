import { parseReadRef, parseTemplate, renderTemplate, type AgentStep, type RunRecord, type StepRun } from '@consola/factory-spec';
import type { AgentLaunchRequest, RunFolderPort } from '../ports';
import type { ItemSource } from '../sources/itemSource';
import { previousDocument } from '../sources/previous';
import { fillActionPlaceholders } from '../support';
import type { ItemRef } from '../views';
import { describeReason } from './commandStep';
import type { RunDefinition } from './definition';
import { joinNames } from './sequence';
import { renderStepPrompt, type StepPromptInput } from './stepPrompt';

/*
 * An agent step's launch, decided from its run's record and definition (and,
 * for a `previous` read, the earlier run's folder), and what a clean exit
 * left undone. It starts nothing: `AutomationService` launches what this
 * returns and records what it says.
 */

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The item a run is about, as the host names one; undefined when its snapshot lacks what that takes. */
export function itemRefOf(run: RunRecord): ItemRef | undefined {
    const { item, connection } = run.trigger;
    if (!item || !connection || item.repo === undefined || item.number === undefined || item.type === undefined) return undefined;
    return { provider: connection, repo: item.repo, type: item.type, number: item.number };
}

/**
 * Why an action cannot run on an item of this type, in the words the entry's
 * problem uses ("the Review action does not apply to issues"); null when it
 * can, or when nothing recorded which types it applies to.
 */
export function actionTypeRefusal(action: { name: string; appliesTo?: ReadonlyArray<'pr' | 'issue'> }, type: 'pr' | 'issue'): string | null {
    if (!action.appliesTo || action.appliesTo.includes(type)) return null;
    return `the ${action.name} action does not apply to ${type === 'pr' ? 'pull requests' : 'issues'}`;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * What the step reads, as its prompt lists them: documents of this run's
 * earlier steps that their records say were written, and every `previous`
 * one it declares, with its size when the earlier run's folder holds it and
 * why not when it does not. With no earlier run, `noEarlierRun` says so
 * instead of listing them.
 */
function readsOf(
    step: AgentStep,
    records: StepRun[],
    earlier: { folder: RunFolderPort; workspaceId: string; previous: { runId: string } | undefined }
): Pick<StepPromptInput, 'reads' | 'noEarlierRun'> {
    const reads: StepPromptInput['reads'] = [];
    let readsPrevious = false;
    for (const entry of step.reads) {
        const ref = parseReadRef(entry);
        if (!ref) continue;
        if (ref.previous) {
            readsPrevious = true;
            if (!earlier.previous) continue;
            const document = previousDocument({ ...earlier, step: ref.step, name: ref.name, file: false });
            if ('value' in document) {
                reads.push({ ref: entry, step: ref.step, bytes: utf8Bytes(document.value), previous: true });
            } else {
                // The reason names the read ("`previous.review.handover` was not written …"); the line already does.
                const named = `\`${entry}\` `;
                const absent = document.absent.startsWith(named) ? document.absent.slice(named.length) : document.absent;
                reads.push({ ref: entry, step: ref.step, previous: true, absent });
            }
            continue;
        }
        const written = records.find((record) => record.id === ref.step)?.artifacts?.find((artifact) => artifact.name === ref.name);
        if (written) reads.push({ ref: entry, step: ref.step, bytes: written.bytes });
    }
    return { reads, ...(readsPrevious && !earlier.previous ? { noEarlierRun: true as const } : {}) };
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
        switch (path.root) {
            case 'item': {
                const value = item && source ? source.itemValue(item, path.field, polled) : undefined;
                return value === undefined ? undefined : String(value);
            }
            case 'steps': {
                if (path.file) return undefined;
                const outputs = run.steps?.find((record) => record.id === path.step)?.outputs;
                return outputs && own(outputs, path.name) ? String(outputs[path.name]) : undefined;
            }
            case 'previous':
                // Prose an agent wrote after reading outside text: never in a prompt (invariant 7).
                return undefined;
        }
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
 * `item.json`: what its header, fence and item fields come from. `previous`
 * is the earlier run on its item (`run.previous`), whose documents a
 * `previous.*` read lists from `folder`.
 */
export function agentStepLaunch(input: {
    workspaceId: string;
    run: RunRecord;
    definition: RunDefinition;
    stepId: string;
    checkout: { cwd: string; scopeId: string };
    source: ItemSource | undefined;
    polled: Record<string, unknown> | undefined;
    previous: { runId: string } | undefined;
    folder: RunFolderPort;
}): AgentStepLaunch {
    const { workspaceId, run, definition, stepId, checkout, source, polled, previous, folder } = input;
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
        const refused = actionTypeRefusal(action, workItem.type);
        if (refused) return { ok: false, error: refused };
        // The title is the author's: the body points at it, the fence holds it.
        body = fillActionPlaceholders(action.body, { workItem, title: 'the title quoted below', url: item.url });
    } else {
        const filled = fillPrompt(step.prompt ?? '', run, source, polled);
        if (!filled.ok) return filled;
        body = filled.text;
    }

    let reads: ReturnType<typeof readsOf>;
    try {
        reads = readsOf(step, run.steps ?? [], { folder, workspaceId, previous });
    } catch (error) {
        return { ok: false, error: `Its reads could not be read from the earlier run's folder (${describeReason(error)}).` };
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
        ...reads,
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
