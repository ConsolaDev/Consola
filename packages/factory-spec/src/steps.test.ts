import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';
import { isStepsEntry } from './schema';
import type { AgentStep, CommandStep } from './steps';

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) => parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const REVIEW = '    on: { github: pull_request.review_requested }\n';
const DAILY = '    on: { cron: "0 9 * * 1-5" }\n';

/** An entry whose steps are the given YAML lines, each already indented as a list item under `steps:`. */
const steps = (...items: string[]) => one(`${REVIEW}    steps:\n${items.map((item) => `      ${item.replace(/\n/g, '\n      ')}`).join('\n')}\n`);

/** A single agent step with `extra` lines (2-space indented keys, no leading dash). */
const agent = (extra = '') => steps(`- prompt: Review it.${extra ? `\n${extra}` : ''}`);
const command = (extra = '') => steps(`- run: echo hi${extra ? `\n${extra}` : ''}`);

const firstStep = <T>(result: ReturnType<typeof one>) => {
    const automation = result.automations[0];
    if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(result.issues));
    return automation.steps[0] as unknown as T;
};

const only = (result: ReturnType<typeof one>) => {
    expect(result.automations).toEqual([]);
    expect(result.issues).toHaveLength(1);
    return result.issues[0];
};

describe('an entry has run: or steps:', () => {
    it('refuses both', () => {
        const issue = only(one(`${REVIEW}    run: { action: Review }\n    steps:\n      - prompt: hi\n`));
        expect(issue.path).toBe('automations[0]');
        expect(issue.message).toMatch(/`run:` or `steps:`, not both/);
    });

    it('refuses neither', () => {
        const issue = only(one(REVIEW));
        expect(issue.path).toBe('automations[0]');
        expect(issue.message).toMatch(/Expected `run:` or `steps:`/);
    });

    it('takes 1 to 20 steps', () => {
        expect(only(one(`${REVIEW}    steps: []\n`)).message).toMatch(/1 to 20 steps/);
        const items = Array.from({ length: 21 }, () => '      - prompt: hi\n').join('');
        expect(only(one(`${REVIEW}    steps:\n${items}`)).message).toMatch(/1 to 20 steps/);
        const twenty = Array.from({ length: 20 }, () => '      - prompt: hi\n').join('');
        expect(one(`${REVIEW}    steps:\n${twenty}`).issues).toEqual([]);
    });

    it('parses a steps entry without a run', () => {
        const result = steps('- prompt: hi');
        expect(result.issues).toEqual([]);
        const automation = result.automations[0];
        expect(isStepsEntry(automation)).toBe(true);
        expect('run' in automation).toBe(false);
    });

    it('needs a scope for a schedule, and takes no filter', () => {
        const issue = only(one(`${DAILY}    steps:\n      - prompt: hi\n`));
        expect(issue.path).toBe('automations[0].scope');
        expect(one(`${DAILY}    steps:\n      - prompt: hi\n    scope: api\n`).issues).toEqual([]);
    });
});

describe('a step has exactly one of prompt, action or run', () => {
    it('refuses none', () => {
        const issue = only(steps('- id: review'));
        expect(issue.path).toBe('automations[0].steps[0]');
        expect(issue.message).toMatch(/one of `prompt`, `action` or `run`/);
    });

    it('refuses two', () => {
        const issue = only(steps('- prompt: hi\n  run: echo hi'));
        expect(issue.path).toBe('automations[0].steps[0]');
        expect(issue.message).toMatch(/names one thing/);
    });

    it('reads an action step', () => {
        expect(firstStep<AgentStep>(steps('- action: Review'))).toMatchObject({ kind: 'agent', action: 'Review' });
    });
});

describe('ids', () => {
    it('names an absent id step-<n>, unnamed', () => {
        const result = steps('- prompt: a', '- run: echo b', '- id: last\n  prompt: c');
        const [first, second, third] = (result.automations[0] as { steps: Array<{ id: string; named: boolean }> }).steps;
        expect([first.id, first.named]).toEqual(['step-1', false]);
        expect([second.id, second.named]).toEqual(['step-2', false]);
        expect([third.id, third.named]).toEqual(['last', true]);
    });

    it('holds an id to the pattern', () => {
        const issue = only(steps('- id: Review\n  prompt: hi'));
        expect(issue.path).toBe('automations[0].steps[0].id');
    });

    it('keeps ids unique', () => {
        const issue = only(steps('- id: a\n  prompt: hi', '- id: a\n  prompt: hi'));
        expect(issue.path).toBe('automations[0].steps[1].id');
        expect(issue.message).toMatch(/unique/);
    });

    it('keeps step-<n> for the unnamed', () => {
        expect(only(steps('- id: step-3\n  prompt: hi')).message).toMatch(/`step-<n>` is what an unnamed step is called/);
    });

    it('reserves previous', () => {
        expect(only(steps('- id: previous\n  prompt: hi')).message).toMatch(/reserved/);
    });
});

const STEP_KEYS: Record<string, string> = {
    agent: 'agents as files',
    skills: 'agents as files',
    mcpServers: 'agents as files',
    max_turns: 'agents as files',
    gate: 'write steps',
    repeat: 'write steps',
    on_exhausted: 'write steps',
    then: 'write steps',
    on_failure: 'write steps',
    checkout: 'write steps',
    environment: 'write steps',
    budget: 'write steps',
    wait: 'waiting runs',
    concurrency: 'waiting runs',
    uses: 'connections as data',
    with: 'connections as data',
    secrets: 'connections as data',
};
const ENTRY_KEYS: Record<string, string> = {
    ...STEP_KEYS,
    callable: 'callable automations',
    inputs: 'callable automations',
};
delete ENTRY_KEYS.with; // an entry's `with:` keeps today's message

describe("refuses later slices' keys with a reason", () => {
    it.each(Object.entries(STEP_KEYS))('step key %s arrives with %s', (key, arrives) => {
        const issue = only(agent(`  ${key}: x`));
        expect(issue.path).toBe(`automations[0].steps[0].${key}`);
        expect(issue.message).toBe(`\`${key}\` arrives with ${arrives}; it is not supported yet.`);
    });

    it.each(Object.entries(ENTRY_KEYS))('entry key %s arrives with %s', (key, arrives) => {
        const result = one(`${REVIEW}    steps:\n      - prompt: hi\n    ${key}: x\n`);
        const issue = only(result);
        expect(issue.path).toMatch(new RegExp(`${key}$`));
        expect(issue.message).toBe(`\`${key}\` arrives with ${arrives}; it is not supported yet.`);
    });

    it('says what to use instead of inputs on a step', () => {
        expect(only(agent('  inputs: x')).message).toBe('`inputs` is not a step key: use `reads` to name what an earlier step wrote.');
    });

    it("keeps an entry's with: message", () => {
        const issue = only(one(`${REVIEW}    steps:\n      - prompt: hi\n    with: x\n`));
        expect(issue.message).toContain('Move `with:` under `run:`');
    });

    it('refuses a stranger by name', () => {
        expect(only(agent('  colour: red')).message).toMatch(/Unrecognized key in a step: colour/);
    });
});

describe('a command', () => {
    it('reads its defaults', () => {
        expect(firstStep<CommandStep>(command())).toEqual({
            id: 'step-1',
            named: false,
            kind: 'run',
            run: 'echo hi',
            env: {},
            outputs: {},
            timeoutMs: 600000,
            dryRun: 'report',
        });
    });

    it('refuses {{ in the command, quoting the template', () => {
        const issue = only(steps('- run: gh pr view "{{item.url}}"'));
        expect(issue.path).toBe('automations[0].steps[0].run');
        expect(issue.message).toBe(
            'Values reach a command only as environment variables: move `{{item.url}}` into `env:` and use `"$PR"`.'
        );
    });

    it('takes env with templates', () => {
        const step = firstStep<CommandStep>(command('  env: { PR: "{{item.url}}", PLAIN: text }'));
        expect(step.env).toEqual({ PR: '{{item.url}}', PLAIN: 'text' });
    });

    it('holds env names to the pattern, and keeps CONSOLA_ for Consola', () => {
        const lower = only(command('  env: { pr: x }'));
        expect(lower.path).toBe('automations[0].steps[0].env.pr');
        expect(lower.message).toContain('uppercase');
        expect(only(command('  env: { CONSOLA_X: y }')).message).toMatch(/`CONSOLA_` is Consola's own/);
    });

    it('refuses an env template that is not a path', () => {
        expect(only(command('  env: { A: "{{title}}" }')).message).toMatch(/not a path/);
    });

    it('reads a timeout', () => {
        expect(firstStep<CommandStep>(command('  timeout: 30s')).timeoutMs).toBe(30000);
        expect(firstStep<CommandStep>(command('  timeout: 1h')).timeoutMs).toBe(3_600_000);
        expect(only(command('  timeout: 2h')).message).toMatch(/at most 1h/);
        expect(only(command('  timeout: 90')).message).toMatch(/`<n>s`, `<n>m` or `<n>h`/);
    });

    it('reads dry_run', () => {
        expect(firstStep<CommandStep>(command('  dry_run: run')).dryRun).toBe('run');
        expect(only(command('  dry_run: yes')).path).toBe('automations[0].steps[0].dry_run');
    });

    it('may name its stdout as its output', () => {
        const step = firstStep<CommandStep>(command('  outputs: { from: stdout, format: json }'));
        expect(step.stdout).toBe('json');
        expect(step.outputs).toEqual({});
        expect(only(command('  outputs: { from: stdout, format: yaml }')).path).toBe('automations[0].steps[0].outputs.format');
    });

    it('declares typed outputs like an agent', () => {
        expect(firstStep<CommandStep>(command('  outputs: { count: integer }')).outputs).toEqual({ count: { type: 'integer' } });
    });

    it('writes no artifacts, and takes no agent keys', () => {
        const issue = only(command('  artifacts: [notes]'));
        expect(issue.path).toBe('automations[0].steps[0].artifacts');
        expect(issue.message).toMatch(/a command writes no artifacts/);
        expect(only(command('  reads: [a.handover]')).path).toBe('automations[0].steps[0].reads');
    });
});

describe('an agent step', () => {
    it('refuses a command key', () => {
        expect(only(agent('  timeout: 1m')).path).toBe('automations[0].steps[0].timeout');
        expect(only(agent('  env: { A: b }')).path).toBe('automations[0].steps[0].env');
    });

    it('refuses a prompt template that is not a path', () => {
        expect(only(steps('- prompt: Look at {{title}}')).message).toMatch(/not a path/);
    });

    it('reads reads', () => {
        const step = firstStep<AgentStep>(agent('  reads: [review.handover, scan.output]'));
        expect(step.reads).toEqual(['review.handover', 'scan.output']);
        expect(only(agent('  reads: [handover]')).path).toBe('automations[0].steps[0].reads');
        expect(only(agent('  reads: [previous.review.handover]')).message).toMatch(/not supported yet/);
    });
});

describe('outputs', () => {
    const outputs = (body: string) => agent(`  outputs:\n${body.replace(/^/gm, '    ')}`);

    it('reads every type', () => {
        const step = firstStep<AgentStep>(
            outputs(
                [
                    'verdict: { enum: [approve, comment] }',
                    'findings: integer',
                    'confidence: { type: number, minimum: 0, maximum: 1 }',
                    'blocking: boolean',
                    'summary: { type: string, maxLength: 500 }',
                    'note: string',
                ].join('\n')
            )
        );
        expect(step.outputs).toEqual({
            verdict: { type: 'enum', values: ['approve', 'comment'] },
            findings: { type: 'integer' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            blocking: { type: 'boolean' },
            summary: { type: 'string', maxLength: 500 },
            note: { type: 'string', maxLength: 1000 },
        });
    });

    it('caps a string at 4000', () => {
        expect(firstStep<AgentStep>(outputs('s: { type: string, maxLength: 4000 }')).outputs.s).toEqual({ type: 'string', maxLength: 4000 });
        expect(only(outputs('s: { type: string, maxLength: 4001 }')).path).toBe('automations[0].steps[0].outputs.s.maxLength');
    });

    it('allows at most 10', () => {
        const eleven = Array.from({ length: 11 }, (_, index) => `o${index}: boolean`).join('\n');
        expect(only(outputs(eleven)).message).toMatch(/at most 10/);
        const ten = Array.from({ length: 10 }, (_, index) => `o${index}: boolean`).join('\n');
        expect(agent(`  outputs:\n${ten.replace(/^/gm, '    ')}`).issues).toEqual([]);
    });

    it('holds names to the pattern', () => {
        expect(only(outputs('Verdict: boolean')).path).toBe('automations[0].steps[0].outputs.Verdict');
    });

    it('refuses a bad enum', () => {
        const twentyOne = Array.from({ length: 21 }, (_, index) => `v${index}`).join(', ');
        const bad = [
            'v: { enum: [] }',
            `v: { enum: [${twentyOne}] }`,
            'v: { enum: [a, a] }',
            `v: { enum: [${'x'.repeat(65)}] }`,
            'v: { enum: ["a\\nb"] }',
            'v: { enum: [""] }',
        ];
        for (const body of bad) expect(only(outputs(body)).path, body).toMatch(/outputs\.v\.enum$/);
    });

    it('refuses objects, arrays and nulls', () => {
        expect(only(outputs('v: { type: object }')).message).toMatch(/no objects, arrays or nulls/);
        expect(only(outputs('v: object')).message).toMatch(/no objects, arrays or nulls/);
        expect(only(outputs('v: [a]')).message).toMatch(/no objects, arrays or nulls/);
    });

    it('reserves handover and output', () => {
        expect(only(outputs('handover: boolean')).message).toMatch(/reserved/);
        expect(only(outputs('output: boolean')).message).toMatch(/reserved/);
    });

    it('refuses an unknown key or an inverted range', () => {
        expect(only(outputs('v: { type: integer, step: 2 }')).path).toBe('automations[0].steps[0].outputs.v.step');
        expect(only(outputs('v: { type: number, minimum: 2, maximum: 1 }')).message).toMatch(/above/);
    });
});

describe('artifacts', () => {
    it('holds names to the pattern, and keeps output for a command', () => {
        expect(only(agent('  artifacts: [Notes]')).path).toBe('automations[0].steps[0].artifacts');
        expect(only(agent('  artifacts: [output]')).message).toMatch(/reserved/);
    });

    it('makes the handover required when listed', () => {
        expect(firstStep<AgentStep>(agent('  artifacts: [handover, notes]'))).toMatchObject({
            artifacts: ['notes'],
            handover: 'required',
        });
        expect(firstStep<AgentStep>(agent())).toMatchObject({ artifacts: [], handover: 'optional' });
    });

    it('shares one namespace with outputs', () => {
        const issue = only(agent('  outputs: { notes: boolean }\n  artifacts: [notes]'));
        expect(issue.message).toMatch(/one namespace/);
    });
});

describe('if:', () => {
    it('must be a string', () => {
        const issue = only(agent('  if: true'));
        expect(issue.path).toBe('automations[0].steps[0].if');
        expect(issue.message).toMatch(/an expression in quotes/);
    });

    it('is at most 500 characters', () => {
        const long = `'${'a'.repeat(499)}' == 'b'`;
        expect(only(agent(`  if: "${long}"`)).message).toMatch(/at most 500/);
    });

    it('reports a parse error at the if', () => {
        const issue = only(agent('  if: "steps.review.verdict =="'));
        expect(issue.path).toBe('automations[0].steps[0].if');
        expect(issue.message).toMatch(/Cannot read this `if`/);
    });

    it('keeps a good expression as written', () => {
        expect(firstStep<AgentStep>(agent(`  if: "steps.review.verdict != 'approve'"`)).if).toBe("steps.review.verdict != 'approve'");
    });
});
