import type { ActionView, ItemRef, ScopeView, WorkspaceView } from './views';
import type { EngineToolCaller, EngineToolContext } from './ports';

/*
 * Small helpers the runner shares with the desktop. Copies, not moves: the
 * renderer imports the originals at runtime and cannot import this package
 * (it pulls in Node built-ins). The desktop's `engineViews.test.ts` pins each
 * one to its original, so a drift fails there.
 */

/** A caught value as a label. Deliberately shallow: never reads `.stderr` or argv. */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const CONSOLA_NAMESPACE = 'consola';

/**
 * Authority for a call from an agent: its own workspace, minus itself.
 * Resolved from the session at the moment of the call.
 */
export function agentToolContext(
    sessionId: string,
    workspaces: WorkspaceView[]
): EngineToolContext & { caller: Extract<EngineToolCaller, { kind: 'agent' }> } {
    const workspace = workspaces.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
    if (!workspace) throw new Error('Calling session no longer exists.');
    return {
        caller: { kind: 'agent', sessionId, workspaceId: workspace.id },
        scope: { workspaceIds: [workspace.id], excludeSessionIds: [sessionId] },
    };
}

/** The first action that applies to `itemType`, in the person's own order. */
export function firstActionFor(actions: ActionView[], itemType: 'pr' | 'issue'): ActionView | undefined {
    return actions.find((action) => action.appliesTo.includes(itemType));
}

/** The workspace's first scope, which is its "workspace folder". */
export function firstScope(workspace: Pick<WorkspaceView, 'scopes'>): ScopeView | undefined {
    return workspace.scopes[0];
}

const PLACEHOLDER_PATTERN = /\{\{\s*(number|repo|title|url|type)\s*\}\}/g;

/**
 * Fill `{{number}} {{repo}} {{title}} {{url}} {{type}}`; any other braces stay
 * as typed. A template with no placeholders comes back untouched.
 */
export function fillActionPlaceholders(
    template: string,
    item: { workItem: ItemRef; title: string; url: string }
): string {
    const values: Record<string, string> = {
        number: String(item.workItem.number),
        repo: item.workItem.repo,
        title: item.title,
        url: item.url,
        type: item.workItem.type === 'pr' ? 'pull request' : 'issue',
    };
    return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => values[key]);
}

/**
 * The person started this item's action themselves while the automation was
 * on its way: their session is the review, and the automation's run is moot.
 */
export class StartedByHandError extends Error {
    constructor(readonly sessionName: string) {
        super(`Already started by hand: “${sessionName}”.`);
        this.name = 'StartedByHandError';
    }
}
