// 'zod/v3', not 'zod': these shapes are handed to the MCP SDK, whose
// zod-compat types trip TS2589 on the root import.
import { z } from 'zod/v3';
import type { Workspace } from '../../shared/workspace';

/**
 * A Consola tool: one capability, reached by agents over the session MCP
 * server and by automations through `run: consola#<name>` (Settings' Run now
 * is an automation run). The registry is the only place arguments are
 * validated, and authority comes from the `ToolContext` the transport builds,
 * never from the arguments.
 */

/** Who is calling. Context for the tool, never the source of authority. */
export type ToolCaller =
    | { kind: 'agent'; sessionId: string; workspaceId: string }
    | { kind: 'automation'; automation: string };

/** What the caller may act on. */
export interface ToolScope {
    workspaceIds: readonly string[] | 'all';
    /** Sessions the call must never touch: the calling session itself. */
    excludeSessionIds: readonly string[];
}

export interface ToolContext {
    caller: ToolCaller;
    scope: ToolScope;
}

export type AgentCaller = Extract<ToolCaller, { kind: 'agent' }>;

/**
 * Authority for a call from an agent: its own workspace, minus itself.
 * Resolved from the session at the moment of the call, so a session deleted
 * or moved since has none.
 */
export function agentContext(sessionId: string, workspaces: Workspace[]): ToolContext & { caller: AgentCaller } {
    const workspace = workspaces.find((candidate) =>
        candidate.sessions.some((session) => session.id === sessionId)
    );
    if (!workspace) throw new Error('Calling session no longer exists.');
    return {
        caller: { kind: 'agent', sessionId, workspaceId: workspace.id },
        scope: { workspaceIds: [workspace.id], excludeSessionIds: [sessionId] },
    };
}

/** The workspaces a scope covers, in their stored order. */
export function workspacesInScope(workspaces: Workspace[], scope: ToolScope): Workspace[] {
    return scope.workspaceIds === 'all'
        ? workspaces
        : workspaces.filter((workspace) => scope.workspaceIds.includes(workspace.id));
}

export interface ToolResult {
    /** One sentence a person reads in a notification or run history. */
    summary: string;
    /** Structured result for the caller: small, JSON-serialisable. */
    data: unknown;
    /**
     * How many things this changed (run) or would change (preview), failures
     * included. Zero lets an automation finish quietly instead of asking —
     * or notifying — about nothing.
     */
    actionable?: number;
    /**
     * Previews only: the arguments that run exactly what was previewed and
     * nothing more. What approving a `confirm` run executes, so a person
     * approves what they saw, not whatever a fresh plan finds later.
     */
    approvalArgs?: Record<string, unknown>;
}

export const CONSOLA_NAMESPACE = 'consola';

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
    /** snake_case; the id is `consola#<name>` and the MCP name `consola_<name>`. */
    name: string;
    description: string;
    input: Shape;
    /** Changes something. Automatable mutating tools must offer `preview`. */
    mutating: boolean;
    /**
     * Can delete something. Surfaced to the CLI as MCP's `destructiveHint`,
     * and an agent's call never runs directly: it waits in Consola for a
     * person to approve its preview — so it must offer one.
     */
    destructive?: boolean;
    /**
     * Whether factory.yml may name it in `run:`. Read-only listings, tools
     * that need a target only a person or agent can name, and tools that
     * would let an automation start automations, are not.
     */
    automatable: boolean;
    /** Never offered to a read-only session, even when it changes nothing. */
    fullToolsOnly?: boolean;
    /** What `run` would do, changing nothing. */
    preview?(args: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<ToolResult>;
    run(args: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<ToolResult>;
}

/** Erases a tool's own shape so tools of different shapes share one registry. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition {
    return tool as unknown as ToolDefinition;
}

export type ToolMode = 'preview' | 'run';

export class ToolRegistry {
    private readonly tools = new Map<string, ToolDefinition>();

    public register(tool: ToolDefinition): void {
        if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered.`);
        // confirm and notify modes show a preview first, so anything an
        // automation can run that changes things must be able to give one.
        if (tool.automatable && tool.mutating && !tool.preview) {
            throw new Error(`Automatable tool ${tool.name} changes things, so it must offer a preview.`);
        }
        if (tool.destructive && !tool.preview) {
            throw new Error(`Destructive tool ${tool.name} must offer a preview: a person approves an agent's call from it.`);
        }
        this.tools.set(tool.name, tool);
    }

    public list(): ToolDefinition[] {
        return [...this.tools.values()];
    }

    /** By `consola#<name>` reference or bare name. */
    public get(ref: string): ToolDefinition | undefined {
        const name = ref.startsWith(`${CONSOLA_NAMESPACE}#`) ? ref.slice(CONSOLA_NAMESPACE.length + 1) : ref;
        return this.tools.get(name);
    }

    /** Parse arguments against the tool's schema; a readable message on failure. */
    public validate(
        tool: ToolDefinition,
        raw: unknown
    ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
        const parsed = z.object(tool.input).strict().safeParse(raw ?? {});
        if (parsed.success) return { ok: true, args: parsed.data };
        return {
            ok: false,
            error: parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
                .join('; '),
        };
    }

    public async invoke(
        ref: string,
        raw: unknown,
        context: ToolContext,
        mode: ToolMode = 'run'
    ): Promise<ToolResult> {
        const tool = this.get(ref);
        if (!tool) throw new Error(`No Consola tool named "${ref}".`);
        const validated = this.validate(tool, raw);
        if (!validated.ok) throw new Error(`Invalid arguments for ${tool.name}: ${validated.error}`);
        if (mode === 'preview') {
            if (!tool.preview) throw new Error(`${tool.name} has nothing to preview; it changes nothing.`);
            return tool.preview(validated.args, context);
        }
        return tool.run(validated.args, context);
    }
}
