import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RunRecord } from '@consola/factory-spec';
import type { Workspace } from '../../shared/workspace';
import { agentContext, type ToolRegistry, type ToolResult } from '../tools/Tool';
import { mcpToolName } from './names';
import { asToolResult } from './toolResult';

export interface SessionServerDeps {
    registry: Pick<ToolRegistry, 'list' | 'invoke'>;
    /** Where an agent's destructive call waits for a person (AutomationService.requestApproval). */
    approvals: {
        request(toolName: string, args: unknown, sessionId: string): Promise<{ preview: ToolResult; run: RunRecord | null }>;
    };
    /** Adds the group tools; called only for conductors. */
    conductorTools: { addTo(server: McpServer, conductorSessionId: string): void };
    getWorkspaces(): Workspace[];
}

/** Told to the agent on every destructive tool, so it knows to hand the decision over. */
const APPROVAL_NOTE =
    ' Nothing is removed when you call this: Consola shows the plan to the person, and it runs only once ' +
    'they approve it there. The result is the plan waiting for them.';

/**
 * The MCP server one session sees, built fresh for each connection.
 *
 * Every session gets the Consola tools, acting on its own workspace and never
 * on itself; a conductor also gets its group tools. The session id comes from
 * the endpoint the connection arrived on (SessionMcpHost), and the caller is
 * re-resolved on every call, so a deleted or moved session loses its
 * authority immediately.
 *
 * An agent never runs a destructive tool itself, whatever its CLI's
 * permission settings: the call becomes a plan waiting for the person in
 * Settings › Automations, and runs only when they approve it there.
 */
export function buildSessionServer(sessionId: string, deps: SessionServerDeps): McpServer {
    const server = new McpServer({ name: 'consola', version: '1.0.0' });

    // A session's kind and tool policy are fixed for its lifetime, so
    // deciding per connection is enough.
    const caller = deps
        .getWorkspaces()
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === sessionId);
    // A read-only session — one an automation started — gets only tools that
    // change nothing: no deletes, and no run_automation, since a run never
    // starts another run. Whatever its item's text talks it into, it has no
    // hands here.
    const readOnly = caller?.toolPolicy === 'read-only';

    for (const tool of deps.registry.list()) {
        if (readOnly && tool.mutating) continue;
        server.registerTool(
            mcpToolName(tool.name),
            {
                description: tool.destructive ? tool.description + APPROVAL_NOTE : tool.description,
                inputSchema: tool.input,
                // How the CLI should treat it when asking the person: a
                // listing is safe to allow; a cleanup deletes things.
                annotations: {
                    readOnlyHint: !tool.mutating,
                    destructiveHint: tool.destructive ?? false,
                    openWorldHint: false,
                },
            },
            (args: unknown) =>
                asToolResult(async () => {
                    if (tool.destructive) {
                        return awaitingApproval(await deps.approvals.request(tool.name, args, sessionId));
                    }
                    const context = agentContext(sessionId, deps.getWorkspaces());
                    return flatten(await deps.registry.invoke(tool.name, args, context));
                })
        );
    }

    if (caller?.kind === 'conductor' && !readOnly) deps.conductorTools.addTo(server, sessionId);

    return server;
}

/** What an agent learns of its destructive call: the plan, and that the person decides. */
function awaitingApproval({ preview, run }: { preview: ToolResult; run: RunRecord | null }) {
    if (!run) return flatten(preview); // Nothing to do, so nothing to approve.
    return {
        ...flatten({
            ...preview,
            summary: `${preview.summary} Waiting for the person to approve it in Consola; nothing has changed yet.`,
        }),
        runId: run.id,
        status: run.status,
    };
}

/** The result's own summary wins over any `summary` its data carries. */
function flatten(result: ToolResult): Record<string, unknown> {
    return isRecord(result.data)
        ? { ...result.data, summary: result.summary }
        : { summary: result.summary, data: result.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
