import type { Factory, FactoryFile } from '../domain/factory.js';
import { NO_STEP_DETAIL, tailOf } from '../domain/run.js';
import type {
  OutputValue,
  RunItem,
  RunStatus,
  RunTrigger,
  RunWrite,
  StepDetail,
  StepKind,
  StepRecord,
  StepStatus,
  WaitingOn,
} from '../domain/run.js';
import { withCurrentMembers } from '../domain/team.js';
import type { Team } from '../domain/team.js';
import type {
  CloudSessionStore,
  FactoryStore,
  MembershipReader,
  RunStore,
  TeamStore,
} from './ports.js';
import { recordRun } from './runs.js';
import { seedCodeReviewTeam, seedDemoAgentRun } from './seedTemplates.js';
import type { TemplateSeed } from './seedTemplates.js';
import { CODE_REVIEW_TEAM_TEMPLATE } from '../domain/factoryTemplates.js';

/*
 * Demo runs for every workspace, so the web's Runs pages have something to show before any
 * runner records a run (`src/seed.ts`, which refuses any database but a local PGlite folder).
 * Never reachable over HTTP. Which workspaces there are, and who is in each, is accounts' to say
 * (`MembershipReader`); company keeps no copy of either.
 *
 * Each of the workspace's teams gets a demo factory (made once, its files saved once), and each
 * factory runs: requests in every state, one with several runs of its own, background runs
 * (schedules, events, polls) and people's manual runs. The first team's factory gets the most:
 * more top-level runs than one page holds. Every member a team holds starts at least one request
 * and one manual run, so everyone's "My runs" shows something. Ids are fixed (`demo-…`), and
 * times are counted back from `nowMs`, so seeding again refreshes the runs instead of adding.
 */

/** The demo factory's agent. */
const REVIEWER = '---\ndescription: Reviews changes.\n---\nYou review changes carefully.\n';

/**
 * A small factory that keeps the schema: what the demo runs ran, each automation in a file of
 * its own, so a step's page can say what it was asked and where.
 */
export const DEMO_FACTORY_FILES: readonly FactoryFile[] = [
  { path: 'factory.yml', content: 'version: 1\n' },
  { path: 'agents/reviewer.md', content: REVIEWER },
  {
    path: 'automations/nightly-build.yaml',
    content: `on: { cron: "0 3 * * *" }
scope: storefront
mode: auto
steps:
  - id: build
    run: pnpm install --frozen-lockfile && pnpm build && pnpm test
    env: { CI: "1", BUILD_TARGET: storefront }
    timeout: 20m
  - id: report
    agent: reviewer
    prompt: Summarise last night's build for the team, and name anything that made it slower.
    outputs: { healthy: boolean }
    max_turns: 8
`,
  },
  {
    path: 'automations/review-prs.yaml',
    content: `on: { github: pull_request.opened }
mode: confirm
steps:
  - id: review
    agent: reviewer
    prompt: |
      Review pull request {{item.number}} in {{item.repo}}. Check correctness, tests and
      naming, count what you found, and write the review in the review artifact.
    outputs:
      verdict: { enum: [approve, comment, request-changes] }
      findings: integer
    artifacts: [review]
    max_turns: 12
  - id: comment
    if: steps.review.verdict != 'approve'
    run: gh pr comment "$PR" --body-file "$REVIEW"
    env: { PR: "{{item.number}}", REVIEW: "{{steps.review.review.file}}" }
    timeout: 2m
`,
  },
  {
    path: 'automations/triage-issues.yaml',
    content: `on: { github: issues.opened }
steps:
  - id: triage
    agent: reviewer
    prompt: |
      Triage issue {{item.number}}: label it, and say in your handover which team should own it.
    outputs:
      label: { enum: [bug, feature, question] }
    max_turns: 6
`,
  },
  {
    path: 'automations/dependency-check.yaml',
    content: `on:
  poll:
    every: 1h
    run: gh api repos/acme/storefront/dependabot/alerts
    key: .number
scope: storefront
steps:
  - id: check
    agent: reviewer
    prompt: |
      Check whether the dependency alert below affects code we ship, and say how urgent it is.
    outputs:
      urgent: boolean
    max_turns: 10
`,
  },
  {
    path: 'automations/deploy.yaml',
    content: `on: { manual: {} }
scope: storefront
mode: confirm
steps:
  - id: deploy
    run: pnpm deploy --env production
    env: { DEPLOY_ENV: production }
    timeout: 15m
`,
  },
];

/** The automations the demo factory defines, each with its steps' ids and kinds. */
const AUTOMATIONS = {
  'nightly-build': [
    ['build', 'run'],
    ['report', 'agent'],
  ],
  'review-prs': [
    ['review', 'agent'],
    ['comment', 'run'],
  ],
  'triage-issues': [['triage', 'agent']],
  'dependency-check': [['check', 'agent']],
  deploy: [['deploy', 'run']],
} as const satisfies Record<string, ReadonlyArray<readonly [string, StepKind]>>;

type AutomationName = keyof typeof AUTOMATIONS;

const TRIGGER_DETAIL: Record<AutomationName, { trigger: RunTrigger; detail: string | null }> = {
  'nightly-build': { trigger: 'cron', detail: '0 3 * * *' },
  'review-prs': { trigger: 'event', detail: 'pull_request.opened' },
  'triage-issues': { trigger: 'event', detail: 'issues.opened' },
  'dependency-check': {
    trigger: 'poll',
    detail: 'gh api repos/acme/storefront/dependabot/alerts',
  },
  deploy: { trigger: 'manual', detail: null },
};

const REPO = 'acme/storefront';
const MINUTE = 60_000;
const DAY = 24 * 60;

const pr = (number: number, title: string): RunItem => ({
  url: `https://github.com/${REPO}/pull/${number}`,
  title,
  kind: 'pr',
  repo: REPO,
  number,
});

const issue = (number: number, title: string): RunItem => ({
  url: `https://github.com/${REPO}/issues/${number}`,
  title,
  kind: 'issue',
  repo: REPO,
  number,
});

/**
 * A step's status, where the run stands: `done` steps completed, then the one at `at` in
 * `status`, then the rest `pending` (or `not-run`, `skipped` for a run that has ended).
 */
type Stand = { done: number; status?: StepStatus; rest?: StepStatus };

/** What one demo run is, before its times and ids are set. */
type Plan = {
  key: string;
  automation: AutomationName | null;
  status: RunStatus;
  waitingOn?: WaitingOn;
  /** Minutes before now that it was made, and that it ran for. */
  ago: number;
  took?: number;
  trigger?: RunTrigger;
  startedBy?: string | null;
  item?: RunItem | null;
  stand?: Stand;
  /** What a pull request's review said: `approve` skips the comment. */
  verdict?: 'approve' | 'comment';
  /** The step that is on its second attempt, its first having failed. */
  retried?: string;
  summary?: string;
  error?: string;
  version?: number;
  request?: {
    text: string;
    budget: { usd: number; runs: number } | null;
    question?: { askedAgo: number; untilIn: number };
  };
  children?: Plan[];
};

/** The time `minutes` before `nowMs`, as a runner writes one. */
const before = (nowMs: number, minutes: number) => new Date(nowMs - minutes * MINUTE).toISOString();

const ENDED: ReadonlySet<RunStatus> = new Set([
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
]);

function stepsOf(
  plan: Plan,
  startedAt: string | null,
  finishedAt: string | null,
  nowMs: number,
): StepRecord[] {
  if (plan.automation === null) {
    const status: StepStatus =
      plan.status === 'needs-approval'
        ? 'pending'
        : plan.status === 'rejected'
          ? 'not-run'
          : plan.status === 'expired' || plan.status === 'cancelled'
            ? 'failed'
            : plan.status;
    return [
      {
        id: 'orchestrator',
        kind: 'orchestrator',
        status,
        attempt: 1,
        agent: null,
        model: 'claude-sonnet',
        startedAt,
        finishedAt,
        costUsd: null,
        error: null,
        skipped: null,
        ...NO_STEP_DETAIL,
      },
    ];
  }
  const stand: Stand =
    plan.stand ??
    (plan.status === 'completed'
      ? { done: AUTOMATIONS[plan.automation].length }
      : plan.status === 'failed'
        ? { done: 0, status: 'failed', rest: 'not-run' }
        : { done: 0, status: 'pending' });
  const statuses = AUTOMATIONS[plan.automation].map(
    (_, index): StepStatus =>
      index < stand.done
        ? 'completed'
        : index === stand.done
          ? (stand.status ?? stand.rest ?? 'pending')
          : (stand.rest ?? 'pending'),
  );
  // A review that approves leaves nothing to comment: the comment's condition is false.
  const skipsComment =
    plan.automation === 'review-prs' && (plan.verdict ?? 'approve') === 'approve';
  if (skipsComment && statuses[1] === 'completed') statuses[1] = 'skipped';
  const ranCount = statuses.filter(
    (status) => status === 'completed' || status === 'failed' || status === 'running',
  ).length;
  // The steps that ran share the run's time one after another, so each ended step has its own
  // finish, and a running step starts where the last one ended.
  const runStart = startedAt === null ? null : Date.parse(startedAt);
  const runEnd = finishedAt === null ? nowMs : Date.parse(finishedAt);
  const slot = runStart === null ? 0 : Math.max(0, runEnd - runStart) / Math.max(1, ranCount);
  const at = (ms: number) => new Date(Math.round(ms)).toISOString();
  return AUTOMATIONS[plan.automation].map(([id, kind], index) => {
    const status = statuses[index];
    const ran = status === 'completed' || status === 'failed' || status === 'running';
    const stepStart = runStart === null ? null : runStart + index * slot;
    const detail = ran ? detailOf(plan, id, status) : NO_STEP_DETAIL;
    const retried = plan.retried === id && ran;
    return {
      id,
      kind,
      status,
      attempt: 1,
      agent: kind === 'agent' ? 'reviewer' : null,
      model: kind === 'agent' && ran ? 'claude-sonnet' : null,
      startedAt: ran && stepStart !== null ? at(stepStart) : null,
      finishedAt: ran && status !== 'running' && stepStart !== null ? at(stepStart + slot) : null,
      costUsd: kind === 'agent' && ran ? 0.12 : null,
      error: status === 'failed' ? (plan.error ?? 'The step failed.') : null,
      skipped:
        status === 'skipped'
          ? "Its condition, steps.review.verdict != 'approve', was false."
          : null,
      ...detail,
      ...(retried && stepStart !== null
        ? {
            attempt: 2,
            previous: [
              {
                attempt: 1,
                status: 'failed' as const,
                error: 'Its turn reached its cap of 12 turns without finishing.',
                finishedAt: at(stepStart - MINUTE),
                costUsd: 0.41,
                turns: 12,
              },
            ],
          }
        : {}),
    };
  });
}

/** The lines a nightly build prints: install, build, then a test line per file. */
function buildLog(tests: number): string[] {
  const lines = [
    '$ pnpm install --frozen-lockfile',
    'Lockfile is up to date, resolution step is skipped',
    'Packages: +1284',
    'Progress: resolved 1284, reused 1284, downloaded 0, added 1284, done',
    '$ pnpm build',
    '> storefront@4.12.0 build',
    '> vite build',
    'vite v7.3.8 building for production...',
    '✓ 1873 modules transformed.',
    'dist/index.html                  1.12 kB │ gzip:   0.58 kB',
    'dist/assets/index-4f2a9c1e.css  84.31 kB │ gzip:  13.94 kB',
    'dist/assets/index-b81d3e07.js  612.48 kB │ gzip: 189.02 kB',
    '✓ built in 41.27s',
    '$ pnpm test',
    ' RUN  v4.1.12 /work/storefront',
  ];
  const areas = ['cart', 'checkout', 'catalog', 'search', 'account', 'wishlist', 'prices'];
  for (let n = 0; n < tests; n++) {
    const area = areas[n % areas.length];
    lines.push(
      ` ✓ src/${area}/${area}${n}.test.ts (${12 + (n % 30)} tests) ${90 + ((n * 37) % 800)}ms`,
    );
  }
  return lines;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** A command's output as the runner sends it: the end of each stream, and their sizes. */
function printed(stdout: string, stderr: string, exitCode: number | null): StepDetail {
  const out = tailOf(stdout);
  const err = tailOf(stderr);
  return {
    ...NO_STEP_DETAIL,
    artifacts: [{ name: 'output', bytes: bytesOf(stdout) + bytesOf(stderr) }],
    command: {
      exitCode,
      signal: null,
      stdoutBytes: bytesOf(stdout),
      stderrBytes: bytesOf(stderr),
      truncated: false,
    },
    output: { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated },
  };
}

/** What an agent step did: its turns against its cap, its outputs and its documents. */
function turned(
  turns: number,
  maxTurns: number,
  outputs: Record<string, OutputValue> | null,
  documents: Array<[string, number]>,
  extra: Partial<StepDetail> = {},
): StepDetail {
  return {
    ...NO_STEP_DETAIL,
    turn: { turns, maxTurns, deniedTools: [] },
    outputs,
    artifacts: documents.map(([name, bytes]) => ({ name, bytes })),
    ...extra,
  };
}

/** What a demo step that ran did, printed and produced, by its id and where it stands. */
function detailOf(plan: Plan, stepId: string, status: StepStatus): StepDetail {
  const running = status === 'running';
  const failed = status === 'failed';
  switch (stepId) {
    case 'build': {
      if (failed) {
        const log = buildLog(0).slice(0, 13).join('\n');
        const stderr = [
          "src/checkout/prices.ts(88,14): error TS2322: Type 'string' is not assignable to type 'Money'.",
          'src/checkout/prices.ts(91,3): error TS2554: Expected 2 arguments, but got 1.',
          'Found 2 errors in the same file, starting at: src/checkout/prices.ts:88',
          '[ELIFECYCLE] Command failed with exit code 1.',
        ].join('\n');
        return printed(`${log.split('\n').slice(0, 8).join('\n')}\n`, `${stderr}\n`, 1);
      }
      if (running) {
        // Cut mid-line: the page shows it as the runner last sent it, still coming.
        const lines = buildLog(9);
        return printed(`${lines.join('\n')}\n ✓ src/cart/cart9.test.ts (21 te`, '', null);
      }
      const lines = buildLog(320);
      lines.push(
        ' Test Files  320 passed (320)',
        '      Tests  8934 passed (8934)',
        '   Duration  2m 14s',
      );
      return printed(`${lines.join('\n')}\n`, '', 0);
    }
    case 'deploy':
      return printed(
        [
          '$ pnpm deploy --env production',
          'Building storefront@4.12.0 for production',
          'Uploading 214 files to s3://acme-storefront-prod (38.2 MB)',
          'Invalidating the CDN cache for shop.acme.example',
          'Deployed 4.12.0 to https://shop.acme.example in 2m 41s',
          '',
        ].join('\n'),
        '',
        running ? null : 0,
      );
    case 'comment':
      return printed(
        `https://github.com/${REPO}/pull/${plan.item?.number ?? 1}#issuecomment-2291834\n`,
        '',
        0,
      );
    case 'report':
      return running
        ? turned(2, 8, null, [])
        : turned(3, 8, { healthy: true }, [['handover', 860]]);
    case 'review':
      return running
        ? turned(4, 12, null, [])
        : turned(
            7,
            12,
            { verdict: plan.verdict ?? 'approve', findings: plan.verdict === 'comment' ? 5 : 3 },
            [
              ['handover', 1180],
              ['review', 2140],
            ],
          );
    case 'triage':
      return running
        ? turned(2, 6, null, [])
        : turned(4, 6, { label: 'bug' }, [['handover', 640]], {
            reminded: plan.key === 'triage-done',
          });
    case 'check':
      return failed
        ? turned(3, 10, null, [], {
            turn: { turns: 3, maxTurns: 10, deniedTools: ['Bash(gh auth refresh:*)'] },
          })
        : turned(5, 10, { urgent: false }, [['handover', 720]]);
    default:
      return NO_STEP_DETAIL;
  }
}

/** One run's record from its plan; a child's parent is the request it is under. */
function runOf(
  plan: Plan,
  context: { prefix: string; factoryId: string; version: number; nowMs: number },
  parent: { runId: string; move: number } | null,
): RunWrite {
  const { nowMs } = context;
  const createdAt = before(nowMs, plan.ago);
  const startedAt =
    plan.status === 'queued' || plan.status === 'needs-approval' || plan.status === 'rejected'
      ? null
      : createdAt;
  const finishedAt = ENDED.has(plan.status) ? before(nowMs, plan.ago - (plan.took ?? 4)) : null;
  const steps = stepsOf(plan, startedAt, finishedAt, nowMs);
  const stepCost = steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
  const childCost = (plan.children ?? []).length * 0.24;
  const isRequest = plan.automation === null;
  const spent = {
    usd: Math.round((0.35 + childCost) * 100) / 100,
    runs: plan.children?.length ?? 0,
  };
  const trigger = parent
    ? { trigger: 'manual' as const, detail: null }
    : plan.automation === null
      ? { trigger: 'manual' as const, detail: null }
      : {
          trigger: plan.trigger ?? TRIGGER_DETAIL[plan.automation].trigger,
          detail: TRIGGER_DETAIL[plan.automation].detail,
        };
  return {
    id: `${context.prefix}-${plan.key}`,
    factoryId: context.factoryId,
    factoryVersion: plan.version ?? context.version,
    parent,
    automation: plan.automation,
    status: plan.status,
    waitingOn: plan.status === 'waiting' ? (plan.waitingOn ?? 'run') : null,
    trigger: trigger.trigger,
    triggerDetail: trigger.trigger === 'manual' ? null : trigger.detail,
    startedBy: parent || trigger.trigger !== 'manual' ? null : (plan.startedBy ?? null),
    item: plan.item ?? null,
    runner: 'cloud',
    steps,
    request:
      isRequest && plan.request
        ? {
            text: plan.request.text,
            budget: plan.request.budget,
            spent,
            question: plan.request.question
              ? {
                  at: before(nowMs, plan.request.question.askedAgo),
                  until: before(nowMs, -plan.request.question.untilIn),
                }
              : null,
          }
        : null,
    conversation: null,
    summary: plan.summary ?? null,
    error: plan.error ?? null,
    costUsd: isRequest ? spent.usd : stepCost > 0 ? Math.round(stepCost * 100) / 100 : null,
    createdAt,
    startedAt,
    finishedAt,
    updatedAt: finishedAt ?? before(nowMs, 0),
  };
}

const child = (
  key: string,
  automation: AutomationName,
  status: RunStatus,
  ago: number,
  extra: Partial<Plan> = {},
): Plan => ({ key, automation, status, ago, ...extra });

/** The requests and runs of the first team's factory: every phase, and more than a page. */
function mainPlans(people: ReadonlyArray<string | null>): Plan[] {
  const person = (n: number) => people[n % people.length] ?? null;
  const ask = (text: string, budget = { usd: 20, runs: 8 }) => ({ text, budget });
  const plans: Plan[] = [
    {
      key: 'request-euro-prices',
      automation: null,
      status: 'waiting',
      waitingOn: 'run',
      ago: 42,
      startedBy: person(0),
      request: ask(
        'Add a euro price toggle to the catalog page, and make sure checkout still works.\nCustomers in Lyon asked for it.',
      ),
      children: [
        child('review', 'review-prs', 'completed', 40, {
          item: pr(482, 'Add a euro price toggle'),
        }),
        child('build', 'nightly-build', 'running', 20, { stand: { done: 0, status: 'running' } }),
        child('deploy', 'deploy', 'queued', 2),
      ],
    },
    {
      key: 'request-question',
      automation: null,
      status: 'waiting',
      waitingOn: 'person',
      ago: 75,
      startedBy: person(1),
      request: {
        ...ask('Find out why checkout is slow on Mondays and fix it.'),
        question: { askedAgo: 12, untilIn: 120 },
      },
      children: [child('triage', 'triage-issues', 'completed', 70)],
    },
    {
      key: 'request-gate',
      automation: null,
      status: 'waiting',
      waitingOn: 'run',
      ago: 130,
      startedBy: person(2),
      item: issue(311, 'Ship the spring sale banner'),
      request: ask('Ship the spring sale banner to production.'),
      children: [
        child('review', 'review-prs', 'completed', 125, {
          item: pr(490, 'Spring sale banner'),
          verdict: 'comment',
        }),
        child('deploy', 'deploy', 'needs-approval', 30),
      ],
    },
    {
      key: 'request-turn',
      automation: null,
      status: 'running',
      ago: 6,
      startedBy: person(0),
      item: issue(318, 'Search returns nothing for accented names'),
      request: ask('Fix search for accented names (José, Zoë).'),
    },
    {
      key: 'request-queued',
      automation: null,
      status: 'queued',
      ago: 1,
      startedBy: person(1),
      request: ask('Rename the "Wishlist" page to "Saved items" everywhere.'),
    },
    {
      key: 'request-approval',
      automation: null,
      status: 'needs-approval',
      ago: 15,
      startedBy: person(2),
      request: ask('Upgrade the payment library to its next major version.'),
    },
    {
      key: 'request-done',
      automation: null,
      status: 'completed',
      ago: 2 * DAY,
      took: 55,
      startedBy: person(0),
      summary: 'Shipped the dark mode toggle; both reviews passed.',
      request: ask('Add a dark mode toggle to the account menu.'),
      children: [
        child('review', 'review-prs', 'completed', 2 * DAY - 5, {
          item: pr(470, 'Dark mode toggle'),
        }),
        child('deploy', 'deploy', 'completed', 2 * DAY - 40),
      ],
    },
    {
      key: 'request-failed',
      automation: null,
      status: 'failed',
      ago: 3 * DAY,
      took: 31,
      startedBy: person(1),
      error: "The orchestrator's turn ran 30 minutes without replying.",
      request: ask('Move the image pipeline to the new CDN.'),
      children: [
        child('build', 'nightly-build', 'failed', 3 * DAY - 2, {
          stand: { done: 0, status: 'failed', rest: 'not-run' },
          error: 'exit 1: [ELIFECYCLE] Command failed with exit code 1.',
        }),
      ],
    },
    {
      key: 'request-budget',
      automation: null,
      status: 'cancelled',
      ago: 4 * DAY,
      took: 90,
      startedBy: person(2),
      summary: 'Cancelled: this request used its budget, 2 of 2 runs.',
      request: ask('Try three layouts for the product page and keep the best.', {
        usd: 5,
        runs: 2,
      }),
      children: [
        child('review-a', 'review-prs', 'completed', 4 * DAY - 10, {
          item: pr(455, 'Product page layout A'),
        }),
        child('review-b', 'review-prs', 'cancelled', 4 * DAY - 60, {
          item: pr(456, 'Product page layout B'),
          stand: { done: 1, status: 'not-run', rest: 'not-run' },
        }),
      ],
    },
    {
      key: 'request-rejected',
      automation: null,
      status: 'rejected',
      ago: 5 * DAY,
      took: 1,
      startedBy: person(0),
      request: ask('Delete every abandoned cart older than a year.'),
    },
    {
      key: 'request-expired',
      automation: null,
      status: 'expired',
      ago: 6 * DAY,
      took: 24 * 60,
      startedBy: person(1),
      error: 'Its question waited past its deadline.',
      request: ask('Decide which old coupons to retire.'),
    },
    // Background runs, and people's own.
    child('review-running', 'review-prs', 'running', 3, {
      item: pr(495, 'Lazy-load the product gallery'),
      stand: { done: 0, status: 'running' },
      retried: 'review',
    }),
    // Both reasons a run asks: an automation that asks every time (review-prs, `confirm`), and
    // one whose version was not approved to run on its own (nightly-build, `auto`). Neither is
    // answered, so a person can try it.
    child('review-approval', 'review-prs', 'needs-approval', 25, {
      item: pr(493, 'Bump the analytics script'),
    }),
    child('nightly-approval', 'nightly-build', 'needs-approval', 35),
    child('review-gate', 'review-prs', 'waiting', 50, {
      waitingOn: 'person',
      item: pr(491, 'Refactor the cart service'),
      stand: { done: 1, status: 'waiting' },
      verdict: 'comment',
    }),
    child('triage-done', 'triage-issues', 'completed', 3 * 60, {
      item: issue(320, 'Footer links are broken on mobile'),
      summary: 'Labelled it a bug and assigned it to the web team.',
    }),
    child('deps-failed', 'dependency-check', 'failed', 5 * 60, {
      error: 'gh api answered 401: the token has expired.',
    }),
    child('deps-done', 'dependency-check', 'completed', 6 * 60, {
      summary: 'No alert needs anyone.',
    }),
    child('deploy-cancelled', 'deploy', 'cancelled', 9 * 60, {
      trigger: 'manual',
      startedBy: person(1),
      stand: { done: 0, status: 'not-run', rest: 'not-run' },
    }),
    child('deploy-rejected', 'deploy', 'rejected', 10 * 60, {
      trigger: 'manual',
      startedBy: person(2),
      stand: { done: 0, status: 'not-run', rest: 'not-run' },
    }),
  ];
  // A nightly build for each of the last 40 nights: more than one page of runs.
  for (let night = 1; night <= 40; night++) {
    const failed = night % 9 === 4;
    plans.push(
      child(
        `nightly-${String(night).padStart(2, '0')}`,
        'nightly-build',
        failed ? 'failed' : 'completed',
        night * DAY,
        {
          took: 12,
          version: night > 30 ? 1 : undefined,
          summary: failed ? undefined : 'Built and summarised.',
          error: failed ? 'exit 1: [ELIFECYCLE] Command failed with exit code 1.' : undefined,
        },
      ),
    );
  }
  return plans;
}

/** A smaller set for every other team's factory: a member outside it sees fewer runs. */
function otherPlans(people: ReadonlyArray<string | null>): Plan[] {
  return [
    {
      key: 'request-docs',
      automation: null,
      status: 'waiting',
      waitingOn: 'run',
      ago: 33,
      startedBy: people[0] ?? null,
      request: { text: 'Write the release notes for this week.', budget: { usd: 10, runs: 4 } },
      children: [
        child('triage', 'triage-issues', 'running', 30, { stand: { done: 0, status: 'running' } }),
      ],
    },
    child('nightly-01', 'nightly-build', 'completed', DAY, { took: 12 }),
    child('deps-done', 'dependency-check', 'completed', 8 * 60),
    child('review-approval', 'review-prs', 'needs-approval', 45, {
      item: pr(497, 'Translate the checkout into Spanish'),
    }),
  ];
}

/** The demo factory's name for a team: unique per team, within a factory name's 64. */
const demoNameOf = (team: Team) => [...`Demo · ${team.name}`].slice(0, 64).join('');

/** The team's demo factory, made and given the demo files if it has none yet. */
async function demoFactoryOf(
  factories: FactoryStore,
  workspaceId: string,
  team: Team,
  savedBy: string,
): Promise<Factory | null> {
  const name = demoNameOf(team);
  let factory = (await factories.list(workspaceId)).find(
    (f) => f.name.toLowerCase() === name.toLowerCase(),
  );
  if (!factory) {
    const made = await factories.create(workspaceId, { name, teamId: team.id, personId: savedBy });
    if (typeof made === 'string') return null;
    factory = made;
  }
  // A factory of that name in another team is someone else's: leave it alone.
  if (factory.teamId !== team.id) return null;
  // Its latest version holds the demo files, or a new one is saved that does: a factory seeded
  // before the files changed gets them as its next version, and seeding again saves nothing.
  const latest = await factories.version(workspaceId, factory.id, factory.latestVersion);
  if (!latest || !sameFiles(latest.files, DEMO_FACTORY_FILES)) {
    await factories.save(workspaceId, factory.id, {
      baseVersion: factory.latestVersion,
      files: DEMO_FACTORY_FILES,
      personId: savedBy,
    });
    factory = (await factories.get(workspaceId, factory.id)) ?? factory;
  }
  return factory;
}

/** Whether two sets of files hold the same paths with the same texts. */
function sameFiles(a: readonly FactoryFile[], b: readonly FactoryFile[]): boolean {
  const key = (files: readonly FactoryFile[]) =>
    JSON.stringify(
      [...files].sort((x, y) => (x.path < y.path ? -1 : 1)).map((f) => [f.path, f.content]),
    );
  return key(a) === key(b);
}

export type DemoSeed = {
  /** The demo factories the runs belong to, by name. */
  factories: string[];
  /** How many runs were recorded, children included. */
  runs: number;
};

/**
 * Seeds the demo runs of one workspace: a demo factory per team, and runs of it started by the
 * team's members, or, for a team with none, by the workspace's (as `membership` lists them now).
 */
export async function seedDemoRuns(
  ports: {
    teams: TeamStore;
    factories: FactoryStore;
    runs: RunStore;
    membership: MembershipReader;
  },
  workspaceId: string,
  nowMs: number,
): Promise<DemoSeed> {
  const { teams, factories, runs, membership } = ports;
  const everyone = await membership.memberIds(workspaceId);
  const members = new Set(everyone);
  const all = (await teams.list(workspaceId)).map((team) => withCurrentMembers(team, members));
  const seeded: DemoSeed = { factories: [], runs: 0 };

  for (const [index, team] of all.entries()) {
    const people = team.memberIds.length > 0 ? team.memberIds : [...everyone];
    const factory = await demoFactoryOf(factories, workspaceId, team, people[0] ?? 'demo-seed');
    if (!factory) continue;
    seeded.factories.push(factory.name);
    const context = {
      prefix: `demo-${factory.id.slice(0, 8)}`,
      factoryId: factory.id,
      version: factory.latestVersion,
      nowMs,
    };
    const plans = index === 0 ? mainPlans(people.length > 0 ? people : [null]) : otherPlans(people);
    // Every member of the team starts a request and a manual run of their own.
    people.forEach((personId, n) => {
      plans.push(
        {
          key: `request-own-${n}`,
          automation: null,
          status: 'completed',
          ago: 8 * 60 + n * 37,
          took: 20,
          startedBy: personId,
          summary: 'Answered in the conversation.',
          request: { text: 'What changed in checkout last week?', budget: null },
        },
        child(`deploy-own-${n}`, 'deploy', 'completed', 12 * 60 + n * 41, {
          trigger: 'manual',
          startedBy: personId,
          summary: 'Deployed.',
        }),
      );
    });

    for (const plan of plans) {
      const request = runOf(plan, context, null);
      await record(runs, workspaceId, request);
      seeded.runs += 1;
      for (const [move, childPlan] of (plan.children ?? []).entries()) {
        const parent = { runId: request.id, move: move + 1 };
        await record(
          runs,
          workspaceId,
          runOf({ ...childPlan, key: `${plan.key}-${childPlan.key}` }, context, parent),
        );
        seeded.runs += 1;
      }
    }
  }
  return seeded;
}

async function record(runs: RunStore, workspaceId: string, run: RunWrite) {
  const answer = await recordRun(runs, workspaceId, run);
  if (answer.kind !== 'recorded') {
    const why = answer.kind === 'invalid' ? JSON.stringify(answer.problems) : answer.kind;
    throw new Error(`The demo run ${run.id} was not recorded: ${why}`);
  }
}

/** What the demo seed did in one workspace. */
export type WorkspaceSeed = {
  workspaceId: string;
  /** Its demo factories and runs (`seedDemoRuns`). */
  runs: DemoSeed;
  /** The code review team on its first team (`seedCodeReviewTeam`). */
  template: TemplateSeed;
  /** Its finished agent run of the code review team; null when the template was left alone. */
  agentRun: 'created' | 'unchanged' | null;
};

/**
 * Seeds every workspace there is, as `membership` lists them, one after the other: its demo runs,
 * then the code review team on its first team, with a finished agent run of it. Seeding again
 * refreshes the same runs, saves the template again only when its files differ, and records the
 * agent run once.
 */
export async function seedEveryWorkspace(
  ports: {
    teams: TeamStore;
    factories: FactoryStore;
    runs: RunStore;
    sessions: CloudSessionStore;
    membership: MembershipReader;
  },
  nowMs: number,
): Promise<WorkspaceSeed[]> {
  const seeded: WorkspaceSeed[] = [];
  for (const workspaceId of await ports.membership.workspaceIds()) {
    const runs = await seedDemoRuns(ports, workspaceId, nowMs);
    const template = await seedCodeReviewTeam(ports, workspaceId);
    const agentRun =
      template.kind === 'taken'
        ? null
        : await seedDemoAgentRun(
            ports,
            workspaceId,
            {
              id: template.factoryId,
              name: CODE_REVIEW_TEAM_TEMPLATE.name,
              version: template.version,
            },
            nowMs,
          );
    seeded.push({ workspaceId, runs, template, agentRun });
  }
  return seeded;
}
