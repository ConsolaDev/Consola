import { describe, expect, it } from 'vitest';
import {
  anyRuleOn,
  anySweepRuleOn,
  DEFAULT_WORKTREE_CLEANUP_RULES,
  describeTrigger,
  normalizeRules,
  type WorktreeCleanupRules,
} from '../../shared/worktreeCleanup';
import {
  type DiskFacts,
  judge,
  type JudgeRequest,
  QUIET_PERIOD_MS,
  type UserFacts,
} from './policy';

const NOW = 10 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

const CLEAN: DiskFacts = {
  managed: true,
  scopeFolder: null,
  recentlyPrepared: false,
  heldByRun: false,
  head: 'a'.repeat(40),
  branch: 'consola/session-1',
  dirty: false,
  dirtyFiles: 0,
  published: 'published',
  ignored: { count: 0, paths: [], complete: true },
  nested: { paths: [], complete: true },
  hidden: { kind: 'none' },
  locked: false,
  processes: { kind: 'none' },
};

function rules(patch: Partial<WorktreeCleanupRules> = {}): WorktreeCleanupRules {
  return { ...DEFAULT_WORKTREE_CLEANUP_RULES, ...patch };
}

function user(patch: Partial<UserFacts> = {}): UserFacts {
  return {
    sessionId: 's-1',
    sessionName: 'Review',
    kind: 'interactive',
    status: 'idle',
    shown: false,
    held: false,
    lastActiveAt: NOW - 3 * DAY,
    optedOut: false,
    rules: rules({ settledDays: 1 }),
    settledAt: NOW - 2 * DAY,
    ...patch,
  };
}

const sweep: JudgeRequest = { trigger: 'sweep', targets: new Set(), now: NOW };

function verdictOf(users: UserFacts[], disk: Partial<DiskFacts> = {}, request = sweep) {
  return judge({ tree: '/wt/app-session-1', users, disk: { ...CLEAN, ...disk } }, request);
}

function headline(users: UserFacts[], disk: Partial<DiskFacts> = {}, request = sweep) {
  const verdict = verdictOf(users, disk, request);
  return verdict.decision === 'keep' ? verdict.blockers[0].kind : 'remove';
}

describe('judge: the sweep', () => {
  it('removes a tree whose every user qualifies, keeping its branch', () => {
    expect(verdictOf([user()])).toEqual({
      decision: 'remove',
      tree: '/wt/app-session-1',
      sessionIds: ['s-1'],
      trigger: 'settled',
      branch: 'keep',
    });
  });

  it.each([
    ['cleanup off for the workspace', { rules: null }, 'not-due'],
    ['every rule off', { rules: rules() }, 'not-due'],
    ['not settled', { settledAt: null }, 'not-due'],
    ['settled too recently', { settledAt: NOW - DAY / 2 }, 'not-due'],
    ['the opt-out', { optedOut: true }, 'opted-out'],
    ['working', { status: 'working' as const }, 'busy'],
    ['waiting on the person', { status: 'needs-attention' as const }, 'busy'],
    ['held by a run', { held: true }, 'held'],
    ['open in a window', { shown: true }, 'shown'],
    ['active within the quiet period', { lastActiveAt: NOW - QUIET_PERIOD_MS / 2 }, 'recent'],
    ['a conductor', { kind: 'conductor' as const }, 'conductor'],
  ])('keeps it for %s', (_label, patch, kind) => {
    expect(headline([user(patch)])).toBe(kind);
  });

  it('applies each rule only when it is on', () => {
    const finished = { kind: 'finished' as const, number: 4, status: 'merged' as const };
    const open = { kind: 'open' as const, number: 4 };
    const pr = rules({ prFinished: true });
    expect(headline([user({ rules: pr, settledAt: null, pullRequest: finished })])).toBe('remove');
    expect(headline([user({ rules: pr, settledAt: null, pullRequest: open })])).toBe('not-due');
    expect(
      headline([
        user({
          rules: pr,
          settledAt: null,
          pullRequest: { kind: 'unknown', detail: 'HTTP 502' },
        }),
      ]),
    ).toBe('not-due');
    // The same finished PR with the rule off is no reason.
    expect(headline([user({ rules: rules(), pullRequest: finished })])).toBe('not-due');
  });

  it('says why a session is not due under each rule that is on', () => {
    const verdict = verdictOf([
      user({
        rules: rules({ prFinished: true, settledDays: 7 }),
        pullRequest: { kind: 'open', number: 9 },
        settledAt: NOW - 2 * DAY,
      }),
    ]);
    expect(verdict).toMatchObject({
      decision: 'keep',
      blockers: [
        {
          kind: 'not-due',
          detail: 'pull request #9 is still open; it settled 2 days ago; removed after 7 days',
        },
      ],
    });
  });

  it('lets a run-finished delay replace the quiet period, but never "open in a window"', () => {
    const run = rules({ runFinished: { enabled: true, afterMinutes: 15 } });
    const ended = NOW - 20 * 60_000;
    const automated = user({ rules: run, settledAt: null, runEndedAt: ended, lastActiveAt: ended });
    expect(headline([automated])).toBe('remove');
    expect(verdictOf([automated])).toMatchObject({ trigger: 'run-finished' });
    expect(headline([{ ...automated, runEndedAt: NOW - 5 * 60_000 }])).toBe('not-due');
    expect(headline([{ ...automated, runEndedAt: null }])).toBe('not-due');
    expect(headline([{ ...automated, shown: true }])).toBe('shown');
    const now = rules({ runFinished: { enabled: true, afterMinutes: 0 } });
    expect(headline([{ ...automated, rules: now, runEndedAt: NOW, lastActiveAt: NOW }])).toBe(
      'remove',
    );
  });

  it('keeps a shared tree until every user qualifies', () => {
    const due = user();
    const notDue = user({ sessionId: 's-2', sessionName: 'Fix CI', settledAt: null });
    expect(headline([due, notDue])).toBe('not-due');
    expect(headline([due, { ...notDue, settledAt: NOW - 5 * DAY }])).toBe('remove');
  });

  it('counts a user reached only through its agentCwd like any other', () => {
    // The index puts it on the tree; the decision does not care how.
    const moved = user({ sessionId: 's-3', sessionName: 'Moved in', shown: true });
    expect(headline([user(), moved])).toBe('shown');
  });

  it('honours a per-workspace override: off beats a global rule', () => {
    const offHere = user({ rules: null });
    const onThere = user({ sessionId: 's-2' });
    expect(headline([onThere, offHere])).toBe('not-due');
  });
});

describe('judge: what the folder says', () => {
  it.each([
    ['not a Consola worktree', { managed: false }, 'not-managed'],
    ['a workspace folder', { scopeFolder: 'app' }, 'scope-folder'],
    ['locked', { locked: true }, 'locked'],
    ['a fresh checkout', { recentlyPrepared: true }, 'recently-prepared'],
    ['an automation run holding it (3-A code review S1)', { heldByRun: true }, 'held'],
    [
      'a process',
      { processes: { kind: 'present' as const, processes: [{ pid: 7, command: 'node' }] } },
      'process',
    ],
    ['uncommitted changes', { dirty: true, dirtyFiles: 2 }, 'dirty'],
    ['local commits', { published: 'local-commits' as const }, 'unpublished'],
    ['unverifiable commits', { published: 'unverifiable' as const }, 'unverifiable'],
    ['hidden edits', { hidden: { kind: 'some' as const, paths: ['a.ts'] } }, 'hidden-changes'],
    [
      'an ignored file',
      { ignored: { count: 1, paths: ['.env'], complete: true } },
      'ignored-files',
    ],
    ['a nested repository', { nested: { paths: ['vendor/lib'], complete: true } }, 'nested-repo'],
  ])('keeps it with %s', (_label, disk, kind) => {
    expect(headline([user()], disk)).toBe(kind);
  });

  it.each([
    ['processes unreadable', { processes: { kind: 'unknown' as const } }],
    ['processes not checked', { processes: undefined }],
    ['lock unreadable', { locked: null }],
    ['status unreadable', { dirty: null }],
    ['ignored files cut short', { ignored: { count: 0, paths: [], complete: false } }],
    ['nested repositories cut short', { nested: { paths: [], complete: false } }],
    ['hidden edits unreadable', { hidden: { kind: 'unknown' as const } }],
    ['ignored files not checked', { ignored: undefined }],
  ])('keeps it when a fact is unknown: %s', (_label, disk) => {
    expect(headline([user()], disk)).toBe('unknown');
  });

  it('keeps a tree a run holds under every rule, and when its session is deleted (3-A code review S1)', () => {
    const due = [
      user({ rules: rules({ settledDays: 1 }) }),
      user({
        rules: rules({ prFinished: true }),
        settledAt: null,
        pullRequest: { kind: 'finished', number: 51, status: 'merged' },
      }),
    ];
    for (const one of due) {
      expect(headline([one])).toBe('remove');
      expect(verdictOf([one], { heldByRun: true })).toMatchObject({
        decision: 'keep',
        blockers: [{ kind: 'held', detail: 'an automation run is holding it' }],
      });
    }
    const deleted: JudgeRequest = {
      trigger: 'session-deleted',
      targets: new Set(['s-1']),
      now: NOW,
    };
    expect(headline([user()], {}, deleted)).toBe('remove');
    expect(headline([user()], { heldByRun: true }, deleted)).toBe('held');
  });

  it('writes the sentences the delete dialog shows', () => {
    const verdict = verdictOf([user()], { dirty: true, dirtyFiles: 2 });
    expect(verdict).toMatchObject({
      blockers: [{ kind: 'dirty', detail: '2 files have uncommitted changes' }],
    });
    const env = verdictOf([user()], {
      ignored: { count: 3, paths: ['.env', 'notes.md', 'db.sqlite'], complete: true },
    });
    expect(env).toMatchObject({
      blockers: [
        {
          kind: 'ignored-files',
          detail: '.env, notes.md and 1 more exist only here, ignored by git',
        },
      ],
    });
  });
});

describe('judge: deleting a session', () => {
  const deleting = (trigger: 'session-deleted' | 'tool-delete' = 'session-deleted') => ({
    trigger,
    targets: new Set(['s-1']),
    now: NOW,
  });

  it('waives "open in a window" and the quiet period for the session being deleted', () => {
    const shownNow = user({ shown: true, lastActiveAt: NOW, rules: null, settledAt: null });
    expect(verdictOf([shownNow], {}, deleting())).toMatchObject({
      decision: 'remove',
      trigger: 'session-deleted',
    });
  });

  it('never waives busy, held, or anything about the folder', () => {
    expect(headline([user({ status: 'working' })], {}, deleting())).toBe('busy');
    expect(headline([user({ held: true })], {}, deleting())).toBe('held');
    expect(headline([user()], { dirty: true }, deleting())).toBe('dirty');
  });

  it('keeps a worktree another session still uses', () => {
    const other = user({ sessionId: 's-2', sessionName: 'Fix CI' });
    expect(verdictOf([user(), other], {}, deleting())).toMatchObject({
      decision: 'keep',
      blockers: [{ kind: 'shared', detail: '"Fix CI" still uses it' }],
    });
  });

  it('deletes only a consola/ branch or a finished PR’s branch on a person’s delete', () => {
    const branchOf = (branch: string, pullRequest?: UserFacts['pullRequest']) => {
      const verdict = verdictOf([user({ pullRequest })], { branch }, deleting());
      return verdict.decision === 'remove' ? verdict.branch : 'kept-tree';
    };
    expect(branchOf('consola/session-1')).toBe('delete-at-head');
    expect(branchOf('feature/mine')).toBe('keep');
    expect(branchOf('feature/mine', { kind: 'finished', number: 3, status: 'merged' })).toBe(
      'delete-at-head',
    );
    expect(branchOf('feature/mine', { kind: 'open', number: 3 })).toBe('keep');
  });

  it('keeps today’s branch rule for the tools', () => {
    const verdict = verdictOf([user()], { branch: 'feature/mine' }, deleting('tool-delete'));
    expect(verdict).toMatchObject({ decision: 'remove', branch: 'delete-at-head' });
  });
});

describe("judge: a run's own checkout (slice 3-B Task 19)", () => {
  const RUN_FINISHED = rules({ runFinished: { enabled: true, afterMinutes: 60 } });
  const owned = (run: DiskFacts['run'], disk: Partial<DiskFacts> = {}): Partial<DiskFacts> => ({
    run,
    gitFolder: null,
    branch: 'fix/SHOP-42',
    ...disk,
  });

  it('with no session on it, its run decides: removed once its run ended that long ago, its branch kept', () => {
    expect(verdictOf([], owned({ endedAt: NOW - 2 * 60 * 60_000, rules: RUN_FINISHED }))).toEqual({
      decision: 'remove',
      tree: '/wt/app-session-1',
      sessionIds: [],
      trigger: 'run-finished',
      branch: 'keep',
    });
  });

  it.each([
    [
      'its run is open',
      { endedAt: null, rules: RUN_FINISHED },
      'run-open',
      'its automation run is still open',
    ],
    [
      'its run ended too recently',
      { endedAt: NOW - 30 * 60_000, rules: RUN_FINISHED },
      'not-due',
      'its automation run ended 30 minutes ago; removed after 1 hour',
    ],
    [
      'cleanup is off for its workspace',
      { endedAt: NOW - DAY, rules: null },
      'not-due',
      'cleanup is off for its workspace',
    ],
    [
      'history dropped its run and the history rule is off',
      { endedAt: undefined, rules: RUN_FINISHED },
      'not-due',
      'its automation run is no longer in history',
    ],
    [
      'no rule for runs is on',
      { endedAt: NOW - DAY, rules: rules({ settledDays: 1 }) },
      'not-due',
      'no cleanup rule applies to it',
    ],
  ])('keeps it when %s', (_name, run, kind, detail) => {
    const verdict = verdictOf([], owned(run));
    expect(verdict).toMatchObject({ decision: 'keep', blockers: [{ kind, detail }] });
    expect(verdict.decision === 'keep' && verdict.blockers).toHaveLength(1);
  });

  it('removes it under the history rule once its run is no longer in history', () => {
    expect(
      verdictOf([], owned({ endedAt: undefined, rules: rules({ runForgotten: true }) })),
    ).toMatchObject({ decision: 'remove', trigger: 'run-forgotten', branch: 'keep' });
  });

  it("a step's session on it goes by the run's rule, not its own; busy or recent still keeps it", () => {
    const step = user({ rules: rules(), settledAt: null, lastActiveAt: NOW - 3 * 60 * 60_000 });
    const ended = owned({ endedAt: NOW - 2 * 60 * 60_000, rules: RUN_FINISHED });
    expect(verdictOf([step], ended)).toMatchObject({ decision: 'remove', trigger: 'run-finished' });
    expect(headline([{ ...step, status: 'working' }], ended)).toBe('busy');
    expect(headline([{ ...step, lastActiveAt: NOW - 30 * 60_000 }], ended)).toBe('recent');
    // The run's own rule is the session's here: while the run is open, the tree says why.
    expect(verdictOf([step], owned({ endedAt: null, rules: RUN_FINISHED }))).toMatchObject({
      decision: 'keep',
      blockers: [{ kind: 'run-open' }],
    });
  });

  it('a changed git folder keeps it as unknown, and one never checked is not fully checked', () => {
    expect(
      verdictOf(
        [],
        owned(
          { endedAt: NOW - DAY, rules: RUN_FINISHED },
          { gitFolder: ".git in the checkout is not Consola's pointer", head: undefined },
        ),
      ),
    ).toMatchObject({
      decision: 'keep',
      blockers: [
        {
          kind: 'unknown',
          detail:
            "its git folder changed (.git in the checkout is not Consola's pointer), so Consola did not read it",
        },
      ],
    });
    expect(
      verdictOf([], owned({ endedAt: NOW - DAY, rules: RUN_FINISHED }, { gitFolder: undefined })),
    ).toMatchObject({
      decision: 'keep',
      blockers: [{ kind: 'unknown', detail: 'it was not fully checked' }],
    });
  });

  it('a person deleting a session in it never deletes a branch: it lives in the run clone', () => {
    const verdict = verdictOf(
      [user()],
      owned({ endedAt: NOW - DAY, rules: RUN_FINISHED }, { branch: 'consola/run' }),
      { trigger: 'session-deleted', targets: new Set(['s-1']), now: NOW },
    );
    expect(verdict).toMatchObject({ decision: 'remove', branch: 'keep' });
  });
});

describe('the history rule in the rules value', () => {
  it('is off when absent, written only when on, and counts as a sweep rule', () => {
    expect(normalizeRules({})).not.toHaveProperty('runForgotten');
    expect(normalizeRules({ runForgotten: true })).toMatchObject({ runForgotten: true });
    expect(
      normalizeRules(
        { runForgotten: 'yes' },
        { ...DEFAULT_WORKTREE_CLEANUP_RULES, runForgotten: true },
      ),
    ).toMatchObject({ runForgotten: true });
    expect(
      normalizeRules(
        { runForgotten: false },
        { ...DEFAULT_WORKTREE_CLEANUP_RULES, runForgotten: true },
      ),
    ).not.toHaveProperty('runForgotten');
    expect(anySweepRuleOn(DEFAULT_WORKTREE_CLEANUP_RULES)).toBe(false);
    expect(anySweepRuleOn(rules({ runForgotten: true }))).toBe(true);
    expect(anyRuleOn(rules({ runForgotten: true }))).toBe(true);
    expect(describeTrigger('run-forgotten')).toBe('Its automation run is no longer in history');
  });
});
