import { isStepsEntry, type Automation } from '@consola/factory-spec';

/** What an entry runs, in words: "Review action", "Prompt", "Tool: cleanup_stale_sessions", "Steps: review → publish". */
export function describeRun(automation: Automation): string {
    if (isStepsEntry(automation)) return `Steps: ${automation.steps.map((step) => step.id).join(' → ')}`;
    const { run } = automation;
    if (run.kind === 'tool') return `Tool: ${run.tool}`;
    return run.kind === 'action' ? `${run.name} action` : 'Prompt';
}

/** An event trigger that did not resolve, said as written. */
export function describeTriggerAsWritten(automation: Automation): string {
    const { trigger } = automation;
    return trigger.kind === 'event' ? `${trigger.connection}: ${trigger.events.join(', ')}` : trigger.cron;
}
