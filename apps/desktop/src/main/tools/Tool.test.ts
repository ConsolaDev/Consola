import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolRegistry } from './Tool';
import type { ToolContext } from './Tool';
import { consolaTools } from './consolaTools';
import type { ConsolaToolDeps } from './consolaTools';

const context: ToolContext = {
  caller: { kind: 'automation', automation: 'test' },
  scope: { workspaceIds: 'all', excludeSessionIds: [] },
};

function registry() {
  const run = vi.fn(async (args: { count: number }) => ({
    summary: `ran ${args.count}`,
    data: args,
  }));
  const preview = vi.fn(async () => ({ summary: 'would run', data: null, actionable: 2 }));
  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: 'do_things',
      description: 'Does things.',
      input: { count: z.number().int().default(1) },
      roles: { count: 'data' },
      mutating: true,
      automatable: true,
      preview,
      run,
    }),
  );
  return { tools, run, preview };
}

describe('ToolRegistry', () => {
  it('finds a tool by consola# reference or bare name', () => {
    const { tools } = registry();
    expect(tools.get('consola#do_things')?.name).toBe('do_things');
    expect(tools.get('do_things')?.name).toBe('do_things');
    expect(tools.get('plugin:x#do_things')).toBeUndefined();
  });

  it('validates and defaults arguments before running', async () => {
    const { tools, run } = registry();
    await expect(tools.invoke('do_things', undefined, context)).resolves.toMatchObject({
      summary: 'ran 1',
    });
    expect(run).toHaveBeenCalledWith({ count: 1 }, context);
  });

  it('rejects unknown and ill-typed arguments with a readable reason', async () => {
    const { tools, run } = registry();
    await expect(tools.invoke('do_things', { count: 'two' }, context)).rejects.toThrow(
      /count: Invalid input: expected number/,
    );
    await expect(tools.invoke('do_things', { cuont: 2 }, context)).rejects.toThrow(
      /Unrecognized key/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('routes preview mode to preview', async () => {
    const { tools, run, preview } = registry();
    await expect(tools.invoke('do_things', {}, context, 'preview')).resolves.toMatchObject({
      actionable: 2,
    });
    expect(preview).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a tool without the preview someone must approve from, and duplicates', () => {
    const tools = new ToolRegistry();
    const base = { description: '', input: {}, run: async () => ({ summary: '', data: null }) };
    expect(() =>
      tools.register(defineTool({ ...base, name: 'x', mutating: true, automatable: true })),
    ).toThrow(/preview/);
    // An agent's destructive call waits for a person, who approves its preview.
    expect(() =>
      tools.register(
        defineTool({ ...base, name: 'w', mutating: true, destructive: true, automatable: false }),
      ),
    ).toThrow(/preview/);
    // Only agents call this one directly; nothing ever needs its preview.
    tools.register(defineTool({ ...base, name: 'z', mutating: true, automatable: false }));
    tools.register(defineTool({ ...base, name: 'y', mutating: false, automatable: false }));
    expect(() =>
      tools.register(defineTool({ ...base, name: 'y', mutating: false, automatable: false })),
    ).toThrow(/already/);
  });

  it('names an unknown tool', async () => {
    await expect(registry().tools.invoke('consola#nope', {}, context)).rejects.toThrow(
      /No Consola tool named/,
    );
  });
});

describe('what each argument of an automatable tool does (Call 5)', () => {
  const run = async () => ({ summary: 'ran', data: null });
  const preview = async () => ({ summary: 'would run', data: null });

  it('refuses an automatable tool with an argument that has no role, naming it', () => {
    const tools = new ToolRegistry();
    expect(() =>
      tools.register(
        defineTool({
          name: 'tag_things',
          description: 'Tags things.',
          input: { a: z.string(), b: z.string() },
          roles: { a: 'data' },
          mutating: true,
          automatable: true,
          preview,
          run,
        }),
      ),
    ).toThrow(
      'Automatable tool tag_things must say what each argument does (prompt, selector or data): b has no role.',
    );
  });

  it("keys the roles by the tool's own arguments, so a misspelt one does not compile (review Minor 15)", () => {
    const tool = defineTool({
      name: 'tag_things',
      description: 'Tags things.',
      input: { a: z.string() },
      // @ts-expect-error `b` is not one of its arguments
      roles: { b: 'data' },
      mutating: false,
      automatable: true,
      run,
    });
    expect(tool.name).toBe('tag_things');
  });

  it('registers an automatable tool with a role for every argument, and needs none for a tool no automation names', () => {
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'tag_things',
        description: 'Tags things.',
        input: { a: z.string(), b: z.string() },
        roles: { a: 'data', b: 'selector' },
        mutating: true,
        automatable: true,
        preview,
        run,
      }),
    );
    tools.register(
      defineTool({
        name: 'list_things',
        description: 'Lists things.',
        input: { a: z.string() },
        mutating: false,
        automatable: false,
        run,
      }),
    );
    expect(tools.list().map((tool) => tool.name)).toEqual(['tag_things', 'list_things']);
  });

  it('has a role for every argument of every automatable tool the app registers', () => {
    // The list main registers (`ipc-handlers.ts`); building it calls none of its deps.
    const tools = new ToolRegistry();
    for (const tool of consolaTools({} as ConsolaToolDeps)) tools.register(tool);
    const automatable = tools.list().filter((tool) => tool.automatable);
    expect(automatable.map((tool) => tool.name)).toContain('cleanup_stale_sessions');
    for (const tool of automatable) {
      for (const argument of Object.keys(tool.input)) {
        expect(tool.roles?.[argument], `${tool.name}: ${argument}`).toMatch(
          /^(prompt|selector|data)$/,
        );
      }
    }
    expect(tools.get('cleanup_stale_sessions')?.roles).toEqual({
      pr_states: 'selector',
      session_ids: 'selector',
    });
  });
});
