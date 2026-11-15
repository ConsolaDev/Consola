import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';
import { isStepsEntry } from './schema';
import { ENV_PREFIX_EXCEPTIONS, isRefusedEnvName, REFUSED_ENV_NAMES, REFUSED_ENV_PREFIXES, stepItemFieldProblems, stepItemFields, type AgentStep, type CommandStep, type ItemFieldTable, type Step } from './steps';

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

    it('reports the one-of issue beside a trigger issue or a refused key', () => {
        const cron = one('    on: { cron: "nope" }\n').issues.map((issue) => issue.path);
        expect(cron).toContain('automations[0]');
        expect(cron).toContain('automations[0].on.cron');
        const gate = one(`${REVIEW}    gate: x\n`).issues.map((issue) => issue.path);
        expect(gate).toContain('automations[0]');
        expect(gate).toContain('automations[0].gate');
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
        // Not a later key just because Object.prototype has it.
        expect(only(agent('  toString: x')).message).toMatch(/Unrecognized key in a step: toString/);
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

    describe('env names and prefixes that make a program run a value', () => {
        const REFUSED_BECAUSE = /these names and prefixes are refused because they make a program run a value.*Values must stay data.*inside `run:`/;
        const refusedFor = (name: string, value = '"{{steps.review.handover.file}}"') => {
            const result = steps('- id: review\n  prompt: Review it.', `- run: echo hi\n  env: { ${name}: ${value} }`);
            expect(result.automations, name).toEqual([]);
            expect(result.issues, name).toHaveLength(1);
            expect(result.issues[0].path, name).toBe(`automations[0].steps[1].env.${name}`);
            return result.issues[0].message;
        };

        it.each([
            // Exact names.
            'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PS4', 'SHELLOPTS', 'BASHOPTS',
            'SSH_ASKPASS', 'PAGER', 'EDITOR', 'VISUAL', 'PATH',
            'HOME', 'IFS', 'ZDOTDIR', 'LESSOPEN', 'LESSCLOSE', 'BROWSER', 'GCONV_PATH', '_JAVA_OPTIONS', 'JAVA_TOOL_OPTIONS',
            // One name for each prefix, and the ones the earlier list named.
            'LD_AUDIT', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT',
            'NODE_PATH', 'NODE_OPTIONS', 'JAVA_HOME', 'NPM_CONFIG_USERCONFIG', 'XDG_CONFIG_HOME',
            'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_12', 'GIT_SSH_COMMAND', 'GIT_PAGER',
            'GH_PAGER', 'GH_EDITOR', 'GH_BROWSER', 'GH_CONFIG_DIR',
        ])('refuses %s, templated or not, saying why and what is refused', (name) => {
            const message = refusedFor(name);
            expect(message).toMatch(REFUSED_BECAUSE);
            expect(message).toContain(`\`${name}\``);
            expect(refusedFor(name, 'plain')).toBe(message);
        });

        it('takes GH_TOKEN and GH_HOST, the shipped template\'s names, and names that only look alike', () => {
            const step = firstStep<CommandStep>(
                command(
                    '  env: { GH_TOKEN: a, GH_HOST: b, PR: c, REPO: d, NUMBER: e, VERDICT: f, BODY_FILE: g, BASH_ENVIRONMENT: h, MY_PATH: i, MY_GIT_DIR: j, HOMEPAGE: k, PATHS: l, EDITORS: m, NODEJS: n }'
                )
            );
            expect(Object.keys(step.env)).toEqual([
                'GH_TOKEN', 'GH_HOST', 'PR', 'REPO', 'NUMBER', 'VERDICT', 'BODY_FILE',
                'BASH_ENVIRONMENT', 'MY_PATH', 'MY_GIT_DIR', 'HOMEPAGE', 'PATHS', 'EDITORS', 'NODEJS',
            ]);
        });

        it('matches NPM_CONFIG_ in any case, as npm reads it, and the rest as written', () => {
            expect(isRefusedEnvName('npm_config_userconfig')).toBe(true);
            expect(isRefusedEnvName('Npm_Config_Prefix')).toBe(true);
            expect(isRefusedEnvName('git_dir')).toBe(false);
            expect(isRefusedEnvName('path')).toBe(false);
        });

        it('is the lists the validator, its message and the prose share', () => {
            for (const name of REFUSED_ENV_NAMES) expect(isRefusedEnvName(name), name).toBe(true);
            for (const prefix of REFUSED_ENV_PREFIXES) expect(isRefusedEnvName(`${prefix}X`), prefix).toBe(true);
            for (const name of ENV_PREFIX_EXCEPTIONS) expect(isRefusedEnvName(name), name).toBe(false);
            const message = refusedFor('BASH_ENV');
            for (const name of REFUSED_ENV_NAMES) expect(message, name).toContain(name);
            for (const prefix of REFUSED_ENV_PREFIXES) expect(message, prefix).toContain(`${prefix}*`);
            for (const name of ENV_PREFIX_EXCEPTIONS) expect(message, name).toContain(name);
        });
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
        const missing = only(command('  outputs: { from: stdout }'));
        expect(missing.path).toBe('automations[0].steps[0].outputs.format');
        expect(missing.message).toBe('Say how to read stdout: `format: json` or `format: text`.');
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
        const result = steps(
            '- id: review\n  prompt: Review it.',
            '- id: scan\n  run: echo hi\n  outputs: { from: stdout, format: text }',
            '- prompt: Read.\n  reads: [review.handover, scan.output]'
        );
        const automation = result.automations[0];
        if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(result.issues));
        expect((automation.steps[2] as AgentStep).reads).toEqual(['review.handover', 'scan.output']);
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

    it('does not mistake an inherited property for an output', () => {
        expect(firstStep<AgentStep>(agent('  artifacts: [constructor]')).artifacts).toEqual(['constructor']);
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
        const result = steps(
            '- id: review\n  prompt: Review it.\n  outputs: { verdict: { enum: [approve, comment] } }',
            `- id: publish\n  prompt: Post it.\n  if: "steps.review.verdict != 'approve'"`
        );
        const automation = result.automations[0];
        if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(result.issues));
        expect((automation.steps[1] as AgentStep).if).toBe("steps.review.verdict != 'approve'");
    });
});

// --- across steps ------------------------------------------------------------------

/** Steps joined into one entry (on `trigger`), with the yaml kept so a line can be found. */
function entry(items: string[], trigger = REVIEW, tail = '') {
    const yaml = `version: 1\nautomations:\n  - name: a\n${trigger}${tail}    steps:\n${items
        .map((item) => item.split('\n').map((line) => `      ${line}`).join('\n'))
        .join('\n')}\n`;
    return { yaml, result: parseFactorySpec(yaml) };
}

const lineOf = (yaml: string, needle: string) => yaml.split('\n').findIndex((line) => line.includes(needle)) + 1;

const REVIEW_STEP = [
    '- id: review',
    '  prompt: Review it.',
    '  outputs:',
    '    verdict: { enum: [approve, comment, request-changes] }',
    '    count: integer',
    '    score: number',
    '    ok: boolean',
    '    note: string',
    '  artifacts: [notes]',
].join('\n');

const FETCH_STEP = '- id: fetch\n  run: gh pr view\n  outputs: { from: stdout, format: json }';

/** One issue, at `path`, on the line holding `needle`. */
function expectIssue(built: ReturnType<typeof entry>, path: string, needle: string, message: RegExp | string) {
    const issue = only(built.result);
    expect(issue.path).toBe(path);
    expect(issue.line).toBe(lineOf(built.yaml, needle));
    if (typeof message === 'string') expect(issue.message).toBe(message);
    else expect(issue.message).toMatch(message);
}

const publishIf = (condition: string, trigger = REVIEW) => entry([REVIEW_STEP, `- id: publish\n  if: "${condition}"\n  run: echo hi`], trigger);

describe('across steps', () => {
    describe('if: scope', () => {
        const expectIf = (condition: string, message: RegExp | string) =>
            expectIssue(publishIf(condition), 'automations[0].steps[1].if', 'if:', message);

        it('accepts every declared output with its type', () => {
            for (const condition of [
                "steps.review.verdict != 'approve'",
                'steps.review.count > 2',
                'steps.review.score <= 0.5',
                'steps.review.ok',
                "steps.review.ok && steps.review.verdict == 'comment'",
                "item.title == 'x'",
            ]) {
                expect(publishIf(condition).result.issues, condition).toEqual([]);
            }
        });

        it('refuses an unknown step', () => expectIf('steps.nope.verdict == 1', /`steps\.nope\.verdict`: .*no step `nope`/));

        it('refuses a later step', () => {
            const built = entry(['- id: first\n  run: echo\n  if: "steps.second.x == 1"', '- id: second\n  run: echo\n  outputs: { x: integer }']);
            expectIssue(built, 'automations[0].steps[0].if', 'if:', /`steps\.second\.x`: .*not before this step/);
        });

        it('refuses the step itself', () => {
            const built = entry(['- id: me\n  run: echo\n  if: "steps.me.x == 1"\n  outputs: { x: integer }']);
            expectIssue(built, 'automations[0].steps[0].if', 'if:', /`steps\.me\.x`: .*not before this step/);
        });

        it('refuses an undeclared output, naming the ones there are', () =>
            expectIf('steps.review.other == 1', /`steps\.review\.other`: .*no output `other` \(it has: verdict, count, score, ok, note\)/));

        it('refuses an artifact, which is prose', () => {
            expectIf("steps.review.notes == 'x'", /`steps\.review\.notes`: .*artifacts are prose; branch on an output/);
        });

        it('refuses the handover as an artifact too', () => {
            expectIf("steps.review.handover == 'x'", /artifacts are prose; branch on an output/);
        });

        it('refuses an unnamed step', () => {
            const built = entry(['- run: echo\n  outputs: { x: integer }', '- id: next\n  if: "steps.step-1.x == 1"\n  run: echo']);
            expectIssue(built, 'automations[0].steps[1].if', 'if:', /only steps with an `id` can be named/);
        });

        it('refuses an out-of-enum literal', () =>
            expectIf("steps.review.verdict == 'aprove'", '`aprove` is not a verdict of review (approve, comment, request-changes)'));

        it('refuses a type mismatch', () => expectIf("steps.review.count == 'x'", /compares a number with a string/));

        it('resolves a property name of Object.prototype as undeclared', () => {
            expectIf('steps.review.constructor == 1', /no output `constructor`/);
            const built = entry(['- id: a\n  run: echo', '- id: b\n  if: "steps.constructor.x == 1"\n  run: echo']);
            expectIssue(built, 'automations[0].steps[1].if', 'if:', /no step `constructor`/);
        });
    });

    describe('reads:', () => {
        const reader = (...reads: string[]) => `- id: next\n  prompt: Go.\n  reads: [${reads.join(', ')}]`;

        it('takes the handover of an earlier agent step, and marks it required', () => {
            const { result } = entry([REVIEW_STEP, reader('review.handover')]);
            expect(result.issues).toEqual([]);
            const automation = result.automations[0];
            if (!isStepsEntry(automation)) throw new Error('steps');
            expect((automation.steps[0] as AgentStep).handover).toBe('required');
        });

        it('takes a declared artifact', () => expect(entry([REVIEW_STEP, reader('review.notes')]).result.issues).toEqual([]));

        it('takes the output of a command that streams stdout', () =>
            expect(entry([FETCH_STEP, reader('fetch.output')]).result.issues).toEqual([]));

        it('refuses `output` without from: stdout', () => {
            const built = entry(['- id: fetch\n  run: echo', reader('fetch.output')]);
            expectIssue(built, 'automations[0].steps[1].reads[0]', 'reads:', /has no artifact `output`/);
        });

        it('refuses an output, which is not a document', () => {
            const built = entry([REVIEW_STEP, reader('review.verdict')]);
            expectIssue(built, 'automations[0].steps[1].reads[0]', 'reads:', /`verdict` is an output/);
        });

        it('refuses a later step', () => {
            const built = entry([`- id: first\n  prompt: Go.\n  reads: [second.handover]`, '- id: second\n  prompt: Go.']);
            expectIssue(built, 'automations[0].steps[0].reads[0]', 'reads:', /`second` is not before this step/);
        });

        it('refuses an unknown step and an unnamed one', () => {
            expectIssue(entry([reader('ghost.handover')]), 'automations[0].steps[0].reads[0]', 'reads:', /no step `ghost`/);
            const unnamed = entry(['- prompt: One.', reader('step-1.handover')]);
            expectIssue(unnamed, 'automations[0].steps[1].reads[0]', 'reads:', /only steps with an `id` can be named/);
        });

        it('refuses previous: that is a later slice', () => {
            const issue = only(entry([REVIEW_STEP, reader('previous.review.handover')]).result);
            expect(issue.message).toMatch(/not supported yet/);
        });

        it('refuses a read with no dot', () => {
            const issue = only(entry([REVIEW_STEP, reader('review')]).result);
            expect(issue.message).toMatch(/`<step>\.<artifact>`/);
        });
    });

    describe('templates in env:', () => {
        const withEnv = (value: string, earlier = REVIEW_STEP) => entry([earlier, `- id: publish\n  run: echo\n  env:\n    BODY: "${value}"`]);

        it('allows any path', () => {
            for (const value of [
                '{{item.title}}',
                '{{item.author}}',
                '{{steps.review.verdict}}',
                '{{steps.review.note}}',
                '{{steps.review.notes}}',
                '{{steps.review.notes.file}}',
                '{{steps.review.handover}}',
            ]) {
                expect(withEnv(value).result.issues, value).toEqual([]);
            }
            expect(entry([FETCH_STEP, '- id: p\n  run: echo\n  env: { A: "{{steps.fetch.output.file}}" }']).result.issues).toEqual([]);
        });

        it('marks the handover required when its file is used', () => {
            const { result } = withEnv('{{steps.review.handover.file}}');
            const automation = result.automations[0];
            if (!isStepsEntry(automation)) throw new Error('steps');
            expect((automation.steps[0] as AgentStep).handover).toBe('required');
        });

        it('refuses .file on an output', () =>
            expectIssue(
                withEnv('{{steps.review.verdict.file}}'),
                'automations[0].steps[1].env.BODY',
                'BODY:',
                /`\.file` names an artifact's file, and verdict is an output/
            ));

        it('refuses an unknown step, a later step, an unnamed step and an unknown name', () => {
            expectIssue(withEnv('{{steps.ghost.x}}'), 'automations[0].steps[1].env.BODY', 'BODY:', /no step `ghost`/);
            expectIssue(withEnv('{{steps.review.nope}}'), 'automations[0].steps[1].env.BODY', 'BODY:', /`review` has no output or artifact `nope`/);
            const later = entry(['- id: first\n  run: echo\n  env: { A: "{{steps.second.x}}" }', '- id: second\n  run: echo']);
            expectIssue(later, 'automations[0].steps[0].env.A', 'A:', /not before this step/);
            const unnamed = entry(['- run: echo', '- id: p\n  run: echo\n  env: { A: "{{steps.step-1.x}}" }']);
            expectIssue(unnamed, 'automations[0].steps[1].env.A', 'A:', /only steps with an `id` can be named/);
        });

        it('reports an unparsable template as its problem', () => {
            const issue = only(withEnv('{{steps.review').result);
            expect(issue.path).toBe('automations[0].steps[1].env.BODY');
            expect(issue.message).toMatch(/Unclosed/);
        });
    });

    describe('templates in prompt:', () => {
        const withPrompt = (text: string, earlier = REVIEW_STEP) => entry([earlier, `- id: next\n  prompt: "${text}"`]);
        const UNTRUSTED = (path: string) => `${path}: it is text someone else wrote; the step gets it below its prompt as data.`;

        it('allows trusted item fields and constrained outputs', () => {
            for (const text of [
                '{{item.url}}',
                '{{item.key}}',
                '{{item.repo}}',
                '{{item.number}}',
                '{{item.type}}',
                '{{steps.review.verdict}}',
                '{{steps.review.count}}',
                '{{steps.review.score}}',
                '{{steps.review.ok}}',
            ]) {
                expect(withPrompt(text).result.issues, text).toEqual([]);
            }
        });

        it('refuses text someone else wrote', () => {
            for (const path of [
                'item.title',
                'item.author',
                'item.labels',
                'steps.review.note',
                'steps.review.notes',
                'steps.review.handover',
                'steps.review.notes.file',
            ]) {
                expectIssue(withPrompt(`Look at {{${path}}}.`), 'automations[0].steps[1].prompt', 'prompt: "Look', UNTRUSTED(path));
            }
        });

        it('refuses an unknown step with its own problem', () => {
            expectIssue(withPrompt('{{steps.ghost.x}}'), 'automations[0].steps[1].prompt', 'prompt: "{{', /no step `ghost`/);
        });
    });

    describe('the handover is optional unless used', () => {
        const handoverOf = (items: string[]) => {
            const { result } = entry(items);
            expect(result.issues).toEqual([]);
            const automation = result.automations[0];
            if (!isStepsEntry(automation)) throw new Error('steps');
            return (automation.steps[0] as AgentStep).handover;
        };

        it('stays optional for a one-agent entry', () => expect(handoverOf(['- id: only\n  prompt: Go.'])).toBe('optional'));
        it('becomes required when a later step reads it', () =>
            expect(handoverOf(['- id: only\n  prompt: Go.', '- id: next\n  prompt: Go.\n  reads: [only.handover]'])).toBe('required'));
        it('stays optional when a later step does not read it', () =>
            expect(handoverOf(['- id: only\n  prompt: Go.', '- id: next\n  prompt: Go.'])).toBe('optional'));
    });

    describe('schedules have no item', () => {
        const onCron = (item: string, tail = '') => entry([item], DAILY, `    scope: app\n${tail}`);

        it('refuses item.* in env:, if: and prompt', () => {
            expectIssue(onCron('- run: echo\n  env: { A: "{{item.url}}" }'), 'automations[0].steps[0].env.A', 'A:', /a schedule has no item/);
            expectIssue(onCron('- run: echo\n  if: "item.url == \'x\'"'), 'automations[0].steps[0].if', 'if:', /a schedule has no item/);
            expectIssue(onCron('- prompt: "{{item.url}}"'), 'automations[0].steps[0].prompt', 'prompt:', /a schedule has no item/);
        });

        it('refuses an action, saying to write the job as the step\'s own prompt', () => {
            // Inside a step the job is `prompt:`; `run: { prompt }` is an entry's, and a step's `run:` is a command.
            expectIssue(
                onCron('- action: Review'),
                'automations[0].steps[0].action',
                'action:',
                'An action is a verb on an item, and a schedule has no item: write the job as `prompt: …`.'
            );
        });

        it('takes outputs of earlier steps', () => {
            const built = entry(['- id: a\n  run: echo\n  outputs: { n: integer }', '- id: b\n  if: "steps.a.n > 1"\n  run: echo'], DAILY, '    scope: app\n');
            expect(built.result.issues).toEqual([]);
        });
    });
});

describe('stepItemFieldProblems', () => {
    const GITHUB: ItemFieldTable = {
        key: { type: { kind: 'string' }, trusted: true },
        url: { type: { kind: 'string' }, trusted: true },
        repo: { type: { kind: 'string' }, trusted: true },
        title: { type: { kind: 'string' }, trusted: false },
        author: { type: { kind: 'string' }, trusted: false },
        number: { type: { kind: 'number' }, trusted: true },
        type: { type: { kind: 'string', enum: { values: ['pr', 'issue'], owner: 'type of the item' } }, trusted: true },
    };
    /** Steps as the runner holds them; a prompt naming an untrusted field never parses, so it is built by hand. */
    const agentStep = (prompt: string): Step => ({ id: 'a', named: true, kind: 'agent', prompt, outputs: {}, artifacts: [], reads: [], handover: 'optional' });
    const problems = (...items: Array<string | Step>) => {
        const parsed = items.filter((item): item is string => typeof item === 'string');
        const automation = parsed.length > 0 ? entry(parsed).result.automations[0] : undefined;
        if (parsed.length > 0 && (!automation || !isStepsEntry(automation))) throw new Error('steps');
        const built = items.map((item) => (typeof item === 'string' ? undefined : item));
        const all = [...(automation && isStepsEntry(automation) ? automation.steps : []), ...built.filter((item): item is Step => !!item)];
        return stepItemFieldProblems(all, GITHUB, 'github');
    };

    it('accepts the table\'s fields', () => {
        expect(problems('- run: echo\n  if: "item.type == \'pr\' && item.number > 3"\n  env: { A: "{{item.title}}" }', '- prompt: "{{item.url}}"')).toEqual([]);
    });

    it('names a field the connection lacks, wherever it is used', () => {
        const message = '`item.labels`: github items have no field `labels` (they have: key, url, repo, title, author, number, type)';
        expect(problems('- run: echo\n  env: { A: "{{item.labels}}" }')).toEqual([message]);
        expect(problems('- run: echo\n  if: "item.labels == \'x\'"')).toEqual([message]);
        expect(problems(agentStep('{{item.labels}}'))).toEqual([message]);
    });

    it('refuses an untrusted field in a prompt', () => {
        expect(problems(agentStep('{{item.author}}'))).toEqual([
            'item.author: it is text someone else wrote; the step gets it below its prompt as data.',
        ]);
    });

    it('checks if: literals against the field', () => {
        expect(problems('- run: echo\n  if: "item.type == \'mr\'"')).toEqual(['`mr` is not a type of the item (pr, issue)']);
        expect(problems('- run: echo\n  if: "item.number == \'x\'"')).toEqual(["`item.number == 'x'` compares a number with a string"]);
    });

    it('lists where each field is used', () => {
        const automation = entry(['- id: a\n  run: echo\n  if: "item.number > 1"\n  env: { A: "{{item.url}}" }', '- id: b\n  prompt: "{{item.key}}"']).result.automations[0];
        if (!automation || !isStepsEntry(automation)) throw new Error('steps');
        expect(stepItemFields(automation.steps)).toEqual([
            { step: 'a', field: 'number', where: 'if' },
            { step: 'a', field: 'url', where: 'env' },
            { step: 'b', field: 'key', where: 'prompt' },
        ]);
    });
});
