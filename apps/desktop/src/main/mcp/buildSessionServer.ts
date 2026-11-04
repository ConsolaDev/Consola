import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from '../../shared/workspace';
import type { ToolContext, ToolRegistry } from '../tools/Tool';
import { asToolResult } from './toolResult';

export interface SessionServerDeps {
    registry: Pick<ToolRegistry, 'list' | 'invoke'>;
    /** Adds the group tools; called only for conductors. */
    conductorTools: { addTo(server: McpServer, conductorSessionId: string): void };
    getWorkspaces(): Workspace[];
}

/**
 * The MCP server one session sees, built fresh for each connection.
 *
 * Every session gets the Consola tools, acting on its own workspace and never
 * on itself; a conductor also gets its group tools. The session id comes from
 * the endpoint the connection arrived on (SessionMcpHost), and the caller is
 * re-resolved on every call, so a deleted or moved session loses its
 * authority immediately.
 */
export function buildSessionServer(sessionId: string, deps: SessionServerDeps): McpServer {
    const server = new McpServer({ name: 'consola', version: '1.0.0' });

    for (const tool of deps.registry.list()) {
        server.registerTool(
            `consola_${tool.name}`,
            {
                description: tool.description,
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
                    const context = agentContext(sessionId, deps.getWorkspaces());
                    const result = await deps.registry.invoke(tool.name, args, context);
                    return isRecord(result.data)
                        ? { summary: result.summary, ...result.data }
                        : { summary: result.summary, data: result.data };
                })
        );
    }

    // A session's kind is fixed for its lifetime, so deciding per connection is enough.
    const caller = deps
        .getWorkspaces()
        .flatMap((workspace) => workspace.sessions)
        .find((session) => session.id === sessionId);
    if (caller?.kind === 'conductor') deps.conductorTools.addTo(server, sessionId);

    return server;
}

/** Authority for a call from an agent: its own workspace, minus itself. */
export function agentContext(sessionId: string, workspaces: Workspace[]): ToolContext {
    const workspace = workspaces.find((candidate) =>
        candidate.sessions.some((session) => session.id === sessionId)
    );
    if (!workspace) throw new Error('Calling session no longer exists.');
    return {
        caller: { kind: 'agent', sessionId, workspaceId: workspace.id },
        scope: { workspaceIds: [workspace.id], excludeSessionIds: [sessionId] },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
