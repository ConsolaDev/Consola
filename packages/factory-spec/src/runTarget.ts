/**
 * What an automation's `run:` names — an object with exactly one key.
 *
 * `tool: <namespace>#<tool>` is a tool the runner invokes in-process, with no
 * agent and no tokens (`consola#cleanup_stale_sessions` today,
 * `plugin:<id>#<tool>` once plugins exist); only a tool takes `with:`.
 * `action: <name>` is one of the workspace's actions, a prompt recipe that
 * starts an agent session on the trigger's item. `prompt: <text>` is a body
 * written in the automation itself. The grammar is fixed here so the runners
 * and every validator agree on it; which tools and actions exist is the
 * runner's business, not the spec's.
 */
export type RunTarget =
    | { kind: 'tool'; ref: string; namespace: string; tool: string; with: Record<string, unknown> }
    | { kind: 'action'; ref: string; name: string }
    | { kind: 'prompt'; ref: 'prompt'; prompt: string };

/** The run kinds that start an agent session. */
export type AgentRunTarget = Extract<RunTarget, { kind: 'action' | 'prompt' }>;

export function isAgentRun(run: RunTarget): run is AgentRunTarget {
    return run.kind !== 'tool';
}

const TOOL_REF = /^([a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)#([a-z][a-z0-9_]*)$/;

/** Null when `ref` is not a well-formed `namespace#tool` reference. */
export function parseToolRef(ref: string): { ref: string; namespace: string; tool: string } | null {
    const trimmed = ref.trim();
    const match = TOOL_REF.exec(trimmed);
    return match ? { ref: trimmed, namespace: match[1], tool: match[2] } : null;
}
