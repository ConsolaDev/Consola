import type { StepsAutomation } from '@consola/factory-spec';

/** What a steps run executes: the entry as it was approved, with every action a step names. */
export interface RunDefinition {
    automation: StepsAutomation;
    version: string;
    /** By step id. */
    actions: Record<string, { name: string; body: string; groupId?: string }>;
}

/**
 * What a `steps:` run will do, kept on its run as `result`: which steps, and
 * the item or scope it is about. Light, so history's cap never blanks an
 * approval; what each step says is in the run folder's definition.
 */
export interface StepsRunPreview {
    kind: 'steps-run';
    steps: Array<{ id: string; kind: 'agent' | 'run' }>;
    /** The item an event run is about. Title and author are the author's own text. */
    item?: { url: string; title: string; author: string; label: string };
    /** A scheduled run's scope. */
    scope?: string;
}

/** The most one artifact (and a step's `output`) may hold. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
