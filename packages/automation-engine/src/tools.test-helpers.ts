import { z } from 'zod/v3';
import { CONSOLA_NAMESPACE } from './support';
import type { EngineToolContext, EngineToolResult, ToolsPort } from './ports';

/*
 * A tool registry for tests, with the rules and messages of the desktop's
 * `ToolRegistry`, so the runner is tested against the behaviour it will meet.
 */

/** A test tool: the engine's tool contract with a zod input shape. */
export interface TestTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  mutating: boolean;
  destructive?: boolean;
  automatable: boolean;
  fullToolsOnly?: boolean;
  preview?(
    args: z.infer<z.ZodObject<Shape>>,
    context: EngineToolContext,
  ): Promise<EngineToolResult>;
  run(args: z.infer<z.ZodObject<Shape>>, context: EngineToolContext): Promise<EngineToolResult>;
}

/** Erases a tool's own shape so tools of different shapes share one registry. */
export function defineTool<Shape extends z.ZodRawShape>(tool: TestTool<Shape>): TestTool {
  return tool as unknown as TestTool;
}

export class FakeToolRegistry implements ToolsPort {
  private readonly tools = new Map<string, TestTool>();

  public register(tool: TestTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered.`);
    if (tool.automatable && tool.mutating && !tool.preview) {
      throw new Error(`Automatable tool ${tool.name} changes things, so it must offer a preview.`);
    }
    if (tool.destructive && !tool.preview) {
      throw new Error(
        `Destructive tool ${tool.name} must offer a preview: a person approves an agent's call from it.`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  public list(): TestTool[] {
    return [...this.tools.values()];
  }

  /** By `consola#<name>` reference or bare name. */
  public get(ref: string): TestTool | undefined {
    const name = ref.startsWith(`${CONSOLA_NAMESPACE}#`)
      ? ref.slice(CONSOLA_NAMESPACE.length + 1)
      : ref;
    return this.tools.get(name);
  }

  public validate(
    tool: TestTool,
    raw: unknown,
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    const parsed = z
      .object(tool.input)
      .strict()
      .safeParse(raw ?? {});
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
    context: EngineToolContext,
    mode: 'preview' | 'run' = 'run',
  ): Promise<EngineToolResult> {
    const tool = this.get(ref);
    if (!tool) throw new Error(`No Consola tool named "${ref}".`);
    const validated = this.validate(tool, raw);
    if (!validated.ok) throw new Error(`Invalid arguments for ${tool.name}: ${validated.error}`);
    if (mode === 'preview') {
      if (!tool.preview)
        throw new Error(`${tool.name} has nothing to preview; it changes nothing.`);
      return tool.preview(validated.args, context);
    }
    return tool.run(validated.args, context);
  }
}
