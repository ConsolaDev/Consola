import { z } from 'zod/v3';
import type { RunRecord } from '@consola/factory-spec';
import type { AutomationView } from '../../shared/automations';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Workspace } from '../../shared/workspace';
import type { SessionCleanupService } from '../cleanup/SessionCleanupService';
import {
    defineTool,
    workspacesInScope,
    type ToolContext,
    type ToolDefinition,
    type ToolResult,
} from './Tool';

/**
 * The tools Consola itself offers. Descriptions are written for the agent
 * reading them: what the tool touches, what it never touches, and which tool
 * to call first.
 */

/** The slice of the automation runner the tools need, resolved lazily: the runner itself runs tools. */
export interface AutomationControl {
    list(): AutomationView[];
    /** Fire an automation now, in its own mode: a `confirm` automation still waits for a person. */
    trigger(name: string, actor: { sessionId?: string }): Promise<RunRecord>;
}

export interface ConsolaToolDeps {
    cleanup: Pick<SessionCleanupService, 'previewStale' | 'cleanupStale' | 'deleteSession'>;
    getWorkspaces(): Workspace[];
    status(instanceId: string): TerminalStatus;
    isManagedPath(dir: string): boolean;
    automations(): AutomationControl;
}

const staleInput = {
    pr_states: z
        .array(z.enum(['merged', 'closed']))
        .min(1)
        .default(['merged', 'closed'])
        .describe('Which finished pull requests count as stale. Default: both.'),
    session_ids: z
        .array(z.string().min(1))
        .optional()
        .describe('Only consider these sessions, e.g. the ids a find_stale_sessions call returned.'),
};

type StaleArgs = { pr_states: Array<'merged' | 'closed'>; session_ids?: string[] };

function staleOptions(args: StaleArgs) {
    return { prStates: args.pr_states, ...(args.session_ids ? { sessionIds: args.session_ids } : {}) };
}

/**
 * A cleanup preview as a tool result. Its approval arguments name exactly
 * the sessions previewed, so approving it can never remove one more.
 */
async function stalePreview(deps: ConsolaToolDeps, args: StaleArgs, context: ToolContext): Promise<ToolResult> {
    const preview = await deps.cleanup.previewStale(context.scope, staleOptions(args));
    return {
        summary: preview.summary,
        data: preview,
        actionable: preview.candidates.length,
        approvalArgs: { ...args, session_ids: preview.candidates.map((candidate) => candidate.sessionId) },
    };
}

const DISK_NOTE =
    'Ignored files in a removed worktree (build output, dependencies, local env files) go with it. ' +
    'Claude transcripts are never deleted.';

export function consolaTools(deps: ConsolaToolDeps): ToolDefinition[] {
    return [
        defineTool({
            name: 'list_sessions',
            description:
                'List the sessions in your Consola workspace: id, name, status (working | ready | ' +
                'needs-attention | exited), the pull request or issue it is linked to, its working ' +
                'directory, and whether that is a Consola-managed worktree. Read-only.',
            input: {},
            mutating: false,
            automatable: false,
            async run(_args, context: ToolContext) {
                const sessions = workspacesInScope(deps.getWorkspaces(), context.scope).flatMap((workspace) =>
                    workspace.sessions.map((session) => ({
                        sessionId: session.id,
                        name: session.name,
                        workspace: workspace.name,
                        status: deps.status(session.instanceId),
                        kind: session.kind,
                        ...(session.groupId
                            ? { group: workspace.groups.find((group) => group.id === session.groupId)?.name }
                            : {}),
                        ...(session.workItem
                            ? {
                                  workItem: `${session.workItem.repo}#${session.workItem.number}`,
                                  workItemType: session.workItem.type,
                              }
                            : {}),
                        ...(session.workItemAction ? { action: session.workItemAction } : {}),
                        ...(session.cwd
                            ? { cwd: session.cwd, consolaWorktree: deps.isManagedPath(session.cwd) }
                            : {}),
                        ...(context.scope.excludeSessionIds.includes(session.id) ? { you: true } : {}),
                    }))
                );
                return { summary: `${sessions.length} sessions.`, data: { sessions } };
            },
        }),

        defineTool({
            name: 'find_stale_sessions',
            description:
                'Find sessions in your workspace whose pull request is merged or closed, and say what ' +
                'cleaning them up would remove (session, Consola worktree, local branch) or why each is ' +
                'kept. Changes nothing. Call this before consola_cleanup_stale_sessions.',
            input: staleInput,
            mutating: false,
            automatable: false,
            run: (args, context) => stalePreview(deps, args, context),
        }),

        defineTool({
            name: 'cleanup_stale_sessions',
            description:
                'Remove sessions in your workspace whose pull request is merged or closed, together with ' +
                'their Consola worktrees and local branches. Anything not provably safe is kept and ' +
                'reported: uncommitted changes, commits missing from the pull request, sessions that are ' +
                'working or waiting on a prompt, worktrees outside Consola’s own folder, conductors, and ' +
                `you. ${DISK_NOTE} Pass session_ids from a consola_find_stale_sessions result to remove ` +
                'only those.',
            input: staleInput,
            mutating: true,
            destructive: true,
            automatable: true,
            preview: (args, context) => stalePreview(deps, args, context),
            async run(args, context) {
                const result = await deps.cleanup.cleanupStale(context.scope, staleOptions(args));
                return {
                    summary: result.summary,
                    data: result,
                    actionable: result.removed.length + result.failed.length,
                };
            },
        }),

        defineTool({
            name: 'delete_session',
            description:
                'Delete one session in your workspace by id (see consola_list_sessions). Its Consola ' +
                'worktree and local branch are deleted too, but only when the worktree is clean, every ' +
                'commit is pushed, and no other session uses it; otherwise they are kept and the result ' +
                `says why. Refuses busy sessions, conductors and yourself. ${DISK_NOTE}`,
            input: { session_id: z.string().min(1).describe('The session to delete.') },
            mutating: true,
            destructive: true,
            automatable: false,
            async run(args, context) {
                const outcome = await deps.cleanup.deleteSession(context.scope, args.session_id);
                return { summary: `Deleted "${outcome.sessionName}".`, data: outcome };
            },
        }),

        defineTool({
            name: 'list_automations',
            description:
                'List the automations in ~/.consola/factory.yml: schedule, mode (auto | confirm | ' +
                'notify), what each runs, the next run, and any problem keeping one from running.',
            input: {},
            mutating: false,
            automatable: false,
            async run() {
                const automations = deps.automations().list();
                return { summary: `${automations.length} automations.`, data: { automations } };
            },
        }),

        defineTool({
            name: 'run_automation',
            description:
                'Run an automation from ~/.consola/factory.yml now, by name, across the workspaces it ' +
                'names. A `notify` automation only reports; any other waits for the person to approve ' +
                'it in Consola — `auto` included, since the person did not start this run. If a run is ' +
                'already waiting for approval, returns that one instead of starting another. Returns ' +
                'the run’s id, status and a one-line summary; the person reviews the details in Consola.',
            input: { name: z.string().min(1).describe('The automation’s name, as in factory.yml.') },
            mutating: true,
            automatable: false,
            async run(args, context) {
                const actor = context.caller.kind === 'agent' ? { sessionId: context.caller.sessionId } : {};
                const run = await deps.automations().trigger(args.name, actor);
                // The run can span workspaces beyond the caller's own, so the
                // caller learns the outcome, never the sessions, paths or
                // pull requests behind it. Summaries are counts only.
                return {
                    summary: run.summary ?? `${args.name}: ${run.status}.`,
                    data: { runId: run.id, status: run.status },
                };
            },
        }),
    ];
}
