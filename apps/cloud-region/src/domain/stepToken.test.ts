import { type GitHubPermissions, TOKEN_REFUSAL_MAX } from '@consola/runner-protocol';
import { describe, expect, it } from 'vitest';
import { automationsOf, checkFactoryFiles } from './factory.js';
import type { RunWrite } from './run.js';
import {
  beyondCheckout,
  grantedAsPurpose,
  judgeDeclared,
  judgeRun,
  MINT_REFUSALS,
  purposeFor,
  RUN_TOKEN_PURPOSES,
  refusalText,
  stepPermissionsOf,
} from './stepToken.js';

const T = '2026-11-25T10:00:00.000Z';

const run = (over: Partial<RunWrite> = {}): RunWrite => ({
  id: 'run-1',
  factoryId: 'f-1',
  factoryVersion: 2,
  parent: null,
  automation: 'review-pr',
  status: 'running',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: {
    url: 'https://github.com/sprocket/catalog-portal/pull/7',
    title: 'Price the catalog in euros',
    kind: 'pr',
    repo: 'sprocket/catalog-portal',
    number: 7,
    headSha: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
    baseRef: 'main',
  },
  runner: 'cloud',
  steps: [],
  request: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: T,
  startedAt: T,
  finishedAt: null,
  updatedAt: T,
  ...over,
});

const REVIEW = `on: { github: pull_request.opened }
steps:
  - id: review
    prompt: Review it.
    outputs: { verdict: { enum: [APPROVE, COMMENT] } }
  - id: post
    run: gh api "repos/$REPO/pulls/$NUMBER/reviews" -f event=COMMENT
    env: { REPO: "{{item.repo}}", NUMBER: "{{item.number}}" }
    permissions: { pull_requests: write }
  - id: quiet
    run: echo hi
  - id: polish
    repeat: { max: 2, until: steps.label.done }
    steps:
      - id: label
        run: echo "done=true" >> "$CONSOLA_OUTPUT"
        outputs: { done: boolean }
        permissions: { issues: write, contents: write }
`;

const automation = () => {
  const files = [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'automations/review-pr.yaml', content: REVIEW },
  ];
  expect(checkFactoryFiles(files)).toEqual({ ok: true, notices: [] });
  const found = automationsOf(files).find((each) => each.name === 'review-pr');
  if (!found) throw new Error('the automation did not parse');
  return found;
};

describe('judgeRun', () => {
  it("takes a running run on its item's repository, in any case", () => {
    expect(judgeRun(run(), 'sprocket/catalog-portal').ok).toBe(true);
    expect(judgeRun(run(), 'Sprocket/Catalog-Portal').ok).toBe(true);
  });

  it('refuses no run, a run not running, and another repository', () => {
    expect(judgeRun(null, 'sprocket/catalog-portal')).toEqual({
      ok: false,
      reason: 'The workspace holds no run with this id.',
    });
    for (const status of ['queued', 'needs-approval', 'completed', 'failed'] as const) {
      expect(judgeRun(run({ status }), 'sprocket/catalog-portal').ok).toBe(false);
    }
    expect(judgeRun(run(), 'sprocket/other').ok).toBe(false);
    expect(judgeRun(run({ item: null }), 'sprocket/catalog-portal').ok).toBe(false);
  });
});

describe('beyondCheckout', () => {
  it('leaves out what every running run may have', () => {
    expect(beyondCheckout({ contents: 'read', metadata: 'read' })).toEqual({});
    expect(beyondCheckout({ contents: 'read', pull_requests: 'write' })).toEqual({
      pull_requests: 'write',
    });
    expect(beyondCheckout({ contents: 'write' })).toEqual({ contents: 'write' });
  });
});

describe('stepPermissionsOf', () => {
  it("reads a run: step's permissions, inside a loop too, and none for one that writes none", () => {
    expect(stepPermissionsOf(automation(), 'post')).toEqual({
      ok: true,
      value: { pull_requests: 'write' },
    });
    expect(stepPermissionsOf(automation(), 'label')).toEqual({
      ok: true,
      value: { contents: 'write', issues: 'write' },
    });
    expect(stepPermissionsOf(automation(), 'quiet')).toEqual({ ok: true, value: {} });
  });

  it('refuses an agent step, a loop and a step the automation does not have', () => {
    expect(stepPermissionsOf(automation(), 'review').ok).toBe(false);
    expect(stepPermissionsOf(automation(), 'polish').ok).toBe(false);
    expect(stepPermissionsOf(automation(), 'deploy').ok).toBe(false);
  });
});

describe('judgeDeclared', () => {
  it('takes what the step declares, at that level or above', () => {
    expect(judgeDeclared({ pull_requests: 'write' }, { pull_requests: 'write' }).ok).toBe(true);
    expect(judgeDeclared({ pull_requests: 'read' }, { pull_requests: 'write' }).ok).toBe(true);
    expect(judgeDeclared({}, {}).ok).toBe(true);
  });

  it('refuses what it does not, naming each permission', () => {
    expect(judgeDeclared({ pull_requests: 'write' }, { pull_requests: 'read' })).toEqual({
      ok: false,
      reason:
        'The step does not declare pull_requests: write in its permissions, so its run gets no token for it.',
    });
    expect(judgeDeclared({ issues: 'write', administration: 'write' }, {})).toEqual({
      ok: false,
      reason:
        'The step does not declare issues: write, administration: write in its permissions, so its run gets no token for it.',
    });
  });
});

describe('purposeFor', () => {
  it("is run-read for the checkout's permissions alone", () => {
    const asks: GitHubPermissions[] = [
      { contents: 'read' },
      { metadata: 'read' },
      { contents: 'read', metadata: 'read' },
    ];
    for (const asked of asks) {
      expect(purposeFor(asked)).toEqual({
        ok: true,
        value: { purpose: 'run-read', grants: { contents: 'read' } },
      });
    }
  });

  it('is review-run for pull requests write, with or without contents read', () => {
    const asks: GitHubPermissions[] = [
      { pull_requests: 'write' },
      { pull_requests: 'write', contents: 'read' },
      { pull_requests: 'write', contents: 'read', metadata: 'read' },
    ];
    for (const asked of asks) {
      expect(purposeFor(asked).ok && purposeFor(asked)).toMatchObject({
        value: { purpose: 'review-run' },
      });
    }
  });

  it('refuses what no purpose grants exactly, in a sentence', () => {
    const asks: GitHubPermissions[] = [
      { pull_requests: 'read' },
      { contents: 'write' },
      { issues: 'write' },
      { pull_requests: 'write', issues: 'write' },
      { pull_requests: 'write', contents: 'write' },
    ];
    for (const asked of asks) {
      const judged = purposeFor(asked);
      expect(judged.ok).toBe(false);
      if (!judged.ok)
        expect(judged.reason).toMatch(/^No GitHub token a run can have grants exactly/);
    }
  });

  it("names only cloud-contract's purposes, each granting contents read", () => {
    expect(RUN_TOKEN_PURPOSES.map((each) => each.purpose)).toEqual(['run-read', 'review-run']);
    for (const { grants } of RUN_TOKEN_PURPOSES) expect(grants.contents).toBe('read');
  });
});

describe('grantedAsPurpose', () => {
  const review = { contents: 'read', pull_requests: 'write' } as const;

  it("takes exactly the purpose's grant, with or without metadata read", () => {
    expect(grantedAsPurpose(review, review)).toBe(true);
    expect(grantedAsPurpose(review, { ...review, metadata: 'read' })).toBe(true);
  });

  it('refuses more, less or other', () => {
    expect(grantedAsPurpose(review, { contents: 'read' })).toBe(false);
    expect(grantedAsPurpose(review, { ...review, issues: 'write' })).toBe(false);
    expect(grantedAsPurpose(review, { contents: 'write', pull_requests: 'write' })).toBe(false);
    expect(grantedAsPurpose({ contents: 'read' }, { contents: 'read', metadata: 'write' })).toBe(
      false,
    );
  });
});

describe('refusalText', () => {
  it("keeps within the protocol's bound", () => {
    expect(refusalText('x'.repeat(TOKEN_REFUSAL_MAX + 10))).toHaveLength(TOKEN_REFUSAL_MAX);
    for (const reason of Object.values(MINT_REFUSALS)) {
      expect(reason.length).toBeLessThanOrEqual(TOKEN_REFUSAL_MAX);
    }
  });
});
