import type { StepsAutomation } from '@consola/factory-spec';

/** What a steps run executes: the entry as it was approved, with every action a step names. */
export interface RunDefinition {
    automation: StepsAutomation;
    version: string;
    /** By step id. */
    actions: Record<string, { name: string; body: string; groupId?: string }>;
}

/** The most one artifact (and a step's `output`) may hold. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
