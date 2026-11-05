import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { defineTool, ToolRegistry, type ToolContext } from './Tool';

const context: ToolContext = {
    caller: { kind: 'automation', automation: 'test' },
    scope: { workspaceIds: 'all', excludeSessionIds: [] },
};

function registry() {
    const run = vi.fn(async (args: { count: number }) => ({ summary: `ran ${args.count}`, data: args }));
    const preview = vi.fn(async () => ({ summary: 'would run', data: null, actionable: 2 }));
    const tools = new ToolRegistry();
    tools.register(
        defineTool({
            name: 'do_things',
            description: 'Does things.',
            input: { count: z.number().int().default(1) },
            mutating: true,
            automatable: true,
            preview,
            run,
        })
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
        await expect(tools.invoke('do_things', undefined, context)).resolves.toMatchObject({ summary: 'ran 1' });
        expect(run).toHaveBeenCalledWith({ count: 1 }, context);
    });

    it('rejects unknown and ill-typed arguments with a readable reason', async () => {
        const { tools, run } = registry();
        await expect(tools.invoke('do_things', { count: 'two' }, context)).rejects.toThrow(/count: Expected number/);
        await expect(tools.invoke('do_things', { cuont: 2 }, context)).rejects.toThrow(/Unrecognized key/);
        expect(run).not.toHaveBeenCalled();
    });

    it('routes preview mode to preview', async () => {
        const { tools, run, preview } = registry();
        await expect(tools.invoke('do_things', {}, context, 'preview')).resolves.toMatchObject({ actionable: 2 });
        expect(preview).toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
    });

    it('refuses a tool without the preview someone must approve from, and duplicates', () => {
        const tools = new ToolRegistry();
        const base = { description: '', input: {}, run: async () => ({ summary: '', data: null }) };
        expect(() =>
            tools.register(defineTool({ ...base, name: 'x', mutating: true, automatable: true }))
        ).toThrow(/preview/);
        // An agent's destructive call waits for a person, who approves its preview.
        expect(() =>
            tools.register(defineTool({ ...base, name: 'w', mutating: true, destructive: true, automatable: false }))
        ).toThrow(/preview/);
        // Only agents call this one directly; nothing ever needs its preview.
        tools.register(defineTool({ ...base, name: 'z', mutating: true, automatable: false }));
        tools.register(defineTool({ ...base, name: 'y', mutating: false, automatable: false }));
        expect(() =>
            tools.register(defineTool({ ...base, name: 'y', mutating: false, automatable: false }))
        ).toThrow(/already/);
    });

    it('names an unknown tool', async () => {
        await expect(registry().tools.invoke('consola#nope', {}, context)).rejects.toThrow(/No Consola tool named/);
    });
});
