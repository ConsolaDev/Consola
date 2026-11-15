import { isStepsEntry, type Automation, type Step } from '@consola/factory-spec';
import { clipText } from './steps/commandIO';
import type { AutomationView } from './views';

/** The most of a command's first line a step's summary shows. */
const COMMAND_SUMMARY_CHARS = 80;

const actionRuns = (name: string) => `${name} action`;

/** What an entry runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions", "Steps: review → publish". */
export function describeRun(automation: Automation): string {
    if (isStepsEntry(automation)) return `Steps: ${automation.steps.map((step) => step.id).join(' → ')}`;
    const { run } = automation;
    if (run.kind === 'tool') return `Tool: ${run.tool}`;
    return run.kind === 'action' ? actionRuns(run.name) : 'Prompt';
}

/** A tool run in-process, or agent sessions; an entry of commands only runs no agent, so it reads as a tool. */
export function describeKind(automation: Automation): AutomationView['kind'] {
    if (isStepsEntry(automation)) return automation.steps.some((step) => step.kind === 'agent') ? 'agent' : 'tool';
    return automation.run.kind === 'tool' ? 'tool' : 'agent';
}

/** Each step as the automation page draws it: "Prompt", "Review action", or the command's first line. */
export function describeSteps(steps: Step[]): NonNullable<AutomationView['steps']> {
    return steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        ...(step.if !== undefined ? { if: step.if } : {}),
        ...(step.kind === 'run' && step.dryRun === 'run' ? { dryRun: true as const } : {}),
        summary: step.kind === 'run' ? commandSummary(step.run) : step.action !== undefined ? actionRuns(step.action) : 'Prompt',
    }));
}

function commandSummary(command: string): string {
    const line = command
        .split('\n')
        .map((text) => text.trim())
        .find((text) => text !== '');
    return clipText(line ?? '', COMMAND_SUMMARY_CHARS);
}

/** An event trigger that did not resolve, said as written. */
export function describeTriggerAsWritten(automation: Automation): string {
    const { trigger } = automation;
    return trigger.kind === 'event' ? `${trigger.connection}: ${trigger.events.join(', ')}` : trigger.cron;
}
