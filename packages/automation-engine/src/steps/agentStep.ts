import { parseTemplate, renderTemplate, type AgentStep, type RunRecord, type StepRun } from '@consola/factory-spec';
import { resolveEventSource, type EventSource } from '../connections';
import type { AgentLaunchRequest } from '../ports';
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

/** The connection a run's own definition names, for its item's header, fence and fields; undefined for a schedule. */
export function runEventSource(definition: RunDefinition): EventSource | undefined {
    const { trigger, filter } = definition.automation;
    if (trigger.kind !== 'event') return undefined;
    const resolution = resolveEventSource(trigger, filter);
    return resolution.ok ? resolution.source : undefined;
}

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
function fillPrompt(text: string, run: RunRecord, event: EventSource | undefined): { ok: true; text: string } | { ok: false; error: string } {
    const parsed = parseTemplate(text);
    if (!parsed.ok) return { ok: false, error: parsed.problem };
    const item = run.trigger.item;
    const rendered = renderTemplate(parsed.parts, (path) => {
        if (path.root === 'item') {
            const value = item && event ? event.itemValue(item, path.field) : undefined;
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
 * The run's first agent step, when it is an action of a run a trigger fired,
 * asks the host to look for the same review started by hand
 * (`startedByHandSince`) on its first attempt: the checkout's lock is let go
 * once it is prepared, and an Inbox click may land between the two.
 */
export function agentStepLaunch(input: {
    workspaceId: string;
    run: RunRecord;
    definition: RunDefinition;
    stepId: string;
    checkout: { cwd: string; scopeId: string };
}): AgentStepLaunch {
    const { workspaceId, run, definition, stepId, checkout } = input;
    const { steps } = definition.automation;
    const index = steps.findIndex((candidate) => candidate.id === stepId);
    const step = steps[index];
    const record = run.steps?.find((candidate) => candidate.id === stepId);
    if (step?.kind !== 'agent' || !record) return { ok: false, error: `Its definition has no agent step ${stepId}.` };

    const automation = run.automationId;
    const event = runEventSource(definition);
    const item = run.trigger.item;
    const workItem = itemRefOf(run);
    const action = definition.actions[step.id];

    let body: string;
    if (action) {
        if (!item || !workItem) return { ok: false, error: `${action.name} is an action, and this run has no item for it.` };
        // The title is the author's: the body points at it, the fence holds it.
        body = fillActionPlaceholders(action.body, { workItem, title: 'the title quoted below', url: item.url });
    } else {
        const filled = fillPrompt(step.prompt ?? '', run, event);
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
        ...(event && item ? { item: { header: event.describeItemHeader(item), fence: event.fenceItem(item) } } : {}),
        ...(definition.automation.scope ? { scope: definition.automation.scope } : {}),
        reads: readsOf(step, run.steps ?? []),
        outputs: step.outputs,
        artifacts: step.artifacts,
        handover: step.handover,
    });
    const name = `${item ? item.title : automation} · ${step.id}`;
    const firstAgentStep = steps.find((candidate) => candidate.kind === 'agent')?.id === step.id;
    // A later attempt is a person's retry or a restart's: the first attempt's launch already looked, and the click is the approval.
    const askByHand = run.trigger.kind === 'event' && firstAgentStep && action !== undefined && record.attempt === 1;
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
