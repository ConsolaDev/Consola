import { parseFactory } from '@consola/factory-spec';
import { readCellMessage, RUN_PROBLEM_TEXT_MAX, RUN_PROBLEMS_MAX } from '@consola/runner-protocol';
import type { RunRecord } from '@consola/runner-protocol';
import { describe, expect, it } from 'vitest';
import {
  checkRun,
  childCountsOf,
  decodeCursor,
  encodeCursor,
  PHASES,
  phaseOf,
  progressOf,
  RUN_STATUSES,
  refusalOf,
  requestPhase,
  NO_STEP_DETAIL,
  OUTPUT_TAIL_MAX,
  stepDefinitionOf,
  stepRecordOf,
  TITLE_MAX,
  tailOf,
  titleOf,
} from './run.js';
import type { RunWrite, StepRecord } from './run.js';

const T = '2026-11-20T10:00:00.000Z';

const step = (id: string, status: StepRecord['status'], kind: StepRecord['kind'] = 'agent') =>
  ({
    id,
    kind,
    status,
    attempt: 1,
    agent: null,
    model: null,
    startedAt: null,
    finishedAt: null,
    costUsd: null,
    error: null,
    skipped: null,
    ...NO_STEP_DETAIL,
  }) satisfies StepRecord;

const automationRun = (overrides: Partial<RunWrite> = {}): RunWrite => ({
  id: 'run-1',
  factoryId: 'factory-1',
  factoryVersion: 2,
  parent: null,
  automation: 'review-prs',
  status: 'running',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: null,
  runner: 'cloud',
  steps: [step('plan', 'completed'), step('review', 'running')],
  request: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: T,
  startedAt: T,
  finishedAt: null,
  updatedAt: T,
  ...overrides,
});

const request = (overrides: Partial<RunWrite> = {}): RunWrite =>
  automationRun({
    id: 'request-1',
    automation: null,
    trigger: 'manual',
    triggerDetail: null,
    startedBy: 'person-1',
    steps: [step('orchestrator', 'running', 'orchestrator')],
    request: {
      text: 'Ship the billing page.\nIt is late.',
      budget: { usd: 20, runs: 8 },
      spent: { usd: 1.5, runs: 1 },
      question: null,
    },
    ...overrides,
  });

const problemsOf = (run: RunWrite) => {
  const checked = checkRun(run);
  return checked.ok ? [] : checked.problems.map((problem) => problem.field);
};

describe('phaseOf', () => {
  it('files every status under one phase', () => {
    expect(RUN_STATUSES.map((status) => [status, phaseOf(status, null)])).toEqual([
      ['queued', 'active'],
      ['running', 'active'],
      ['needs-approval', 'needs-you'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['rejected', 'stopped'],
      ['waiting', 'active'],
      ['expired', 'failed'],
      ['cancelled', 'stopped'],
    ]);
  });

  it('files a run waiting on a person as needing them, and one waiting on a run as at work', () => {
    expect(phaseOf('waiting', 'person')).toBe('needs-you');
    expect(phaseOf('waiting', 'run')).toBe('active');
  });
});

describe('requestPhase', () => {
  it('lifts a request at work whose run needs someone', () => {
    expect(requestPhase('active', ['completed', 'needs-you'])).toBe('needs-you');
    expect(requestPhase('active', ['active', 'completed'])).toBe('active');
  });

  it('never lifts a request that has ended, or already needs someone', () => {
    for (const own of PHASES.filter((phase) => phase !== 'active')) {
      expect(requestPhase(own, ['needs-you'])).toBe(own);
    }
  });
});

describe('progressOf and childCountsOf', () => {
  it('count the steps that ended, and name the first at work', () => {
    const steps = [
      step('a', 'completed'),
      step('b', 'skipped'),
      step('c', 'waiting'),
      step('d', 'running'),
      step('e', 'pending'),
    ];
    expect(progressOf(steps)).toEqual({ total: 5, done: 2, current: 'c' });
    expect(progressOf([step('a', 'completed')])).toEqual({ total: 1, done: 1, current: null });
  });

  it("count a request's runs by phase", () => {
    expect(childCountsOf(['active', 'needs-you', 'failed', 'failed', 'completed'])).toEqual({
      total: 5,
      active: 1,
      needsYou: 1,
      failed: 2,
    });
  });
});

describe('titleOf', () => {
  it("is an item's title first, for either kind", () => {
    const item = {
      url: 'https://github.com/a/b/pull/1',
      title: 'Fix login',
      kind: 'pr' as const,
      repo: 'a/b',
      number: 1,
      headSha: null,
      baseRef: null,
    };
    expect(titleOf({ ...request(), item })).toBe('Fix login');
    expect(titleOf({ ...automationRun(), item })).toBe('Fix login');
  });

  it("is a request's first line that holds anything, else the automation's name", () => {
    expect(titleOf(request())).toBe('Ship the billing page.');
    const blankFirst = request({
      request: {
        ...(request().request as NonNullable<RunWrite['request']>),
        text: '\n  \n\tHello\n',
      },
    });
    expect(titleOf(blankFirst)).toBe('Hello');
    expect(titleOf(automationRun())).toBe('review-prs');
  });

  it(`is one line of at most ${TITLE_MAX} characters`, () => {
    const long = request({
      request: {
        ...(request().request as NonNullable<RunWrite['request']>),
        text: 'é'.repeat(300),
      },
    });
    const title = titleOf(long);
    expect([...title]).toHaveLength(TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    const item = {
      url: 'https://x.test/1',
      title: 'a\u0007b\tc',
      kind: null,
      repo: null,
      number: null,
      headSha: null,
      baseRef: null,
    };
    expect(titleOf({ ...automationRun(), item })).toBe('a b c');
  });
});

describe('checkRun', () => {
  it('takes a good automation run and a good request, deriving kind, title and phase', () => {
    expect(checkRun(automationRun())).toEqual({
      ok: true,
      run: { ...automationRun(), kind: 'automation', title: 'review-prs', ownPhase: 'active' },
    });
    const checked = checkRun(request({ status: 'waiting', waitingOn: 'person' }));
    expect(checked.ok && checked.run.kind).toBe('request');
    expect(checked.ok && checked.run.ownPhase).toBe('needs-you');
  });

  it('says what a waiting run waits on exactly while it is waiting', () => {
    expect(problemsOf(automationRun({ status: 'waiting' }))).toEqual(['waitingOn']);
    expect(problemsOf(automationRun({ waitingOn: 'run' }))).toEqual(['waitingOn']);
  });

  it('refuses a status, trigger or step it does not know', () => {
    expect(problemsOf(automationRun({ status: 'paused' as never }))).toContain('status');
    expect(problemsOf(automationRun({ trigger: 'webhook' as never }))).toEqual(['trigger']);
    expect(
      problemsOf(automationRun({ steps: [{ ...step('a', 'running'), kind: 'x' as never }] })),
    ).toEqual(['steps[0].kind']);
  });

  it('keeps an automation exactly for an automation run, and an orchestrator for a request', () => {
    expect(problemsOf(automationRun({ automation: null }))).toEqual(['automation']);
    expect(problemsOf(request({ automation: 'review-prs' }))).toEqual(['automation']);
    expect(problemsOf(automationRun({ automation: 'Not A Name' }))).toEqual(['automation']);
    expect(problemsOf(request({ steps: [step('plan', 'running')] }))).toEqual(['steps']);
    expect(
      problemsOf(automationRun({ steps: [step('orchestrator', 'running', 'orchestrator')] })),
    ).toEqual(['steps']);
  });

  it('takes a parent only on a run a request started: manual, by no person', () => {
    const parent = { runId: 'request-1', move: 1 };
    expect(problemsOf(automationRun({ parent, trigger: 'manual' }))).toEqual([]);
    expect(problemsOf(automationRun({ parent }))).toEqual(['trigger']);
    expect(problemsOf(automationRun({ parent, trigger: 'manual', startedBy: 'p' }))).toEqual([
      'trigger',
    ]);
    expect(problemsOf(request({ parent }))).toContain('parent');
    expect(
      problemsOf(automationRun({ parent: { runId: 'run-1', move: 1 }, trigger: 'manual' })),
    ).toEqual(['parent.runId']);
  });

  it('takes an item only at an https address', () => {
    const item = {
      url: 'http://github.com/a/b/pull/1',
      title: 'Fix',
      kind: 'pr' as const,
      repo: 'a/b',
      number: 1,
      headSha: null,
      baseRef: null,
    };
    expect(problemsOf(automationRun({ item }))).toEqual(['item.url']);
    expect(problemsOf(automationRun({ item: { ...item, url: 'javascript:alert(1)' } }))).toEqual([
      'item.url',
    ]);
    expect(
      problemsOf(automationRun({ item: { ...item, url: 'https://github.com/a/b/pull/1' } })),
    ).toEqual([]);
    expect(
      problemsOf(automationRun({ item: { ...item, url: 'https://x.test', number: 0 } })),
    ).toEqual(['item.number']);
  });

  it('gives only a pull request a head commit, of 40 lowercase hex, and a base branch', () => {
    const head = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
    const pr = {
      url: 'https://github.com/sprocket/catalog-portal/pull/7',
      title: 'Price the catalog in euros',
      kind: 'pr' as const,
      repo: 'sprocket/catalog-portal',
      number: 7,
      headSha: head,
      baseRef: 'main',
    };
    expect(problemsOf(automationRun({ item: pr }))).toEqual([]);
    expect(problemsOf(automationRun({ item: { ...pr, headSha: null, baseRef: null } }))).toEqual(
      [],
    );
    expect(problemsOf(automationRun({ item: { ...pr, headSha: head.toUpperCase() } }))).toEqual([
      'item.headSha',
    ]);
    expect(problemsOf(automationRun({ item: { ...pr, headSha: 'c0ffee' } }))).toEqual([
      'item.headSha',
    ]);
    expect(problemsOf(automationRun({ item: { ...pr, baseRef: ' ' } }))).toEqual(['item.baseRef']);
    for (const kind of ['issue', null] as const) {
      expect(problemsOf(automationRun({ item: { ...pr, kind, baseRef: null } }))).toEqual(['item']);
      expect(problemsOf(automationRun({ item: { ...pr, kind, headSha: null } }))).toEqual(['item']);
      expect(
        problemsOf(automationRun({ item: { ...pr, kind, headSha: null, baseRef: null } })),
      ).toEqual([]);
    }
  });

  it('refuses text a database cannot hold, wherever it is', () => {
    expect(problemsOf(automationRun({ summary: 'a\u0000b' }))).toEqual(['summary']);
    expect(
      problemsOf(automationRun({ steps: [{ ...step('a', 'failed'), error: '\uD800' }] })),
    ).toEqual(['steps[0].error']);
  });

  it('refuses times it cannot store, ids it does not take, and costs below zero', () => {
    expect(problemsOf(automationRun({ createdAt: 'yesterday' }))).toEqual(['createdAt']);
    expect(problemsOf(automationRun({ updatedAt: '2026-11-20T10:00:00.123456Z' }))).toEqual([
      'updatedAt',
    ]);
    expect(problemsOf(automationRun({ id: 'has space' }))).toEqual(['id']);
    expect(problemsOf(automationRun({ costUsd: -1 }))).toEqual(['costUsd']);
    expect(problemsOf(automationRun({ factoryVersion: 0 }))).toEqual(['factoryVersion']);
  });

  it("refuses a request's text over 64 KB", () => {
    const facts = request().request as NonNullable<RunWrite['request']>;
    expect(problemsOf(request({ request: { ...facts, text: 'a'.repeat(64 * 1024 + 1) } }))).toEqual(
      ['request.text'],
    );
  });
});

describe('RunWrite', () => {
  it("is the protocol's RunRecord, both ways", () => {
    const write: RunWrite = automationRun();
    const record: RunRecord = write;
    const back: RunWrite = record;
    expect(back).toBe(write);
  });
});

describe('refusalOf', () => {
  it("names every problem checkRun found, as the protocol's run.refused", () => {
    const checked = checkRun(automationRun({ status: 'waiting', costUsd: -1 }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const refusal = refusalOf('run-1', checked.problems);
    expect(refusal).toEqual({ type: 'run.refused', runId: 'run-1', problems: checked.problems });
    expect(readCellMessage(JSON.parse(JSON.stringify(refusal)))).toEqual({
      ok: true,
      value: refusal,
    });
  });

  it('keeps within the bounds, never quoting more of what the runner sent', () => {
    const long = `\`${'a'.repeat(5000)}\` is no automation's name.`;
    const many = Array.from({ length: RUN_PROBLEMS_MAX + 10 }, (_, i) => ({
      field: `steps[${i}].${'x'.repeat(2000)}`,
      message: long,
    }));
    const refusal = refusalOf('run-1', many);
    expect(refusal.problems).toHaveLength(RUN_PROBLEMS_MAX);
    for (const { field, message } of refusal.problems) {
      expect(field.length).toBeLessThanOrEqual(RUN_PROBLEM_TEXT_MAX);
      expect(message.length).toBe(RUN_PROBLEM_TEXT_MAX);
    }
    expect(readCellMessage(JSON.parse(JSON.stringify(refusal))).ok).toBe(true);
    // A pair of surrogates is never cut in two.
    const emoji = `${'a'.repeat(RUN_PROBLEM_TEXT_MAX - 1)}😀`;
    const [cut] = refusalOf('run-1', [{ field: 'summary', message: emoji }]).problems;
    expect(cut?.message).toBe('a'.repeat(RUN_PROBLEM_TEXT_MAX - 1));
  });

  it('names a problem even when it is handed none', () => {
    expect(refusalOf('run-1', []).problems).toHaveLength(1);
  });
});

describe('the cursor', () => {
  it('reads back what it was made from', () => {
    const cursor = { createdAt: T, id: 'run-1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is null for anything the list did not hand out', () => {
    for (const text of [
      '',
      'not a cursor!',
      btoa('[1,2]'),
      btoa('["yesterday","run-1"]'),
      btoa('{}'),
    ]) {
      expect(decodeCursor(text.replace(/=+$/, ''))).toBeNull();
    }
  });
});

describe("a step's details", () => {
  const done = (overrides: Partial<StepRecord> = {}): StepRecord => ({
    ...step('review', 'completed'),
    attempt: 2,
    outputs: { verdict: 'approve', findings: 3, blocking: false },
    artifacts: [{ name: 'review', bytes: 2140 }],
    turn: { turns: 7, maxTurns: 12, deniedTools: ['WebFetch'] },
    previous: [
      {
        attempt: 1,
        status: 'failed',
        error: 'Out of turns.',
        finishedAt: T,
        costUsd: 0.4,
        turns: 12,
      },
    ],
    reminded: true,
    ...overrides,
  });
  const withStep = (one: StepRecord) => automationRun({ steps: [one] });

  it('are taken when they hold what a runner records', () => {
    expect(problemsOf(withStep(done()))).toEqual([]);
    const command = {
      exitCode: 0,
      signal: null,
      stdoutBytes: 48_211,
      stderrBytes: 0,
      truncated: false,
    };
    const output = { stdout: 'x'.repeat(OUTPUT_TAIL_MAX), stderr: '', truncated: true };
    expect(problemsOf(withStep({ ...step('build', 'completed', 'run'), command, output }))).toEqual(
      [],
    );
  });

  it('refuse an output tail over the cap, and byte counts or turns below zero', () => {
    const output = { stdout: 'é'.repeat(OUTPUT_TAIL_MAX / 2 + 1), stderr: '', truncated: true };
    expect(problemsOf(withStep({ ...step('build', 'running', 'run'), output }))).toEqual([
      'steps[0].output.stdout',
    ]);
    const command = {
      exitCode: 1,
      signal: null,
      stdoutBytes: -1,
      stderrBytes: 0,
      truncated: false,
    };
    expect(problemsOf(withStep({ ...step('build', 'failed', 'run'), command }))).toEqual([
      'steps[0].command',
    ]);
    expect(
      problemsOf(withStep(done({ turn: { turns: 1.5, maxTurns: null, deniedTools: [] } }))),
    ).toEqual(['steps[0].turn']);
    expect(problemsOf(withStep(done({ artifacts: [{ name: 'review', bytes: -2 }] })))).toEqual([
      'steps[0].artifacts[0]',
    ]);
  });

  it('refuse an output that is no value, and an earlier attempt that is not earlier', () => {
    expect(problemsOf(withStep(done({ outputs: { score: Number.NaN } })))).toEqual([
      'steps[0].outputs',
    ]);
    expect(problemsOf(withStep(done({ attempt: 1 })))).toEqual(['steps[0].previous[0].attempt']);
    const previous = [{ ...done().previous[0], status: 'lost' } as never];
    expect(problemsOf(withStep(done({ previous })))).toEqual(['steps[0].previous[0].status']);
  });

  it("refuse text a database cannot hold, in an output's name or its printed text", () => {
    expect(problemsOf(withStep(done({ outputs: { 'a\u0000b': 1 } })))).toEqual([
      'steps[0].outputs',
    ]);
    const output = { stdout: 'ok\u0000', stderr: '', truncated: false };
    expect(problemsOf(withStep({ ...step('build', 'completed', 'run'), output }))).toEqual([
      'steps[0].output.stdout',
    ]);
  });

  it('read a step stored before they existed as having none', () => {
    const { outputs, artifacts, turn, command, previous, reminded, output, ...stored } = done();
    expect(stepRecordOf(stored)).toEqual({ ...stored, ...NO_STEP_DETAIL });
    expect(stepRecordOf(done())).toEqual(done());
  });
});

describe('tailOf', () => {
  it('keeps text that fits whole', () => {
    expect(tailOf('one\ntwo\n', 16)).toEqual({ text: 'one\ntwo\n', truncated: false });
  });

  it('keeps the last whole lines that fit, and says more came before', () => {
    expect(tailOf('first line\nsecond\nthird\n', 10)).toEqual({ text: 'third\n', truncated: true });
    // A cut that falls just after a line's end keeps the next line whole.
    expect(tailOf('first line\nsecond\nthird\n', 13)).toEqual({
      text: 'second\nthird\n',
      truncated: true,
    });
    const tail = tailOf(`${'é'.repeat(20_000)}\nend`);
    expect(tail).toEqual({ text: 'end', truncated: true });
  });

  it('keeps the last bytes of a line too long for the cap, never half a character', () => {
    const { text, truncated } = tailOf('é'.repeat(10), 5);
    expect(truncated).toBe(true);
    expect(text).toBe('éé');
  });
});

describe('stepDefinitionOf', () => {
  const REVIEW = `on: { github: { events: [pull_request.opened] } }
steps:
  - id: review
    agent: reviewer
    prompt: Review pull request {{item.number}}.
    outputs:
      verdict: { enum: [approve, comment] }
      findings: { type: integer }
    artifacts: [review]
    max_turns: 12
  - id: comment
    if: steps.review.verdict != 'approve'
    run: gh pr comment "$PR" --body-file "$REVIEW"
    env: { PR: "{{item.number}}", REVIEW: "{{steps.review.review.file}}" }
    timeout: 2m
`;
  const [automation] = parseFactory({
    factoryYml: 'version: 1\n',
    automations: { 'review-prs': REVIEW },
    agents: { reviewer: '---\ndescription: Reviews.\n---\nYou review.\n' },
    skills: {},
    stray: [],
    laterFolders: [],
    unread: [],
    outside: [],
  }).automations;
  if (!automation) throw new Error('the automation did not parse');

  it("says what an agent step was asked, as written, its outputs' types in words", () => {
    expect(stepDefinitionOf(automation, 'review', 4)).toEqual({
      kind: 'agent',
      prompt: 'Review pull request {{item.number}}.',
      action: null,
      agent: 'reviewer',
      run: null,
      env: [],
      if: null,
      outputs: [
        { name: 'verdict', type: 'one of: approve, comment' },
        { name: 'findings', type: 'an integer' },
      ],
      artifacts: ['review'],
      maxTurns: 12,
      timeoutMs: null,
      file: 'automations/review-prs.yaml',
      version: 4,
      range: null,
    });
    expect(stepDefinitionOf(automation, 'review', 4, { start: 2, end: 10 })?.range).toEqual({
      start: 2,
      end: 10,
    });
  });

  it('says what a command step runs, with its environment as written', () => {
    expect(stepDefinitionOf(automation, 'comment', 4)).toMatchObject({
      kind: 'run',
      prompt: null,
      agent: null,
      run: 'gh pr comment "$PR" --body-file "$REVIEW"',
      env: [
        { name: 'PR', value: '{{item.number}}' },
        { name: 'REVIEW', value: '{{steps.review.review.file}}' },
      ],
      if: "steps.review.verdict != 'approve'",
      outputs: [],
      maxTurns: null,
      timeoutMs: 120_000,
    });
  });

  it('is null for a step the automation does not define', () => {
    expect(stepDefinitionOf(automation, 'deploy', 4)).toBeNull();
  });

  it('describes no call, in a loop or not, as it describes no gate (the merge of slice 3 and 5a)', () => {
    const SHIP = `on: manual
scope: storefront
steps:
  - id: fix
    prompt: Fix the bug.
  - id: post
    uses: slack#chat_post_message
    with: { channel: C0SUPPORT1, text: Fixed. }
  - id: polish
    repeat: { max: 2, until: "steps.tidy.done" }
    steps:
      - id: tidy
        uses: consola#cleanup_stale_sessions
        with: { pr_states: [merged] }
        outputs: { done: { type: boolean } }
`;
    const [ship] = parseFactory({
      factoryYml: 'version: 1\nmcpServers:\n  slack:\n    command: /opt/sprocket/bin/slack-mcp\n',
      automations: { ship: SHIP },
      agents: {},
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    }).automations;
    if (!ship) throw new Error('the automation did not parse');

    expect(stepDefinitionOf(ship, 'fix', 4)).toMatchObject({
      kind: 'agent',
      prompt: 'Fix the bug.',
    });
    expect(stepDefinitionOf(ship, 'post', 4)).toBeNull();
    expect(stepDefinitionOf(ship, 'tidy', 4)).toBeNull();
  });

  it('describes the steps inside a loop, and none for a gate or the loop itself', () => {
    const SHIP = `on: manual
scope: storefront
steps:
  - id: fix
    prompt: Fix the bug.
  - id: polish
    repeat: { max: 3, until: steps.check.clean }
    steps:
      - id: check
        run: pnpm lint --format json
        outputs: { clean: { type: boolean } }
      - id: tidy
        agent: reviewer
        prompt: Tidy what the check found.
  - id: decide
    gate: { ask: Ship it? }
`;
    const [ship] = parseFactory({
      factoryYml: 'version: 1\n',
      automations: { ship: SHIP },
      agents: { reviewer: '---\ndescription: Reviews.\n---\nYou review.\n' },
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    }).automations;
    if (!ship) throw new Error('the automation did not parse');

    expect(stepDefinitionOf(ship, 'check', 4)).toMatchObject({
      kind: 'run',
      run: 'pnpm lint --format json',
      outputs: [{ name: 'clean' }],
    });
    expect(stepDefinitionOf(ship, 'tidy', 4)).toMatchObject({
      kind: 'agent',
      agent: 'reviewer',
      prompt: 'Tidy what the check found.',
    });
    // A loop runs nothing itself, and a gate is a person's decision: neither is an agent
    // or a command step, the two a definition describes.
    expect(stepDefinitionOf(ship, 'polish', 4)).toBeNull();
    expect(stepDefinitionOf(ship, 'decide', 4)).toBeNull();
  });
});
