import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  automationVersion,
  parseFactorySpec,
  stableStringify,
  type RunRecord,
  type StepRunStatus,
} from '@consola/factory-spec';
import { INTERRUPTED_PROMPT } from './AutomationService';
import { inboxItem } from './inboxItems.test-helpers';
import { INTERRUPTED_COMMAND, recoverAfterRestart } from './steps/recover';
import {
  CHECKOUT_HEAD,
  checkoutPathFor,
  REVIEW_BODY,
  stepsHarness,
  turnReport,
  WORKSPACE_ID,
  type FakeCommand,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';
import { SessionOpenedError, StartedByHandError } from './support';
import type { InboxItemView, SessionView } from './views';

const NAME = 'review-assigned-prs';
const KEY = `${WORKSPACE_ID} ${NAME}`;
const SUMMARISE_BODY = 'Summarise {{title}} for someone who has not read it.';

/** One `- name:` entry: its `on:` and other keys as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

/** A file holding one entry named review-assigned-prs. */
function factory(head: string, ...steps: string[]): string {
  return file(entry(NAME, head, ...steps));
}
const ON_REVIEW = '    on: { github: pull_request.review_requested }\n';
const DAILY_IN_API = '    on: { cron: "0 9 * * 1-5" }\n    scope: api\n';

const PUBLISH =
  'gh api "repos/$REPO/pulls/$NUMBER/reviews" -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event=COMMENT -F body=@"$BODY_FILE"';

/** The shipped review template, shortened: an action step, then a command that posts what it found. */
const TEMPLATE = factory(
  `${ON_REVIEW}    mode: auto\n`,
  '- id: review\n  action: Review\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }',
  `- id: publish\n  if: steps.review.verdict != 'approve'\n  run: ${PUBLISH}\n  env: { REPO: "{{item.repo}}", NUMBER: "{{item.number}}", BODY_FILE: "{{steps.review.handover.file}}" }`,
);

const only = (yaml: string) => ({ ...parseFactorySpec(yaml).automations[0], file: 'factory.yml' });

async function listed(options: StepsHarnessOptions) {
  const h = await stepsHarness(options);
  return h.service.list(WORKSPACE_ID)[0];
}

describe('a steps entry, resolved against its workspace', () => {
  it('an entry with a gate runs: it is not refused for it', async () => {
    const GATED_ENTRY = file(
      entry(
        'gated',
        ON_REVIEW,
        '- id: review\n  action: Review',
        '- id: decide\n  gate: { ask: Post it as an approval?, show: [review.handover] }',
      ),
    );
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    expect(
      h.service.list(WORKSPACE_ID).find((view) => view.name === 'gated')?.problem,
    ).toBeUndefined();
  });

  it("resolves, its version covering each action step's body", async () => {
    const h = await stepsHarness({ yaml: TEMPLATE });
    expect(h.service.list(WORKSPACE_ID)[0]).toMatchObject({ name: NAME, asksFirst: true });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();

    h.store.accept(
      KEY,
      automationVersion(only(TEMPLATE), stableStringify({ review: REVIEW_BODY })),
    );
    await h.service.syncWorkspaces();
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

    // Editing the action in settings changes what the step runs: it asks again.
    const review = h.world.workspace.actions[0];
    h.world.workspace.actions[0] = { ...review, prompt: `${REVIEW_BODY} Be brief.` };
    await h.service.syncWorkspaces();
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
  });

  it('hashes no body when no step names an action', async () => {
    const yaml = factory(
      `${DAILY_IN_API}    mode: auto\n`,
      '- prompt: Summarise what changed in api.',
      '- run: git log -1',
    );
    const h = await stepsHarness({ yaml });
    h.store.accept(KEY, automationVersion(only(yaml)));
    await h.service.syncWorkspaces();
    expect(h.service.list(WORKSPACE_ID)[0]).toMatchObject({ name: NAME });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
  });

  it("hashes every action step's body, not only the first", async () => {
    const yaml = factory(
      `${ON_REVIEW}    mode: auto\n`,
      '- id: review\n  action: Review',
      '- id: summary\n  action: Summarise',
    );
    const h = await stepsHarness({ yaml });
    h.world.workspace.actions.push({
      name: 'Summarise',
      appliesTo: ['pr'],
      prompt: SUMMARISE_BODY,
    });
    await h.service.syncWorkspaces();
    h.store.accept(
      KEY,
      automationVersion(
        only(yaml),
        stableStringify({ review: REVIEW_BODY, summary: SUMMARISE_BODY }),
      ),
    );
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

    // The second step's action edited: what the entry runs changed, so it asks again.
    h.world.workspace.actions[2] = {
      ...h.world.workspace.actions[2],
      prompt: `${SUMMARISE_BODY} Be brief.`,
    };
    await h.service.syncWorkspaces();
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
  });

  it('asks first under notify only when its dry run would start something', async () => {
    const yaml = factory(`${ON_REVIEW}    mode: notify\n`, '- action: Review');
    const agentStep = await stepsHarness({ yaml });
    expect(agentStep.service.list(WORKSPACE_ID)[0]).toMatchObject({
      mode: 'notify',
      asksFirst: true,
    });
    agentStep.store.accept(
      KEY,
      automationVersion(only(yaml), stableStringify({ 'step-1': REVIEW_BODY })),
    );
    expect(agentStep.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

    const fetches = await listed({
      yaml: factory(
        `${DAILY_IN_API}    mode: notify\n`,
        '- run: git fetch --prune\n  dry_run: run',
        '- run: git log -1',
      ),
    });
    expect(fetches.asksFirst).toBe(true);

    const reportsOnly = await listed({
      yaml: factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git log -1'),
    });
    expect(reportsOnly.problem).toBeUndefined();
    expect(reportsOnly.asksFirst).toBeUndefined();
  });

  it.each<[string, StepsHarnessOptions, string]>([
    [
      'an action step naming an action the workspace lacks',
      { yaml: factory(ON_REVIEW, '- action: Nope') },
      'no action named Nope in this workspace',
    ],
    [
      'an action step whose action does not apply to the items',
      { yaml: factory(ON_REVIEW, '- action: Triage') },
      'the Triage action does not apply to pull requests',
    ],
    [
      'an agent step on a harness that cannot run read-only',
      {
        yaml: factory(ON_REVIEW, '- prompt: Review it.'),
        harness: { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' },
      },
      'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
    ],
    [
      'a run: step on Windows',
      {
        yaml: factory(
          ON_REVIEW,
          '- run: gh pr view "$NUMBER"\n  env: { NUMBER: "{{item.number}}" }',
        ),
        platform: 'win32',
      },
      'run: steps need a POSIX shell, which Windows does not have',
    ],
    [
      'an item field the connection lacks',
      { yaml: factory(ON_REVIEW, '- run: echo "$LABELS"\n  env: { LABELS: "{{item.labels}}" }') },
      '`item.labels`: github items have no field `labels` (they have: key, url, repo, number, type, title, author)',
    ],
    [
      'a scope on an event whose items have a repository',
      { yaml: factory(`${ON_REVIEW}    scope: api\n`, '- prompt: Review it.') },
      'scope: a github item runs in a worktree of its own repository, so it takes no scope',
    ],
    [
      'a schedule naming a scope the workspace lacks',
      {
        yaml: factory(
          '    on: { cron: "0 9 * * 1-5" }\n    scope: web\n',
          '- prompt: Summarise web.',
        ),
      },
      'no scope named "web" in this workspace; it has: catalog-portal, api',
    ],
  ])('has a problem for %s', async (_name, options, problem) => {
    expect((await listed(options)).problem).toBe(problem);
  });

  it('refuses an untrusted item field in a prompt when the file loads, before the runner sees it', async () => {
    const h = await stepsHarness({
      yaml: factory(ON_REVIEW, '- prompt: "Review {{item.title}}."'),
    });
    expect(h.service.list(WORKSPACE_ID)).toEqual([]);
    expect(h.service.snapshot(WORKSPACE_ID).issues.map((issue) => issue.message)).toContain(
      'item.title: it is text someone else wrote; the step gets it below its prompt as data.',
    );
  });

  it('reports the first step with a problem, in file order', async () => {
    expect(
      (await listed({ yaml: factory(ON_REVIEW, '- action: Triage', '- action: Nope') })).problem,
    ).toBe('the Triage action does not apply to pull requests');
    expect(
      (await listed({ yaml: factory(ON_REVIEW, '- action: Nope', '- action: Triage') })).problem,
    ).toBe('no action named Nope in this workspace');
  });

  it('reports scope, then steps, then item fields, then Windows, then the harness', async () => {
    const cannotRestrict = {
      name: 'Codex',
      problem: 'Codex sessions cannot be made read-only yet.',
    };
    const labels = '- run: echo "$LABELS"\n  env: { LABELS: "{{item.labels}}" }';
    const everything = { platform: 'win32', harness: cannotRestrict } as const;

    expect(
      (
        await listed({
          ...everything,
          yaml: factory(
            '    on: { cron: "0 9 * * 1-5" }\n    scope: web\n',
            '- prompt: Look.',
            '- run: ls',
          ),
        })
      ).problem,
    ).toBe('no scope named "web" in this workspace; it has: catalog-portal, api');
    expect(
      (await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Nope', labels) })).problem,
    ).toBe('no action named Nope in this workspace');
    expect(
      (await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Review', labels) }))
        .problem,
    ).toBe(
      '`item.labels`: github items have no field `labels` (they have: key, url, repo, number, type, title, author)',
    );
    expect(
      (await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Review', '- run: ls') }))
        .problem,
    ).toBe('run: steps need a POSIX shell, which Windows does not have');
    expect(
      (
        await listed({
          harness: cannotRestrict,
          yaml: factory(ON_REVIEW, '- action: Review', '- run: ls'),
        })
      ).problem,
    ).toBe(
      'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
    );
  });

  it('needs no harness for an entry of commands only', async () => {
    const entry = await listed({
      yaml: factory(DAILY_IN_API, '- run: git fetch --prune'),
      harness: { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' },
    });
    expect(entry.problem).toBeUndefined();
    expect(entry.nextRunAt).not.toBeNull();
  });

  it("refuses a loop's command on Windows, as any command", async () => {
    const looped = factory(
      ON_REVIEW,
      '- id: polish\n  repeat: { max: 2, until: steps.check.ok }\n  steps:\n    - id: check\n      run: gh pr checks\n      outputs: { ok: boolean }',
    );
    expect((await listed({ yaml: looped, platform: 'win32' })).problem).toBe(
      'run: steps need a POSIX shell, which Windows does not have',
    );
    // On a POSIX shell nothing is in its way.
    expect((await listed({ yaml: looped })).problem).toBeUndefined();
  });

  it('needs no POSIX shell for an entry of agent steps only', async () => {
    expect(
      (await listed({ yaml: factory(ON_REVIEW, '- action: Review'), platform: 'win32' })).problem,
    ).toBeUndefined();
  });
});

describe('a harness whose extra args override what steps compile', () => {
  const stepProblem =
    "This harness's extra arguments set `--max-turns`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.";
  const overriding = { name: 'Stub', problem: null, stepProblem };
  const refusal = `Stub can’t run automation steps: ${stepProblem}`;

  it('refuses steps entries with an agent step, which then do not run on Run now', async () => {
    const h = await stepsHarness({ yaml: TEMPLATE, harness: overriding });
    expect(h.service.list(WORKSPACE_ID).find((a) => a.name === NAME)?.problem).toBe(refusal);
    await expect(h.service.trigger(WORKSPACE_ID, NAME)).rejects.toThrow(
      `${NAME} cannot run: ${refusal}`,
    );
    expect(h.world.launches).toEqual([]);
  });

  it('leaves a steps entry of commands only alone', async () => {
    const entry = await listed({
      yaml: factory(DAILY_IN_API, '- run: git fetch --prune'),
      harness: overriding,
    });
    expect(entry.problem).toBeUndefined();
  });

  it('leaves a legacy prompt entry alone: its turn does not report', async () => {
    const entry = await listed({ yaml: file(legacy('digest')), harness: overriding });
    expect(entry.problem).toBeUndefined();
  });

  it('a harness that cannot run read-only says that first', async () => {
    const entry = await listed({
      yaml: TEMPLATE,
      harness: {
        name: 'Codex',
        problem: 'Codex sessions cannot be made read-only yet.',
        stepProblem,
      },
    });
    expect(entry.problem).toBe(
      'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
    );
  });

  it('a harness with no step problem refuses nothing', async () => {
    const entry = await listed({ yaml: TEMPLATE, harness: { ...overriding, stepProblem: null } });
    expect(entry.problem).toBeUndefined();
  });

  it("and the workspace's capabilities say so", async () => {
    const h = await stepsHarness({ yaml: TEMPLATE, harness: overriding });
    expect(h.service.capabilities(WORKSPACE_ID).harness).toEqual({
      name: 'Stub',
      canRunAgents: true,
      stepsProblem: refusal,
    });
    const readOnly = await stepsHarness({
      yaml: TEMPLATE,
      harness: {
        name: 'Codex',
        problem: 'Codex sessions cannot be made read-only yet.',
        stepProblem,
      },
    });
    expect(readOnly.service.capabilities(WORKSPACE_ID).harness).toEqual({
      name: 'Codex',
      canRunAgents: false,
      problem:
        'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
    });
  });
});

describe('a steps entry, as the panel lists it', () => {
  it('shows each step, its if:, and what it runs', async () => {
    const entry = await listed({ yaml: TEMPLATE });
    expect(entry).toMatchObject({
      kind: 'agent',
      target: 'steps',
      runs: 'Steps: review → publish',
      steps: [
        { id: 'review', kind: 'agent', summary: 'Review action' },
        {
          id: 'publish',
          kind: 'run',
          if: "steps.review.verdict != 'approve'",
          summary:
            'gh api "repos/$REPO/pulls/$NUMBER/reviews" -f commit_id="$CONSOLA_CHECKOUT_HEAD"…',
        },
      ],
    });
    expect(entry.steps![0]).not.toHaveProperty('if');
  });

  it('says Prompt for a prompt step, and gives a command its first line', async () => {
    const yaml = factory(
      DAILY_IN_API,
      '- prompt: Summarise what changed.',
      '- run: |\n\n    git fetch --prune\n    git log -1',
    );
    expect((await listed({ yaml })).steps).toEqual([
      { id: 'step-1', kind: 'agent', summary: 'Prompt' },
      { id: 'step-2', kind: 'run', summary: 'git fetch --prune' },
    ]);
  });

  it('lists an entry of commands only as a tool', async () => {
    expect(await listed({ yaml: factory(DAILY_IN_API, '- run: git fetch --prune') })).toMatchObject(
      { kind: 'tool', target: 'steps' },
    );
  });

  it('still shows its steps while it has a problem', async () => {
    expect(await listed({ yaml: factory(ON_REVIEW, '- action: Nope') })).toMatchObject({
      problem: 'no action named Nope in this workspace',
      steps: [{ id: 'step-1', kind: 'agent', summary: 'Nope action' }],
    });
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
const PR52 = inboxItem({ repo: 'sprocket/catalog-portal', number: 52, title: 'Cache the catalog' });
const PR51_LABEL = 'sprocket/catalog-portal#51 “Add retries” by @alice';
const TEMPLATE_VERSION = automationVersion(
  only(TEMPLATE),
  stableStringify({ review: REVIEW_BODY }),
);
/** Weekdays at 9 in api: a command, then an agent step. */
const DAILY = factory(
  `${DAILY_IN_API}    mode: auto\n`,
  '- id: fresh\n  run: git fetch --prune',
  '- id: summary\n  prompt: Summarise what changed in api.',
);
const COMMANDS_ONLY = factory(
  `${DAILY_IN_API}    mode: auto\n`,
  '- id: fresh\n  run: git fetch --prune',
  '- id: log\n  run: git log -1',
);
/** Weekdays at 9 in api: one prompt step. */
const SUMMARY = factory(
  `${DAILY_IN_API}    mode: auto\n`,
  '- id: summary\n  prompt: Summarise what changed in api.',
);

/** A harness whose event automations have had their first look at an empty Inbox, which fires nothing. */
async function watching(options: StepsHarnessOptions): Promise<StepsHarness> {
  const h = await stepsHarness(options);
  await h.poll([]);
  return h;
}

/** Accept every entry in `yaml` at its current version, as a person approving each once would. */
function acceptEvery(h: StepsHarness, yaml: string): void {
  for (const automation of parseFactorySpec(yaml).automations) {
    const bodies: Record<string, string> = {};
    for (const step of automation.steps ?? []) {
      if (step.kind === 'agent' && step.action)
        bodies[step.id] = h.world.workspace.actions.find(
          (action) => action.name === step.action,
        )!.prompt;
    }
    const body = Object.keys(bodies).length > 0 ? stableStringify(bodies) : undefined;
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation, body));
  }
}

/** A run as history first recorded it: what it was the moment it was added. */
function firstRecorded(h: StepsHarness, runId: string): RunRecord | undefined {
  return h.history.appends.find((line) => line.run.id === runId)?.run;
}

/** ws-1's `runs/`. */
const runsDir = (h: StepsHarness) => path.dirname(h.folder.runDir(WORKSPACE_ID, 'any'));

/** A session the person started on `item` with the Review action. */
function byHand(item: InboxItemView, at: Date): SessionView {
  const { number } = item.workItem;
  return {
    id: `hand-${number}`,
    workspaceId: WORKSPACE_ID,
    name: `PR ${number}`,
    scopeId: 'scope-catalog-portal',
    harnessId: 'claude',
    claudeSessionId: `claude-hand-${number}`,
    createdAt: at.getTime(),
    workItemKey: item.key,
    workItemAction: 'Review',
  };
}

describe('firing a steps run', () => {
  it('a scheduled steps run records its definition and a light result', async () => {
    const h = await stepsHarness({ yaml: DAILY });
    h.advance(HOUR);
    await h.tick();
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      automationId: NAME,
      actionName: 'steps',
      actionVersion: automationVersion(only(DAILY)),
      trigger: { kind: 'cron' },
      status: 'needs-approval',
    });
    // Light: what each step is and where it runs, none of what it says.
    expect(run.result).toEqual({
      kind: 'steps-run',
      steps: [
        { id: 'fresh', kind: 'run' },
        { id: 'summary', kind: 'agent' },
      ],
      scope: 'api',
    });
    expect(run.steps).toEqual([
      { id: 'fresh', kind: 'run', status: 'pending', attempt: 1 },
      { id: 'summary', kind: 'agent', status: 'pending', attempt: 1 },
    ]);
    expect(run).not.toHaveProperty('approval');
    expect(run).not.toHaveProperty('dryRun');
    expect(JSON.stringify(run)).not.toContain('Summarise what changed');
    expect(h.folder.readDefinition(WORKSPACE_ID, run.id)).toEqual({
      automation: only(DAILY),
      version: run.actionVersion,
      actions: {},
      checkout: 'scope',
    });

    // An action step's body is in the snapshot, by step id.
    const event = await watching({ yaml: TEMPLATE });
    await event.poll([PR51]);
    const [reviewing] = event.store.runs();
    expect(event.folder.readDefinition(WORKSPACE_ID, reviewing.id)).toEqual({
      automation: only(TEMPLATE),
      version: TEMPLATE_VERSION,
      actions: { review: { name: 'Review', body: REVIEW_BODY, groupId: 'g-1' } },
      checkout: 'item',
      readsItems: true,
    });
    expect(reviewing.result).toEqual({
      kind: 'steps-run',
      steps: [
        { id: 'review', kind: 'agent' },
        { id: 'publish', kind: 'run' },
      ],
      item: { url: PR51.url, title: 'Add retries', author: 'alice', label: PR51_LABEL },
      // The seen record its item fired under: the one an item is given back to.
      firedUnder: event.store.seen(KEY)!.definition,
    });
    expect(JSON.stringify(reviewing)).not.toContain('say what should change');
  });

  it('an auto entry asks once, and approving lets it run on its own', async () => {
    const h = await watching({ yaml: TEMPLATE });
    await h.poll([PR51]);
    const [asked] = h.store.runs();
    expect(asked).toMatchObject({
      status: 'needs-approval',
      mode: 'confirm',
      summary: `Steps: review → publish: ${PR51_LABEL}. Approve once to let this new or changed automation run on its own.`,
    });
    expect(h.notices).toEqual([
      {
        title: `${NAME} needs your approval`,
        body: `${asked.summary} Review it in Consola.`,
        runId: asked.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: true,
      },
    ]);

    expect(await h.service.approve(asked.id)).toMatchObject({
      status: 'queued',
      approvedAt: h.now().toISOString(),
    });
    expect(h.store.acceptedVersion(KEY)).toBe(TEMPLATE_VERSION);
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

    // Approved, it started: its review is working in #51's checkout.
    await h.flush();
    expect(h.store.get(asked.id)?.status).toBe('running');
    expect(h.world.launches.map((launch) => launch.step?.name)).toEqual(['Add retries · review']);

    await h.poll([PR51, PR52]);
    const next = h.store.runs()[0];
    expect(next).toMatchObject({
      trigger: { item: { number: 52 } },
      status: 'running',
      mode: 'auto',
      summary: 'Steps: review → publish: sprocket/catalog-portal#52 “Cache the catalog” by @alice.',
    });
    // It went in line without asking, and started on its own.
    expect(firstRecorded(h, next.id)?.status).toBe('queued');
    expect(h.notices).toHaveLength(1);
    expect(h.world.launches.map((launch) => launch.step?.name)).toEqual([
      'Add retries · review',
      'Cache the catalog · review',
    ]);
  });

  it('confirm waits before the first step', async () => {
    const h = await watching({
      yaml: factory(`${ON_REVIEW}    mode: confirm\n`, '- id: review\n  action: Review'),
    });
    await h.poll([PR51]);
    const [asked] = h.store.runs();
    expect(asked).toMatchObject({
      status: 'needs-approval',
      mode: 'confirm',
      summary: `Steps: review: ${PR51_LABEL}.`,
    });
    expect(await h.service.approve(asked.id)).toMatchObject({
      status: 'queued',
      steps: [{ id: 'review', status: 'pending' }],
    });
    // Approving one run of a confirm entry lets no other run alone.
    expect(h.store.acceptedVersion(KEY)).toBeUndefined();
    await h.poll([PR51, PR52]);
    expect(h.store.runs()[0]).toMatchObject({
      trigger: { item: { number: 52 } },
      status: 'needs-approval',
      mode: 'confirm',
    });
  });

  it("an agent's request always waits", async () => {
    const h = await stepsHarness({ yaml: DAILY });
    h.store.accept(KEY, automationVersion(only(DAILY)));
    const asked = (await h.service.trigger(WORKSPACE_ID, NAME, { sessionId: 's-9' }))!;
    expect(asked).toMatchObject({
      status: 'needs-approval',
      mode: 'confirm',
      trigger: { kind: 'manual', by: 'agent', actorId: 's-9' },
      summary:
        'Steps: fresh → summary in api. An agent asked for this run: approving runs this run only.',
    });
    expect(h.notices).toMatchObject([{ needsApproval: true }]);

    // A person's Run now of the same accepted version goes straight in line.
    h.service.dismiss(asked.id);
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    expect(run).toMatchObject({ mode: 'auto', trigger: { by: 'person' } });
    expect(firstRecorded(h, run.id)?.status).toBe('queued');
    expect(h.notices).toHaveLength(1);
  });

  it('notify is a dry run that asks first when it starts anything', async () => {
    const reviews = factory(
      `${ON_REVIEW}    mode: notify\n`,
      '- id: review\n  action: Review',
      '- id: publish\n  run: gh pr comment "$NUMBER" --body-file handover.md\n  env: { NUMBER: "{{item.number}}" }',
    );
    const h = await watching({ yaml: reviews });
    await h.poll([PR51]);
    const [asked] = h.store.runs();
    expect(asked).toMatchObject({ status: 'needs-approval', mode: 'confirm', dryRun: true });
    expect(asked.summary).toMatch(
      / Approve once to let this new or changed automation run on its own\.$/,
    );
    expect(await h.service.approve(asked.id)).toMatchObject({
      status: 'queued',
      mode: 'confirm',
      dryRun: true,
    });
    expect(h.store.acceptedVersion(KEY)).toBe(
      automationVersion(only(reviews), stableStringify({ review: REVIEW_BODY })),
    );
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    await h.poll([PR51, PR52]);
    const next = h.store.runs()[0];
    expect(next).toMatchObject({ trigger: { item: { number: 52 } }, mode: 'notify', dryRun: true });
    expect(firstRecorded(h, next.id)?.status).toBe('queued');

    // Only reported commands: nothing would start, so it never asks. It reports, and says what would have run.
    const reportsOnly = factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git log -1');
    const reports = await stepsHarness({ yaml: reportsOnly });
    const byPerson = (await reports.service.trigger(WORKSPACE_ID, NAME))!;
    expect(byPerson).toMatchObject({ mode: 'notify', dryRun: true });
    expect(firstRecorded(reports, byPerson.id)?.status).toBe('queued');
    const done = (runId: string) => [
      {
        title: `${NAME}: done`,
        body: 'step-1 would have run',
        runId,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ];
    expect(reports.notices).toEqual(done(byPerson.id));
    // Nor when an agent asks: a run of its own, in line.
    const asking = await stepsHarness({ yaml: reportsOnly });
    const byAgent = (await asking.service.trigger(WORKSPACE_ID, NAME, { sessionId: 's-9' }))!;
    expect(byAgent).toMatchObject({
      mode: 'notify',
      dryRun: true,
      trigger: { by: 'agent', actorId: 's-9' },
    });
    expect(firstRecorded(asking, byAgent.id)?.status).toBe('queued');
    expect(asking.notices).toEqual(done(byAgent.id));

    // A command marked to run in a dry run would start something: it asks.
    const fetches = await stepsHarness({
      yaml: factory(
        `${DAILY_IN_API}    mode: notify\n`,
        '- run: git fetch --prune\n  dry_run: run',
        '- run: git log -1',
      ),
    });
    expect(await fetches.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({
      status: 'needs-approval',
      mode: 'confirm',
      dryRun: true,
    });
  });

  it('a one-step entry under notify still starts nothing', async () => {
    const h = await watching({
      yaml: `version: 1\nautomations:\n  - name: ${NAME}\n${ON_REVIEW}    mode: notify\n    run: { action: Review }\n`,
    });
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      status: 'completed',
      mode: 'notify',
      summary: `${PR51_LABEL}. Nothing started (notify).`,
    });
    expect(run.trigger.item).toEqual({ key: PR51.key, url: PR51.url, title: 'Add retries' });
    expect(run).not.toHaveProperty('dryRun');
    expect(run).not.toHaveProperty('steps');
    expect(h.notices).toMatchObject([
      { title: NAME, body: `${PR51_LABEL}.`, needsApproval: false },
    ]);
  });

  it('an event fire snapshots the item', async () => {
    const h = await watching({ yaml: TEMPLATE });
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run.trigger).toEqual({
      kind: 'event',
      at: h.now().toISOString(),
      connection: 'github',
      events: ['pull_request.review_requested'],
      item: {
        key: PR51.key,
        url: PR51.url,
        title: 'Add retries',
        repo: 'sprocket/catalog-portal',
        number: 51,
        type: 'pr',
        author: 'alice',
      },
    });

    // #51 leaving the list and coming back while its run waits creates nothing.
    await h.poll([]);
    await h.poll([PR51]);
    expect(h.store.runs().map((candidate) => candidate.id)).toEqual([run.id]);
  });

  it('an action edited after the fire does not change what the run executes', async () => {
    const h = await watching({ yaml: TEMPLATE });
    await h.poll([PR51]);
    const [run] = h.store.runs();
    h.world.workspace.actions[0] = {
      ...h.world.workspace.actions[0],
      prompt: `${REVIEW_BODY} Be brief.`,
    };
    await h.service.syncWorkspaces();
    expect(h.folder.readDefinition(WORKSPACE_ID, run.id)).toMatchObject({
      version: run.actionVersion,
      actions: { review: { body: REVIEW_BODY } },
    });
  });

  it('a queued run is rejected when its automation changes', async () => {
    const summarise = factory(
      `${DAILY_IN_API}    mode: auto\n`,
      '- id: summary\n  prompt: Summarise what changed in api.',
    );
    // No agent slot: it waits in line.
    const h = await stepsHarness({ yaml: summarise, maxConcurrentAgents: 0 });
    const asked = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    const queued = await h.service.approve(asked.id);
    await h.flush();
    expect(h.store.get(queued.id)?.status).toBe('queued');

    await h.setYaml(
      summarise.replace(
        'Summarise what changed in api.',
        'Summarise what changed in api this week.',
      ),
    );
    h.world.maxConcurrentAgents = 2;
    // It has not started, so its approval no longer covers what it would run. The next pump (a tick's) says so.
    await h.tick();
    expect(h.store.get(queued.id)).toMatchObject({
      status: 'rejected',
      summary: 'Its automation changed since it was queued.',
      steps: [{ id: 'summary', status: 'not-run' }],
    });
    expect(h.world.launches).toEqual([]);
  });

  it('a review started by hand on the item is not done twice', async () => {
    // No agent slot, so a run that fires waits in line.
    const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 0 });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.advance(1000);
    h.world.workspace.sessions.push(byHand(PR51, h.now()));
    h.advance(1000);
    await h.poll([PR51]);
    const [rejected] = h.store.runs();
    expect(rejected).toMatchObject({
      status: 'rejected',
      summary: 'Already started by hand: “PR 51”.',
      result: { kind: 'steps-run' },
      // Ended before its first step.
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    // It never runs, so there is nothing to snapshot.
    expect(h.folder.readDefinition(WORKSPACE_ID, rejected.id)).toBeNull();

    // Nor while a run waits in line.
    await h.poll([PR51, PR52]);
    const [queued] = h.store.runs();
    expect(queued).toMatchObject({ trigger: { item: { number: 52 } }, status: 'queued' });
    h.advance(1000);
    h.world.workspace.sessions.push(byHand(PR52, h.now()));
    h.world.maxConcurrentAgents = 2;
    await h.tick();
    expect(h.store.get(queued.id)).toMatchObject({
      status: 'rejected',
      summary: 'Already started by hand: “PR 52”.',
    });
    expect(h.world.checkouts.prepared).toEqual([]);

    // Only an action step names what a session started by hand would be labelled.
    const prompted = await watching({
      yaml: factory(`${ON_REVIEW}    mode: confirm\n`, '- prompt: Review it.'),
    });
    prompted.advance(1000);
    prompted.world.workspace.sessions.push(byHand(PR51, prompted.now()));
    prompted.advance(1000);
    await prompted.poll([PR51]);
    expect(prompted.store.runs()[0]).toMatchObject({ status: 'needs-approval' });
  });

  it('records a run whose definition could not be written as failed, and the next fire is a run of its own', async () => {
    const h = await stepsHarness({ yaml: DAILY });
    // runs/ is a file: no run folder can be made under it.
    fs.mkdirSync(path.dirname(runsDir(h)), { recursive: true });
    fs.writeFileSync(runsDir(h), '');
    const failed = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    expect(failed).toMatchObject({
      status: 'failed',
      finishedAt: h.now().toISOString(),
      result: { kind: 'steps-run' },
      steps: [
        { id: 'fresh', status: 'not-run' },
        { id: 'summary', status: 'not-run' },
      ],
    });
    expect(failed.error).toMatch(/^Could not write its definition: \S.*[^.]\.$/);
    expect(h.notices).toMatchObject([
      { title: `${NAME} could not start`, needsApproval: false, runId: failed.id },
    ]);

    fs.rmSync(runsDir(h));
    const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    expect(next).toMatchObject({ status: 'needs-approval' });
    expect(next.id).not.toBe(failed.id);
    expect(h.folder.readDefinition(WORKSPACE_ID, next.id)).not.toBeNull();
  });

  it('records an item run whose definition could not be written as failed, and says so', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    fs.mkdirSync(path.dirname(runsDir(h)), { recursive: true });
    fs.writeFileSync(runsDir(h), '');
    await h.poll([PR51]);
    const [failed] = h.store.runs();
    expect(failed).toMatchObject({
      status: 'failed',
      trigger: { kind: 'event', item: { number: 51 } },
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(failed.error).toMatch(/^Could not write its definition: \S.*[^.]\.$/);
    expect(h.notices).toMatchObject([
      {
        title: `${NAME} could not start`,
        body: expect.any(String),
        runId: failed.id,
        needsApproval: false,
      },
    ]);
    expect(h.world.checkouts.prepared).toEqual([]);
    expect(h.world.launches).toEqual([]);
  });

  it.each<[string, string, StepsHarnessOptions, (h: StepsHarness) => Promise<void>]>([
    ['an agent step', SUMMARY, { maxConcurrentAgents: 0 }, (h) => h.world.endTurn('session-1')],
    [
      'commands only',
      COMMANDS_ONLY,
      { maxConcurrentCommands: 0 },
      async (h) => {
        await h.world.commands[0].end();
        await h.world.commands[1].end();
      },
    ],
  ])('a schedule keeps one steps run at a time (%s)', async (_name, yaml, noSlot, finish) => {
    // No slot in its first step's lane at first, so the run waits in line.
    const h = await stepsHarness({ yaml, ...noSlot });
    h.store.accept(KEY, automationVersion(only(yaml)));
    h.advance(HOUR);
    await h.tick();
    const [first] = h.store.runs();
    expect(first).toMatchObject({ status: 'queued', trigger: { kind: 'cron' } });

    // The next occurrence, and a Run now, while it waits in line: that run is the answer.
    h.advance(DAY);
    await h.tick();
    expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
    expect(h.store.runs()).toHaveLength(1);

    // Started, it holds its place while it runs.
    h.world.maxConcurrentAgents = undefined;
    h.world.maxConcurrentCommands = undefined;
    await h.tick();
    expect(h.store.get(first.id)).toMatchObject({
      status: 'running',
      startedAt: h.now().toISOString(),
    });
    h.advance(DAY);
    await h.tick();
    expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
    expect(h.store.runs()).toHaveLength(1);

    // Once it ends, the next fire is a run of its own.
    await finish(h);
    expect(h.store.get(first.id)?.status).toBe('completed');
    const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    expect(firstRecorded(h, next.id)?.status).toBe('queued');
    expect(next.id).not.toBe(first.id);
  });
});

const MINUTE = 60 * 1000;
/** #51's automation checkout, as the fake host places it. */
const CHECKOUT = checkoutPathFor(PR51.workItem);
const ON_REVIEW_AUTO = `${ON_REVIEW}    mode: auto\n`;
const DAILY_AUTO = `${DAILY_IN_API}    mode: auto\n`;
/** A first step that decides how the night went, and a second that writes it up. */
const ONE =
  '- id: one\n  prompt: Read what changed in api overnight.\n  outputs:\n    mood: { enum: [calm, worrying] }';
const TWO = '- id: two\n  prompt: Write up the {{steps.one.mood}} night for the team.';
const NIGHTLY = entry('nightly', DAILY_AUTO, ONE, TWO);
const WEEKLY = entry('weekly', DAILY_AUTO, '- id: digest\n  prompt: Sum up the week in api.');
/** A one-step prompt on the same schedule: a legacy agent run, in the same lane as agent steps. */
const legacy = (name: string) =>
  `  - name: ${name}\n${DAILY_AUTO}    run: { prompt: Sum up api. }\n`;
/** One prompt step on #51's review requests, under `name`. */
const look = (name: string, verb: string) =>
  entry(name, ON_REVIEW_AUTO, `- id: look\n  prompt: ${verb} {{item.url}}.`);
const TWO_LOOKS = file(look(NAME, 'Look at'), look('second-look', 'Look again at'));
/** The review, then a summary that reads its handover: two agent steps on one item. */
const PAIR = factory(
  ON_REVIEW_AUTO,
  '- id: review\n  action: Review\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }',
  '- id: summary\n  prompt: Summarise the review of {{item.url}} for the team.\n  reads: [review.handover]',
);

/** A started harness over `yaml`, every entry in it accepted, so each runs on its own. */
async function accepted(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, ...options });
  acceptEvery(h, yaml);
  return h;
}

/** The statuses of a run's steps on each line history recorded for it, repeats folded. */
function stepLines(h: StepsHarness, runId: string): string[] {
  const lines = h.history.appends
    .filter((line) => line.run.id === runId)
    .map((line) => (line.run.steps ?? []).map((step) => step.status).join(' '));
  return lines.filter((line, index) => line !== lines[index - 1]);
}

const byName = (h: StepsHarness, name: string) =>
  h.store.runs().find((run) => run.automationId === name)!;
const launched = (h: StepsHarness) =>
  h.world.launches.map((launch) => launch.step?.name ?? launch.run.automation);

describe('running a steps run', () => {
  it('two prompt steps on a schedule run one after the other in the scope folder', async () => {
    const h = await accepted(file(NIGHTLY));
    h.advance(HOUR);
    await h.tick();
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      automationId: 'nightly',
      status: 'running',
      trigger: { kind: 'cron' },
      startedAt: h.now().toISOString(),
      checkout: { cwd: '/code/api', scopeId: 'scope-api' },
    });
    const [one] = h.world.launches;
    expect(h.world.launches).toHaveLength(1);
    expect(one).toMatchObject({
      workspaceId: WORKSPACE_ID,
      run: { id: run.id, automation: 'nightly' },
      step: {
        id: 'one',
        attempt: 1,
        cwd: '/code/api',
        scopeId: 'scope-api',
        name: 'nightly · one',
      },
    });
    expect(one).not.toHaveProperty('item');
    expect(one.prompt).toContain(
      '[Consola] Step "one" (1 of 2) of the automation "nightly" (run run-1), in api. ',
    );
    expect(one.prompt).toContain('\n\nRead what changed in api overnight.\n\n');
    expect(h.store.get(run.id)!.steps).toMatchObject([
      {
        id: 'one',
        status: 'running',
        attempt: 1,
        sessionId: 'session-1',
        conversation: { harnessId: 'claude', id: 'claude-1', cwd: '/code/api' },
      },
      { id: 'two', status: 'pending' },
    ]);

    // Step two waits for one to end with its outputs.
    h.advance(MINUTE);
    const broadcasts = h.world.broadcasts.length;
    expect(h.world.setOutputs('session-1', { mood: 'calm' })).toMatchObject({ isError: false });
    await h.world.endTurn('session-1');
    const ended = h.now().toISOString();
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'completed',
      outputs: { mood: 'calm' },
      finishedAt: ended,
    });
    expect(h.store.get(run.id)!.updatedAt).toBe(ended);
    expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
    const outputsFile = path.join(
      h.folder.attemptDir(WORKSPACE_ID, run.id, 'one', 1),
      'outputs.json',
    );
    expect(JSON.parse(fs.readFileSync(outputsFile, 'utf8'))).toEqual({ mood: 'calm' });
    expect(h.world.launches[1].step).toEqual({
      id: 'two',
      attempt: 1,
      cwd: '/code/api',
      scopeId: 'scope-api',
      name: 'nightly · two',
      checkout: 'scope',
    });
    expect(h.world.launches[1].prompt).toContain('\n\nWrite up the calm night for the team.\n\n');

    await h.world.endTurn('session-2');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'one → two (calm)',
      finishedAt: ended,
    });
    expect(h.store.get(run.id)).not.toHaveProperty('sessionId');
    // The click opens the run page: there is no session to open.
    expect(h.notices).toEqual([
      {
        title: 'nightly: done',
        body: 'one → two (calm)',
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
    // Each transition is its own line, written before the next step starts.
    expect(stepLines(h, run.id)).toEqual([
      'pending pending',
      'queued pending',
      'running pending',
      'completed pending',
      'completed queued',
      'completed running',
      'completed completed',
    ]);
  });

  it('if: false skips, a failure makes later steps not-run', async () => {
    const yaml = file(
      entry(
        'nightly',
        DAILY_AUTO,
        ONE,
        "- id: alarm\n  if: steps.one.mood == 'worrying'\n  prompt: Say what is worrying.",
        '- id: two\n  prompt: Write up the night.',
        '- id: three\n  prompt: File the write-up.',
      ),
    );
    const h = await accepted(yaml);
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1');
    expect(h.store.get(run.id)!.steps).toMatchObject([
      { id: 'one', status: 'completed' },
      { id: 'alarm', status: 'skipped', skipped: "if: steps.one.mood == 'worrying' is false" },
      { id: 'two', status: 'running', sessionId: 'session-2' },
      { id: 'three', status: 'pending' },
    ]);
    // The skip is recorded on its own, before the next step is queued.
    expect(stepLines(h, run.id)).toContain('completed skipped pending pending');

    await h.world.endTurn('session-2', { exitCode: 1, lastLine: 'Rate limited.' });
    const error = 'It stopped before finishing (exit 1): Rate limited.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'completed' },
        { id: 'alarm', status: 'skipped' },
        { id: 'two', status: 'failed', error },
        { id: 'three', status: 'not-run' },
      ],
    });
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
    expect(h.notices).toEqual([
      {
        title: 'nightly did not finish',
        body: error,
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
  });

  it('a step that ends without what it declares fails, saying what is missing', async () => {
    const yaml = file(entry('nightly', DAILY_AUTO, `${ONE}\n  artifacts: [notes]`, TWO));
    const h = await accepted(yaml);
    const nothing = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    // Once reminded, and still without, it fails.
    await h.world.endTurn('session-1');
    await h.world.endTurn('session-1');
    expect(h.store.get(nothing.id)).toMatchObject({
      status: 'failed',
      error: 'ended without setting mood, and without writing notes',
      steps: [
        { id: 'one', status: 'failed' },
        { id: 'two', status: 'not-run' },
      ],
    });
    // Its outputs are written only for an attempt that has them all.
    expect(
      fs.existsSync(
        path.join(h.folder.attemptDir(WORKSPACE_ID, nothing.id, 'one', 1), 'outputs.json'),
      ),
    ).toBe(false);

    const noNotes = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-2', { mood: 'calm' });
    await h.world.endTurn('session-2');
    await h.world.endTurn('session-2');
    expect(h.store.get(noNotes.id)).toMatchObject({
      status: 'failed',
      error: 'ended without writing notes',
    });

    // A stop is told in the words a one-step run uses.
    const stopped = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-3', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(stopped.id)).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing: you stopped it.',
    });
  });

  it('a step session finds its step tools when its CLI first connects', async () => {
    const h = await accepted(file(NIGHTLY));
    const seen: unknown[] = [];
    // Inside the launch: the session is on the record, and its CLI is about to ask for its tools.
    h.world.onLaunch = (request, session) => {
      seen.push({
        declaration: h.service.stepIO().declaration(session.id),
        step: h.store.get(request.run.id)?.steps?.[0].status,
        written: !h.world.setOutputs(session.id, { mood: 'calm' }).isError,
      });
    };
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    await h.flush();
    expect(seen).toEqual([
      {
        declaration: {
          outputs: { mood: { type: 'enum', values: ['calm', 'worrying'] } },
          writable: ['handover'],
        },
        step: 'running',
        written: true,
      },
    ]);
  });

  it('a step whose working folder is gone fails before it launches', async () => {
    const h = await accepted(file(NIGHTLY));
    h.world.goneFolders.add('/code/api');
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const error = 'Its working folder is gone: /code/api.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'failed', error },
        { id: 'two', status: 'not-run' },
      ],
    });
    expect(h.world.launches).toEqual([]);
  });

  it('an item run prepares its automation checkout once and records head', async () => {
    const h = await watching({ yaml: PAIR });
    acceptEvery(h, PAIR);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.world.checkouts.prepared).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        workItem: PR51.workItem,
        startedByHand: { label: 'Review', since: run.createdAt },
      },
    ]);
    expect(run).toMatchObject({
      status: 'running',
      checkout: { cwd: CHECKOUT, scopeId: 'scope-catalog-portal', head: CHECKOUT_HEAD },
    });

    h.world.setOutputs('session-1', { verdict: 'comment' });
    h.world.writeArtifact('session-1', 'handover', 'Two retries are unbounded.');
    await h.world.endTurn('session-1');
    expect(h.world.checkouts.prepared).toHaveLength(1);
    // Every step names the run's own checkout as its folder, so the host never prepares the Inbox's worktree for it.
    expect(h.world.launches.map((launch) => launch.step?.cwd)).toEqual([CHECKOUT, CHECKOUT]);
    const summary = h.world.launches[1];
    expect(summary).toMatchObject({
      step: {
        id: 'summary',
        attempt: 1,
        cwd: CHECKOUT,
        scopeId: 'scope-catalog-portal',
        name: 'Add retries · summary',
      },
      item: { workItem: PR51.workItem, title: 'Add retries', label: NAME },
    });
    // Only the first agent step, an action, is what a person may have started by hand; a prompt step has no group.
    expect(summary.item).not.toHaveProperty('startedByHandSince');
    expect(summary.item).not.toHaveProperty('groupId');
    expect(summary.prompt).toContain(
      '\n\nSummarise the review of https://github.com/sprocket/catalog-portal/pull/51 for the team.\n\n',
    );
    expect(summary.prompt).toContain('\n  - review.handover (from step "review", 26 B)\n');

    await h.world.endTurn('session-2');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'review → summary (comment)',
      checkout: { head: CHECKOUT_HEAD },
    });
  });

  it("an action step renders the action's placeholders with the title pointed at the fence, and carries its name and group", async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    const [review] = h.world.launches;
    expect(review).toMatchObject({
      workspaceId: WORKSPACE_ID,
      run: { id: run.id, automation: NAME },
      item: {
        workItem: PR51.workItem,
        title: 'Add retries',
        label: 'Review',
        groupId: 'g-1',
        startedByHandSince: run.createdAt,
      },
      step: {
        id: 'review',
        attempt: 1,
        cwd: CHECKOUT,
        scopeId: 'scope-catalog-portal',
        name: 'Add retries · review',
      },
    });
    const sections = review.prompt.split('\n\n');
    expect(sections[0]).toMatch(
      /^\[Consola\] Step "review" \(1 of 2\) of the automation "review-assigned-prs" \(run run-1\), for pull request #51 in sprocket\/catalog-portal \(https:\/\/github\.com\/sprocket\/catalog-portal\/pull\/51\), in a dedicated git worktree for it\. /,
    );
    expect(sections[1]).toBe(
      'Review the title quoted below and say what should change before it merges.',
    );
    expect(review.prompt).toMatch(
      /\n<untrusted-data>\ntitle: "Add retries"\nauthor: "alice"\n<\/untrusted-data>$/,
    );
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'running',
      sessionId: 'session-1',
      conversation: { harnessId: 'claude', id: 'claude-1', cwd: CHECKOUT },
    });
  });

  it('a run reads its item as it is when it starts', async () => {
    const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 0 });
    h.store.accept(KEY, TEMPLATE_VERSION);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    await h.poll([{ ...PR51, title: 'Add retries with backoff', author: 'bob' }]);
    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(h.store.get(run.id)!.trigger.item).toMatchObject({
      number: 51,
      title: 'Add retries with backoff',
      author: 'bob',
    });
    expect(h.world.launches[0]).toMatchObject({
      item: { title: 'Add retries with backoff' },
      step: { name: 'Add retries with backoff · review' },
    });
    expect(h.world.launches[0].prompt).toMatch(
      /\ntitle: "Add retries with backoff"\nauthor: "bob"\n/,
    );
  });

  it("checkout: { pr: item } names the item's automation checkout, and runs exactly as without it (Call 15)", async () => {
    const LOOK = '- id: look\n  prompt: Look at {{item.url}}.';
    const runOn51 = async (yaml: string) => {
      const h = await watching({ yaml });
      acceptEvery(h, yaml);
      expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
      await h.poll([PR51]);
      const [run] = h.store.runs();
      return { h, run };
    };
    const without = await runOn51(factory(ON_REVIEW_AUTO, LOOK));
    const named = await runOn51(factory(`${ON_REVIEW_AUTO}    checkout: { pr: item }\n`, LOOK));
    expect(named.run).toMatchObject({
      status: 'running',
      checkout: { cwd: CHECKOUT, scopeId: 'scope-catalog-portal', head: CHECKOUT_HEAD },
    });
    expect(named.run.checkout).toEqual(without.run.checkout);
    expect(named.h.world.checkouts.prepared).toEqual(without.h.world.checkouts.prepared);
    expect(named.h.world.launches.map((launch) => launch.step?.cwd)).toEqual([CHECKOUT]);
    // The key is in the version, so the entry that writes it is approved apart.
    expect(named.run.actionVersion).not.toBe(without.run.actionVersion);
  });

  it('a checkout failure fails the run before its first step, saying why', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    const why =
      "A full-tools session was launched in this item's automation checkout (“PR 51”), so Consola will not move it. Delete that session, then retry.";
    h.world.checkouts.fails = new Error(why);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      status: 'failed',
      error: why,
      checkout: { cwd: CHECKOUT },
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(run.checkout).not.toHaveProperty('head');
    expect(h.world.launches).toEqual([]);
    expect(h.notices).toEqual([
      {
        title: `${NAME} could not start`,
        body: why,
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
  });

  it('a review started by hand while the run was getting ready is not done twice', async () => {
    // At the launch: the first step, an action, asks the host to look under the lock an Inbox click takes.
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.world.launchThrows = new StartedByHandError('PR 51');
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.world.launches).toMatchObject([
      { item: { label: 'Review', startedByHandSince: run.createdAt } },
    ]);
    const rejected = {
      status: 'rejected',
      summary: 'Already started by hand: “PR 51”.',
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    };
    expect(h.store.get(run.id)).toMatchObject(rejected);
    expect(h.notices).toEqual([]);

    // At the preparation: the checkout refuses under the same lock.
    const preparing = await watching({ yaml: TEMPLATE });
    preparing.store.accept(KEY, TEMPLATE_VERSION);
    preparing.world.checkouts.fails = new StartedByHandError('PR 51');
    await preparing.poll([PR51]);
    expect(preparing.store.runs()[0]).toMatchObject(rejected);
    expect(preparing.world.launches).toEqual([]);
    expect(preparing.notices).toEqual([]);
  });

  it('a second run on the same item waits for the checkout, then prepares it afresh', async () => {
    const h = await watching({ yaml: TWO_LOOKS });
    acceptEvery(h, TWO_LOOKS);
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    expect(first.status).toBe('running');
    expect(second).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
    expect(h.world.checkouts.prepared).toHaveLength(1);
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id]);
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [second.id]: 1 });

    // Waiting is written when it starts, not at every look.
    const lines = h.history.appends.length;
    await h.tick();
    expect(h.history.appends.length).toBe(lines);

    await h.world.endTurn('session-1');
    expect(h.store.get(first.id)?.status).toBe('completed');
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(second.id)).toMatchObject({
      status: 'running',
      summary: `Steps: look: ${PR51_LABEL}.`,
      checkout: { cwd: CHECKOUT, head: CHECKOUT_HEAD },
    });
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id, second.id]);
  });

  it('a run still preparing its checkout holds it', async () => {
    const h = await watching({ yaml: TWO_LOOKS });
    acceptEvery(h, TWO_LOOKS);
    let release!: () => void;
    h.world.checkouts.gate = new Promise((resolve) => (release = resolve));
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    expect(h.world.checkouts.prepared).toHaveLength(1);
    // Claimed before the fetch: the record names the folder, not yet the commit.
    expect(first).toMatchObject({ status: 'running', checkout: { cwd: CHECKOUT } });
    expect(first.checkout).not.toHaveProperty('head');
    expect(second).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
    expect(h.world.launches).toEqual([]);

    h.world.checkouts.gate = undefined;
    release();
    await h.flush();
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id]);
    expect(h.world.checkouts.prepared).toHaveLength(1);
    expect(h.store.get(second.id)?.status).toBe('queued');

    await h.world.endTurn('session-1');
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id, second.id]);
  });

  it("a session running in the item's checkout holds it too", async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.world.busyFolders.add(CHECKOUT);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
    expect(h.world.checkouts.prepared).toEqual([]);

    h.world.busyFolders.clear();
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      summary: `Steps: review → publish: ${PR51_LABEL}.`,
    });
    expect(h.world.checkouts.prepared).toHaveLength(1);
  });

  it('a working run holds its checkout, whichever workspace it is in', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    // Its preparation never ends: it stays started and unfinished.
    h.world.checkouts.gate = new Promise(() => {});
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(false);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);
    // By its item too, wherever the folder is.
    expect(h.service.checkoutHeld('/elsewhere', PR51.key)).toBe(true);
    expect(h.service.checkoutHeld('/elsewhere')).toBe(false);
    expect(h.service.checkoutHeld(checkoutPathFor(PR52.workItem), PR52.key)).toBe(false);

    // One service serves every workspace, and the folder is one per item: another workspace's run holds it as well.
    h.store.add({
      ...structuredClone(run),
      id: 'run-ws-2',
      attribution: { ...run.attribution, workspaceId: 'ws-2' },
    });
    h.store.update(run.id, { status: 'failed', finishedAt: h.now().toISOString() });
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);
    h.store.update('run-ws-2', { status: 'completed', finishedAt: h.now().toISOString() });
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(false);
  });

  it('a started run goes ahead of runs that have not started', async () => {
    const yaml = file(NIGHTLY, WEEKLY);
    const h = await accepted(yaml, { maxConcurrentAgents: 1 });
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    await h.flush();
    expect(h.store.get(weekly.id)?.status).toBe('queued');

    h.world.setOutputs('session-1', { mood: 'worrying' });
    await h.world.endTurn('session-1');
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
    expect(h.store.get(weekly.id)?.status).toBe('queued');

    await h.world.endTurn('session-2');
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two', 'weekly · digest']);
  });

  it('each lane numbers its own line, legacy runs and steps alike: started runs first, then the rest as they joined', async () => {
    const yaml = file(NIGHTLY, WEEKLY, legacy('legacy'), legacy('legacy-two'));
    const h = await accepted(yaml);
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    const legacyRun = (await h.service.trigger(WORKSPACE_ID, 'legacy'))!;
    await h.flush();
    expect(launched(h)).toEqual(['nightly · one', 'legacy']);

    // One slot from here on: both of those are working, so what comes next waits.
    h.world.maxConcurrentAgents = 1;
    h.advance(MINUTE);
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    h.advance(MINUTE);
    const legacyTwo = (await h.service.trigger(WORKSPACE_ID, 'legacy-two'))!;
    h.advance(MINUTE);
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1');
    // Nightly has started, so its next step is first in line.
    expect(h.store.get(nightly.id)!.steps).toMatchObject([
      { status: 'completed' },
      { status: 'queued' },
    ]);
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({
      [nightly.id]: 1,
      [weekly.id]: 2,
      [legacyTwo.id]: 3,
    });

    await h.world.endTurn('session-2');
    expect(h.store.get(legacyRun.id)?.status).toBe('completed');
    expect(launched(h)).toEqual(['nightly · one', 'legacy', 'nightly · two']);
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [weekly.id]: 1, [legacyTwo.id]: 2 });
  });

  it('a started run finishes on its snapshot; a queued run of the old version is rejected', async () => {
    const yaml = factory(
      ON_REVIEW_AUTO,
      '- id: one\n  prompt: Look at {{item.url}}.',
      '- id: two\n  prompt: Write up {{item.url}}.',
    );
    const h = await watching({ yaml, maxConcurrentAgents: 1 });
    acceptEvery(h, yaml);
    await h.poll([PR51, PR52]);
    const started = h.store.runs().find((run) => run.trigger.item?.number === 51)!;
    const waiting = h.store.runs().find((run) => run.trigger.item?.number === 52)!;
    expect(waiting.status).toBe('queued');

    await h.setYaml(yaml.replace('Write up {{item.url}}.', 'Write up {{item.url}} in one line.'));
    await h.world.endTurn('session-1');
    expect(launched(h)).toEqual(['Add retries · one', 'Add retries · two']);
    expect(h.world.launches[1].prompt).toContain(
      '\n\nWrite up https://github.com/sprocket/catalog-portal/pull/51.\n\n',
    );

    await h.world.endTurn('session-2');
    expect(h.store.get(started.id)?.status).toBe('completed');
    expect(h.store.get(waiting.id)).toMatchObject({
      status: 'rejected',
      summary: 'Its automation changed since it was queued.',
      steps: [
        { id: 'one', status: 'not-run' },
        { id: 'two', status: 'not-run' },
      ],
    });
    expect(h.world.launches).toHaveLength(2);
  });

  it('a session closed mid-step fails the step and frees its slot', async () => {
    const yaml = file(NIGHTLY, WEEKLY);
    const h = await accepted(yaml, { maxConcurrentAgents: 1 });
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    await h.flush();
    h.world.workspace.sessions = h.world.workspace.sessions.filter(
      (session) => session.id !== 'session-1',
    );
    await h.service.syncWorkspaces();
    await h.flush();
    const error = 'Its session was closed before it finished.';
    expect(h.store.get(nightly.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'failed', error },
        { id: 'two', status: 'not-run' },
      ],
    });
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
    expect(h.store.get(weekly.id)?.status).toBe('running');
    // The person closed it: as for a one-step run, nothing to tell them.
    expect(h.notices).toEqual([]);
  });

  it('a missing definition fails the run', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const folder = h.folder.runDir(WORKSPACE_ID, run.id);
    fs.rmSync(path.join(folder, 'definition.json'));
    await h.service.syncWorkspaces();
    const error = `Its definition is gone from ${folder}; it cannot continue.`;
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'failed', error },
        { id: 'two', status: 'not-run' },
      ],
    });
    expect(h.notices).toEqual([
      {
        title: 'nightly did not finish',
        body: error,
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
    // Its turn ending afterwards changes nothing.
    await h.world.endTurn('session-1');
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error });
  });

  it('a definition that cannot be read for now leaves a started run as it is', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const definition = path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json');
    const text = fs.readFileSync(definition, 'utf8');
    fs.writeFileSync(definition, 'not json');
    await h.service.syncWorkspaces();
    // Only a definition that is gone ends it; one that fails to read is logged, and the run waits.
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        { id: 'one', status: 'running', sessionId: 'session-1' },
        { id: 'two', status: 'pending' },
      ],
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(run.id), expect.any(Error));
    expect(h.notices).toEqual([]);

    // Readable again, it goes on.
    fs.writeFileSync(definition, text);
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1');
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
  });

  it('a steps run starts only into a free slot, and the line keeps its order', async () => {
    const look = (name: string) => entry(name, DAILY_AUTO, '- id: one\n  prompt: Look at api.');
    const yaml = file(legacy('first'), look('a'), look('b'), legacy('l'));
    const h = await accepted(yaml, { maxConcurrentAgents: 1 });
    await h.service.trigger(WORKSPACE_ID, 'first');
    h.advance(1000);
    const a = (await h.service.trigger(WORKSPACE_ID, 'a'))!;
    h.advance(1000);
    const b = (await h.service.trigger(WORKSPACE_ID, 'b'))!;
    h.advance(1000);
    const l = (await h.service.trigger(WORKSPACE_ID, 'l'))!;
    await h.flush();
    expect(launched(h)).toEqual(['first']);

    // One slot frees: the first in line takes it, and nothing else starts.
    await h.world.endTurn('session-1');
    expect(launched(h)).toEqual(['first', 'a · one']);
    expect(h.store.get(a.id)!.steps).toMatchObject([{ id: 'one', status: 'running' }]);
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [b.id]: 1, [l.id]: 2 });
    for (const waiting of [b, l]) expect(h.store.get(waiting.id)?.status).toBe('queued');
    expect(h.store.get(b.id)).not.toHaveProperty('startedAt');
    // No run holds `running` without a step working.
    const running = h.store.runs().filter((run) => run.status === 'running' && run.steps);
    expect(running.every((run) => run.steps!.some((step) => step.status === 'running'))).toBe(true);
  });

  it("a started run's next step goes ahead of a run that has not started, even one queued while a launch was awaited", async () => {
    const monthly = entry(
      'monthly',
      DAILY_AUTO,
      '- id: digest\n  prompt: Sum up the month in api.',
    );
    const h = await accepted(file(NIGHTLY, WEEKLY, monthly), { maxConcurrentAgents: 1 });
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    h.advance(1000);
    await h.service.trigger(WORKSPACE_ID, 'weekly');
    h.advance(1000);
    const waiting = (await h.service.trigger(WORKSPACE_ID, 'monthly'))!;
    await h.flush();
    expect(launched(h)).toEqual(['nightly · one']);

    // A second slot: weekly starts, and while its step launches, nightly's first step
    // ends, freeing a slot and queueing its second. That one is first in line.
    h.world.onLaunch = (request) => {
      if (request.run.automation !== 'weekly') return;
      h.world.setOutputs('session-1', { mood: 'calm' });
      h.service.turnEnded('session-1', { exitCode: 0 });
    };
    h.world.maxConcurrentAgents = 2;
    await h.tick();
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest', 'nightly · two']);
    expect(h.store.get(waiting.id)?.status).toBe('queued');
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [waiting.id]: 1 });
  });

  it('after a restart an interrupted agent step resumes in its session, ahead in line and holding its slot', async () => {
    const yaml = file(NIGHTLY, WEEKLY);
    let h = await accepted(yaml, { maxConcurrentAgents: 1 });
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    h.world.writeArtifact('session-1', 'handover', 'A quiet night.');
    h = await h.relaunch();
    // Picked up where it was: its session, its attempt, what it set and wrote.
    expect(h.world.resumes).toEqual([{ sessionId: 'session-1', prompt: INTERRUPTED_PROMPT }]);
    expect(launched(h)).toEqual(['nightly · one']);
    expect(h.store.get(nightly.id)).toMatchObject({
      status: 'running',
      steps: [
        {
          id: 'one',
          status: 'running',
          attempt: 1,
          sessionId: 'session-1',
          outputs: { mood: 'calm' },
          artifacts: [{ name: 'handover' }],
        },
        { id: 'two', status: 'pending' },
      ],
    });
    expect(h.store.get(nightly.id)!.steps![0]).not.toHaveProperty('previous');

    // It holds the only slot: another run waits, and its next step goes first.
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    await h.flush();
    expect(h.store.get(weekly.id)?.status).toBe('queued');
    await h.world.endTurn('session-1');
    expect(h.store.get(nightly.id)!.steps![0]).toMatchObject({
      status: 'completed',
      outputs: { mood: 'calm' },
    });
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
    expect(h.world.launches[1].prompt).toContain('\n\nWrite up the calm night for the team.\n\n');
  });

  it('an attempt set running names no earlier session until its own launches', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    // No slot when one ends, so two waits in line.
    h.world.maxConcurrentAgents = 0;
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1');
    // As an earlier execution would leave it: a conversation on the record.
    const stale = { harnessId: 'claude', id: 'claude-1', cwd: '/code/api' };
    h.store.update(run.id, {
      steps: h.store
        .get(run.id)!
        .steps!.map((step) => (step.id === 'two' ? { ...step, conversation: stale } : step)),
    });
    const seen: unknown[] = [];
    h.world.onLaunch = () => {
      // The earlier session's turn ending while this one launches settles nothing.
      h.service.turnEnded('session-1', { exitCode: 0 });
      seen.push(h.store.get(run.id)!.steps![1]);
    };
    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 'two', status: 'running' });
    expect(seen[0]).not.toHaveProperty('conversation');
    expect(seen[0]).not.toHaveProperty('sessionId');
    expect(h.store.get(run.id)!.steps![1]).toMatchObject({
      status: 'running',
      sessionId: 'session-2',
      conversation: { id: 'claude-2' },
    });
  });

  it('a run that cannot go on once its checkout is prepared fails, and the line moves on', async () => {
    const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 1 });
    h.store.accept(KEY, TEMPLATE_VERSION);
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', listener);
    onTestFinished(() => {
      process.off('unhandledRejection', listener);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    let release!: () => void;
    h.world.checkouts.gate = new Promise((resolve) => (release = resolve));
    await h.poll([PR51, PR52]);
    const first = h.store.runs().find((run) => run.trigger.item?.number === 51)!;
    const second = h.store.runs().find((run) => run.trigger.item?.number === 52)!;
    expect(second.status).toBe('queued');

    // While it prepares, its definition becomes one Consola cannot run.
    fs.writeFileSync(path.join(h.folder.runDir(WORKSPACE_ID, first.id), 'definition.json'), '{}');
    h.world.checkouts.gate = undefined;
    release();
    await h.flush();
    expect(h.store.get(first.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/\S/),
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(escaped).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(first.id), expect.any(Error));
    // The pump ran again: #52 has the slot now.
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(second.id)?.status).toBe('running');
  });
});

/** The shipped review template, shortened: fresh asks whether a review is needed, then the review, then the post. */
const FRESH =
  '- id: fresh\n  run: echo "needed=true" >> "$CONSOLA_OUTPUT"\n  env: { PR: "{{item.url}}" }\n  outputs: { needed: boolean }\n  dry_run: run';
const REVIEW_IT =
  '- id: review\n  if: steps.fresh.needed\n  prompt: Review this pull request and write the review as your handover.\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }';
const POST =
  `- id: publish\n  if: steps.fresh.needed\n  run: ${PUBLISH}\n` +
  '  env: { REPO: "{{item.repo}}", NUMBER: "{{item.number}}", VERDICT: "{{steps.review.verdict}}", BODY_FILE: "{{steps.review.handover.file}}" }';
const REVIEWS = (mode: string) =>
  factory(`${ON_REVIEW}    mode: ${mode}\n`, FRESH, REVIEW_IT, POST);
/** What publish's command.json says it runs with: the rendered `env:` and nothing else. */
const PUBLISH_ENV = (h: StepsHarness, runId: string) => [
  { name: 'REPO', template: '{{item.repo}}', value: 'sprocket/catalog-portal' },
  { name: 'NUMBER', template: '{{item.number}}', value: '51' },
  { name: 'VERDICT', template: '{{steps.review.verdict}}', value: 'request-changes' },
  {
    name: 'BODY_FILE',
    template: '{{steps.review.handover.file}}',
    value: h.folder.artifactPath(WORKSPACE_ID, runId, 'review', 1, 'handover'),
  },
];

/** An item run of `yaml` on #51, accepted, its first command started. */
async function onPr51(yaml: string): Promise<{ h: StepsHarness; run: RunRecord }> {
  const h = await watching({ yaml });
  acceptEvery(h, yaml);
  await h.poll([PR51]);
  return { h, run: h.store.runs()[0] };
}

/** The review step of `REVIEWS` ends: its verdict set, its handover written. */
async function reviewed(
  h: StepsHarness,
  sessionId: string,
  handover = 'Two retries are unbounded.',
): Promise<void> {
  h.world.setOutputs(sessionId, { verdict: 'request-changes' });
  h.world.writeArtifact(sessionId, 'handover', handover);
  await h.world.endTurn(sessionId);
}

type FakeCommandEnd = FakeCommand['end'];

const commandFile = (h: StepsHarness, runId: string, stepId: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(h.folder.attemptDir(WORKSPACE_ID, runId, stepId, 1), 'command.json'),
      'utf8',
    ),
  );

describe('command steps', () => {
  it("outputs flow into the next command's env, and CONSOLA_ variables are set", async () => {
    const { h, run } = await onPr51(REVIEWS('auto'));
    const freshDir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'fresh', 1);
    const [fresh] = h.world.commands;
    expect(h.world.commands).toHaveLength(1);
    expect(fresh.spec).toMatchObject({
      command: 'echo "needed=true" >> "$CONSOLA_OUTPUT"',
      cwd: CHECKOUT,
      timeoutMs: 600_000,
      stdoutPath: path.join(freshDir, 'stdout.log'),
      stderrPath: path.join(freshDir, 'stderr.log'),
      secrets: ['gho_stub'],
    });
    // The login env and the token, the rendered env:, Consola's variables, then git hooks off.
    expect(fresh.spec.env).toEqual({
      PATH: '/bin',
      GH_TOKEN: 'gho_stub',
      PR: PR51.url,
      CONSOLA_OUTPUT: path.join(freshDir, 'outputs.env'),
      CONSOLA_RUN_ID: run.id,
      CONSOLA_STEP: 'fresh',
      CONSOLA_CHECKOUT_HEAD: CHECKOUT_HEAD,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    });
    // Its $CONSOLA_OUTPUT is there, empty, when it starts.
    expect(fs.readFileSync(path.join(freshDir, 'outputs.env'), 'utf8')).toBe('');
    expect(commandFile(h, run.id, 'fresh')).toEqual({
      cwd: CHECKOUT,
      command: 'echo "needed=true" >> "$CONSOLA_OUTPUT"',
      env: [{ name: 'PR', template: '{{item.url}}', value: PR51.url }],
    });

    h.advance(MINUTE);
    const broadcasts = h.world.broadcasts.length;
    const said = 'Asked for the latest review.\n';
    await fresh.end({ outputs: 'needed=true\n', stdout: said });
    const ended = h.now().toISOString();
    expect(h.store.get(run.id)!.steps![0]).toEqual({
      id: 'fresh',
      kind: 'run',
      status: 'completed',
      attempt: 1,
      queuedAt: run.createdAt,
      startedAt: run.createdAt,
      finishedAt: ended,
      outputs: { needed: true },
      command: {
        envNames: ['PR'],
        intentAt: run.createdAt,
        exitCode: 0,
        stdoutBytes: said.length,
        stderrBytes: 0,
        truncated: false,
      },
    });
    expect(h.store.get(run.id)!.updatedAt).toBe(ended);
    expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
    expect(JSON.parse(fs.readFileSync(path.join(freshDir, 'outputs.json'), 'utf8'))).toEqual({
      needed: true,
    });
    expect(launched(h)).toEqual(['Add retries · review']);

    await reviewed(h, 'session-1');
    const publish = h.world.commands[1];
    expect(publish.spec.command).toBe(PUBLISH);
    expect(publish.spec.env).toMatchObject({
      REPO: 'sprocket/catalog-portal',
      NUMBER: '51',
      VERDICT: 'request-changes',
      BODY_FILE: h.folder.artifactPath(WORKSPACE_ID, run.id, 'review', 1, 'handover'),
      CONSOLA_CHECKOUT_HEAD: h.store.get(run.id)!.checkout!.head,
      CONSOLA_RUN_ID: run.id,
      CONSOLA_STEP: 'publish',
      GH_TOKEN: 'gho_stub',
    });
    expect(publish.spec.secrets).toEqual(['gho_stub']);
    // command.json holds the rendered env: only, never the login env or the token.
    expect(commandFile(h, run.id, 'publish')).toEqual({
      cwd: CHECKOUT,
      command: PUBLISH,
      env: PUBLISH_ENV(h, run.id),
    });
    expect(JSON.stringify(commandFile(h, run.id, 'publish'))).not.toMatch(/gho_stub|GH_TOKEN|PATH/);

    await publish.end();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'fresh → review → publish (request-changes)',
    });
    expect(h.world.commandEnvAsked).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    // Each transition its own line; a command's result is written with its status, never after it.
    expect(stepLines(h, run.id)).toEqual([
      'pending pending pending',
      'queued pending pending',
      'running pending pending',
      'completed pending pending',
      'completed queued pending',
      'completed running pending',
      'completed completed pending',
      'completed completed queued',
      'completed completed running',
      'completed completed completed',
    ]);
    const resultWhileRunning = h.history.appends.some(({ run: line }) =>
      line.steps?.some((step) => step.status === 'running' && step.command?.exitCode !== undefined),
    );
    expect(resultWhileRunning).toBe(false);
  });

  it('intent is on disk before the spawn', async () => {
    const h = await accepted(COMMANDS_ONLY);
    const durable: RunRecord[] = [];
    const appendDurably = h.history.appendDurably;
    h.history.appendDurably = (workspaceId, run, live) => {
      appendDurably(workspaceId, run, live);
      durable.push(structuredClone(run));
    };
    const seen: unknown[] = [];
    h.world.onCommand = (spec) => {
      const run = h.store.get(String(spec.env.CONSOLA_RUN_ID))!;
      seen.push({ step: run.steps![0], durable: durable.at(-1)?.steps?.[0] });
    };
    await h.service.trigger(WORKSPACE_ID, NAME);
    await h.flush();
    const at = h.now().toISOString();
    const intent = {
      id: 'fresh',
      status: 'running',
      startedAt: at,
      command: { envNames: [], intentAt: at },
    };
    expect(seen).toEqual([
      { step: expect.objectContaining(intent), durable: expect.objectContaining(intent) },
    ]);
    expect(durable).toHaveLength(1);
  });

  it('a failed intent write spawns nothing', async () => {
    const h = await accepted(COMMANDS_ONLY);
    h.history.failDurable = new Error('No space left on device.');
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    const error =
      'Could not record that it was about to run (No space left on device); nothing ran.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'fresh', status: 'failed', error },
        { id: 'log', status: 'not-run' },
      ],
    });
    // No intent on the record: nothing may have run.
    expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('command');
    expect(h.world.commands).toEqual([]);
  });

  describe('from: stdout', () => {
    const fetchThenRead = (format: string) =>
      factory(
        ON_REVIEW_AUTO,
        `- id: fetch\n  run: gh pr view "$PR" --json files\n  env: { PR: "{{item.url}}" }\n  outputs: { from: stdout, format: ${format} }`,
        '- id: summary\n  prompt: Summarise the files {{item.url}} changes.\n  reads: [fetch.output]',
      );
    const FILES = '{"files":[{"path":"src/retry.ts"}]}\n';

    it('JSON stdout becomes artifact output, which a later step reads', async () => {
      const { h, run } = await onPr51(fetchThenRead('json'));
      await h.world.commands[0].end({ stdout: FILES });
      expect(h.store.get(run.id)!.steps![0]).toMatchObject({
        status: 'completed',
        artifacts: [{ name: 'output', bytes: FILES.length }],
      });
      expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('outputs');
      const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'fetch', 1);
      expect(fs.readFileSync(path.join(dir, 'output.json'), 'utf8')).toBe(FILES);
      expect(h.folder.readArtifact(WORKSPACE_ID, run.id, 'fetch', 1, 'output')).toBe(FILES);
      expect(h.world.launches[0].prompt).toContain(
        `\n  - fetch.output (from step "fetch", ${FILES.length} B)\n`,
      );
    });

    it('text stdout likewise, as the masked log holds it', async () => {
      const { h, run } = await onPr51(fetchThenRead('text'));
      await h.world.commands[0].end({ stdout: 'src/retry.ts\nauthorised as gho_stub\n' });
      expect(h.store.get(run.id)!.steps![0]).toMatchObject({
        status: 'completed',
        artifacts: [{ name: 'output' }],
      });
      const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'fetch', 1);
      expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe(
        'src/retry.ts\nauthorised as ***\n',
      );
      expect(h.world.launches[0].prompt).toContain('\n  - fetch.output (from step "fetch", ');
    });

    it.each<[string, string, Parameters<FakeCommandEnd>[0], RegExp]>([
      [
        'stdout that is not JSON',
        'json',
        { stdout: 'Not Found (gho_stub)\n\x1b[31m' },
        /^Its stdout is not JSON \([^\x00-\x1f]+\)\.$/,
      ],
      [
        'stdout over the 256 KB an output holds',
        'text',
        { stdout: 'x'.repeat(256 * 1024 + 1) },
        /^Its stdout is over 256 KB, the most an output may hold\.$/,
      ],
      [
        'a log that was cut short',
        'json',
        { stdout: FILES, result: { truncated: true } },
        /^Its logs were cut short, so its stdout may not be whole\.$/,
      ],
    ])('%s fails the step', async (_name, format, how, error) => {
      const { h, run } = await onPr51(fetchThenRead(format));
      await h.world.commands[0].end(how);
      expect(h.store.get(run.id)).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(error),
        steps: [
          { id: 'fetch', status: 'failed' },
          { id: 'summary', status: 'not-run' },
        ],
      });
      expect(JSON.stringify(h.store.get(run.id))).not.toContain('gho_stub');
      expect(h.world.launches).toEqual([]);
    });
  });

  describe('fails before starting, with nothing run', () => {
    /** The run, its fresh step completed and its review handed over, with no command slot left for publish. */
    async function upToPublish(handover?: string) {
      const { h, run } = await onPr51(REVIEWS('auto'));
      await h.world.commands[0].end({ outputs: 'needed=true\n' });
      h.world.maxConcurrentCommands = 0;
      await reviewed(h, 'session-1', handover);
      expect(h.store.get(run.id)!.steps![2]).toMatchObject({ id: 'publish', status: 'queued' });
      return { h, run };
    }
    const failedAtPublish = (error: string) => ({
      status: 'failed',
      error,
      steps: [
        { status: 'completed' },
        { status: 'completed' },
        { id: 'publish', status: 'failed', error },
      ],
    });

    it('an absent value', async () => {
      const { h, run } = await upToPublish();
      fs.rmSync(h.folder.artifactPath(WORKSPACE_ID, run.id, 'review', 1, 'handover'));
      h.world.maxConcurrentCommands = undefined;
      await h.tick();
      expect(h.store.get(run.id)).toMatchObject(
        failedAtPublish(
          'steps.review.handover.file has no value: its file is gone from the run folder',
        ),
      );
      expect(h.world.commands).toHaveLength(1);
      expect(h.world.commandEnvAsked).toHaveLength(1);
      expect(h.store.get(run.id)!.steps![2]).not.toHaveProperty('command');
    });

    it('env over 64 KB', async () => {
      const yaml = factory(
        DAILY_AUTO,
        '- id: one\n  prompt: Read what changed in api overnight.',
        '- id: post\n  run: echo "$NOTES"\n  env: { NOTES: "{{steps.one.handover}}" }',
      );
      const h = await accepted(yaml);
      const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
      await h.flush();
      h.world.writeArtifact('session-1', 'handover', 'x'.repeat(64 * 1024 + 1));
      await h.world.endTurn('session-1');
      const error =
        "env: this step's values are over 64 KB; pass a file with {{steps.<step>.<artifact>.file}} instead.";
      expect(h.store.get(run.id)).toMatchObject({
        status: 'failed',
        error,
        steps: [{ status: 'completed' }, { id: 'post', status: 'failed', error }],
      });
      expect(h.world.commands).toEqual([]);
      expect(h.world.commandEnvAsked).toEqual([]);
    });

    it('a token that cannot be borrowed', async () => {
      const h = await accepted(COMMANDS_ONLY);
      h.world.commandEnvThrows = new Error('no oauth token found for github.com account JaviDev');
      const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
      await h.flush();
      const error =
        'Its environment could not be prepared (no oauth token found for github.com account JaviDev); nothing ran.';
      expect(h.store.get(run.id)).toMatchObject({
        status: 'failed',
        error,
        steps: [
          { id: 'fresh', status: 'failed', error },
          { id: 'log', status: 'not-run' },
        ],
      });
      expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('command');
      expect(h.world.commands).toEqual([]);
    });
  });

  it.each<[string, Parameters<FakeCommandEnd>[0], string, Record<string, unknown>]>([
    [
      'exits non-zero',
      { result: { exitCode: 1, lastStderrLine: 'HTTP 401: Bad credentials (gho_stub)' } },
      'exit 1: HTTP 401: Bad credentials (***)',
      { exitCode: 1 },
    ],
    [
      'times out, even at exit 0',
      { result: { exitCode: 0, timedOut: true } },
      'timed out after 10m',
      { exitCode: 0 },
    ],
    [
      'is stopped, even at exit 0',
      { result: { exitCode: 0, stopped: true } },
      'Stopped while running: it may have done its work',
      { exitCode: 0 },
    ],
    [
      'is killed by a signal',
      { result: { exitCode: null, signal: 'SIGKILL' } },
      'killed by SIGKILL',
      { signal: 'SIGKILL' },
    ],
    [
      'writes an output it does not declare',
      { outputs: 'gho_stub=1\n' },
      '$CONSOLA_OUTPUT line 1: *** is not an output of this step (it declares none)',
      { exitCode: 0 },
    ],
  ])('a command that %s fails its step, its words masked', async (_name, how, error, ended) => {
    const h = await accepted(COMMANDS_ONLY);
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    await h.world.commands[0].end(how);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        {
          id: 'fresh',
          status: 'failed',
          error,
          command: { intentAt: expect.any(String), ...ended },
        },
        { id: 'log', status: 'not-run' },
      ],
    });
    expect(JSON.stringify(h.store.get(run.id))).not.toContain('gho_stub');
    expect(h.notices).toMatchObject([{ title: `${NAME} did not finish`, body: error }]);
    expect(h.world.commands).toHaveLength(1);
  });

  it('an output that repeats the token is recorded masked', async () => {
    const yaml = factory(
      DAILY_AUTO,
      '- id: whoami\n  run: echo "note=signed in as $GH_TOKEN" >> "$CONSOLA_OUTPUT"\n  outputs: { note: string }',
    );
    const h = await accepted(yaml);
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    await h.world.commands[0].end({ outputs: 'note=signed in as gho_stub\n' });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      steps: [{ status: 'completed', outputs: { note: 'signed in as ***' } }],
    });
    const outputs = path.join(
      h.folder.attemptDir(WORKSPACE_ID, run.id, 'whoami', 1),
      'outputs.json',
    );
    expect(JSON.parse(fs.readFileSync(outputs, 'utf8'))).toEqual({ note: 'signed in as ***' });
  });

  it('a command that never started fails its step, saying nothing ran', async () => {
    const h = await accepted(COMMANDS_ONLY);
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    await h.world.commands[0].neverStarted(new Error('spawn /bin/bash EACCES'));
    const error = 'The command could not start (spawn /bin/bash EACCES); nothing ran.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'fresh', status: 'failed', error, command: { envNames: [] } },
        { status: 'not-run' },
      ],
    });
    // Not the shape of a command a quit cut off: it did not run.
    expect(h.store.get(run.id)!.steps![0].command).not.toHaveProperty('intentAt');
  });

  it('notify reports commands and spawns nothing, except dry_run: run', async () => {
    const { h, run } = await onPr51(REVIEWS('notify'));
    expect(run).toMatchObject({ mode: 'notify', dryRun: true, status: 'running' });
    // fresh only reads, so it runs in a dry run too.
    await h.world.commands[0].end({ outputs: 'needed=true\n' });
    expect(launched(h)).toEqual(['Add retries · review']);
    await reviewed(h, 'session-1');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'fresh → review (request-changes); publish would have run',
      steps: [
        { status: 'completed' },
        { status: 'completed' },
        { id: 'publish', status: 'reported', finishedAt: h.now().toISOString() },
      ],
    });
    expect(h.store.get(run.id)!.steps![2]).not.toHaveProperty('startedAt');
    // Never spawned, nor its environment asked for; what it would have run is on disk.
    expect(h.world.commands).toHaveLength(1);
    expect(h.world.commandEnvAsked).toEqual([WORKSPACE_ID]);
    expect(commandFile(h, run.id, 'publish')).toEqual({
      cwd: CHECKOUT,
      command: PUBLISH,
      env: PUBLISH_ENV(h, run.id),
    });
    expect(JSON.stringify(commandFile(h, run.id, 'publish'))).not.toMatch(/gho_stub|GH_TOKEN|PATH/);
  });

  it('a command starts while both agent slots are taken', async () => {
    const yaml = file(
      entry(NAME, ON_REVIEW_AUTO, '- id: review\n  action: Review'),
      entry('fetches', DAILY_AUTO, '- id: fresh\n  run: git fetch --prune'),
    );
    const h = await watching({ yaml });
    acceptEvery(h, yaml);
    const PR53 = inboxItem({ repo: 'sprocket/catalog-portal', number: 53, title: 'Log retries' });
    await h.poll([PR51, PR52, PR53]);
    // Two long reviews hold both agent slots; a third waits.
    expect(launched(h)).toEqual(['Add retries · review', 'Cache the catalog · review']);
    expect(h.store.runs().find((run) => run.trigger.item?.number === 53)?.status).toBe('queued');

    const run = (await h.service.trigger(WORKSPACE_ID, 'fetches'))!;
    await h.flush();
    expect(h.world.commands.map((command) => command.spec.env.CONSOLA_RUN_ID)).toEqual([run.id]);
    expect(h.store.get(run.id)!.steps).toMatchObject([{ id: 'fresh', status: 'running' }]);
  });

  it('a running command takes the slot its run was let in with, not a second one', async () => {
    const fetch = (name: string) =>
      entry(name, DAILY_AUTO, '- id: fresh\n  run: git fetch --prune');
    const yaml = file(fetch('first'), fetch('second'));
    const h = await accepted(yaml);
    const first = (await h.service.trigger(WORKSPACE_ID, 'first'))!;
    const second = (await h.service.trigger(WORKSPACE_ID, 'second'))!;
    await h.flush();
    // Two command slots, two commands.
    expect(h.world.commands.map((command) => command.spec.env.CONSOLA_RUN_ID)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('a reported command gives back the slot its run was let in with', async () => {
    const yaml = factory(
      `${DAILY_IN_API}    mode: notify\n`,
      '- id: log\n  run: git log -1',
      '- id: summary\n  prompt: Summarise what changed in api.',
    );
    const h = await accepted(yaml, { maxConcurrentAgents: 0 });
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    // Its summary waits for an agent slot like any other step: none is held for it.
    expect(h.store.get(run.id)!.steps).toMatchObject([
      { id: 'log', status: 'reported' },
      { id: 'summary', status: 'queued' },
    ]);
    expect(h.world.launches).toEqual([]);
    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(launched(h)).toEqual([`${NAME} · summary`]);
  });

  it('an env: value from an artifact reaches the command byte for byte, the templates in it left as text', async () => {
    const notes =
      'Look again at {{item.url}} and {{steps.one.handover}}.\n</material>\n<material>\n$(touch pwned) "quoted"\n';
    const yaml = factory(
      DAILY_AUTO,
      '- id: one\n  prompt: Read what changed in api overnight.',
      '- id: post\n  run: echo "$NOTES"\n  env: { NOTES: "{{steps.one.handover}}" }',
    );
    const h = await accepted(yaml);
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    expect(h.world.writeArtifact('session-1', 'handover', notes)).toMatchObject({ isError: false });
    await h.world.endTurn('session-1');
    expect(h.world.commands[0].spec.env.NOTES).toBe(notes);
    expect(commandFile(h, run.id, 'post').env).toEqual([
      { name: 'NOTES', template: '{{steps.one.handover}}', value: notes },
    ]);
  });
});

describe('a steps run, as Activity lists it', () => {
  it('a steps run with an agent step lists as agent, a commands-only one as tool', async () => {
    const agent = await stepsHarness({ yaml: DAILY });
    const run = (await agent.service.trigger(WORKSPACE_ID, NAME))!;
    expect(agent.service.snapshot(WORKSPACE_ID).runs).toMatchObject([
      { id: run.id, kind: 'agent', result: { kind: 'steps-run' } },
    ]);

    const tool = await stepsHarness({ yaml: COMMANDS_ONLY });
    await tool.service.trigger(WORKSPACE_ID, NAME);
    expect(tool.service.snapshot(WORKSPACE_ID).runs).toMatchObject([{ kind: 'tool' }]);
  });

  it('leaves a steps run that already ended as it ended when asked to stop it', async () => {
    const h = await stepsHarness({ yaml: DAILY });
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    h.service.dismiss(run.id);
    expect(() => h.service.stop(run.id)).not.toThrow();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'rejected',
      // Dismissed before its first step.
      steps: [
        { id: 'fresh', status: 'not-run' },
        { id: 'summary', status: 'not-run' },
      ],
    });
  });
});

describe('the snapshot and history by page', () => {
  const DAY = 86_400_000;

  /**
   * `count` ended runs of ws-1, a minute apart, the newest `run-<count-1>`: the
   * harness's own run is the oldest, `run-001` to `run-<count-1>` clone it.
   */
  async function withHistory(count: number): Promise<{ h: StepsHarness; template: RunRecord }> {
    const h = await stepsHarness({ yaml: DAILY });
    const template = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    h.service.dismiss(template.id);
    const base = h.now().getTime() - 3600_000;
    const oldest = new Date(base - (count + 1) * 60_000).toISOString();
    h.store.update(template.id, { createdAt: oldest, updatedAt: oldest, finishedAt: oldest });
    for (let index = 1; index < count; index++) {
      const at = new Date(base - (count - index) * 60_000).toISOString();
      h.store.add({
        ...structuredClone(h.store.get(template.id)!),
        id: `run-${String(index).padStart(3, '0')}`,
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
      });
    }
    return { h, template };
  }

  const ids = (runs: Array<{ id: string }>) => runs.map((run) => run.id);

  it('the snapshot holds live runs plus the newest 200', async () => {
    const { h, template } = await withHistory(300);
    // One live run is older than the 200th ended run: it is still there.
    for (const [id, createdAt] of [
      ['live-a', '2026-01-01T00:00:00.000Z'],
      ['live-b', h.now().toISOString()],
    ]) {
      h.store.add({
        ...structuredClone(template),
        id,
        status: 'queued',
        finishedAt: undefined,
        createdAt,
      });
    }
    const snapshot = h.service.snapshot(WORKSPACE_ID);
    expect(snapshot.runs).toHaveLength(202);
    expect(ids(snapshot.runs)).toEqual(expect.arrayContaining(['live-a', 'live-b']));
    expect(ids(snapshot.runs)).toContain('run-299');
    expect(ids(snapshot.runs)).toContain('run-100');
    expect(ids(snapshot.runs)).not.toContain('run-099');
    expect(snapshot.hasOlder).toBe(true);
  });

  it('hasOlder counts this workspace only', async () => {
    const { h, template } = await withHistory(5);
    for (let index = 0; index < 250; index++) {
      h.store.add({
        ...structuredClone(template),
        id: `other-${index}`,
        attribution: { ...template.attribution, workspaceId: 'ws-2' },
      });
    }
    const snapshot = h.service.snapshot(WORKSPACE_ID);
    expect(snapshot.hasOlder).toBe(false);
    expect(snapshot.runs).toHaveLength(5);
  });

  it('hasOlder is false when what lies past 200 is older than the 30-day window, as listRuns lists nothing of it', async () => {
    const { h, template } = await withHistory(200);
    // filterRuns keeps an ended run only if it finished (else updated, else was created) within 30 days.
    // Added last: retention measures each added run against its own clock.
    const old = new Date(h.now().getTime() - 40 * DAY).toISOString();
    for (const id of ['stale-a', 'stale-b']) {
      h.store.add({
        ...structuredClone(template),
        id,
        createdAt: old,
        updatedAt: old,
        finishedAt: old,
      });
    }
    expect(h.service.snapshot(WORKSPACE_ID).runs).toHaveLength(200);
    expect(h.service.snapshot(WORKSPACE_ID).hasOlder).toBe(false);
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 50, before: template.id })).toEqual({
      runs: [],
      hasOlder: false,
    });
  });

  it('a list entry never carries steps, and names its current step', async () => {
    const h = await stepsHarness({ yaml: DAILY });
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    h.store.update(run.id, {
      status: 'queued',
      steps: [
        { id: 'a', kind: 'run', status: 'completed', attempt: 1 },
        { id: 'b', kind: 'run', status: 'skipped', attempt: 1 },
        { id: 'publish', kind: 'run', status: 'queued', attempt: 1 },
      ],
    });
    const [entry] = h.service.snapshot(WORKSPACE_ID).runs;
    expect(entry).not.toHaveProperty('steps');
    expect(entry.step).toEqual({
      id: 'publish',
      status: 'queued',
      index: 3,
      count: 3,
      kind: 'run',
    });
  });

  describe('the step an ended run names', () => {
    async function stepOf(status: RunRecord['status'], steps: RunRecord['steps']) {
      const h = await stepsHarness({ yaml: DAILY });
      const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
      h.store.update(run.id, { status, steps, finishedAt: h.now().toISOString() });
      return h.service.snapshot(WORKSPACE_ID).runs[0].step;
    }
    const step = (id: string, status: StepRunStatus, attempt = 1) => ({
      id,
      kind: 'run' as const,
      status,
      attempt,
    });

    it('is the failed step of a failed run', async () => {
      expect(
        await stepOf('failed', [
          step('s1', 'completed'),
          step('s2', 'failed'),
          step('s3', 'not-run'),
        ]),
      ).toEqual({
        id: 's2',
        status: 'failed',
        index: 2,
        count: 3,
        kind: 'run',
      });
    });

    it('is the step a failed run did not reach when it failed between steps, never one that completed', async () => {
      expect(
        await stepOf('failed', [
          step('s1', 'completed'),
          step('s2', 'not-run'),
          step('s3', 'not-run'),
        ]),
      ).toEqual({
        id: 's2',
        status: 'not-run',
        index: 2,
        count: 3,
        kind: 'run',
      });
      expect(await stepOf('failed', [step('s1', 'skipped'), step('s2', 'not-run')])).toMatchObject({
        id: 's2',
        status: 'not-run',
      });
      // Every step completed and it failed after: there is no step to name.
      expect(
        await stepOf('failed', [step('s1', 'completed'), step('s2', 'completed')]),
      ).toBeUndefined();
    });

    it('is the last step that ran for any other ended run, a failed one included, and differs from a failed run', async () => {
      const steps = [step('s1', 'failed'), step('s2', 'completed'), step('s3', 'skipped')];
      expect(await stepOf('completed', steps)).toEqual({
        id: 's2',
        status: 'completed',
        index: 2,
        count: 3,
        kind: 'run',
      });
      expect(await stepOf('failed', steps)).toEqual({
        id: 's1',
        status: 'failed',
        index: 1,
        count: 3,
        kind: 'run',
      });
      expect(
        await stepOf('rejected', [step('s1', 'completed'), step('s2', 'failed')]),
      ).toMatchObject({ id: 's2', status: 'failed' });
    });

    it("is a dry run's last reported step", async () => {
      expect(
        await stepOf('completed', [
          step('s1', 'reported'),
          step('s2', 'reported'),
          step('s3', 'skipped'),
        ]),
      ).toEqual({
        id: 's2',
        status: 'reported',
        index: 2,
        count: 3,
        kind: 'run',
      });
    });

    it('is the retried step as it finished, not its earlier failure', async () => {
      const retried = {
        ...step('s2', 'completed', 2),
        previous: [{ attempt: 1, status: 'failed' as const }],
      };
      expect(
        await stepOf('completed', [step('s1', 'completed'), retried, step('s3', 'skipped')]),
      ).toMatchObject({ id: 's2', index: 2 });
    });

    it('is none for a run that failed before any step ran, or that has no steps', async () => {
      expect(
        await stepOf('failed', [step('s1', 'not-run'), step('s2', 'not-run')]),
      ).toBeUndefined();
      expect(await stepOf('rejected', [step('s1', 'not-run')])).toBeUndefined();
      expect(await stepOf('completed', undefined)).toBeUndefined();
    });
  });

  it('listRuns pages from the run before, with no duplicate or skip across a tied createdAt', async () => {
    const { h, template } = await withHistory(300);
    // Two runs at the same instant across the page boundary: newest first, ties by id descending.
    // `run-2499` was added last, so only the tie-break puts `run-250` ahead of it.
    const at = h.store.get('run-250')!.createdAt;
    h.store.add({
      ...structuredClone(template),
      id: 'run-2499',
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    });
    const first = h.service.listRuns(WORKSPACE_ID, { limit: 50 });
    expect(first.runs).toHaveLength(50);
    expect(first.hasOlder).toBe(true);
    const second = h.service.listRuns(WORKSPACE_ID, { limit: 50, before: first.runs[49].id });
    const listed = [...ids(first.runs), ...ids(second.runs)];
    const num = (n: number) => `run-${String(n).padStart(3, '0')}`;
    expect(new Set(listed).size).toBe(100);
    expect(listed).toEqual([
      ...Array.from({ length: 50 }, (_, index) => num(299 - index)),
      'run-2499',
      ...Array.from({ length: 49 }, (_, index) => num(249 - index)),
    ]);
    expect(first.runs[49].id).toBe('run-250');
    expect(second.runs[0]).not.toHaveProperty('steps');
  });

  it('listRuns answers an unknown run with an empty page, clamps the limit, and ends with hasOlder false', async () => {
    const { h } = await withHistory(250);
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 10, before: 'nope' })).toEqual({
      runs: [],
      hasOlder: false,
    });
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 5000 }).runs).toHaveLength(200);
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 0 }).runs).toHaveLength(1);
    expect(h.service.listRuns(WORKSPACE_ID, { limit: -4 }).runs).toHaveLength(1);
    const last = h.service.listRuns(WORKSPACE_ID, { limit: 200, before: 'run-050' });
    expect(last.runs).toHaveLength(50);
    expect(last.hasOlder).toBe(false);
  });

  it('listRuns lists only the workspace asked for', async () => {
    const { h, template } = await withHistory(3);
    h.store.add({
      ...structuredClone(template),
      id: 'elsewhere',
      attribution: { ...template.attribution, workspaceId: 'ws-2' },
    });
    expect(ids(h.service.listRuns(WORKSPACE_ID, { limit: 50 }).runs)).not.toContain('elsewhere');
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 50, before: 'elsewhere' }).runs).toEqual([]);
  });

  it('listRuns searches all of history', async () => {
    const { h } = await withHistory(300);
    h.store.update('run-005', { summary: 'Published the catalog digest.' });
    expect(ids(h.service.snapshot(WORKSPACE_ID).runs)).not.toContain('run-005');
    const found = h.service.listRuns(WORKSPACE_ID, { limit: 50, query: 'catalog digest' });
    expect(ids(found.runs)).toEqual(['run-005']);
    expect(found.hasOlder).toBe(false);
  });
});

describe('run folders', () => {
  it("folders history dropped are swept at start, and a deleted workspace's runs go with it", async () => {
    let h = await watching({ yaml: TEMPLATE });
    await h.poll([PR51]);
    const [dismissed] = h.store.runs();
    h.service.dismiss(dismissed.id);
    await h.poll([PR51, PR52]);
    const [waiting] = h.store.runs();
    // A folder no run in history names: a crash between the write and the record, say.
    h.folder.writeDefinition(
      WORKSPACE_ID,
      'stray',
      h.folder.readDefinition(WORKSPACE_ID, waiting.id)!,
    );
    expect(fs.readdirSync(runsDir(h)).sort()).toEqual([dismissed.id, waiting.id, 'stray'].sort());

    // A month on, retention drops the dismissed run; the waiting one stays, and so does its folder.
    h.advance(31 * DAY);
    h = await h.relaunch();
    expect(h.store.runs().map((run) => run.id)).toEqual([waiting.id]);
    expect(fs.readdirSync(runsDir(h))).toEqual([waiting.id]);

    // Retention dropping a workspace's last steps run still reaches its folder.
    h.service.dismiss(waiting.id);
    h.advance(31 * DAY);
    h = await h.relaunch();
    expect(h.store.runs()).toEqual([]);
    expect(fs.readdirSync(runsDir(h))).toEqual([]);

    // A deleted workspace's runs/ goes with its history.
    await h.poll([]);
    await h.poll([PR51]);
    expect(h.store.runs()).toHaveLength(1);
    h.world.workspaceDeleted = true;
    await h.service.syncWorkspaces();
    expect(h.store.runs()).toEqual([]);
    expect(fs.existsSync(runsDir(h))).toBe(false);
  });

  it('logs a sweep that fails, and starts anyway', async () => {
    let h = await watching({ yaml: TEMPLATE });
    await h.poll([PR51]);
    const [run] = h.store.runs();
    // runs/ replaced by a file: it cannot be listed.
    fs.rmSync(runsDir(h), { recursive: true });
    fs.writeFileSync(runsDir(h), '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());

    h = await h.relaunch();
    expect(logged).toHaveBeenCalledWith(
      `Could not sweep ${WORKSPACE_ID}'s run folders.`,
      expect.any(Error),
    );
    expect(h.service.list(WORKSPACE_ID).map((entry) => entry.name)).toEqual([NAME]);
    expect(h.store.get(run.id)?.status).toBe('needs-approval');
  });
});

describe('the reminder turn', () => {
  const REMINDER = 'You ended without: mood (consola_set_outputs). Set it now; do nothing else.';

  it('is used once, then the step fails', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toEqual([{ sessionId: 'session-1', prompt: REMINDER }]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        { id: 'one', status: 'running', reminded: true },
        { id: 'two', status: 'pending' },
      ],
    });

    await h.world.endTurn('session-1');
    expect(h.world.reminders).toHaveLength(1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'ended without setting mood',
      steps: [
        { id: 'one', status: 'failed', error: 'ended without setting mood' },
        { id: 'two', status: 'not-run' },
      ],
    });
  });

  it('gets 1 + 2 per missing item as its cap', async () => {
    const h = await accepted(file(NIGHTLY));
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    await h.flush();
    await h.world.endTurn('session-1');
    expect(h.world.reminderCaps).toEqual([3]);

    // An output set and a handover a later step reads: two missing items.
    const handed = entry(
      'handed',
      DAILY_AUTO,
      ONE,
      '- id: two\n  prompt: Write up the night.\n  reads: [one.handover]',
    );
    const both = await accepted(file(handed));
    await both.service.trigger(WORKSPACE_ID, 'handed');
    await both.flush();
    await both.world.endTurn('session-1');
    expect(both.world.reminders).toHaveLength(1);
    expect(both.world.reminderCaps).toEqual([5]);
  });

  it('that hits its own cap fails in the reminder’s words, not as the step’s limit', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', { exitCode: 0, report: turnReport({ turns: 2 }) });
    expect(h.world.reminderCaps).toEqual([3]);
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({ maxTurns: 3, subtype: 'error_max_turns', isError: true, turns: 3 }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'Its reminder hit its limit of 3 turns before finishing.',
    });
  });

  it('a quit during it resumes it under its own cap, and a quit in the first turn under the record’s', async () => {
    let h = await accepted(file(NIGHTLY));
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    await h.flush();
    h = await h.relaunch();
    // The first turn, cut off: its resume runs under the step's own cap, the record's.
    expect(h.world.resumes).toEqual([{ sessionId: 'session-1', prompt: INTERRUPTED_PROMPT }]);
    expect(h.world.resumeCaps).toEqual([undefined]);
    await h.world.endTurn('session-1');
    expect(h.world.reminderCaps).toEqual([3]);
    // The reminder, cut off: resumed under the reminder's cap, for what is still missing.
    h = await h.relaunch();
    expect(h.world.resumes).toHaveLength(2);
    expect(h.world.resumeCaps).toEqual([undefined, 3]);
  });

  it('a reminder cut off whose missing items cannot be read fails, and is not resumed uncapped', async () => {
    let h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toHaveLength(1);
    // Its step tools can no longer say what it left out.
    h.store.update(run.id, {
      steps: h.store
        .get(run.id)!
        .steps!.map((step) => (step.id === 'one' ? { ...step, id: 'renamed' } : step)),
    });
    h = await h.relaunch();
    expect(h.world.resumes).toEqual([]);
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: `Run ${run.id} has no agent step renamed.`,
    });
  });

  it('that sets the outputs completes the step', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1');
    expect(h.world.setOutputs('session-1', { mood: 'calm' })).toMatchObject({ isError: false });
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toHaveLength(1);
    expect(h.store.get(run.id)?.steps).toMatchObject([
      { id: 'one', status: 'completed', outputs: { mood: 'calm' } },
      { id: 'two', status: 'running' },
    ]);
    expect(
      fs.existsSync(path.join(h.folder.attemptDir(WORKSPACE_ID, run.id, 'one', 1), 'outputs.json')),
    ).toBe(true);
  });

  it('holds the slot while it runs', async () => {
    const h = await accepted(file(NIGHTLY, WEEKLY), { maxConcurrentAgents: 1 });
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    await h.flush();
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toHaveLength(1);
    expect(h.store.get(weekly.id)?.status).toBe('queued');
    expect(launched(h)).toEqual(['nightly · one']);
    await h.world.endTurn('session-1');
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
  });

  it('that cannot be delivered fails the step with the reason', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.remindThrows = new Error('You opened its session before Consola could remind it.');
    await h.world.endTurn('session-1');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'You opened its session before Consola could remind it.',
      steps: [
        { id: 'one', status: 'failed' },
        { id: 'two', status: 'not-run' },
      ],
    });
  });

  it('is not asked for after a failed exit or a stop', async () => {
    const h = await accepted(file(NIGHTLY));
    await h.service.trigger(WORKSPACE_ID, 'nightly');
    await h.flush();
    await h.world.endTurn('session-1', { exitCode: 1 });
    expect(h.world.reminders).toEqual([]);
  });

  it('is not asked for once its session is closed', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.workspace.sessions = [];
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toEqual([]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Its session was closed before it finished.',
    });
  });
});

/** A promise the test lets go of when it says. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const STOPPED_BY_YOU = 'It stopped before finishing: you stopped it.';
const STOPPED_COMMAND = 'Stopped while running: it may have done its work';
const NO_TURN = 'Stopped: its session was no longer running.';
const HELD = 'Another run on this item is working; retry once it ends.';
/** What a retry of a run that never started is refused with: its approval was refused, or the line turned it away. */
const NEVER_STARTED = 'It never started; run it again.';
const NEW_HEAD = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
/** How the executor reports a command its stop ended. */
const SIGTERMED = { result: { exitCode: null, signal: 'SIGTERM', stopped: true } };
/** NIGHTLY with a third step, so a stop at two leaves one after it. */
const NIGHTLY3 = entry(
  'nightly',
  DAILY_AUTO,
  ONE,
  TWO,
  '- id: three\n  prompt: File the write-up.',
);
const THREE = file(NIGHTLY3);
/** An action step then a command on #51's review requests, beside a one-step look at the same item. */
const ITEM_PAIR = file(
  entry(
    NAME,
    ON_REVIEW_AUTO,
    '- id: review\n  action: Review',
    '- id: publish\n  run: gh pr comment "$PR" --body done\n  env: { PR: "{{item.url}}" }',
  ),
  look('second-look', 'Look again at'),
);

const definitionFile = (h: StepsHarness, runId: string) =>
  path.join(h.folder.runDir(WORKSPACE_ID, runId), 'definition.json');

/** A `REVIEWS` run on #51 whose fresh and review steps completed, its publish command running. */
async function publishing(): Promise<{ h: StepsHarness; run: RunRecord; publish: FakeCommand }> {
  const { h, run } = await onPr51(REVIEWS('auto'));
  await h.world.commands[0].end({ outputs: 'needed=true\n' });
  await reviewed(h, 'session-1');
  return { h, run, publish: h.world.commands[1] };
}

/** A run as a crash between two lines leaves it: `stepId` back to pending, so nothing is queued or running. */
function betweenSteps(h: StepsHarness, runId: string, stepId: string): void {
  const steps = h.store.get(runId)!.steps!.map((step) => {
    if (step.id !== stepId) return step;
    const { queuedAt: _queuedAt, ...rest } = step;
    return { ...rest, status: 'pending' as const };
  });
  h.store.update(runId, { steps });
}

/** THREE's run, its first step done with `mood`, its second waiting for a slot that never comes. */
async function waitingAtTwo(h: StepsHarness): Promise<RunRecord> {
  const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
  await h.flush();
  h.world.maxConcurrentAgents = 0;
  h.world.setOutputs('session-1', { mood: 'calm' });
  await h.world.endTurn('session-1');
  expect(h.store.get(run.id)!.steps![1]).toMatchObject({ id: 'two', status: 'queued' });
  return run;
}

describe('a reporting turn', () => {
  const CAPPED = entry(
    'capped',
    DAILY_AUTO,
    '- id: one\n  prompt: Read what changed in api.\n  max_turns: 6',
  );
  const LONE = entry('lone', DAILY_AUTO, '- id: digest\n  prompt: Sum up the week in api.');
  const turnFile = (h: StepsHarness, runId: string, stepId: string, attempt = 1) =>
    JSON.parse(
      fs.readFileSync(
        path.join(h.folder.attemptDir(WORKSPACE_ID, runId, stepId, attempt), 'turn.json'),
        'utf8',
      ),
    );

  it('records cost, turns and the model on the step, and the sum on the run', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ cost: 0.0123, turns: 3, model: 'claude-opus-5-5' }),
    });
    const first = h.store.get(run.id)!;
    expect(first.steps?.[0].status).toBe('completed');
    expect(first.steps?.[0].turn).toEqual({ costUsd: 0.0123, turns: 3 });
    expect(first.steps?.[0].model).toBe('claude-opus-5-5');
    expect(first.costUsd).toBe(0.0123);

    await h.world.endTurn('session-2', {
      exitCode: 0,
      report: turnReport({ cost: 0.02, turns: 1 }),
    });
    const done = h.store.get(run.id)!;
    expect(done.status).toBe('completed');
    expect(done.steps?.[1].turn).toEqual({ costUsd: 0.02, turns: 1 });
    expect(done.costUsd).toBeCloseTo(0.0323, 10);
  });

  it("records the step's own cap", async () => {
    const h = await accepted(file(CAPPED));
    const run = (await h.service.trigger(WORKSPACE_ID, 'capped'))!;
    await h.flush();
    // The cap the launch ran with is the report's; the step's own is the definition's.
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ turns: 2, maxTurns: 6 }),
    });
    expect(h.store.get(run.id)?.steps?.[0].turn).toEqual({ turns: 2, maxTurns: 6 });
  });

  it('keeps the turn in turn.json', async () => {
    const h = await accepted(file(CAPPED));
    const run = (await h.service.trigger(WORKSPACE_ID, 'capped'))!;
    await h.flush();
    const report = turnReport({
      cost: 0.0123,
      turns: 3,
      model: 'claude-opus-5-5',
      maxTurns: 6,
      otherLines: ['Warning: x'],
      text: 'FINDINGS: none',
    });
    await h.world.endTurn('session-1', { exitCode: 0, report });
    expect(turnFile(h, run.id, 'one')).toEqual({
      turns: [
        {
          endedAt: h.now().toISOString(),
          exitCode: 0,
          maxTurns: 6,
          init: report.raw.init,
          result: report.raw.result,
          otherLines: ['Warning: x'],
        },
      ],
    });
  });

  it('fails on is_error whatever subtype says, and still records its cost', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({
        subtype: 'success',
        isError: true,
        text: 'Not logged in · Please run /login',
        cost: 0,
        turns: 1,
      }),
    });
    expect(h.world.reminders).toEqual([]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      costUsd: 0,
      steps: [
        {
          id: 'one',
          status: 'failed',
          error: 'It stopped before finishing: Not logged in · Please run /login.',
          turn: { costUsd: 0, turns: 1 },
        },
        { id: 'two', status: 'not-run' },
      ],
    });
  });

  it('error_max_turns fails with no reminder, and keeps what it set', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({
        maxTurns: 6,
        subtype: 'error_max_turns',
        isError: true,
        cost: 0.0123,
        turns: 6,
      }),
    });
    expect(h.world.reminders).toEqual([]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      costUsd: 0.0123,
      steps: [
        {
          id: 'one',
          status: 'failed',
          error: 'It hit its limit of 6 turns before finishing.',
          outputs: { mood: 'calm' },
          turn: { costUsd: 0.0123, turns: 6 },
        },
        { id: 'two', status: 'not-run' },
      ],
    });
    const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'one', 1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'outputs.json'), 'utf8'))).toEqual({
      mood: 'calm',
    });
  });

  it('error_max_turns with nothing set writes no outputs.json', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const logged = vi.spyOn(console, 'error');
    onTestFinished(() => logged.mockRestore());
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({ maxTurns: 6, subtype: 'error_max_turns', isError: true }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'It hit its limit of 6 turns before finishing.',
    });
    const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'one', 1);
    expect(fs.existsSync(path.join(dir, 'outputs.json'))).toBe(false);
    expect(logged).not.toHaveBeenCalled();
  });

  it('error_max_turns whose outputs.json cannot be written still fails in its own words', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    vi.spyOn(h.folder, 'writeJson').mockImplementation(() => {
      throw new Error('disk full');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({ maxTurns: 6, subtype: 'error_max_turns', isError: true }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'It hit its limit of 6 turns before finishing.',
      outputs: { mood: 'calm' },
    });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('outputs.json');
  });

  it("a turn with no result fails with the CLI's last line, never the pane's", async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', {
      exitCode: 1,
      lastLine: 'Finished: 3 turns.',
      report: turnReport({ noResult: true, otherLines: ['TypeError: boom'] }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing (exit 1): TypeError: boom.',
    });
    expect(h.world.reminders).toEqual([]);
  });

  it('exit 0 with no result line fails', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', { exitCode: 0, report: turnReport({ noResult: true }) });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'It ended without reporting how its turn went.',
    });
  });

  it('a stop is a stop', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', {
      exitCode: 0,
      stopped: 'you pressed Ctrl+C',
      report: turnReport({ noResult: true }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing: you pressed Ctrl+C.',
    });
    expect(turnFile(h, run.id, 'one').turns[0]).toMatchObject({
      exitCode: 0,
      stopped: 'you pressed Ctrl+C',
    });
  });

  it("the reminder's turn is recorded with the first's: its cost is the conversation's running total", async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ cost: 0.0015, turns: 2 }),
    });
    expect(h.world.reminders).toHaveLength(1);
    expect(h.world.reminderCaps).toEqual([3]);
    h.world.setOutputs('session-1', { mood: 'calm' });
    // A resumed turn reports the conversation's cost so far (canary row 14, Call 12's fallback).
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ cost: 0.003, turns: 1, maxTurns: 3 }),
    });
    const stored = h.store.get(run.id)!;
    expect(stored.steps?.[0].status).toBe('completed');
    expect(stored.steps?.[0].turn?.costUsd).toBeCloseTo(0.003, 10);
    expect(stored.steps?.[0].turn?.costUsd).not.toBeCloseTo(0.0045, 10);
    expect(stored.steps?.[0].turn?.turns).toBe(3);
    // The reminder ran with a cap of its own; the step has none.
    expect(stored.steps?.[0].turn).not.toHaveProperty('maxTurns');
    expect(stored.costUsd).toBeCloseTo(0.003, 10);
    expect(
      turnFile(h, run.id, 'one').turns.map((turn: { maxTurns?: number }) => turn.maxTurns),
    ).toEqual([undefined, 3]);
  });

  it("a retry keeps the earlier attempt's cost and turns", async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({
        isError: true,
        text: 'Overloaded',
        cost: 0.01,
        turns: 4,
        model: 'claude-opus-5-5',
      }),
    });
    expect(h.store.get(run.id)?.status).toBe('failed');
    await h.service.retry(run.id);
    await h.flush();
    const retried = h.store.get(run.id)!;
    expect(retried.steps?.[0].previous?.[0]).toMatchObject({ costUsd: 0.01, turns: 4 });
    expect(retried.steps?.[0].turn).toBeUndefined();
    expect(retried.steps?.[0].model).toBeUndefined();
    expect(retried.costUsd).toBe(0.01);

    // A new attempt is a new conversation: its first total is its own.
    h.world.setOutputs('session-2', { mood: 'calm' });
    await h.world.endTurn('session-2', { exitCode: 0, report: turnReport({ cost: 0.02 }) });
    const after = h.store.get(run.id)!;
    expect(after.steps?.[0].turn?.costUsd).toBe(0.02);
    expect(after.costUsd).toBeCloseTo(0.03, 10);
  });

  it('a retry of an attempt that reported no turns remembers none', async () => {
    const h = await accepted(file(NIGHTLY));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await h.world.endTurn('session-1', {
      exitCode: 1,
      report: turnReport({ isError: true, text: 'Overloaded', cost: 0.01 }),
    });
    await h.service.retry(run.id);
    await h.flush();
    const [earlier] = h.store.get(run.id)!.steps![0].previous!;
    expect(earlier).toMatchObject({ attempt: 1, costUsd: 0.01 });
    expect(earlier).not.toHaveProperty('turns');
  });

  it('a legacy agent run records nothing new', async () => {
    const h = await accepted(file(legacy('digest')));
    const run = (await h.service.trigger(WORKSPACE_ID, 'digest'))!;
    await h.flush();
    await h.world.endTurn('session-1', { exitCode: 0 });
    const stored = h.store.get(run.id)!;
    expect(stored.status).toBe('completed');
    expect(stored.costUsd).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stored, 'costUsd')).toBe(false);
  });

  it('a turn without a report takes the path it always did', async () => {
    const h = await accepted(file(LONE));
    const run = (await h.service.trigger(WORKSPACE_ID, 'lone'))!;
    await h.flush();
    await h.world.endTurn('session-1', { exitCode: 0 });
    const stored = h.store.get(run.id)!;
    expect(stored.status).toBe('completed');
    expect(stored.steps?.[0].turn).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stored, 'costUsd')).toBe(false);
    const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'digest', 1);
    expect(fs.existsSync(path.join(dir, 'turn.json'))).toBe(false);
  });

  it('a turn.json that cannot be written fails nothing', async () => {
    const h = await accepted(file(LONE));
    const run = (await h.service.trigger(WORKSPACE_ID, 'lone'))!;
    await h.flush();
    vi.spyOn(h.folder, 'appendTurn').mockImplementation(() => {
      throw new Error('disk full');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ cost: 0.0123, turns: 3 }),
    });
    const stored = h.store.get(run.id)!;
    expect(stored.steps?.[0]).toMatchObject({
      status: 'completed',
      turn: { costUsd: 0.0123, turns: 3 },
    });
    expect(stored.costUsd).toBe(0.0123);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('turn.json');
  });
});

describe('stop in every state', () => {
  it('a running agent step is stopped through its session; its turn end fails it, and its slot frees', async () => {
    const h = await accepted(file(NIGHTLY3, WEEKLY), { maxConcurrentAgents: 1 });
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
    await h.flush();
    h.service.stop(nightly.id);
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: 'you stopped it' }]);
    // Running until its turn ends: that is what says how it ended.
    expect(h.store.get(nightly.id)?.status).toBe('running');
    await h.world.endTurn('session-1', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(nightly.id)).toMatchObject({
      status: 'failed',
      error: STOPPED_BY_YOU,
      steps: [
        { id: 'one', status: 'failed', error: STOPPED_BY_YOU },
        { id: 'two', status: 'not-run' },
        { id: 'three', status: 'not-run' },
      ],
    });
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
    expect(h.store.get(weekly.id)?.status).toBe('running');
  });

  it('an agent step whose session has no turn running fails at once', async () => {
    const h = await accepted(file(NIGHTLY3, WEEKLY), { maxConcurrentAgents: 1 });
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.service.trigger(WORKSPACE_ID, 'weekly');
    await h.flush();
    h.world.noTurnToStop = true;
    h.service.stop(nightly.id);
    await h.flush();
    expect(h.store.get(nightly.id)).toMatchObject({
      status: 'failed',
      error: NO_TURN,
      steps: [
        { id: 'one', status: 'failed', error: NO_TURN },
        { status: 'not-run' },
        { status: 'not-run' },
      ],
    });
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
    expect(h.notices).toEqual([]);
  });

  it('an agent step still launching is stopped once it has launched', async () => {
    const h = await accepted(THREE);
    const launch = held();
    h.world.launchGate = launch.promise;
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({ id: 'one', status: 'running' });
    h.service.stop(run.id);
    expect(h.world.stops).toEqual([]);

    h.world.launchGate = undefined;
    launch.release();
    await h.flush();
    // Launched: its session is recorded, then its turn is ended.
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: 'you stopped it' }]);
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'running',
      sessionId: 'session-1',
    });
    await h.world.endTurn('session-1', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: STOPPED_BY_YOU,
      steps: [
        { id: 'one', status: 'failed', error: STOPPED_BY_YOU },
        { status: 'not-run' },
        { status: 'not-run' },
      ],
    });
    expect(h.world.launches).toHaveLength(1);
  });

  it('a stop during a launch is honoured whatever started it late: the checkout before it, or a reminder that returned after its turn', async () => {
    // An item run: its preparation goes straight into the first step's launch.
    const prepared = await watching({ yaml: TEMPLATE });
    prepared.store.accept(KEY, TEMPLATE_VERSION);
    const fetch = held();
    prepared.world.checkouts.gate = fetch.promise;
    const launch = held();
    prepared.world.launchGate = launch.promise;
    await prepared.poll([PR51]);
    const [run] = prepared.store.runs();
    // The pump that started the run has finished: the preparation's own advance starts the launch, inside its call.
    expect(prepared.world.launches).toEqual([]);
    prepared.world.checkouts.gate = undefined;
    fetch.release();
    await prepared.flush();
    expect(prepared.world.launches).toHaveLength(1);
    prepared.service.stop(run.id);
    expect(prepared.store.get(run.id)?.status).toBe('running');
    prepared.world.launchGate = undefined;
    launch.release();
    await prepared.flush();
    expect(prepared.world.stops).toEqual([{ sessionId: 'session-1', reason: 'you stopped it' }]);

    // A reminder whose turn completed the step before the call returned: the next step is launching by then.
    const h = await accepted(THREE);
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const reminder = held();
    h.world.remindGate = reminder.promise;
    await h.world.endTurn('session-1');
    h.world.setOutputs('session-1', { mood: 'calm' });
    const next = held();
    h.world.launchGate = next.promise;
    await h.world.endTurn('session-1');
    expect(h.store.get(nightly.id)!.steps).toMatchObject([
      { status: 'completed' },
      { id: 'two', status: 'running' },
      { status: 'pending' },
    ]);
    h.world.remindGate = undefined;
    reminder.release();
    await h.flush();
    h.service.stop(nightly.id);
    expect(h.store.get(nightly.id)?.status).toBe('running');
    h.world.launchGate = undefined;
    next.release();
    await h.flush();
    expect(h.world.stops.at(-1)).toEqual({ sessionId: 'session-2', reason: 'you stopped it' });
  });

  it('a stop while its reminder is delivered, or while it resumes, is honoured once it is', async () => {
    const h = await accepted(THREE);
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const reminder = held();
    h.world.remindGate = reminder.promise;
    await h.world.endTurn('session-1');
    expect(h.world.reminders).toHaveLength(1);
    h.service.stop(run.id);
    expect(h.world.stops).toEqual([]);
    h.world.remindGate = undefined;
    reminder.release();
    await h.flush();
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: 'you stopped it' }]);
    await h.world.endTurn('session-1', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: STOPPED_BY_YOU });

    // A step a restart put back in line with its session, stopped while it resumes there.
    const r = await accepted(THREE);
    const resumed = (await r.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await r.flush();
    r.store.update(resumed.id, {
      steps: r.store
        .get(resumed.id)!
        .steps!.map((step) => (step.id === 'one' ? { ...step, status: 'queued' } : step)),
    });
    const resume = held();
    r.world.resumeGate = resume.promise;
    void r.service.tick();
    await r.flush();
    expect(r.world.resumes).toEqual([{ sessionId: 'session-1', prompt: INTERRUPTED_PROMPT }]);
    r.service.stop(resumed.id);
    expect(r.world.stops).toEqual([]);
    r.world.resumeGate = undefined;
    resume.release();
    await r.flush();
    expect(r.world.stops).toEqual([{ sessionId: 'session-1', reason: 'you stopped it' }]);
  });

  it('a run preparing its checkout fails once the preparation settles, before its first step starts', async () => {
    const h = await watching({ yaml: ITEM_PAIR });
    acceptEvery(h, ITEM_PAIR);
    const preparing = held();
    h.world.checkouts.gate = preparing.promise;
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    expect(second).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
    h.service.stop(first.id);
    // Its fetch is still moving the checkout: it holds it until that ends.
    expect(h.store.get(first.id)?.status).toBe('running');
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);

    h.world.checkouts.gate = undefined;
    preparing.release();
    await h.flush();
    const error = 'Stopped before review started.';
    expect(h.store.get(first.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'review', status: 'failed', error },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(h.store.get(first.id)!.steps![0]).not.toHaveProperty('startedAt');
    // Never started: the checkout and the slot went to the next run on the item.
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([second.id]);
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.notices).toEqual([]);

    // A preparation that fails after the stop ends it the same way: as stopped.
    const failing = await watching({ yaml: TEMPLATE });
    failing.store.accept(KEY, TEMPLATE_VERSION);
    const gate = held();
    failing.world.checkouts.gate = gate.promise;
    await failing.poll([PR51]);
    const [run] = failing.store.runs();
    failing.service.stop(run.id);
    failing.world.checkouts.fails = new Error(
      'Could not bring the automation checkout to the head of sprocket/catalog-portal#51: fetch failed.',
    );
    gate.release();
    await failing.flush();
    expect(failing.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'review', status: 'failed', error },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(failing.notices).toEqual([]);
  });

  it('a running command is stopped through its handle; its result fails it, and its slot frees', async () => {
    const yaml = file(
      entry(NAME, ON_REVIEW_AUTO, FRESH, REVIEW_IT, POST),
      entry('fetches', DAILY_AUTO, '- id: fetch\n  run: git fetch --prune'),
    );
    const h = await watching({ yaml, maxConcurrentCommands: 1 });
    acceptEvery(h, yaml);
    await h.poll([PR51]);
    const run = byName(h, NAME);
    const fetches = (await h.service.trigger(WORKSPACE_ID, 'fetches'))!;
    await h.flush();
    expect(h.store.get(fetches.id)?.status).toBe('queued');
    const [fresh] = h.world.commands;
    h.service.stop(run.id);
    expect(fresh.stops).toBe(1);
    // Running until its result says how it ended.
    expect(h.store.get(run.id)?.status).toBe('running');

    await fresh.end(SIGTERMED);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: STOPPED_COMMAND,
      steps: [
        {
          id: 'fresh',
          status: 'failed',
          error: STOPPED_COMMAND,
          command: { intentAt: expect.any(String), signal: 'SIGTERM' },
        },
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    expect(h.world.commands.map((command) => command.spec.env.CONSOLA_RUN_ID)).toEqual([
      run.id,
      fetches.id,
    ]);
  });

  it('a step waiting for a slot fails at once, never started', async () => {
    const h = await accepted(THREE);
    const run = await waitingAtTwo(h);
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [run.id]: 1 });
    h.service.stop(run.id);
    const error = 'Stopped before two started.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'completed' },
        { id: 'two', status: 'failed', error },
        { id: 'three', status: 'not-run' },
      ],
    });
    expect(h.store.get(run.id)!.steps![1]).not.toHaveProperty('startedAt');
    expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({});
    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(h.world.launches).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it('a command step whose environment is being borrowed fails at once, and nothing spawns', async () => {
    const h = await accepted(COMMANDS_ONLY);
    const env = held();
    h.world.commandEnvGate = env.promise;
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    expect(h.world.commandEnvAsked).toEqual([WORKSPACE_ID]);
    h.service.stop(run.id);
    const error = 'Stopped before fresh started.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'fresh', status: 'failed', error },
        { id: 'log', status: 'not-run' },
      ],
    });
    h.world.commandEnvGate = undefined;
    env.release();
    await h.flush();
    expect(h.world.commands).toEqual([]);
    expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('command');
  });

  it('a run between steps fails at once, before its next step', async () => {
    const h = await accepted(THREE);
    const run = await waitingAtTwo(h);
    betweenSteps(h, run.id, 'two');
    h.service.stop(run.id);
    const error = 'Stopped before two started.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'completed' },
        { id: 'two', status: 'failed', error },
        { id: 'three', status: 'not-run' },
      ],
    });
    expect(h.notices).toEqual([]);
  });

  it('a stop between steps never ends as a completion, even when every step left would skip', async () => {
    const worrying = (id: string) =>
      `- id: ${id}\n  if: steps.one.mood == 'worrying'\n  prompt: Say what is worrying.`;
    const h = await accepted(
      file(entry('nightly', DAILY_AUTO, ONE, worrying('two'), worrying('three'))),
    );
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    // As a crash between two lines leaves it: one done and calm, nothing after it looked at yet.
    const done = {
      status: 'completed' as const,
      outputs: { mood: 'calm' },
      finishedAt: h.now().toISOString(),
    };
    h.store.update(run.id, {
      steps: h.store
        .get(run.id)!
        .steps!.map((step) => (step.id === 'one' ? { ...step, ...done } : step)),
    });
    h.service.stop(run.id);
    const error = 'Stopped before two started.';
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { id: 'one', status: 'completed' },
        { id: 'two', status: 'failed', error },
        { id: 'three', status: 'not-run' },
      ],
    });
    expect(h.notices).toEqual([]);
  });

  it('a stop that arrives after the last step completed lets the run complete', async () => {
    const h = await accepted(file(entry('nightly', DAILY_AUTO, ONE)));
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    const reminder = held();
    h.world.remindGate = reminder.promise;
    await h.world.endTurn('session-1');
    // Stopped while its reminder is delivered; the reminder's turn completes the step meanwhile.
    h.service.stop(run.id);
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'one (calm)',
      steps: [{ id: 'one', status: 'completed' }],
    });
    expect(h.store.get(run.id)!.error).toBeUndefined();
    h.world.remindGate = undefined;
    reminder.release();
    await h.flush();
    expect(h.store.get(run.id)?.status).toBe('completed');
  });

  it('a run waiting for approval or in line is dismissed', async () => {
    const asking = await stepsHarness({ yaml: SUMMARY });
    const asked = (await asking.service.trigger(WORKSPACE_ID, NAME))!;
    expect(asked.status).toBe('needs-approval');
    asking.service.stop(asked.id);
    expect(asking.store.get(asked.id)).toMatchObject({
      status: 'rejected',
      steps: [{ id: 'summary', status: 'not-run' }],
    });

    const lined = await accepted(SUMMARY, { maxConcurrentAgents: 0 });
    const queued = (await lined.service.trigger(WORKSPACE_ID, NAME))!;
    expect(queued.status).toBe('queued');
    lined.service.stop(queued.id);
    expect(lined.store.get(queued.id)).toMatchObject({
      status: 'rejected',
      steps: [{ id: 'summary', status: 'not-run' }],
    });
    expect(lined.service.snapshot(WORKSPACE_ID).queue).toEqual({});
    lined.world.maxConcurrentAgents = undefined;
    await lined.tick();
    expect(lined.world.launches).toEqual([]);
  });

  it('a launch that resolves after its run ended is stopped at once, and nothing is recorded', async () => {
    const h = await accepted(THREE);
    const launch = held();
    h.world.launchGate = launch.promise;
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    // While it launches, its definition goes with its folder: the run ends.
    fs.rmSync(definitionFile(h, run.id));
    await h.service.syncWorkspaces();
    expect(h.store.get(run.id)?.status).toBe('failed');
    const ended = structuredClone(h.store.get(run.id));
    const lines = h.history.appends.length;

    h.world.launchGate = undefined;
    launch.release();
    await h.flush();
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: 'its run had ended' }]);
    expect(h.store.get(run.id)).toEqual(ended);
    expect(h.history.appends).toHaveLength(lines);
  });

  it('a run that cannot go on stops what its step was running', async () => {
    const commands = await accepted(COMMANDS_ONLY);
    const fetching = (await commands.service.trigger(WORKSPACE_ID, NAME))!;
    await commands.flush();
    fs.rmSync(definitionFile(commands, fetching.id));
    await commands.service.syncWorkspaces();
    expect(commands.store.get(fetching.id)?.status).toBe('failed');
    expect(commands.world.commands[0].stops).toBe(1);

    const agent = await accepted(THREE);
    const nightly = (await agent.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await agent.flush();
    fs.rmSync(definitionFile(agent, nightly.id));
    await agent.service.syncWorkspaces();
    expect(agent.world.stops).toEqual([{ sessionId: 'session-1', reason: 'its run had ended' }]);

    // Its workspace deleted: the run goes with it, and its command is stopped.
    const deleted = await accepted(COMMANDS_ONLY);
    await deleted.service.trigger(WORKSPACE_ID, NAME);
    await deleted.flush();
    deleted.world.workspaceDeleted = true;
    await deleted.service.syncWorkspaces();
    expect(deleted.world.commands[0].stops).toBe(1);
  });
});

describe('retry', () => {
  it('retry gives the step a new attempt and folder, keeping earlier outputs', async () => {
    const { h, run } = await onPr51(REVIEWS('auto'));
    await h.world.commands[0].end({ outputs: 'needed=true\n' });
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    const error = 'It stopped before finishing (exit 1): Rate limited.';
    const failedAt = h.now().toISOString();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error,
      steps: [
        { status: 'completed' },
        { id: 'review', status: 'failed' },
        { id: 'publish', status: 'not-run' },
      ],
    });

    // The file changes and would ask again: the click is the approval, and the run executes its own snapshot.
    await h.setYaml(
      REVIEWS('auto').replace(
        'write the review as your handover',
        'write a short review as your handover',
      ),
    );
    h.advance(MINUTE);
    const retried = await h.service.retry(run.id);
    expect(retried).toMatchObject({ id: run.id, status: 'running' });
    await h.flush();
    expect(h.world.launches[1]).toMatchObject({
      step: { id: 'review', attempt: 2, cwd: CHECKOUT },
    });
    expect(h.world.launches[1].prompt).toContain('write the review as your handover');
    const stored = h.store.get(run.id)!;
    expect(stored).toMatchObject({
      status: 'running',
      steps: [
        { id: 'fresh', status: 'completed', attempt: 1, outputs: { needed: true } },
        {
          id: 'review',
          status: 'running',
          attempt: 2,
          sessionId: 'session-2',
          startedAt: h.now().toISOString(),
          previous: [{ attempt: 1, status: 'failed', error, finishedAt: failedAt }],
        },
        { id: 'publish', status: 'pending', attempt: 1 },
      ],
    });
    expect(stored.error).toBeUndefined();
    expect(stored.finishedAt).toBeUndefined();

    // Its documents go to review/2, and publish reads them there.
    await reviewed(h, 'session-2', 'Retries are bounded now.');
    expect(h.folder.readArtifact(WORKSPACE_ID, run.id, 'review', 2, 'handover')).toBe(
      'Retries are bounded now.',
    );
    expect(h.world.commands[1].spec.env.BODY_FILE).toBe(
      h.folder.artifactPath(WORKSPACE_ID, run.id, 'review', 2, 'handover'),
    );
    await h.world.commands[1].end();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'fresh → review → publish (request-changes)',
    });
  });

  it('retrying an agent step records a new head; retrying a command keeps the old one', async () => {
    const { h, run } = await onPr51(REVIEWS('auto'));
    await h.world.commands[0].end({ outputs: 'needed=true\n' });
    await h.world.endTurn('session-1', { exitCode: 1 });
    h.world.checkouts.head = NEW_HEAD;
    await h.service.retry(run.id);
    await h.flush();
    // Prepared again, without asking after a review by hand: the click is the person's.
    expect(h.world.checkouts.prepared).toEqual([
      expect.objectContaining({ workItem: PR51.workItem }),
      { workspaceId: WORKSPACE_ID, workItem: PR51.workItem },
    ]);
    expect(h.store.get(run.id)!.checkout).toEqual({
      cwd: CHECKOUT,
      scopeId: 'scope-catalog-portal',
      head: NEW_HEAD,
    });

    // Its publish fails; retried, it runs in the checkout as it is, with the head the run recorded.
    await reviewed(h, 'session-2');
    await h.world.commands[1].end({
      result: { exitCode: 1, lastStderrLine: 'HTTP 502: Bad Gateway' },
    });
    const error = 'exit 1: HTTP 502: Bad Gateway';
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error });
    h.world.checkouts.head = CHECKOUT_HEAD;
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(run.id)!.checkout!.head).toBe(NEW_HEAD);
    const publish = h.world.commands[2];
    expect(publish.spec.env).toMatchObject({
      CONSOLA_STEP: 'publish',
      CONSOLA_CHECKOUT_HEAD: NEW_HEAD,
      CONSOLA_OUTPUT: path.join(
        h.folder.attemptDir(WORKSPACE_ID, run.id, 'publish', 2),
        'outputs.env',
      ),
    });
    const step = h.store.get(run.id)!.steps![2];
    expect(step).toMatchObject({
      status: 'running',
      attempt: 2,
      previous: [{ attempt: 1, status: 'failed', error }],
    });
    // This attempt's command record is its own: the first one's result is not carried over.
    expect(step.command).toEqual({
      envNames: ['REPO', 'NUMBER', 'VERDICT', 'BODY_FILE'],
      intentAt: h.now().toISOString(),
    });
  });

  it("a retry is the person's: a review they started by hand since does not refuse it", async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.world.byHandRefuses = true;
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.world.launches[0].item).toMatchObject({ startedByHandSince: run.createdAt });
    await h.world.endTurn('session-1', { exitCode: 1 });
    // The automation's review failed; the person reviews by hand, then retries it anyway.
    h.advance(MINUTE);
    h.world.workspace.sessions.push(byHand(PR51, h.now()));
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.launches[1]).toMatchObject({ step: { id: 'review', attempt: 2 } });
    expect(h.world.launches[1].item).not.toHaveProperty('startedByHandSince');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        { id: 'review', status: 'running', attempt: 2, sessionId: 'session-2' },
        { id: 'publish', status: 'pending' },
      ],
    });
  });

  it('retry is refused while another run holds the checkout', async () => {
    const h = await watching({ yaml: TWO_LOOKS });
    acceptEvery(h, TWO_LOOKS);
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    await h.world.endTurn('session-1', { exitCode: 1 });
    expect(h.store.get(first.id)?.status).toBe('failed');
    expect(h.store.get(second.id)?.status).toBe('running');
    const before = structuredClone(h.store.get(first.id));
    const lines = h.history.appends.length;
    await expect(h.service.retry(first.id)).rejects.toThrow(HELD);
    expect(h.store.get(first.id)).toEqual(before);
    expect(h.history.appends).toHaveLength(lines);
    expect(h.world.checkouts.prepared).toHaveLength(2);

    // A session running in the checkout holds it too.
    await h.world.endTurn('session-2');
    h.world.busyFolders.add(CHECKOUT);
    await expect(h.service.retry(first.id)).rejects.toThrow(HELD);
    h.world.busyFolders.clear();
    await h.service.retry(first.id);
    await h.flush();
    expect(h.world.launches.map((launch) => [launch.run.id, launch.step?.attempt])).toEqual([
      [first.id, 1],
      [second.id, 1],
      [first.id, 2],
    ]);
  });

  it('a retry holds the checkout while it prepares: a second retry and a new run on the item wait for it', async () => {
    const h = await watching({ yaml: TWO_LOOKS });
    acceptEvery(h, TWO_LOOKS);
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    await h.world.endTurn('session-1', { exitCode: 1 });
    await h.world.endTurn('session-2', { exitCode: 1 });
    const preparing = held();
    h.world.checkouts.gate = preparing.promise;
    const retrying = h.service.retry(first.id);
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);
    // Both runs failed: only the retry's claim names the folder (3-A code review S1).
    expect(h.service.heldCheckouts()).toEqual([CHECKOUT]);
    await expect(h.service.retry(second.id)).rejects.toThrow(HELD);
    // The item comes back into the list: each automation's new run waits for the checkout.
    await h.poll([]);
    await h.poll([PR51]);
    const later = h.store.runs().filter((run) => run.id !== first.id && run.id !== second.id);
    expect(later.map((run) => [run.status, run.summary])).toEqual([
      ['queued', "waiting for this item's checkout"],
      ['queued', "waiting for this item's checkout"],
    ]);

    h.world.checkouts.gate = undefined;
    preparing.release();
    await retrying;
    await h.flush();
    expect(h.store.get(first.id)).toMatchObject({
      status: 'running',
      checkout: { head: CHECKOUT_HEAD },
    });
    expect(h.world.launches.at(-1)).toMatchObject({ run: { id: first.id }, step: { attempt: 2 } });
    for (const run of later) expect(h.store.get(run.id)?.status).toBe('queued');
  });

  it('a retry whose preparation fails throws and leaves the run as it was', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    await h.world.endTurn('session-1', { exitCode: 1 });
    const before = structuredClone(h.store.get(run.id));
    const lines = h.history.appends.length;
    const why =
      'Could not bring the automation checkout to the head of sprocket/catalog-portal#51: fetch failed. Nothing was read; retry once it can be fetched.';
    h.world.checkouts.fails = new Error(why);
    await expect(h.service.retry(run.id)).rejects.toThrow(why);
    expect(h.store.get(run.id)).toEqual(before);
    expect(h.history.appends).toHaveLength(lines);
    expect(h.service.checkoutHeld(CHECKOUT)).toBe(false);
    expect(h.world.launches).toHaveLength(1);
  });

  it('a run that failed preparing its checkout retries from its first step', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.world.checkouts.fails = new Error('fetch failed');
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      status: 'failed',
      steps: [{ status: 'not-run' }, { status: 'not-run' }],
    });
    h.world.checkouts.fails = undefined;
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      checkout: { cwd: CHECKOUT, head: CHECKOUT_HEAD },
      steps: [
        {
          id: 'review',
          status: 'running',
          attempt: 2,
          sessionId: 'session-1',
          previous: [{ attempt: 1, status: 'not-run' }],
        },
        { id: 'publish', status: 'pending' },
      ],
    });
    expect(h.world.launches).toMatchObject([{ step: { id: 'review', attempt: 2 } }]);
  });

  it('a retry from a command before the review is not refused by a review the person started by hand', async () => {
    const yaml = factory(
      ON_REVIEW_AUTO,
      '- id: fetch\n  run: git fetch --prune',
      '- id: review\n  action: Review',
    );
    const h = await watching({ yaml });
    acceptEvery(h, yaml);
    h.world.byHandRefuses = true;
    await h.poll([PR51]);
    const [run] = h.store.runs();
    await h.world.commands[0].end({
      result: { exitCode: 1, lastStderrLine: 'fatal: unable to access' },
    });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      steps: [
        { id: 'fetch', status: 'failed' },
        { id: 'review', status: 'not-run' },
      ],
    });
    // The person reviews it by hand, then retries the run anyway.
    h.advance(MINUTE);
    h.world.workspace.sessions.push(byHand(PR51, h.now()));
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.commands[1].spec.env.CONSOLA_OUTPUT).toBe(
      path.join(h.folder.attemptDir(WORKSPACE_ID, run.id, 'fetch', 2), 'outputs.env'),
    );
    await h.world.commands[1].end();
    // Its review is still a first attempt, but the run was retried: nothing asks after the review by hand.
    expect(h.world.launches).toMatchObject([{ step: { id: 'review', attempt: 1 } }]);
    expect(h.world.launches[0].item).not.toHaveProperty('startedByHandSince');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        { id: 'fetch', status: 'completed', attempt: 2 },
        { id: 'review', status: 'running', attempt: 1, sessionId: 'session-1' },
      ],
    });
  });

  it('a run that failed before any step is retried even after a review by hand', async () => {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    h.world.byHandRefuses = true;
    h.world.checkouts.fails = new Error('fetch failed');
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(run).toMatchObject({
      status: 'failed',
      steps: [
        { id: 'review', status: 'not-run' },
        { id: 'publish', status: 'not-run' },
      ],
    });
    // The automation never reviewed it; the person does, by hand, then retries the run anyway.
    h.world.checkouts.fails = undefined;
    h.advance(MINUTE);
    h.world.workspace.sessions.push(byHand(PR51, h.now()));
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.launches).toMatchObject([{ step: { id: 'review', attempt: 2 } }]);
    expect(h.world.launches[0].item).not.toHaveProperty('startedByHandSince');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        { id: 'review', status: 'running', attempt: 2, sessionId: 'session-1' },
        { id: 'publish', status: 'pending' },
      ],
    });
  });

  it.each<[string, (h: StepsHarness) => Promise<void>, string]>([
    [
      'factory.yml changed since its preview',
      (h) =>
        h.setYaml(
          TEMPLATE.replace(
            "if: steps.review.verdict != 'approve'",
            "if: steps.review.verdict == 'request-changes'",
          ),
        ),
      'Not run: factory.yml changed since this preview; run it again.',
    ],
    [
      'its entry left factory.yml',
      (h) => h.setYaml('version: 1\nautomations: []\n'),
      'Not run: it is no longer in its workspace’s factory.',
    ],
  ])(
    'a run whose approval was refused because %s never started: retry refuses it and launches nothing',
    async (_, change, refused) => {
      const h = await watching({ yaml: TEMPLATE });
      await h.poll([PR51]);
      const [asked] = h.store.runs();
      expect(asked.status).toBe('needs-approval');
      await change(h);
      await expect(h.service.approve(asked.id)).rejects.toThrow(refused);
      const before = structuredClone(h.store.get(asked.id))!;
      expect(before).toMatchObject({
        status: 'failed',
        error: refused,
        steps: [{ status: 'not-run' }, { status: 'not-run' }],
      });
      expect(before.startedAt).toBeUndefined();

      await expect(h.service.retry(asked.id)).rejects.toThrow(NEVER_STARTED);
      await h.flush();
      expect(h.store.get(asked.id)).toEqual(before);
      expect(h.world.checkouts.prepared).toEqual([]);
      expect(h.world.launches).toEqual([]);
      expect(h.world.commands).toEqual([]);
    },
  );

  it('a queued run its entry problem turned away never started: retry refuses it', async () => {
    // No agent slot: approved, it waits in line.
    const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 0 });
    await h.poll([PR51]);
    const [asked] = h.store.runs();
    await h.service.approve(asked.id);
    await h.flush();
    expect(h.store.get(asked.id)?.status).toBe('queued');

    // Its action goes; the next pump turns it away.
    h.world.workspace.actions = [];
    await h.service.syncWorkspaces();
    h.world.maxConcurrentAgents = 2;
    await h.tick();
    const before = structuredClone(h.store.get(asked.id))!;
    expect(before).toMatchObject({
      status: 'failed',
      error: 'Not run: no action named Review in this workspace.',
    });
    expect(before.startedAt).toBeUndefined();

    await expect(h.service.retry(asked.id)).rejects.toThrow(NEVER_STARTED);
    await h.flush();
    expect(h.store.get(asked.id)).toEqual(before);
    expect(h.world.launches).toEqual([]);
  });

  it('a schedule retries in its scope folder, preparing nothing; a run not failed, another step, or a lost definition is refused', async () => {
    const h = await accepted(THREE);
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    await expect(h.service.retry(run.id)).rejects.toThrow(
      `Run ${run.id} is not a failed steps run.`,
    );
    await h.world.endTurn('session-1', { exitCode: 1 });
    await expect(h.service.retry(run.id, 'two')).rejects.toThrow(
      `Run ${run.id} can be retried only from one.`,
    );
    await h.service.retry(run.id, 'one');
    await h.flush();
    expect(h.world.checkouts.prepared).toEqual([]);
    expect(h.world.launches[1].step).toEqual({
      id: 'one',
      attempt: 2,
      cwd: '/code/api',
      scopeId: 'scope-api',
      name: 'nightly · one',
      checkout: 'scope',
    });

    const gone = await accepted(THREE);
    const lost = (await gone.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await gone.flush();
    await gone.world.endTurn('session-1', { exitCode: 1 });
    fs.rmSync(definitionFile(gone, lost.id));
    const before = structuredClone(gone.store.get(lost.id));
    await expect(gone.service.retry(lost.id)).rejects.toThrow(
      `Its definition is gone from ${gone.folder.runDir(WORKSPACE_ID, lost.id)}; it cannot continue.`,
    );
    expect(gone.store.get(lost.id)).toEqual(before);
    expect(gone.world.launches).toHaveLength(1);
  });
});

describe('picking runs up after a restart', () => {
  it.each<[string, (h: StepsHarness) => void, string]>([
    [
      'is gone',
      (h) => {
        h.world.workspace.sessions = h.world.workspace.sessions.filter(
          (session) => session.id !== 'session-1',
        );
      },
      'Consola quit while it ran, and its session is gone.',
    ],
    [
      'was opened',
      (h) => h.world.liveTerminals.add('session-1'),
      'Consola quit while it ran, and you opened its session.',
    ],
  ])(
    '… or runs again in a new session when that session %s, reminded afresh',
    async (_name, move, why) => {
      let h = await accepted(THREE);
      const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
      await h.flush();
      h.world.writeArtifact('session-1', 'handover', 'Half a write-up.');
      // Quit during its reminder turn.
      await h.world.endTurn('session-1');
      expect(h.store.get(run.id)!.steps![0]).toMatchObject({
        status: 'running',
        reminded: true,
        artifacts: [{ name: 'handover' }],
      });
      move(h);
      h = await h.relaunch();
      expect(h.world.resumes).toEqual([]);
      expect(h.world.launches.map((launch) => launch.step)).toMatchObject([
        { id: 'one', attempt: 1 },
        { id: 'one', attempt: 2 },
      ]);
      const step = h.store.get(run.id)!.steps![0];
      expect(step).toMatchObject({
        status: 'running',
        attempt: 2,
        sessionId: 'session-2',
        previous: [{ attempt: 1, status: 'failed', error: why, finishedAt: h.now().toISOString() }],
      });
      for (const key of ['reminded', 'artifacts', 'outputs', 'command'])
        expect(step).not.toHaveProperty(key);

      // Attempt 2 gets a reminder of its own.
      await h.world.endTurn('session-2');
      expect(h.world.reminders.map((reminder) => reminder.sessionId)).toEqual([
        'session-1',
        'session-2',
      ]);
    },
  );

  it('a launch a quit cut off comes back at the same attempt, and still asks after a review by hand', async () => {
    let h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    // Consola quits while the review launches: no session is recorded.
    h.world.launchGate = new Promise(() => {});
    await h.poll([PR51]);
    const [run] = h.store.runs();
    h.world.launchGate = undefined;
    h = await h.relaunch();
    expect(h.world.launches.map((launch) => launch.step?.attempt)).toEqual([1, 1]);
    expect(h.world.launches[1].item).toMatchObject({ startedByHandSince: run.createdAt });
    expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('previous');
  });

  it('a session opened while its resume starts runs the step again in a new session; any other refusal fails it', async () => {
    let h = await accepted(THREE);
    const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.flush();
    // The person's pane mounts after the look, before the resume spawns: the desktop refuses it.
    h.world.resumeThrows = new SessionOpenedError();
    h = await h.relaunch();
    expect(h.world.resumes).toEqual([{ sessionId: 'session-1', prompt: INTERRUPTED_PROMPT }]);
    expect(h.world.launches.map((launch) => launch.step)).toMatchObject([
      { id: 'one', attempt: 1 },
      { id: 'one', attempt: 2 },
    ]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      steps: [
        {
          id: 'one',
          status: 'running',
          attempt: 2,
          sessionId: 'session-2',
          previous: [
            {
              attempt: 1,
              status: 'failed',
              error: 'Consola quit while it ran, and you opened its session.',
            },
          ],
        },
        { status: 'pending' },
        { status: 'pending' },
      ],
    });

    const other = await accepted(THREE);
    const failing = (await other.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await other.flush();
    other.world.resumeThrows = new Error('Its conversation could not be found.');
    const again = await other.relaunch();
    expect(again.store.get(failing.id)).toMatchObject({
      status: 'failed',
      error: 'Its conversation could not be found.',
      steps: [{ id: 'one', status: 'failed' }, { status: 'not-run' }, { status: 'not-run' }],
    });
    expect(again.world.launches).toHaveLength(1);
  });

  it('an interrupted command is not re-run; retry runs it once', async () => {
    const started = await publishing();
    const { run, publish } = started;
    const h = await started.h.relaunch();
    // The quit abandoned it and stopped its group; the start failed it as interrupted.
    expect(publish.stops).toBe(1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_COMMAND,
      steps: [
        { status: 'completed' },
        { status: 'completed' },
        {
          id: 'publish',
          status: 'failed',
          error: INTERRUPTED_COMMAND,
          command: { intentAt: expect.any(String) },
        },
      ],
    });
    await h.tick();
    expect(h.world.commands).toHaveLength(2);

    await h.service.retry(run.id);
    await h.flush();
    await h.tick();
    expect(h.world.commands).toHaveLength(3);
    expect(h.world.commands[2].spec.env).toMatchObject({
      CONSOLA_STEP: 'publish',
      CONSOLA_OUTPUT: path.join(
        h.folder.attemptDir(WORKSPACE_ID, run.id, 'publish', 2),
        'outputs.env',
      ),
    });
    await h.world.commands[2].end();
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'completed' });
    expect(h.store.get(run.id)!.steps![2].previous).toEqual([
      { attempt: 1, status: 'failed', error: INTERRUPTED_COMMAND, finishedAt: expect.any(String) },
    ]);
    expect(h.world.commands).toHaveLength(3);
  });

  it('a run between steps advances on start', async () => {
    let h = await accepted(THREE);
    const run = await waitingAtTwo(h);
    betweenSteps(h, run.id, 'two');
    h.world.maxConcurrentAgents = undefined;
    h = await h.relaunch();
    expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
    expect(h.store.get(run.id)!.steps).toMatchObject([
      { status: 'completed' },
      { id: 'two', status: 'running', attempt: 1 },
      { status: 'pending' },
    ]);
  });

  it('a run cut off preparing its checkout prepares it after a restart, and the next run on the item is not held forever', async () => {
    let h = await watching({ yaml: TWO_LOOKS });
    acceptEvery(h, TWO_LOOKS);
    // Its preparation never ends in this launch: Consola quits while it fetches.
    h.world.checkouts.gate = new Promise(() => {});
    await h.poll([PR51]);
    const first = byName(h, NAME);
    const second = byName(h, 'second-look');
    expect(first).toMatchObject({ status: 'running', checkout: { cwd: CHECKOUT } });
    expect(first.checkout).not.toHaveProperty('head');
    h.world.checkouts.gate = undefined;
    h = await h.relaunch();
    await h.flush();
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(first.id)).toMatchObject({
      status: 'running',
      checkout: { cwd: CHECKOUT, head: CHECKOUT_HEAD },
    });
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id]);
    expect(h.store.get(second.id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
    });

    await h.world.endTurn('session-1');
    expect(h.store.get(first.id)?.status).toBe('completed');
    expect(h.world.checkouts.prepared).toHaveLength(3);
    expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id, second.id]);
  });

  it('a session closed mid-step frees its slot even while its definition cannot be read', async () => {
    const h = await accepted(file(NIGHTLY3, WEEKLY), { maxConcurrentAgents: 1 });
    const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
    await h.service.trigger(WORKSPACE_ID, 'weekly');
    await h.flush();
    fs.writeFileSync(definitionFile(h, nightly.id), 'not json');
    h.world.workspace.sessions = h.world.workspace.sessions.filter(
      (session) => session.id !== 'session-1',
    );
    await h.service.syncWorkspaces();
    await h.flush();
    const error = 'Its session was closed before it finished.';
    expect(h.store.get(nightly.id)).toMatchObject({
      status: 'failed',
      steps: [{ id: 'one', status: 'failed', error }, { status: 'not-run' }, { status: 'not-run' }],
    });
    expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
    expect(h.notices).toEqual([]);
  });
});

describe('quitting', () => {
  it('quitting stops running commands and records nothing after', async () => {
    const { h, run, publish } = await publishing();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    h.service.shutdown();
    expect(publish.stops).toBe(1);
    const lines = h.history.appends.length;
    const notices = h.notices.length;
    // A stop that arrives during the quit has nothing left to stop, and records nothing either.
    h.service.stop(run.id);
    expect(publish.stops).toBe(1);

    await publish.end({ ...SIGTERMED, stdout: 'posted\n' });
    const step = h.store.get(run.id)!.steps![2];
    expect(step).toMatchObject({
      id: 'publish',
      status: 'running',
      command: { intentAt: expect.any(String) },
    });
    expect(step.command).not.toHaveProperty('exitCode');
    expect(step.command).not.toHaveProperty('signal');
    expect(h.history.appends).toHaveLength(lines);
    expect(h.notices).toHaveLength(notices);
    expect(logged).not.toHaveBeenCalled();
    expect(
      fs.existsSync(
        path.join(h.folder.attemptDir(WORKSPACE_ID, run.id, 'publish', 1), 'outputs.json'),
      ),
    ).toBe(false);

    // The next start fails it as interrupted: the record the retry warning looks for.
    const recovered = recoverAfterRestart(h.store.get(run.id)!, h.now().toISOString())!;
    expect(recovered.steps![2]).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_COMMAND,
      command: { intentAt: step.command!.intentAt },
    });
    expect(recovered.steps![2].command).not.toHaveProperty('exitCode');
    expect(recovered.steps![2].command).not.toHaveProperty('signal');
  });

  it('a command whose environment arrives after a quit is not spawned; the next start runs it', async () => {
    const h = await accepted(COMMANDS_ONLY);
    const env = held();
    h.world.commandEnvGate = env.promise;
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    h.service.shutdown();
    h.world.commandEnvGate = undefined;
    env.release();
    await h.flush();
    expect(h.world.commands).toEqual([]);
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({ id: 'fresh', status: 'queued' });
    expect(h.store.get(run.id)!.steps![0]).not.toHaveProperty('command');

    const next = await h.relaunch();
    expect(next.world.commands).toHaveLength(1);
    expect(next.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'running',
      attempt: 1,
      command: { intentAt: expect.any(String) },
    });
  });

  it('a command that started stays tracked when telling the windows fails', async () => {
    const h = await accepted(COMMANDS_ONLY, { maxConcurrentCommands: 0 });
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    const appendDurably = h.history.appendDurably;
    // Every broadcast throws from the moment its intent is on disk.
    h.history.appendDurably = (workspaceId, record, live) => {
      appendDurably(workspaceId, record, live);
      h.world.broadcastThrows = new Error('The window is gone.');
    };
    h.world.maxConcurrentCommands = undefined;
    await expect(h.service.tick()).rejects.toThrow('The window is gone.');
    h.world.broadcastThrows = undefined;
    h.history.appendDurably = appendDurably;
    // Spawned, and its handle is where a stop reaches it.
    expect(h.world.commands).toHaveLength(1);
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'running',
      command: { intentAt: expect.any(String) },
    });
    h.service.stop(run.id);
    expect(h.world.commands[0].stops).toBe(1);
    await h.world.commands[0].end(SIGTERMED);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: STOPPED_COMMAND });
  });
});

describe('reading a run: steps, logs, artifacts', () => {
  /** TEMPLATE's run with its review done and its command posted (its stdout and stderr on disk). */
  async function published() {
    const h = await watching({ yaml: TEMPLATE });
    h.store.accept(KEY, TEMPLATE_VERSION);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    h.world.setOutputs('session-1', { verdict: 'comment' });
    h.world.writeArtifact('session-1', 'handover', 'Two retries are unbounded.');
    // Each step has a window of its own, apart from the run's.
    h.advance(MINUTE);
    await h.world.endTurn('session-1');
    h.advance(MINUTE);
    await h.world.commands[0].end({ stdout: 'posted\n', stderr: 'warning: slow\n' });
    return { h, run };
  }
  const unchanged = (h: StepsHarness) => ({
    launches: h.world.launches.length,
    commands: h.world.commands.length,
    checkouts: h.world.checkouts.prepared.length,
    notices: h.notices.length,
  });

  it('step detail, logs and artifacts are read from the run folder and start nothing', async () => {
    const { h, run } = await published();
    const before = unchanged(h);

    const detail = h.service.getStepDetail(run.id, 'publish')!;
    expect(detail).toMatchObject({
      runId: run.id,
      step: { id: 'publish', kind: 'run' },
      record: { id: 'publish', status: 'completed' },
    });
    expect(detail.command?.env.map((row) => row.name)).toEqual(['REPO', 'NUMBER', 'BODY_FILE']);
    expect(detail.command?.env[0]).toEqual({
      name: 'REPO',
      template: '{{item.repo}}',
      value: 'sprocket/catalog-portal',
    });
    expect(detail.stdout).toEqual({ text: 'posted\n', bytes: 7, truncated: false });
    expect(detail.stderr?.text).toBe('warning: slow\n');
    expect(h.service.readStepLog(run.id, 'publish', 'stdout')).toEqual({
      text: 'posted\n',
      bytes: 7,
      truncated: false,
    });
    expect(h.service.readStepLog(run.id, 'publish', 'stderr')?.text).toBe('warning: slow\n');
    expect(h.service.readArtifact(run.id, { step: 'review', name: 'handover' })).toEqual({
      content: 'Two retries are unbounded.',
      bytes: 26,
    });
    expect(h.service.getRunDefinition(run.id)?.automation.steps.map((step) => step.id)).toEqual([
      'review',
      'publish',
    ]);

    // An agent step has no command or logs, and a step or run that does not exist answers null.
    const review = h.service.getStepDetail(run.id, 'review')!;
    expect(review).toMatchObject({ step: { kind: 'agent' }, record: { id: 'review' } });
    expect(review).not.toHaveProperty('command');
    expect(h.service.getStepDetail(run.id, 'nope')).toBeNull();
    expect(h.service.getStepDetail('no-such-run', 'publish')).toBeNull();
    expect(h.service.getRunDefinition('no-such-run')).toBeNull();
    expect(h.service.readStepLog(run.id, 'review', 'stdout')).toBeNull();
    expect(h.service.readArtifact(run.id, { step: 'review', name: 'summary' })).toBeNull();

    expect(unchanged(h)).toEqual(before);
  });

  it('readArtifact refuses a name that is not a token', async () => {
    const { h, run } = await published();
    const read = vi.spyOn(h.folder, 'readArtifact');
    // Where `review/../definition` resolves, so a traversal would really find it.
    fs.writeFileSync(
      path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'review', 'definition.md'),
      'outside',
    );

    for (const name of [
      '../definition',
      '../../definition',
      'handover/../../x',
      '',
      'Handover',
      'outputs.env',
      'a'.repeat(65),
    ]) {
      expect(h.service.readArtifact(run.id, { step: 'review', name })).toBeNull();
    }
    for (const step of ['../review', 'review/..', '', 'nope', 'REVIEW']) {
      expect(h.service.readArtifact(run.id, { step, name: 'handover' })).toBeNull();
      expect(h.service.getStepDetail(run.id, step)).toBeNull();
      expect(h.service.readStepLog(run.id, step, 'stdout')).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('never serves outputs.env, nor an artifact the step does not declare', async () => {
    const { h, run } = await published();
    const attempt = h.folder.attemptDir(WORKSPACE_ID, run.id, 'publish', 1);
    fs.writeFileSync(path.join(attempt, 'outputs.env'), 'TOKEN=gho_stub\n');
    // Even named `outputs`, and even once a file of that name exists.
    h.folder.writeArtifact(WORKSPACE_ID, run.id, 'publish', 1, 'outputs', 'gho_stub');
    h.folder.writeArtifact(WORKSPACE_ID, run.id, 'publish', 1, 'stray', 'gho_stub');
    for (const name of ['outputs', 'outputs.env', 'outputs-env', 'stray', 'command', 'stdout']) {
      expect(h.service.readArtifact(run.id, { step: 'publish', name })).toBeNull();
    }
    const everything = JSON.stringify([
      h.service.getStepDetail(run.id, 'publish'),
      h.service.readStepLog(run.id, 'publish', 'stdout'),
    ]);
    expect(everything).not.toContain('gho_stub');
  });

  it("a step's conversation target is the step's own pointer and window", async () => {
    const { h, run } = await published();
    const target = h.service.stepConversationTarget(run.id, 'review')!;
    const review = h.store.get(run.id)!.steps![0];
    expect(target).toMatchObject({
      conversation: review.conversation,
      sessionId: review.sessionId,
      startedAt: review.startedAt,
      finishedAt: review.finishedAt,
      createdAt: run.createdAt,
      attribution: run.attribution,
    });
    expect(target.sessionId).toBeDefined();
    // The step's window, not the run's.
    const ended = h.store.get(run.id)!;
    expect(review.startedAt).toBeDefined();
    expect(target.startedAt).toBe(review.startedAt);
    expect(target.finishedAt).toBe(review.finishedAt);
    expect(target.finishedAt).not.toBe(ended.finishedAt);
    expect(target.finishedAt).not.toBe(ended.startedAt);
    expect(h.service.stepConversationTarget(run.id, 'publish')).toMatchObject({
      sessionId: undefined,
      conversation: undefined,
    });
    expect(h.service.stepConversationTarget(run.id, 'nope')).toBeNull();
    expect(h.service.stepConversationTarget('no-such-run', 'review')).toBeNull();
  });
});

describe('reading a run: failures and the output artifact', () => {
  it('a command.json that is not JSON rejects rather than answering as if there were no command', async () => {
    const h = await watching({ yaml: COMMANDS_ONLY });
    h.store.accept(KEY, automationVersion(only(COMMANDS_ONLY)));
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    await h.world.commands[0].end({ stdout: 'ok\n' });
    const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'fresh', 1);
    expect(h.service.getStepDetail(run.id, 'fresh')?.command).toBeDefined();

    fs.writeFileSync(path.join(dir, 'command.json'), '{ not json');
    expect(() => h.service.getStepDetail(run.id, 'fresh')).toThrow();
    // Genuine absence is still just absent.
    fs.rmSync(path.join(dir, 'command.json'));
    expect(h.service.getStepDetail(run.id, 'fresh')).not.toHaveProperty('command');
  });

  it("reads a command's output artifact", async () => {
    const yaml = factory(
      `${DAILY_IN_API}    mode: auto\n`,
      '- id: facts\n  run: echo hi\n  outputs: { from: stdout, format: text }',
    );
    const h = await watching({ yaml });
    h.store.accept(KEY, automationVersion(only(yaml)));
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    await h.world.commands[0].end({ stdout: 'hi\n' });
    expect(h.service.readArtifact(run.id, { step: 'facts', name: 'output' })).toEqual({
      content: 'hi\n',
      bytes: 3,
    });
  });
});

// Slice 3: Run on…'s last run names the gate a run waits at, or was rejected at.
describe("Run on…'s last run at a gate", () => {
  const GATED = factory(
    `${ON_REVIEW}    mode: auto\n`,
    '- id: look\n  prompt: Look at {{item.url}}.',
    '- id: decide\n  gate: { ask: Post it? }',
    '- id: after\n  run: echo posted',
  );

  async function parked(): Promise<{ h: StepsHarness; run: RunRecord }> {
    const h = await watching({ yaml: GATED });
    acceptEvery(h, GATED);
    await h.poll([PR51]);
    const [run] = h.store.runs();
    await h.world.endTurn(run.steps![0].sessionId!);
    expect(h.store.get(run.id)?.status).toBe('waiting');
    return { h, run: h.store.get(run.id)! };
  }
  const lastRunOn51 = (h: StepsHarness) =>
    h.service.listRunTargets(WORKSPACE_ID, NAME).inbox.find((row) => row.url === PR51.url)?.lastRun;

  it('names the gate a run on the item waits at', async () => {
    const { h, run } = await parked();
    expect(lastRunOn51(h)).toEqual({
      id: run.id,
      status: 'waiting',
      at: run.createdAt,
      gate: 'decide',
    });
  });

  it('names the gate a run on the item was rejected at', async () => {
    const { h, run } = await parked();
    h.service.answerGate(run.id, 'decide', 'reject');
    await h.flush();
    expect(lastRunOn51(h)).toMatchObject({ id: run.id, status: 'rejected', gate: 'decide' });
  });

  it('says a run turned away after it started did start (3-A code review M6)', async () => {
    const { h, run } = await parked();
    // As a run its entry's retry started again ends when a review was started by hand meanwhile.
    h.store.update(run.id, {
      status: 'rejected',
      summary: 'Already started by hand: “Review”.',
      steps: run.steps!.map((step) => ({ ...step, status: 'not-run', gate: undefined })),
      finishedAt: h.now().toISOString(),
    });
    expect(lastRunOn51(h)).toEqual({
      id: run.id,
      status: 'rejected',
      at: h.store.get(run.id)!.finishedAt,
      started: true,
    });
    // One never started (dismissed, or turned away at its fire) says nothing of it.
    h.store.update(run.id, { startedAt: undefined });
    expect(lastRunOn51(h)).not.toHaveProperty('started');
  });

  it('names no gate for a run that went past it', async () => {
    const { h, run } = await parked();
    h.service.answerGate(run.id, 'decide', 'approve');
    await h.flush();
    await h.world.commands.at(-1)!.end();
    expect(h.store.get(run.id)?.status).toBe('completed');
    expect(lastRunOn51(h)).toEqual({
      id: run.id,
      status: 'completed',
      at: h.store.get(run.id)!.finishedAt,
    });
    expect(lastRunOn51(h)).not.toHaveProperty('gate');
  });
});
