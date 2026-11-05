import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// 'zod/v3', not 'zod': the root import trips TS2589 in the SDK's zod-compat conditional types.
import { z } from 'zod/v3';
import type { TerminalStatus } from '../../shared/terminalStatus';
import {
    generateSessionInstanceId,
    type NewSessionFields,
    type Session,
    type Workspace,
} from '../../shared/workspace';
import { asToolResult } from '../mcp/toolResult';

/**
 * The tools a conductor drives its group with: spawn, prompt, observe.
 *
 * Added on top of the Consola tools on a conductor's own MCP endpoint
 * (SessionMcpHost), and only there. Scope of authority is the conductor's
 * group, resolved fresh from the records on every call, never trusted from
 * arguments — the conductor's id comes from the endpoint the call arrived on.
 */

/** The fleet's own status vocabulary: what a conductor sees is what the UI shows. */
export type ConductorSessionStatus = TerminalStatus;

export interface ConductorToolsDeps {
    getWorkspaces(): Workspace[];
    launchSession(
        workspaceId: string,
        fields: NewSessionFields & { initialPrompt?: string }
    ): Promise<Session>;
    /** Enqueue on the session's guarded FIFO. False when no live terminal. */
    queuePrompt(instanceId: string, prompt: string): boolean;
    getStatus(instanceId: string): ConductorSessionStatus;
}

export class ConductorTools {
    constructor(private readonly deps: ConductorToolsDeps) {}

    /** Register the four group tools on one conductor's server. */
    public addTo(server: McpServer, conductorSessionId: string): void {
        server.registerTool(
            'consola_spawn_session',
            {
                description:
                    'Start a worker session in your group. scopePath must be one of the ' +
                    "workspace's scopes (omit for your own scope); cwd must be inside it. " +
                    'Returns { sessionId, instanceId }.',
                inputSchema: {
                    name: z.string().min(1),
                    scopePath: z.string().optional(),
                    cwd: z.string().optional(),
                    prompt: z.string().min(1),
                },
            },
            (args) => asToolResult(() => this.handleSpawnSession(conductorSessionId, args))
        );

        server.registerTool(
            'consola_send_prompt',
            {
                description:
                    'Queue a prompt on a session in your group. Delivery waits for an ' +
                    'empty composer and never types into a menu.',
                inputSchema: {
                    sessionId: z.string().min(1),
                    prompt: z.string().min(1),
                },
            },
            (args) => asToolResult(() => this.handleSendPrompt(conductorSessionId, args))
        );

        server.registerTool(
            'consola_session_status',
            {
                description:
                    "One group member's state: working | ready | needs-attention | exited.",
                inputSchema: { sessionId: z.string().min(1) },
            },
            (args) => asToolResult(() => this.handleSessionStatus(conductorSessionId, args))
        );

        server.registerTool(
            'consola_group_status',
            {
                description: 'Every session in your group: [{ sessionId, name, status }].',
                inputSchema: {},
            },
            () => asToolResult(() => this.handleGroupStatus(conductorSessionId))
        );
    }

    /**
     * Who is calling, resolved fresh from the records on every tool call.
     *
     * The id comes from the endpoint the request arrived on, so this cannot
     * be spoofed by arguments; re-resolving means a deleted conductor or a
     * changed group takes effect immediately.
     */
    private resolveConductor(conductorSessionId: string): {
        workspace: Workspace;
        conductor: Session;
        groupId: string;
    } {
        for (const workspace of this.deps.getWorkspaces()) {
            const conductor = workspace.sessions.find((s) => s.id === conductorSessionId);
            if (!conductor) continue;
            if (conductor.kind !== 'conductor') {
                throw new Error('Calling session is not a conductor.');
            }
            if (!conductor.groupId) {
                throw new Error('Conductor has no group; nothing to act on.');
            }
            return { workspace, conductor, groupId: conductor.groupId };
        }
        throw new Error('Conductor session no longer exists.');
    }

    private groupMembers(workspace: Workspace, groupId: string): Session[] {
        return workspace.sessions.filter((s) => s.groupId === groupId);
    }

    public async handleSpawnSession(
        conductorSessionId: string,
        args: { name: string; scopePath?: string; cwd?: string; prompt: string }
    ): Promise<{ sessionId: string; instanceId: string }> {
        const { workspace, conductor, groupId } = this.resolveConductor(conductorSessionId);

        const scope = args.scopePath
            ? workspace.scopes.find((s) => path.resolve(s.path) === path.resolve(args.scopePath!))
            : workspace.scopes.find((s) => s.id === conductor.scopeId);
        if (!scope) {
            throw new Error(
                `scopePath is not one of this workspace's scopes: ${args.scopePath ?? '(conductor scope missing)'}`
            );
        }

        if (args.cwd) {
            const relative = path.relative(path.resolve(scope.path), path.resolve(args.cwd));
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`cwd must be inside the scope ${scope.path}`);
            }
        }

        // groupId and kind come from the calling conductor's record, never
        // from arguments: a conductor cannot spawn outside its own group, and
        // cannot mint further conductors. Workers inherit its harness so the
        // whole group runs as one login.
        const spawned = await this.deps.launchSession(workspace.id, {
            name: args.name,
            workspaceId: workspace.id,
            instanceId: generateSessionInstanceId(workspace.id),
            harnessId: conductor.harnessId,
            scopeId: scope.id,
            cwd: args.cwd,
            groupId,
            kind: 'interactive',
            initialPrompt: args.prompt,
        } as NewSessionFields & { initialPrompt?: string });

        return { sessionId: spawned.id, instanceId: spawned.instanceId };
    }

    public handleSendPrompt(
        conductorSessionId: string,
        args: { sessionId: string; prompt: string }
    ): { queued: true } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);

        if (!this.deps.queuePrompt(target.instanceId, args.prompt)) {
            throw new Error(`Session ${args.sessionId} has no live terminal; prompt not delivered.`);
        }
        return { queued: true };
    }

    public handleSessionStatus(
        conductorSessionId: string,
        args: { sessionId: string }
    ): { status: ConductorSessionStatus; name: string } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);
        return { status: this.deps.getStatus(target.instanceId), name: target.name };
    }

    public handleGroupStatus(
        conductorSessionId: string
    ): Array<{ sessionId: string; name: string; status: ConductorSessionStatus }> {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        return this.groupMembers(workspace, groupId).map((member) => ({
            sessionId: member.id,
            name: member.name,
            status: this.deps.getStatus(member.instanceId),
        }));
    }
}
