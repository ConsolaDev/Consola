import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';
import { LATER_KEYS, parseAutomationEntry } from '@consola/factory-spec';
import { describeCapabilities, GRAMMAR_EXAMPLES, TRUSTED_ITEM_FIELDS } from './capabilities';
import { defineTool } from './tools.test-helpers';
import { stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';

const indent = (text: string, by: string) =>
    text
        .split('\n')
        .map((line) => `${by}${line}`)
        .join('\n');

const CLEAN_UP = defineTool({
    name: 'cleanup_stale_sessions',
    description: 'Clean up sessions whose pull requests are done.',
    input: { pr_states: z.array(z.enum(['merged', 'closed'])).optional() },
    mutating: true,
    automatable: true,
    preview: async () => ({ summary: 'Would clean up.', data: null }),
    run: async () => ({ summary: 'Cleaned up.', data: null }),
});

const grammar = () =>
    describeCapabilities({
        filePath: '/f/factory.yml',
        fileExists: true,
        tools: [],
        actions: [],
        scopes: [],
        taken: [],
        boundConnection: 'github',
        harness: { name: 'Claude', problem: null },
    });

describe('what an agent writing an entry is told', () => {
    it('every GRAMMAR example parses and resolves', async () => {
        expect(GRAMMAR_EXAMPLES.map((example) => example.title)).toEqual([
            'A tool, on a schedule',
            'An action, on an event',
            'A prompt, on a schedule',
            'Steps, on an event',
        ]);
        // One name, one meaning: no two examples share an entry name.
        const names = GRAMMAR_EXAMPLES.map((example) => /^- name: (\S+)/.exec(example.entry)?.[1]);
        expect(new Set(names).size).toBe(names.length);

        for (const example of GRAMMAR_EXAMPLES) {
            const parsed = parseAutomationEntry(example.entry);
            if (!parsed.ok) throw new Error(`${example.title}: ${parsed.issues[0].message}`);
            // Each example appears in the grammar text as written.
            expect(grammar().grammar, example.title).toContain(example.entry);

            const h = await stepsHarness({ tools: [CLEAN_UP], yaml: `version: 1\nautomations:\n${indent(example.entry, '  ')}\n` });
            const [listed] = h.service.list(WORKSPACE_ID);
            expect(listed.name, example.title).toBe(parsed.automation.name);
            expect(listed.problem, example.title).toBeUndefined();
        }
    });

    it('the grammar names every refused key and $CONSOLA_OUTPUT', () => {
        const text = grammar().grammar;
        for (const [key, arrivesWith] of Object.entries(LATER_KEYS)) {
            expect(text, key).toContain(`\`${key}\``);
            expect(text, `${key} arrives with`).toContain(arrivesWith);
        }
        expect(text).toContain('$CONSOLA_OUTPUT');
        expect(text).toContain('from: stdout');
        expect(text).toContain('{{ }} works only in prompt: and env:, never in run:');
        expect(text).toContain(
            "your login environment and the workspace's bound account, in the item's own checkout or the scope folder, with git hooks off. In a pull request's checkout, a command that builds or tests runs the author's code."
        );
    });

    it('the trusted list in the prose is the one the validator enforces', async () => {
        const text = grammar().grammar;
        expect(text).toContain(`item.${TRUSTED_ITEM_FIELDS.join(', ')}`);
        const fields = ['key', 'url', 'repo', 'number', 'type', 'title', 'author'];
        for (const field of fields) {
            const yaml =
                'version: 1\nautomations:\n  - name: probe\n    on: { github: pull_request.review_requested }\n' +
                `    steps:\n      - prompt: "Look at {{item.${field}}}."\n`;
            const trusted = parseAutomationEntry(yaml.split('automations:\n')[1]).ok;
            expect(trusted, field).toBe(TRUSTED_ITEM_FIELDS.includes(field));
        }
    });

    it('READ_ONLY_LIMITS says posting is a run: step', () => {
        const limits = grammar().readOnlyLimits;
        expect(limits).toMatch(/^An automation’s agent session/);
        expect(limits.endsWith("Posting or changing something is a run: step with the vendor's CLI (gh), after the read-only agent step.")).toBe(true);
    });

    it('notify says a dry run, and that it asks once first', () => {
        const notify = grammar().modes.find((mode) => mode.mode === 'notify')?.means ?? '';
        expect(notify).toMatch(/dry run/);
        expect(notify).toMatch(/asks once first/);
    });
});
