import { describe, expect, it } from 'vitest';
import { parseAutomationEntry } from './entry';
import { MAX_IF_LENGTH } from './expression';
import { isStepsEntry } from './schema';
import { secretTemplateReason } from './secrets';
import { laterKeyMessage, type Step } from './steps';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  ENTRY_USES_REASON,
  MAX_CALL_TIMEOUT_MS,
  parseUsesStep,
  USES_REF_PATTERN,
  usesTexts,
  type StepReaders,
  type UsesStep,
} from './uses';

const HEAD = 'name: a\non: { github: pull_request.review_requested }\nsteps:\n';
/** An entry whose steps are the given YAML items, each written at column 0 (`- id: …`). */
const entry = (...items: string[]) =>
  parseAutomationEntry(
    `${HEAD}${items.map((item) => `  ${item.replace(/\n/g, '\n  ')}`).join('\n')}\n`,
  );
const issuesOf = (result: ReturnType<typeof entry>) =>
  result.ok ? [] : result.issues.map(({ message, path }) => ({ message, path }));
const stepsOf = (result: ReturnType<typeof entry>): Step[] => {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  if (!isStepsEntry(result.automation)) throw new Error('not a steps entry');
  return result.automation.steps;
};
const call = (lines: string) => entry(`- id: post\n  uses: slack#chat_post_message\n${lines}`);

const REFERENCE =
  'Expected `uses` to name a server and one of its tools, e.g. `uses: slack#chat_post_message`.';
const TOOL_NAME = (tool: string) =>
  `\`${tool}\` is not a tool's name: MCP names are letters, digits, \`.\`, \`_\` and \`-\`, at most 128.`;
const CALLABLE = 'Calling an automation arrives with callable automations.';
const PINNED = 'Pinned references arrive with shared factories.';

describe('a uses: step', () => {
  it('parses a server, a tool, its arguments, its outputs and its timeout', () => {
    const [step] = stepsOf(
      call(
        '  with: { channel: C0SUPPORT1, text: "{{steps.brief.handover}}" }\n  outputs: { ts: string }\n  timeout: 30s',
      ),
    );
    expect(step).toEqual({
      id: 'post',
      named: true,
      kind: 'uses',
      uses: 'slack#chat_post_message',
      server: 'slack',
      tool: 'chat_post_message',
      with: { channel: 'C0SUPPORT1', text: '{{steps.brief.handover}}' },
      outputs: { ts: { type: 'string', maxLength: 1000 } },
      timeoutMs: 30_000,
      dryRun: 'report',
    } satisfies UsesStep);
  });

  it('takes no with:, no outputs and the default timeout when none is written', () => {
    const [step] = stepsOf(entry('- uses: slack#chat_post_message'));
    expect(step).toEqual({
      id: 'step-1',
      named: false,
      kind: 'uses',
      uses: 'slack#chat_post_message',
      server: 'slack',
      tool: 'chat_post_message',
      with: {},
      outputs: {},
      timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      dryRun: 'report',
    });
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(60_000);
  });

  it('names Consola’s own tools as the consola server, and an if:', () => {
    const [step] = stepsOf(
      entry('- uses: consola#cleanup_stale_sessions\n  if: "item.number > 3"\n  dry_run: run'),
    );
    expect(step).toMatchObject({
      server: 'consola',
      tool: 'cleanup_stale_sessions',
      if: 'item.number > 3',
      dryRun: 'run',
    });
  });

  it('takes a tool named by MCP’s rule, wider than run: { tool }’s', () => {
    const [step] = stepsOf(entry('- uses: notion#Notion-search.v2'));
    expect(step).toMatchObject({ server: 'notion', tool: 'Notion-search.v2' });
    expect(USES_REF_PATTERN.test(`slack#${'a'.repeat(128)}`)).toBe(true);
    expect(USES_REF_PATTERN.test(`slack#${'a'.repeat(129)}`)).toBe(false);
  });

  it.each([
    ['slack#chat post', TOOL_NAME('chat post')],
    [`slack#${'a'.repeat(129)}`, TOOL_NAME('a'.repeat(129))],
    ['slack#a#b', TOOL_NAME('a#b')],
    ['Slack#x', REFERENCE],
    ['#x', REFERENCE],
    ['"slack#"', REFERENCE],
    ['3', REFERENCE],
    ['[slack#x]', REFERENCE],
    ['""', REFERENCE],
    ['"  "', REFERENCE],
    ['slack', CALLABLE],
    ['nightly-checks', CALLABLE],
    ['acme/.consola/briefing@v3', PINNED],
    ['slack#post@v2', PINNED],
    ['sprocket/factory#post', PINNED],
  ])('refuses uses: %s with its reason', (uses, message) => {
    expect(issuesOf(entry(`- uses: ${uses}`))).toEqual([{ message, path: 'steps[0].uses' }]);
  });

  it('keeps with: as written, of every YAML kind', () => {
    const [step] = stepsOf(
      call(
        '  with:\n    limit: 20\n    unfurl: false\n    thread: null\n    tags: [a, 2]\n    blocks: [{ type: section, text: { kind: mrkdwn, body: "*Brief:* {{steps.brief.handover}}" } }]',
      ),
    );
    expect((step as UsesStep).with).toEqual({
      limit: 20,
      unfurl: false,
      thread: null,
      tags: ['a', 2],
      blocks: [
        { type: 'section', text: { kind: 'mrkdwn', body: '*Brief:* {{steps.brief.handover}}' } },
      ],
    });
  });

  it.each([
    [
      '  with: { "{{item.key}}": 1 }',
      "An argument's name is written as it is: `{{item.key}}` can't hold `{{ }}`.",
      'steps[0].with',
    ],
    [
      '  with: { file: "{{steps.brief.handover.file}}" }',
      'A tool gets values, not paths on this machine: use the artifact itself.',
      'steps[0].with.file',
    ],
    [
      '  with: { blocks: [{ text: "see {{previous.brief.handover.file}}" }] }',
      'A tool gets values, not paths on this machine: use the artifact itself.',
      'steps[0].with.blocks[0].text',
    ],
    [
      '  with: { t: "{{secrets.SLACK_BOT_TOKEN}}" }',
      secretTemplateReason('SLACK_BOT_TOKEN'),
      'steps[0].with.t',
    ],
    [
      '  with: { t: "{{ nope }}" }',
      '`{{nope}}` is not a path; item fields are `{{item.title}}`.',
      'steps[0].with.t',
    ],
    ['  with: { t: "{{ item.title" }', 'Unclosed `{{` in `{{ item.title`.', 'steps[0].with.t'],
    ['  with: [a]', "Expected `with:` to be a mapping of the tool's arguments.", 'steps[0].with'],
    ['  with: text', "Expected `with:` to be a mapping of the tool's arguments.", 'steps[0].with'],
  ])('refuses %s', (lines, message, path) => {
    expect(issuesOf(call(lines))).toEqual([{ message, path }]);
  });

  it('holds its timeout to 1s through 10m, written as today’s', () => {
    expect(issuesOf(call('  timeout: 11m'))).toEqual([
      { message: "A tool call's timeout is at most 10m.", path: 'steps[0].timeout' },
    ]);
    expect(issuesOf(call('  timeout: 2h'))).toEqual([
      { message: 'A timeout is at most 1h.', path: 'steps[0].timeout' },
    ]);
    expect(issuesOf(call('  timeout: 500ms'))).toEqual([
      {
        message: 'Write the timeout as `<n>s`, `<n>m` or `<n>h`, e.g. `10m`.',
        path: 'steps[0].timeout',
      },
    ]);
    expect(issuesOf(call('  timeout: 0s'))).toEqual([
      { message: 'A timeout is at least 1s.', path: 'steps[0].timeout' },
    ]);
    expect((stepsOf(call('  timeout: 10m'))[0] as UsesStep).timeoutMs).toBe(MAX_CALL_TIMEOUT_MS);
  });

  it('takes dry_run: report or run, and outputs by name, never from stdout', () => {
    expect(issuesOf(call('  dry_run: maybe'))).toEqual([
      { message: 'Expected `dry_run` to be `report` or `run`.', path: 'steps[0].dry_run' },
    ]);
    expect(issuesOf(call('  outputs: { from: stdout, format: json }'))).toEqual([
      {
        message:
          "A tool's outputs are its result's fields: declare them by name, e.g. `outputs: { ts: string }`.",
        path: 'steps[0].outputs',
      },
    ]);
    expect(issuesOf(call('  outputs: { handover: string }'))[0]).toEqual({
      message:
        "`handover` is reserved: a step's handover and its `output` are artifacts, read as `steps.<id>.handover`.",
      path: 'steps[0].outputs.handover',
    });
  });

  it.each([
    ['prompt: Post it.', 'A step names one thing to do; got uses and prompt.'],
    ['action: Review', 'A step names one thing to do; got uses and action.'],
    ['run: echo hi', 'A step names one thing to do; got uses and run.'],
    ['agent: briefer', 'A tool call runs no agent and no shell.'],
    ['max_turns: 3', 'A tool call runs no agent and no shell.'],
    ['environment: sandbox', 'A tool call runs no agent and no shell.'],
    ['env: { A: b }', 'A tool takes its values in `with:`.'],
    [
      'secrets: [SLACK_BOT_TOKEN]',
      "A tool's credentials belong to its server: name them under `mcpServers.slack.secrets`.",
    ],
    ['artifacts: [notes]', 'A tool reads nothing from the run: pass what it needs in `with:`.'],
    [
      'reads: [brief.handover]',
      'A tool reads nothing from the run: pass what it needs in `with:`.',
    ],
    ['gate: confirm', laterKeyMessage('gate')],
    ['repeat: 3', laterKeyMessage('repeat')],
    ['colour: red', 'Unrecognized key in a step: colour.'],
    ['toString: x', 'Unrecognized key in a step: toString.'],
  ])('refuses %s beside uses:, at its key', (line, message) => {
    const key = line.split(':')[0];
    expect(issuesOf(call(`  ${line}`))).toEqual([{ message, path: `steps[0].${key}` }]);
  });

  it('reads id and if exactly as an agent step does (one reader)', () => {
    const cases = [
      'id: step-3',
      'id: previous',
      'id: Post',
      'id: 3',
      'if: 3',
      `if: "${'x'.repeat(MAX_IF_LENGTH + 1)}"`,
      'if: "steps.a.b =="',
    ];
    for (const line of cases) {
      const asCall = issuesOf(entry(`- uses: slack#post\n  ${line}`));
      const asAgent = issuesOf(entry(`- prompt: Post it.\n  ${line}`));
      expect(asCall, line).toEqual(asAgent);
      expect(asCall, line).toHaveLength(1);
    }
  });
});

describe('parseUsesStep on its own', () => {
  const readers: StepReaders = {
    idAndIf: () => ({ id: 'post', named: true }),
    outputs: () => ({}),
    timeout: () => 1000,
    laterKey: () => undefined,
  };

  it('returns null once it reported anything, however well the rest reads', () => {
    const fails: string[] = [];
    const step = parseUsesStep(
      { uses: 'slack#post', prompt: 'Post it.' },
      (message) => fails.push(message),
      readers,
    );
    expect(step).toBeNull();
    expect(fails).toEqual(['A step names one thing to do; got uses and prompt.']);
    expect(parseUsesStep({ uses: 'slack#post' }, () => {}, readers)).toMatchObject({
      server: 'slack',
      tool: 'post',
    });
  });
});

describe('usesTexts', () => {
  it('lists every string in with:, depth first, at its path', () => {
    const step = {
      ...(stepsOf(entry('- uses: slack#post'))[0] as UsesStep),
      with: { a: 'x {{item.ts}}', b: [1, { c: '{{steps.s.o}}' }], d: 2 },
    };
    expect(usesTexts(step)).toEqual([
      { text: 'x {{item.ts}}', path: ['with', 'a'] },
      { text: '{{steps.s.o}}', path: ['with', 'b', 1, 'c'] },
    ]);
  });
});

describe('uses: on an entry', () => {
  it('is a step: put it under steps:', () => {
    const result = parseAutomationEntry(`${HEAD}  - prompt: hi\nuses: slack#post\n`);
    expect(issuesOf(result)).toEqual([{ message: ENTRY_USES_REASON, path: 'uses' }]);
    expect(ENTRY_USES_REASON).toBe('`uses:` is a step: put it under `steps:`.');
  });
});
