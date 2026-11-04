/**
 * What an automation's `run:` names.
 *
 * `<namespace>#<tool>` is a tool the runner invokes in-process, with no agent
 * and no tokens: `consola#cleanup_stale_sessions` today, `plugin:<id>#<tool>`
 * once plugins exist. A bare name is an action, a prompt recipe that starts an
 * agent session (`run: Review`). The grammar is fixed here so that the
 * runners and every validator agree on it; which namespaces and tools exist
 * is the runner's business, not the spec's.
 */
export type RunTarget =
    | { kind: 'tool'; ref: string; namespace: string; tool: string }
    | { kind: 'action'; ref: string; name: string };

const TOOL_REF = /^([a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)#([a-z][a-z0-9_]*)$/;

/** Null when `ref` is neither a well-formed tool reference nor an action name. */
export function parseRunTarget(ref: string): RunTarget | null {
    const trimmed = ref.trim();
    const tool = TOOL_REF.exec(trimmed);
    if (tool) {
        return { kind: 'tool', ref: trimmed, namespace: tool[1], tool: tool[2] };
    }
    // A `#` that did not match the tool grammar is a malformed tool reference,
    // never an action that happens to contain one.
    if (trimmed.length === 0 || trimmed.includes('#')) return null;
    return { kind: 'action', ref: trimmed, name: trimmed };
}
