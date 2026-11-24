import {
  callArguments,
  type McpServerDefinition,
  type RunRecord,
  type StepRun,
  type UsesStep,
} from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { McpCallOutcome, RunFolderPort } from '../ports';
import type { ItemSource } from '../sources/itemSource';
import type { RunDefinition } from './definition';
import {
  CALL_RESULT_CAP_BYTES,
  callEnd,
  callFileOf,
  callOutputs,
  maskDeep,
  MAX_ARGUMENT_BYTES,
  MAX_TEMPLATED_BYTES,
  outputArtifactOf,
  outputSchemaProblem,
  reachedOf,
  renderCallArguments,
  resultFileOf,
  resultObjectOf,
  serverLaunchOf,
  withCallIntent,
  withCallResult,
  withCallStarted,
} from './usesStep';

const SLACK: McpServerDefinition = {
  name: 'slack',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@sprocket/slack-mcp@1.4.2'],
  env: { SLACK_TEAM_ID: 'T0SPROCKET' },
  secrets: ['SLACK_BOT_TOKEN'],
};
const TRACKER: McpServerDefinition = {
  name: 'tracker',
  transport: 'http',
  url: 'https://mcp.tracker.sprocket.example/mcp',
  headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' },
  secrets: ['TRACKER_TOKEN'],
};

const HANDOVER = 'Shipped: the cart total fix.';

/** A call `post` with `with`, after `triage` (typed outputs) and `brief` (a handover). */
function post(withArgs: Record<string, unknown>): UsesStep {
  return {
    id: 'post',
    named: true,
    kind: 'uses',
    uses: 'slack#chat_post_message',
    server: 'slack',
    tool: 'chat_post_message',
    with: withArgs,
    outputs: {},
    timeoutMs: 60_000,
    dryRun: 'report',
  };
}

/** A run whose `triage` and `brief` completed, and the folder holding `brief`'s handover. */
function render(
  step: UsesStep,
  options: {
    handover?: string;
    item?: Record<string, unknown>;
    previous?: { runId: string };
  } = {},
) {
  const steps: RunDefinition['automation']['steps'] = [
    {
      id: 'triage',
      named: true,
      kind: 'agent',
      prompt: 'Triage it.',
      outputs: {
        count: { type: 'integer' },
        flag: { type: 'boolean' },
        verdict: { type: 'enum', values: ['post', 'skip'] },
        note: { type: 'string', maxLength: 2000 },
      },
      artifacts: [],
      reads: [],
      handover: 'optional',
    },
    {
      id: 'brief',
      named: true,
      kind: 'agent',
      prompt: 'Write it.',
      outputs: {},
      artifacts: [],
      reads: [],
      handover: 'required',
    },
    step,
  ];
  const records: StepRun[] = [
    {
      id: 'triage',
      kind: 'agent',
      status: 'completed',
      attempt: 1,
      outputs: { count: 3, flag: true, verdict: 'post', note: 'See the cart.' },
    },
    {
      id: 'brief',
      kind: 'agent',
      status: 'completed',
      attempt: 1,
      artifacts: [{ name: 'handover', bytes: 10 }],
    },
    { id: 'post', kind: 'uses', status: 'queued', attempt: 1 },
  ];
  const run = {
    id: 'run-1',
    automationId: 'brief',
    trigger: options.item ? { kind: 'poll', item: { key: 'k-1', title: 'T', url: '' } } : {},
    steps: records,
  } as unknown as RunRecord;
  const automation = {
    name: 'brief',
    trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
    mode: 'auto',
    steps,
  } as unknown as RunDefinition['automation'];
  const definition: RunDefinition = {
    automation,
    version: 'v',
    actions: {},
    calls: {
      post: {
        ref: step.uses,
        server: step.server,
        tool: step.tool,
        arguments: callArguments(step, automation),
      },
    },
  };
  const folder = {
    readArtifact: (_ws: string, runId: string, stepId: string, _attempt: number, name: string) =>
      runId === 'run-1' && stepId === 'brief' && name === 'handover'
        ? (options.handover ?? HANDOVER)
        : null,
    latestAttempt: () => null,
  } as unknown as RunFolderPort;
  const source = {
    itemValue: (_item: unknown, field: string, polled?: Record<string, unknown>) =>
      polled?.[field] as string | undefined,
  } as unknown as ItemSource;
  return renderCallArguments({
    run,
    definition,
    step,
    source,
    polled: options.item,
    previous: options.previous,
    workspaceId: 'ws-1',
    folder,
  });
}
const argsOf = (result: ReturnType<typeof render>) => {
  if (!('ok' in result) || !result.ok) throw new Error(JSON.stringify(result));
  return result.args;
};

describe('renderCallArguments (5a-2 Task 7, Review Focus 5)', () => {
  it('keeps a lone path’s type and fills other text in', () => {
    expect(
      argsOf(
        render(
          post({
            count: '{{steps.triage.count}}',
            ok: '{{ steps.triage.flag }}',
            verdict: '{{steps.triage.verdict}}',
            text: '{{steps.brief.handover}}',
            line: 'n={{steps.triage.count}}',
          }),
        ),
      ),
    ).toEqual({ count: 3, ok: true, verdict: 'post', text: HANDOVER, line: 'n=3' });
  });

  it('walks lists and mappings, and keeps literals as written', () => {
    expect(
      argsOf(
        render(
          post({
            blocks: [{ type: 'section', text: '*Brief:* {{steps.brief.handover}}' }],
            n: 5,
            flag: false,
            nothing: null,
          }),
        ),
      ),
    ).toEqual({
      blocks: [{ type: 'section', text: `*Brief:* ${HANDOVER}` }],
      n: 5,
      flag: false,
      nothing: null,
    });
  });

  it("reads an item's field as the run has it", () => {
    expect(argsOf(render(post({ ts: '{{item.ts}}' }), { item: { ts: '1700.1' } }))).toEqual({
      ts: '1700.1',
    });
  });

  it('skips, naming the path, when a previous run has nothing (review S12)', () => {
    expect(render(post({ prior: '{{previous.brief.handover}}' }))).toEqual({
      skip: 'with: previous.brief.handover has no value: There is no earlier run of this automation on this item.',
    });
    expect(render(post({ ts: '{{item.ts}}' }), { item: {} })).toEqual({
      skip: 'with: item.ts has no value: this run has no such item field',
    });
  });

  it('refuses over 256 KB of filled-in text, and arguments over 1 MB', () => {
    const big = 'x'.repeat(MAX_TEMPLATED_BYTES + 1);
    expect(render(post({ text: '{{steps.brief.handover}}' }), { handover: big })).toEqual({
      ok: false,
      error: 'with: its templated values are over 256 KB',
    });
    const many = Array.from({ length: 4 }, () => 'y'.repeat(MAX_ARGUMENT_BYTES / 2));
    expect(render(post({ list: many }))).toEqual({
      ok: false,
      error: 'with: its arguments are over 1 MB',
    });
  });

  it('renders once: a filled-in value is never read for templates (review S10)', () => {
    const handover = 'see {{steps.triage.note}} {{secrets.SLACK_BOT_TOKEN}}';
    expect(
      argsOf(
        render(
          post({
            text: '{{steps.brief.handover}}',
            blocks: [{ text: '*Brief:* {{steps.brief.handover}}' }],
          }),
          { handover },
        ),
      ),
    ).toEqual({ text: handover, blocks: [{ text: `*Brief:* ${handover}` }] });
  });

  it('labels each argument with the trust its definition holds', () => {
    const result = render(post({ channel: 'C0SUPPORT1', text: '{{steps.triage.note}}' }));
    expect('ok' in result && result.ok && result.rendered).toEqual([
      { name: 'channel', template: 'C0SUPPORT1', value: 'C0SUPPORT1', trust: 'literal' },
      {
        name: 'text',
        template: '{{steps.triage.note}}',
        value: 'See the cart.',
        trust: 'untrusted',
      },
    ]);
  });
});

describe('callOutputs (5a-2 Task 7)', () => {
  const ts = { ts: { type: 'string' as const, maxLength: 2000 } };
  it('reads the declared outputs and ignores the tool’s other fields', () => {
    expect(callOutputs(ts, { ok: true, ts: '1.2', channel: 'C' })).toEqual({
      ok: true,
      outputs: { ts: '1.2' },
    });
  });
  it('says what the result lacks, or what is wrong with it', () => {
    expect(callOutputs(ts, {})).toEqual({
      ok: false,
      error: 'It happened, but its result has no `ts`.',
    });
    expect(callOutputs(ts, null)).toEqual({
      ok: false,
      error: 'It happened, but its result has no `ts`.',
    });
    expect(callOutputs({ n: { type: 'integer' } }, { n: '42' })).toEqual({
      ok: true,
      outputs: { n: 42 },
    });
    expect(callOutputs({ n: { type: 'integer' } }, { n: 'x' })).toEqual({
      ok: false,
      error: "It happened, but its result's `n` must be an integer (got 'x').",
    });
  });
  it('is ok whatever the object when it declares no outputs', () => {
    expect(callOutputs({}, null)).toEqual({ ok: true, outputs: {} });
    expect(callOutputs({}, { anything: [1] })).toEqual({ ok: true, outputs: {} });
  });
});

describe('what a call says it reached, and keeps in call.json (5a-2 Task 7)', () => {
  it('words the server it reached', () => {
    expect(reachedOf(SLACK)).toBe('started `npx -y @sprocket/slack-mcp@1.4.2` on this Mac');
    expect(reachedOf(TRACKER)).toBe('called https://mcp.tracker.sprocket.example/mcp');
    expect(reachedOf('consola')).toBe("Consola's own tool, in process");
  });

  it('masks every string, the values’ and the templates’, at any depth', () => {
    const value = 'stub-slack-secret-9c1e"\\back%slash';
    const masks = [value, JSON.stringify(value).slice(1, -1)];
    const file = callFileOf(
      {
        server: 'slack',
        reached: reachedOf(SLACK),
        tool: 'chat_post_message',
        rendered: [
          {
            name: 'blocks',
            template: [{ text: `literal ${value}` }],
            value: [{ text: `literal ${value}`, nested: { deeper: value } }],
            trust: 'literal',
          },
        ],
        wouldHave: true,
      },
      masks,
    );
    expect(file).toEqual({
      server: 'slack',
      reached: 'started `npx -y @sprocket/slack-mcp@1.4.2` on this Mac',
      tool: 'chat_post_message',
      arguments: [
        {
          name: 'blocks',
          template: [{ text: 'literal ***' }],
          value: [{ text: 'literal ***', nested: { deeper: '***' } }],
          trust: 'literal',
        },
      ],
      wouldHave: true,
    });
    expect(JSON.stringify(file)).not.toContain('stub-slack-secret');
  });
});

describe("a call's records (5a-2 Task 7)", () => {
  const records: StepRun[] = [
    {
      id: 'post',
      kind: 'uses',
      status: 'queued',
      attempt: 2,
      sessionId: 's-old',
      call: { intentAt: '2026-11-16T08:00:00.000Z', resultAt: '2026-11-16T08:00:01.000Z' },
    },
  ];
  it('starts an attempt with no call an earlier one left, then its intent, then its answer', () => {
    const started = withCallStarted(records, 'post', '2026-11-16T09:00:00.000Z');
    expect(started).toEqual([
      {
        id: 'post',
        kind: 'uses',
        status: 'running',
        attempt: 2,
        startedAt: '2026-11-16T09:00:00.000Z',
      },
    ]);
    const intent = withCallIntent(started, 'post', '2026-11-16T09:00:01.000Z');
    expect(intent[0].call).toEqual({ intentAt: '2026-11-16T09:00:01.000Z' });
    expect(
      withCallResult(intent, 'post', '2026-11-16T09:00:02.000Z', { isError: true, bytes: 12 })[0]
        .call,
    ).toEqual({
      intentAt: '2026-11-16T09:00:01.000Z',
      resultAt: '2026-11-16T09:00:02.000Z',
      resultBytes: 12,
      isError: true,
    });
    expect(
      withCallResult(intent, 'post', '2026-11-16T09:00:02.000Z', { isError: false, bytes: 2 })[0]
        .call,
    ).not.toHaveProperty('isError');
  });
});

/*
 * Task 8: a server's call.
 */

const answered = (fields: {
  structuredContent?: unknown;
  content?: unknown[];
  isError?: boolean;
}): Extract<McpCallOutcome, { kind: 'answered' }> => ({
  kind: 'answered',
  isError: fields.isError ?? false,
  content: fields.content ?? [],
  ...(fields.structuredContent !== undefined
    ? { structuredContent: fields.structuredContent }
    : {}),
  bytes: 10,
});
const text = (value: string) => ({ type: 'text', text: value });
const REF = 'slack#chat_post_message';

describe('outputSchemaProblem (5a-2 Task 8)', () => {
  const ts = { ts: { type: 'string' as const, maxLength: 2000 } };
  const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  it('takes outputs the schema has, of a type that fits', () => {
    expect(outputSchemaProblem(ts, schema({ ts: { type: 'string' } }), REF)).toBeNull();
    expect(
      outputSchemaProblem({ n: { type: 'integer' } }, schema({ n: { type: 'integer' } }), REF),
    ).toBeNull();
    expect(
      outputSchemaProblem({ n: { type: 'number' } }, schema({ n: { type: 'integer' } }), REF),
    ).toBeNull();
    expect(outputSchemaProblem(ts, schema({ ts: {} }), REF)).toBeNull();
    expect(outputSchemaProblem(ts, undefined, REF)).toBeNull();
    expect(outputSchemaProblem(ts, schema({ ts: { type: ['string', 'null'] } }), REF)).toBeNull();
  });
  it('refuses one it lacks, or of another type', () => {
    expect(outputSchemaProblem(ts, schema({ channel: { type: 'string' } }), REF)).toBe(
      "`slack#chat_post_message`'s output schema has no `ts`. Nothing was sent.",
    );
    expect(
      outputSchemaProblem({ n: { type: 'integer' } }, schema({ n: { type: 'number' } }), REF),
    ).toBe(
      '`slack#chat_post_message` returns `n` as number, and this step declares it integer. Nothing was sent.',
    );
  });
});

describe('resultObjectOf (5a-2 Task 8)', () => {
  it('reads structured content, else one text block holding a JSON object', () => {
    expect(resultObjectOf(answered({ structuredContent: { ok: true, ts: '1.2' } }))).toEqual({
      ok: true,
      ts: '1.2',
    });
    expect(resultObjectOf(answered({ content: [text('{"ts":"1.2"}')] }))).toEqual({ ts: '1.2' });
  });
  it('reads nothing from prose, two blocks, an image, a list or a structured list', () => {
    expect(resultObjectOf(answered({ content: [text('Posted it.')] }))).toBeNull();
    expect(
      resultObjectOf(answered({ content: [text('{"ts":"1"}'), text('{"ts":"2"}')] })),
    ).toBeNull();
    expect(resultObjectOf(answered({ content: [{ type: 'image', data: 'AA==' }] }))).toBeNull();
    expect(resultObjectOf(answered({ content: [text('[1,2]')] }))).toBeNull();
    expect(resultObjectOf(answered({ structuredContent: [1, 2] }))).toBeNull();
  });
});

describe('maskDeep (5a-2 Task 8, review S9)', () => {
  const value = 'stub-slack-secret-9c1e';
  it('masks keys and values at any depth', () => {
    expect(maskDeep({ [value]: { inner: value, list: [`a ${value}`] } }, [value])).toEqual({
      '***': { inner: '***', list: ['a ***'] },
    });
  });
  it('keeps both values of two keys that mask alike', () => {
    expect(maskDeep({ [`${value}`]: 1, [`${value}x`.slice(0, -1) + ' ']: 2 }, [value])).toEqual({
      '***': 1,
      '*** ': 2,
    });
    expect(
      maskDeep({ [value]: 1, [`x${value}`]: 2, [`${value}`.toUpperCase()]: 3 }, [
        value,
        `x${value}`,
      ]),
    ).toMatchObject({
      '***': 1,
      '***#2': 2,
    });
  });
});

describe('resultFileOf (5a-2 Task 8, review S9)', () => {
  const value = 'stub-slack-secret-9c1e"\\back%slash';
  const masks = [value, JSON.stringify(value).slice(1, -1)];
  it('keeps a result that fits, masked at any depth, keys included', () => {
    expect(
      resultFileOf(
        answered({ structuredContent: { [value]: 1, echoed: value }, content: [text(value)] }),
        masks,
      ),
    ).toEqual({
      isError: false,
      bytes: 10,
      result: {
        content: [{ type: 'text', text: '***' }],
        structuredContent: { '***': 1, echoed: '***' },
      },
    });
  });
  it('cuts one over 1 MB to the first 1 MB of its text, masked before the cut', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const file = resultFileOf(answered({ content: [text(big)] }), masks);
    expect(file).not.toHaveProperty('result');
    expect(file.cut).toBe(JSON.stringify({ content: [text(big)] }).slice(0, CALL_RESULT_CAP_BYTES));
    // A value that straddles the cut is masked first, so no prefix of it survives.
    const prefix = '{"content":[{"type":"text","text":"';
    const straddling = `${'y'.repeat(CALL_RESULT_CAP_BYTES - prefix.length - 5)}${value}${'z'.repeat(1024)}`;
    const cut = resultFileOf(answered({ content: [text(straddling)] }), masks).cut!;
    expect(cut).toContain('***');
    expect(cut).not.toContain('stub-');
  });
});

describe('outputArtifactOf (5a-2 Task 8)', () => {
  it('keeps structured content as JSON, one text block as text, nothing over 256 KB', () => {
    expect(outputArtifactOf(answered({ structuredContent: { ts: '1.2' } }), [])).toEqual({
      content: '{"ts":"1.2"}',
      format: 'json',
    });
    expect(outputArtifactOf(answered({ content: [text('Posted.')] }), [])).toEqual({
      content: 'Posted.',
      format: 'text',
    });
    expect(
      outputArtifactOf(answered({ content: [text('x'.repeat(256 * 1024 + 1))] }), []),
    ).toBeNull();
    expect(outputArtifactOf(answered({ content: [text('a'), text('b')] }), [])).toBeNull();
  });
});

describe('serverLaunchOf (5a-2 Task 8, review S8)', () => {
  const values = {
    SLACK_BOT_TOKEN: 'stub-slack-secret-9c1e',
    PAGER_TOKEN: 'stub-pager-secret-7b2d',
    TRACKER_TOKEN: 'stub-tracker-secret-4d7a',
  };
  it('gives a stdio server its env: and its own secrets, and nothing else', () => {
    expect(serverLaunchOf(SLACK, values)).toEqual({
      ok: true,
      launch: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@sprocket/slack-mcp@1.4.2'],
        env: { SLACK_TEAM_ID: 'T0SPROCKET', SLACK_BOT_TOKEN: 'stub-slack-secret-9c1e' },
      },
    });
  });
  it("fills a remote server's headers with its own secrets only", () => {
    expect(serverLaunchOf(TRACKER, values)).toEqual({
      ok: true,
      launch: {
        transport: 'http',
        url: 'https://mcp.tracker.sprocket.example/mcp',
        headers: { Authorization: 'Bearer stub-tracker-secret-4d7a' },
      },
    });
  });
  it("leaves a hand-built header's reference to another name as written", () => {
    expect(
      serverLaunchOf(
        {
          ...TRACKER,
          headers: {
            ...(TRACKER.transport === 'http' ? TRACKER.headers : {}),
            'X-Pager': '${PAGER_TOKEN}',
          },
        },
        values,
      ),
    ).toMatchObject({
      launch: {
        headers: { Authorization: 'Bearer stub-tracker-secret-4d7a', 'X-Pager': '${PAGER_TOKEN}' },
      },
    });
  });

  it('refuses a header value with a line break, and a secret the run does not hold', () => {
    expect(serverLaunchOf(TRACKER, { TRACKER_TOKEN: 'v\r\nX-Evil: 1' })).toEqual({
      ok: false,
      error:
        "Couldn't use `TRACKER_TOKEN` in a header: its value holds a line break. Nothing was sent.",
    });
    expect(serverLaunchOf(SLACK, {})).toEqual({
      ok: false,
      error: "its server's secrets were not read before it started. Nothing was sent.",
    });
  });
});

describe('callEnd: the Failure table (5a-2 Task 8)', () => {
  const end = (outcome: McpCallOutcome, outputs?: Parameters<typeof callEnd>[0]['outputs']) =>
    callEnd({ ref: REF, timeoutMs: 30_000, outcome, outputs }, ['stub-secret-1']);
  it.each([
    ['timeout', 'the call timed out after 30s'],
    ['stopped', 'it was stopped while the call ran'],
    ['closed', 'the server closed the connection before answering'],
    ['too-large', 'its answer was over 8 MB'],
    ['unreadable', 'its answer could not be read (bad JSON at 3 near ***)'],
  ] as const)('%s', (why, words) => {
    expect(end({ kind: 'unanswered', why, detail: 'bad JSON at 3 near stub-secret-1' })).toEqual({
      status: 'failed',
      error: `It may or may not have happened: ${words}. Check, then retry.`,
      call: {},
    });
  });
  it('fails an error result with its text, masked and clipped, and says it may have acted', () => {
    expect(
      end(
        answered({
          isError: true,
          content: [text(`rate_limited after post stub-secret-1 ${'x'.repeat(400)}`)],
        }),
      ),
    ).toEqual({
      status: 'failed',
      error: `\`${REF}\` failed: rate_limited after post *** ${'x'.repeat(272)}…`,
      call: { isError: true },
    });
  });
  it('completes a landed call, and fails one whose outputs fail, as landed', () => {
    expect(end(answered({}), { ok: true, outputs: {} })).toEqual({
      status: 'completed',
      call: { landed: true },
    });
    expect(
      end(answered({}), { ok: false, error: 'It happened, but its result has no `ts`.' }),
    ).toEqual({
      status: 'failed',
      error: 'It happened, but its result has no `ts`.',
      call: { landed: true },
    });
  });
});
