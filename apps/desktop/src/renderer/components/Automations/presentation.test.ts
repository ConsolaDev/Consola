import { describe, expect, it } from 'vitest';
import type {
  AgentRunPreview,
  AutomationsSnapshot,
  RunListEntry,
  RunRecord,
} from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
  ASSIGNED_REVIEWS_OFFER,
  collapseSteps,
  filterRuns,
  finalAnswer,
  formatAgo,
  formatCountdown,
  formatDueAt,
  formatDuration,
  formatRunWhen,
  historySlots,
  isRunFilterNarrowed,
  latestRun,
  modeInWords,
  NO_RUN_FILTER,
  ranInWords,
  recentRuns,
  recentRunsInWords,
  runAbout,
  runAutomationOptions,
  runStage,
  sidebarRowState,
  tableShowsUnseenFailures,
  unseenFailures,
  statusLabel,
  statusWord,
  rejectedAtGate,
  runStatusLabel,
  runStatusWord,
  runWorked,
  statusCounts,
  stepWords,
  waitingForWords,
  waitingForYouRuns,
  runWaitingForYou,
  mergeRunPages,
  foldDroppedRuns,
  runRowWords,
  sidebarRunWaits,
  newestRunFirst,
  olderRunsCursor,
  triggerLabel,
  approvalStep,
  runAgainTitle,
  commandFoot,
  formatElapsed,
  groupRunsByDay,
  runKindCounts,
  snapshotRunCounts,
  templateModeWords,
  triggerInWords,
  lastRunWords,
  runOnRows,
  runAgainTarget,
  runInsights,
  runsByDay,
  statusCountsInWords,
  yamlTokens,
  issuesByFile,
  issuesTitle,
  noticesLine,
  type RunListFilter,
  type YamlToken,
} from './presentation';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const by = (filter: Partial<RunListFilter> = {}): RunListFilter => ({
  ...NO_RUN_FILTER,
  ...filter,
});

function run(overrides: Partial<RunListEntry> = {}): RunListEntry {
  const createdAt = overrides.createdAt ?? ago(HOUR);
  return {
    id: 'r1',
    runner: 'local',
    source: 'personal',
    automationId: 'review-prs',
    actionName: 'prompt',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'cron', at: createdAt },
    status: 'completed',
    attribution: { automationId: 'review-prs', actionName: 'prompt', triggerKind: 'cron' },
    createdAt,
    updatedAt: createdAt,
    kind: 'agent',
    ...overrides,
  };
}

function snapshot(
  runs: RunListEntry[],
  automations: AutomationsSnapshot['automations'] = [],
): AutomationsSnapshot {
  return {
    filePath: '/f/factory.yml',
    fileExists: true,
    automations,
    issues: [],
    notices: [],
    runs,
    hasOlder: false,
    queue: {},
    suggestAssignedReviews: false,
    templates: [],
  };
}

describe('statusWord', () => {
  it("calls a parked run's status 'on hold'", () => {
    expect(statusWord('waiting')).toBe('on hold');
    expect(statusLabel('waiting')).toBe('On hold');
  });

  it('says where a run stands in a word, using the run statuses the panel shows', () => {
    expect(statusWord('needs-approval')).toBe('waiting');
    expect(statusWord('rejected')).toBe('dismissed');
    for (const status of ['queued', 'running', 'completed', 'failed'] as const) {
      expect(statusWord(status)).toBe(status);
    }
  });
});

describe('triggerLabel', () => {
  it('uses the fixed words', () => {
    expect(triggerLabel(run())).toBe('scheduled');
    expect(triggerLabel(run({ trigger: { kind: 'cron', at: '', catchUp: true } }))).toBe(
      'catch-up',
    );
    expect(triggerLabel(run({ trigger: { kind: 'event', at: '' } }))).toBe('event');
    expect(triggerLabel(run({ trigger: { kind: 'manual', at: '', by: 'person' } }))).toBe(
      'run now',
    );
    expect(triggerLabel(run({ trigger: { kind: 'manual', at: '', by: 'agent' } }))).toBe(
      'asked by an agent',
    );
  });
});

describe('triggerInWords', () => {
  it('says what fired a run as a run list line', () => {
    expect(triggerInWords(run())).toBe('Scheduled');
    expect(triggerInWords(run({ trigger: { kind: 'cron', at: '', catchUp: true } }))).toBe(
      'Scheduled, run late',
    );
    expect(triggerInWords(run({ trigger: { kind: 'event', at: '' } }))).toBe('Inbox event');
    expect(triggerInWords(run({ trigger: { kind: 'manual', at: '', by: 'person' } }))).toBe(
      'Run by you',
    );
    expect(triggerInWords(run({ trigger: { kind: 'manual', at: '', by: 'agent' } }))).toBe(
      'Asked for by an agent',
    );
  });
});

describe('formatDuration', () => {
  it('counts from startedAt, not createdAt', () => {
    const r = run({ createdAt: ago(HOUR), startedAt: ago(45_000), finishedAt: ago(0) });
    expect(formatDuration(r, NOW)).toBe('45s');
  });

  it('formats minutes and hours, counting to now while unfinished', () => {
    expect(formatDuration(run({ startedAt: ago(192_000) }), NOW)).toBe('3m 12s');
    expect(formatDuration(run({ startedAt: ago(HOUR + 2 * 60_000) }), NOW)).toBe('1h 02m');
  });
});

describe('runAbout', () => {
  it('prefers the item title, then the summary, then the status', () => {
    const item = { key: 'k', url: 'u', title: 'Fix the cart' };
    expect(runAbout(run({ trigger: { kind: 'event', at: '', item }, summary: 's' }))).toBe(
      'Fix the cart',
    );
    expect(runAbout(run({ summary: 'Removed 3 sessions' }))).toBe('Removed 3 sessions');
    expect(runAbout(run({ status: 'failed' }))).toBe('failed');
  });

  it('says why a failed run failed, in the first line of its error, over its summary', () => {
    const failed = run({
      status: 'failed',
      summary: 'Running in “Morning digest”.',
      error: 'It stopped before finishing (exit 1): Error: boom.\n    at main (cli.js:1)',
    });
    expect(runAbout(failed)).toBe('It stopped before finishing (exit 1): Error: boom.');
    // An event run is still about its item.
    const item = { key: 'k', url: 'u', title: 'Fix the cart' };
    expect(runAbout({ ...failed, trigger: { kind: 'event', at: '', item } })).toBe('Fix the cart');
    // With no error to say, the summary still does.
    expect(
      runAbout(run({ status: 'failed', summary: 'Did not finish in “Morning digest”.' })),
    ).toBe('Did not finish in “Morning digest”.');
    // Only a failure prefers its error.
    expect(runAbout(run({ status: 'completed', summary: 'Ready.', error: 'old' }))).toBe('Ready.');
  });
});

describe('mergeRunPages / olderRunsCursor', () => {
  it('lists each run once, newest first, the first page winning', () => {
    const live = run({ id: 'a', createdAt: ago(HOUR), summary: 'live copy' });
    const stale = run({ id: 'a', createdAt: ago(HOUR), summary: 'stale copy' });
    const older = run({ id: 'b', createdAt: ago(2 * HOUR) });
    const merged = mergeRunPages([live], [older, stale]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b']);
    expect(merged[0].summary).toBe('live copy');
  });

  it('continues from the oldest ended run, not an old live one at the end', () => {
    const runs = [
      run({ id: 'new' }),
      run({ id: 'ended', createdAt: ago(2 * HOUR) }),
      run({ id: 'old-live', status: 'running', createdAt: ago(40 * DAY) }),
    ];
    expect(olderRunsCursor(runs)).toBe('ended');
    expect(olderRunsCursor([run({ status: 'queued' })])).toBeUndefined();
  });
});

describe('foldDroppedRuns', () => {
  it('keeps a run the snapshot dropped as its edge moved, once', () => {
    const r200 = run({ id: 'r200', createdAt: ago(10 * HOUR) });
    const r1 = run({ id: 'r1', createdAt: ago(2 * HOUR) });
    const fresh = run({ id: 'fresh', createdAt: ago(HOUR) });
    const older = [run({ id: 'r201', createdAt: ago(11 * HOUR) })];
    const folded = foldDroppedRuns([r1, r200], [fresh, r1], older);
    expect(folded.map((r) => r.id)).toEqual(['r200', 'r201']);
    expect(foldDroppedRuns([r1, r200], [fresh, r1], folded).map((r) => r.id)).toEqual([
      'r200',
      'r201',
    ]);
  });

  it('follows a run from live to ended without dropping or doubling it, and ignores dropped live runs', () => {
    const live = run({ id: 'x', status: 'running', createdAt: ago(40 * DAY) });
    const ended = { ...live, status: 'completed' as const };
    const older = [run({ id: 'o', createdAt: ago(5 * HOUR) })];
    // Still in the snapshot, now ended: nothing to fold.
    expect(foldDroppedRuns([live], [ended], older)).toBe(older);
    // A live run that vanished is not an ended run to keep.
    expect(foldDroppedRuns([live], [], older)).toBe(older);
    // Ended, then pushed out of the edge: kept below.
    expect(foldDroppedRuns([ended], [], older).map((r) => r.id)).toEqual(['o', 'x']);
    expect(mergeRunPages([ended], [live]).map((r) => r.status)).toEqual(['completed']);
  });

  it('orders ties by id descending, as the engine does', () => {
    const at = ago(HOUR);
    const sorted = [run({ id: 'a', createdAt: at }), run({ id: 'b', createdAt: at })].sort(
      newestRunFirst,
    );
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('runRowWords', () => {
  const item = { key: 'k', url: 'u', title: 'Fix the cart' };
  const step = {
    id: 'publish',
    status: 'failed' as const,
    index: 2,
    count: 3,
    kind: 'run' as const,
  };

  it("keeps an event run's item title and puts the step beside it", () => {
    const failed = run({
      status: 'failed',
      trigger: { kind: 'event', at: '', item },
      step,
      error: 'boom',
    });
    expect(runRowWords(failed)).toEqual({ about: 'Fix the cart', step: 'failed at publish' });
  });

  it('uses the step as the title of a steps run with no item', () => {
    expect(runRowWords(run({ status: 'failed', step }))).toEqual({
      about: 'failed at publish',
      step: null,
    });
  });

  it("keeps a legacy failed run's error line", () => {
    const legacy = run({ status: 'failed', error: 'It stopped before finishing (exit 1)\nmore' });
    expect(stepWords(legacy)).toBeNull();
    expect(runRowWords(legacy)).toEqual({
      about: 'It stopped before finishing (exit 1)',
      step: null,
    });
  });
});

describe('sidebarRunWaits (3-A code review M2)', () => {
  it('says a run at a gate waits for the person there, and only an approval for its approval', () => {
    const gate = {
      id: 'decide',
      status: 'waiting' as const,
      index: 3,
      count: 4,
      kind: 'gate' as const,
      gate: true as const,
    };
    expect(sidebarRunWaits(run({ status: 'waiting', step: gate }))).toBe(
      'waiting for you at decide',
    );
    // A loop's row at its exhaustion gate is a gate too.
    expect(
      sidebarRunWaits(run({ status: 'waiting', step: { ...gate, id: 'polish', kind: 'repeat' } })),
    ).toBe('waiting for you at polish');
    expect(sidebarRunWaits(run({ status: 'needs-approval' }))).toBe('waiting for your approval');
  });
});

describe('stepWords', () => {
  const at = (
    status: RunListEntry['status'],
    stepStatus: 'queued' | 'running' | 'failed' | 'completed' | 'not-run',
    extra: Partial<RunListEntry> = {},
  ) =>
    run({
      status,
      step: { id: 'publish', status: stepStatus, index: 2, count: 3, kind: 'run' },
      ...extra,
    });

  it('says which step a run is at', () => {
    expect(stepWords(at('running', 'running'))).toBe('running · publish');
    expect(stepWords(at('running', 'queued'))).toBe('waiting for a slot before publish');
    expect(stepWords(at('failed', 'failed'))).toBe('failed at publish');
  });

  it('says a run that failed between steps failed before the one it did not reach', () => {
    // The engine names the step it stopped before (`not-run`): "failed at" it would be untrue.
    expect(stepWords(at('failed', 'not-run'))).toBe('failed before publish');
  });

  it("says a run waits for its item's checkout", () => {
    expect(stepWords(run({ status: 'queued', summary: "waiting for this item's checkout" }))).toBe(
      "waiting for this item's checkout",
    );
  });

  it('is null for a legacy run, and for states with nothing to add', () => {
    expect(stepWords(run({ status: 'running' }))).toBeNull();
    expect(stepWords(run({ status: 'queued', summary: 'queued' }))).toBeNull();
    expect(stepWords(at('completed', 'completed'))).toBeNull();
  });
});

describe('filterRuns', () => {
  it('lists a steps run of kind agent under Prompts & reviews', () => {
    const runs = [
      run({
        id: 's',
        kind: 'agent',
        step: { id: 'review', status: 'completed', index: 1, count: 2, kind: 'agent' },
      }),
      run({ id: 't', kind: 'tool' }),
    ];
    expect(filterRuns(runs, by({ kind: 'agent' }), NOW).map((r) => r.id)).toEqual(['s']);
  });

  it('keeps what history keeps: a run that ended in the last 30 days, and every live one; newest first', () => {
    const runs = [
      run({ id: 'old', createdAt: ago(31 * DAY) }),
      // Created long ago, but it ended within 30 days.
      run({
        id: 'long',
        createdAt: ago(40 * DAY),
        updatedAt: ago(29 * DAY),
        finishedAt: ago(29 * DAY),
      }),
      // When it finished is what counts, not when it was last touched.
      run({
        id: 'ended',
        createdAt: ago(40 * DAY),
        updatedAt: ago(DAY),
        finishedAt: ago(31 * DAY),
      }),
      run({ id: 'a', createdAt: ago(2 * DAY) }),
      run({ id: 'b', createdAt: ago(HOUR) }),
      // Waiting for a person or a slot, or working: never hidden, however old.
      run({ id: 'waiting', status: 'needs-approval', createdAt: ago(45 * DAY) }),
      run({ id: 'queued', status: 'queued', createdAt: ago(46 * DAY) }),
      run({ id: 'running', status: 'running', createdAt: ago(47 * DAY) }),
    ];
    expect(filterRuns(runs, by(), NOW).map((r) => r.id)).toEqual([
      'b',
      'a',
      'long',
      'waiting',
      'queued',
      'running',
    ]);
  });

  it('matches an item title case-insensitively', () => {
    const item = { key: 'k', url: 'u', title: 'Add Catalog Search' };
    const runs = [run({ id: 'x', trigger: { kind: 'event', at: '', item } }), run({ id: 'y' })];
    expect(filterRuns(runs, by({ query: 'catalog search' }), NOW).map((r) => r.id)).toEqual(['x']);
  });

  it('matches the automation name and the summary', () => {
    const runs = [
      run({ id: 'x', summary: 'Removed 3 sessions' }),
      run({ id: 'y', automationId: 'digest' }),
    ];
    expect(filterRuns(runs, by({ query: 'REMOVED' }), NOW).map((r) => r.id)).toEqual(['x']);
    expect(filterRuns(runs, by({ query: 'digest' }), NOW).map((r) => r.id)).toEqual(['y']);
  });

  it('applies the kind filters: agent, tool plus requests, failed', () => {
    const runs = [
      run({ id: 'a', kind: 'agent' }),
      run({ id: 't', kind: 'tool' }),
      run({ id: 'q', kind: 'request' }),
      run({ id: 'f', kind: 'tool', status: 'failed' }),
    ];
    expect(filterRuns(runs, by({ kind: 'agent' }), NOW).map((r) => r.id)).toEqual(['a']);
    expect(
      filterRuns(runs, by({ kind: 'tool' }), NOW)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['f', 'q', 't']);
    expect(filterRuns(runs, by({ kind: 'failed' }), NOW).map((r) => r.id)).toEqual(['f']);
  });

  it('narrows to one automation by its id, exactly, and combines with the other filters', () => {
    const runs = [
      run({ id: 'r', automationId: 'review-prs' }),
      run({ id: 'r2', automationId: 'review-prs-nightly' }),
      run({ id: 'rf', automationId: 'review-prs', status: 'failed' }),
      run({ id: 'd', automationId: 'digest' }),
    ];
    expect(
      filterRuns(runs, by({ automation: 'review-prs' }), NOW)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['r', 'rf']);
    expect(
      filterRuns(runs, by({ automation: 'review-prs', kind: 'failed' }), NOW).map((r) => r.id),
    ).toEqual(['rf']);
    expect(filterRuns(runs, by({ automation: 'digest', query: 'review' }), NOW)).toEqual([]);
  });
});

describe('isRunFilterNarrowed', () => {
  it('is false only for no query (blank counts as none), every kind and every automation', () => {
    expect(isRunFilterNarrowed(by({ query: '   ' }))).toBe(false);
    expect(isRunFilterNarrowed(by({ query: 'x' }))).toBe(true);
    expect(isRunFilterNarrowed(by({ kind: 'failed' }))).toBe(true);
    expect(isRunFilterNarrowed(by({ automation: 'digest' }))).toBe(true);
  });
});

describe('runAutomationOptions', () => {
  const auto = (name: string) => ({ name }) as AutomationsSnapshot['automations'][number];

  it("lists the file's entries in order, then what else has runs, each with its count", () => {
    const history = [
      run({ id: '1', automationId: 'digest' }),
      run({ id: '2', automationId: 'digest' }),
      run({ id: '3', automationId: 'removed-one' }),
      run({
        id: '4',
        automationId: 'consola#delete_session',
        source: 'manual',
        actionName: 'consola#delete_session',
      }),
    ];
    const options = runAutomationOptions(
      snapshot([], [auto('sweep'), auto('digest')]),
      history,
      null,
    );
    expect(options).toEqual([
      { id: 'sweep', label: 'sweep', count: 0, inFile: true },
      { id: 'digest', label: 'digest', count: 2, inFile: true },
      { id: 'removed-one', label: 'removed-one', count: 1, inFile: false },
      // An agent's request reads as its rows do.
      { id: 'consola#delete_session', label: 'Delete session', count: 1, inFile: false },
    ]);
  });

  it('keeps the chosen automation listed when nothing else would list it', () => {
    expect(runAutomationOptions(snapshot([]), [], 'gone')).toEqual([
      { id: 'gone', label: 'gone', count: 0, inFile: false },
    ]);
  });
});

describe('formatRunWhen', () => {
  // Local times, so the calendar days do not depend on the machine's zone.
  const now = new Date(2026, 10, 12, 20, 0);
  const at = (month: number, day: number, hour: number, year = 2026) =>
    new Date(year, month, day, hour, 28);
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  it('says only the time today, "Yesterday" the day before, and the weekday within the week', () => {
    const today = at(10, 12, 18);
    const yesterday = at(10, 11, 9);
    const thisWeek = at(10, 7, 9);
    expect(formatRunWhen(today.toISOString(), now)).toBe(time(today));
    expect(formatRunWhen(yesterday.toISOString(), now)).toBe(`Yesterday, ${time(yesterday)}`);
    expect(formatRunWhen(thisWeek.toISOString(), now)).toBe(
      `${thisWeek.toLocaleDateString(undefined, { weekday: 'short' })}, ${time(thisWeek)}`,
    );
  });

  it('says the date from a week back, with the year only when it is not this one', () => {
    const lastWeek = at(10, 5, 9);
    const lastYear = at(11, 30, 9, 2025);
    expect(formatRunWhen(lastWeek.toISOString(), now)).toBe(
      `${lastWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(lastWeek)}`,
    );
    expect(formatRunWhen(lastYear.toISOString(), now)).toContain(
      lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    );
  });

  it('says nothing for a time it cannot read', () => {
    expect(formatRunWhen('not a date', now)).toBe('');
  });
});

describe('sidebarRowState', () => {
  const lastSeen = ago(DAY);

  it('is idle without a snapshot', () => {
    expect(sidebarRowState(undefined, lastSeen, 0)).toEqual({ kind: 'idle' });
  });

  it('ranks waiting above failed above running', () => {
    const waiting = run({ id: 'w', status: 'needs-approval' });
    const failed = run({ id: 'f', status: 'failed', finishedAt: ago(HOUR) });
    const running = run({ id: 'r', status: 'running' });
    expect(sidebarRowState(snapshot([running, failed, waiting]), lastSeen, 1)).toEqual({
      kind: 'waiting',
      count: 1,
    });
    expect(sidebarRowState(snapshot([running, failed]), lastSeen, 0)).toEqual({
      kind: 'failed',
      count: 1,
    });
    expect(sidebarRowState(snapshot([running]), lastSeen, 0)).toEqual({
      kind: 'running',
      count: 1,
    });
  });

  it('does not count a failure from before lastSeen', () => {
    const old = run({ status: 'failed', finishedAt: ago(2 * DAY) });
    expect(sidebarRowState(snapshot([old]), lastSeen, 0)).toEqual({ kind: 'idle' });
  });

  it('counts only running agent runs', () => {
    const tool = run({ status: 'running', kind: 'tool' });
    expect(sidebarRowState(snapshot([tool]), lastSeen, 0)).toEqual({ kind: 'idle' });
  });
});

describe('unseenFailures', () => {
  it('is the failures that ended after the person last looked', () => {
    const fresh = run({ id: 'fresh', status: 'failed', finishedAt: ago(HOUR) });
    const old = run({ id: 'old', status: 'failed', finishedAt: ago(2 * DAY) });
    const fine = run({ id: 'fine', status: 'completed', finishedAt: ago(HOUR) });
    expect(unseenFailures(snapshot([fresh, old, fine]), ago(DAY)).map((entry) => entry.id)).toEqual(
      ['fresh'],
    );
  });
});

describe('tableShowsUnseenFailures', () => {
  const lastSeen = ago(DAY);
  const auto = (name: string) => ({ name }) as AutomationsSnapshot['automations'][number];
  const failed = (id: string, automationId: string) =>
    run({ id, automationId, status: 'failed', createdAt: ago(2 * HOUR), finishedAt: ago(HOUR) });

  it('holds with nothing unseen', () => {
    expect(tableShowsUnseenFailures(snapshot([], [auto('digest')]), lastSeen, NOW)).toBe(true);
  });

  it('holds when each unseen failure is what its row says under "Last run"', () => {
    const runs = [
      failed('a', 'digest'),
      failed('b', 'sweep'),
      run({ id: 'old', automationId: 'digest', createdAt: ago(3 * HOUR) }),
    ];
    expect(
      tableShowsUnseenFailures(snapshot(runs, [auto('digest'), auto('sweep')]), lastSeen, NOW),
    ).toBe(true);
  });

  it('fails for a failure outside factory.yml, which only Activity lists', () => {
    const runs = [failed('a', 'digest'), failed('b', 'removed-one')];
    expect(tableShowsUnseenFailures(snapshot(runs, [auto('digest')]), lastSeen, NOW)).toBe(false);
  });

  it('fails for a failure a later run has taken the place of', () => {
    const later = run({ id: 'later', automationId: 'digest', createdAt: ago(HOUR / 2) });
    expect(
      tableShowsUnseenFailures(
        snapshot([later, failed('a', 'digest')], [auto('digest')]),
        lastSeen,
        NOW,
      ),
    ).toBe(false);
  });

  it('fails for a failure behind a run waiting for you, which the row speaks for however old', () => {
    const waiting = run({
      id: 'w',
      automationId: 'digest',
      status: 'needs-approval',
      createdAt: ago(5 * HOUR),
    });
    expect(
      tableShowsUnseenFailures(
        snapshot([failed('a', 'digest'), waiting], [auto('digest')]),
        lastSeen,
        NOW,
      ),
    ).toBe(false);
  });
});

const step = (n: number): ConversationEntry => ({ kind: 'step', tool: `Tool${n}` });
const prompt: ConversationEntry = { kind: 'prompt', text: 'Review this' };
const answerText: ConversationEntry = { kind: 'text', text: 'All good.' };

describe('collapseSteps', () => {
  it('leaves nine steps alone', () => {
    const entries = [prompt, ...Array.from({ length: 9 }, (_, i) => step(i)), answerText];
    expect(collapseSteps(entries)).toEqual(entries);
  });

  it('collapses twelve steps to 4, a "more" of 4, and 4', () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(i));
    const result = collapseSteps([prompt, ...steps, answerText]);
    expect(result).toEqual([
      prompt,
      ...steps.slice(0, 4),
      { kind: 'more', count: 4, hidden: steps.slice(4, 8) },
      ...steps.slice(8),
      answerText,
    ]);
  });
});

describe('finalAnswer', () => {
  it('takes the text after the last step, joined by blank lines', () => {
    const result = finalAnswer([
      prompt,
      step(1),
      { kind: 'text', text: 'One.' },
      { kind: 'text', text: 'Two.' },
    ]);
    expect(result.answer).toBe('One.\n\nTwo.');
    expect(result.steps).toEqual([step(1)]);
  });

  it('treats texts between steps as steps', () => {
    const between: ConversationEntry = { kind: 'text', text: 'Looking now.' };
    const result = finalAnswer([prompt, step(1), between, step(2), answerText]);
    expect(result.steps).toEqual([step(1), between, step(2)]);
    expect(result.answer).toBe('All good.');
  });

  it('has no answer when the run ended on a step', () => {
    expect(finalAnswer([prompt, step(1)]).answer).toBeNull();
  });
});

describe('modeInWords', () => {
  it('says what each mode does when it fires', () => {
    expect(modeInWords('confirm')).toBe('Asks you before each run');
    expect(modeInWords('notify')).toBe('Tells you what it would do, and starts nothing');
    expect(modeInWords('auto')).toBe('Runs on its own');
    expect(modeInWords('auto', true)).toBe(
      'Runs on its own once you approve a run no agent asked for',
    );
  });

  it("keeps today's words for cron, event and manual entries", () => {
    for (const source of ['cron', 'event', 'manual'] as const) {
      expect(modeInWords('auto', true, source, true)).toBe(
        'Runs on its own once you approve a run no agent asked for',
      );
      expect(modeInWords('confirm', false, source)).toBe('Asks you before each run');
      expect(modeInWords('notify', false, source)).toBe(
        'Tells you what it would do, and starts nothing',
      );
    }
  });

  it('says a poll waits for Allow, not for approving a run', () => {
    expect(modeInWords('auto', false, 'poll', true)).toBe('Runs on its own once you allow it');
    expect(modeInWords('confirm', false, 'poll', true)).toBe(
      'Asks you before each run, once you allow it',
    );
    expect(modeInWords('notify', false, 'poll', true)).toBe('Runs dry runs once you allow it');
  });

  it("says today's words for a poll once it is allowed", () => {
    expect(modeInWords('auto', false, 'poll', false)).toBe('Runs on its own');
    expect(modeInWords('confirm', false, 'poll', false)).toBe('Asks you before each run');
  });
});

const preview: AgentRunPreview = { kind: 'agent-run', runs: 'Review action', prompt: 'Review #4' };

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const { kind: _kind, ...base } = run();
  return { ...base, ...overrides };
}

describe('ranInWords', () => {
  it("names an agent run's target from its preview, and a tool by its name", () => {
    expect(ranInWords(record({ result: preview }))).toBe('Review action');
    expect(ranInWords(record({ actionName: 'consola#cleanup_stale_sessions' }))).toBe(
      'Tool: cleanup_stale_sessions',
    );
  });
});

describe('runStage', () => {
  it('places an agent run by where it stands', () => {
    expect(runStage(record({ result: preview, status: 'needs-approval' }))).toBe('agent-waiting');
    expect(runStage(record({ result: preview, status: 'queued' }))).toBe('agent-queued');
    expect(runStage(record({ result: preview, status: 'running' }))).toBe('agent-running');
  });

  it('has a conversation to show once a session ran it', () => {
    expect(runStage(record({ result: preview, status: 'completed', sessionId: 's1' }))).toBe(
      'agent-finished',
    );
    const conversation = { harnessId: 'h', id: 'c' };
    expect(runStage(record({ result: preview, status: 'failed', conversation }))).toBe(
      'agent-finished',
    );
  });

  it('has none when nothing started: dismissed, notify, or it could not start', () => {
    expect(runStage(record({ result: preview, status: 'rejected' }))).toBe('agent-unstarted');
    expect(runStage(record({ result: preview, status: 'completed' }))).toBe('agent-unstarted');
    expect(runStage(record({ result: preview, status: 'failed', error: 'No folder' }))).toBe(
      'agent-unstarted',
    );
  });

  it('treats everything else as a tool run, whatever its result', () => {
    expect(runStage(record({ status: 'needs-approval', result: { skipped: [] } }))).toBe('tool');
    expect(runStage(record({ status: 'completed' }))).toBe('tool');
  });
});

describe('formatAgo', () => {
  it('counts minutes, hours and days back, and says the date from a week back', () => {
    expect(formatAgo(ago(20_000), NOW)).toBe('just now');
    expect(formatAgo(ago(14 * 60_000), NOW)).toBe('14m ago');
    expect(formatAgo(ago(3 * HOUR + 59 * 60_000), NOW)).toBe('3h ago');
    expect(formatAgo(ago(2 * DAY + HOUR), NOW)).toBe('2d ago');
    expect(formatAgo(ago(9 * DAY), NOW)).toBe(formatRunWhen(ago(9 * DAY), NOW).split(',')[0]);
    expect(formatAgo('not a date', NOW)).toBe('');
  });
});

describe('formatCountdown', () => {
  const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  it('counts down in minutes, then hours and minutes, then days and hours', () => {
    expect(formatCountdown(ahead(14 * 60_000), NOW)).toBe('in 14m');
    expect(formatCountdown(ahead(3 * HOUR + 12 * 60_000), NOW)).toBe('in 3h 12m');
    expect(formatCountdown(ahead(5 * HOUR), NOW)).toBe('in 5h');
    expect(formatCountdown(ahead(2 * DAY + 4 * HOUR), NOW)).toBe('in 2d 4h');
    expect(formatCountdown(ahead(3 * DAY), NOW)).toBe('in 3d');
  });

  it('rounds minutes up, so it never says "in 0m" while time is left', () => {
    expect(formatCountdown(ahead(10_000), NOW)).toBe('in 1m');
    expect(formatCountdown(ahead(59 * 60_000 + 30_000), NOW)).toBe('in 1h');
  });

  it('is due now once the time has come', () => {
    expect(formatCountdown(NOW.toISOString(), NOW)).toBe('due now');
    expect(formatCountdown(ago(30_000), NOW)).toBe('due now');
    expect(formatCountdown('not a date', NOW)).toBe('');
  });
});

describe('formatDueAt', () => {
  // Local times, so the calendar days do not depend on the machine's zone.
  const now = new Date(2026, 10, 12, 8, 0);
  const at = (month: number, day: number, hour: number, year = 2026) =>
    new Date(year, month, day, hour, 30);
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  it('says only the time today, "Tomorrow" the day after, and the weekday within the week', () => {
    const today = at(10, 12, 21);
    const tomorrow = at(10, 13, 9);
    const thisWeek = at(10, 16, 9);
    expect(formatDueAt(today.toISOString(), now)).toBe(time(today));
    expect(formatDueAt(tomorrow.toISOString(), now)).toBe(`Tomorrow, ${time(tomorrow)}`);
    expect(formatDueAt(thisWeek.toISOString(), now)).toBe(
      `${thisWeek.toLocaleDateString(undefined, { weekday: 'short' })}, ${time(thisWeek)}`,
    );
  });

  it('says the date from a week ahead, with the year only when it is not this one', () => {
    const nextWeek = at(10, 20, 9);
    const nextYear = at(0, 2, 9, 2027);
    expect(formatDueAt(nextWeek.toISOString(), now)).toBe(
      `${nextWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(nextWeek)}`,
    );
    expect(formatDueAt(nextYear.toISOString(), now)).toContain('2027');
  });
});

describe('recentRuns', () => {
  it("draws one automation's latest runs, oldest first, capped", () => {
    const runs = [
      run({ id: 'new', createdAt: ago(HOUR) }),
      run({ id: 'other', automationId: 'other', createdAt: ago(2 * HOUR) }),
      run({ id: 'mid', createdAt: ago(3 * HOUR) }),
      run({ id: 'old', createdAt: ago(4 * HOUR) }),
    ];
    expect(recentRuns(runs, 'review-prs', NOW).map((entry) => entry.id)).toEqual([
      'old',
      'mid',
      'new',
    ]);
    expect(recentRuns(runs, 'review-prs', NOW, 2).map((entry) => entry.id)).toEqual(['mid', 'new']);
  });

  it('leaves out what history has dropped, as Activity does', () => {
    const runs = [
      run({ id: 'kept', createdAt: ago(DAY) }),
      run({ id: 'gone', createdAt: ago(40 * DAY) }),
    ];
    expect(recentRuns(runs, 'review-prs', NOW).map((entry) => entry.id)).toEqual(['kept']);
  });
});

describe('historySlots', () => {
  it('pads on the left, so the newest run is always the last slot', () => {
    expect(historySlots(['a', 'b'], 4)).toEqual([null, null, 'a', 'b']);
    expect(historySlots([], 3)).toEqual([null, null, null]);
  });

  it('keeps only the newest runs when there are more than slots', () => {
    expect(historySlots(['a', 'b', 'c', 'd'], 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('recentRunsInWords', () => {
  it('counts each outcome, completed first', () => {
    const runs = [run({ status: 'failed' }), run(), run(), run({ status: 'running' })];
    expect(recentRunsInWords(runs)).toBe('Last 4 runs: 2 completed, 1 failed, 1 running');
  });

  it('counts a parked run as on hold, right after the ones waiting for approval', () => {
    const runs = [run(), run({ status: 'waiting' }), run({ status: 'needs-approval' })];
    expect(recentRunsInWords(runs)).toBe('Last 3 runs: 1 completed, 1 waiting, 1 on hold');
  });

  it('says "all" when every run went the same way', () => {
    expect(recentRunsInWords([run(), run(), run()])).toBe('Last 3 runs: all completed');
    expect(recentRunsInWords([run({ status: 'failed' })])).toBe('Last run: failed');
    expect(recentRunsInWords([])).toBe('No runs in the last 30 days');
  });
});

describe('latestRun', () => {
  it('speaks for a run waiting for the person first, however old', () => {
    const waiting = run({ id: 'w', status: 'needs-approval', createdAt: ago(DAY) });
    const latest = latestRun([waiting, run({ id: 'done', createdAt: ago(HOUR) })], NOW);
    expect(latest).toMatchObject({
      tone: 'needs-approval',
      label: 'Waiting for you',
      detail: '1d ago',
    });
    expect(latest?.run.id).toBe('w');
  });

  it('then a running run, with how long it has worked', () => {
    const running = run({
      id: 'r',
      status: 'running',
      startedAt: ago(72_000),
      createdAt: ago(2 * HOUR),
    });
    expect(latestRun([running, run({ id: 'done' })], NOW)).toMatchObject({
      label: 'Running',
      detail: 'for 1m 12s',
    });
  });

  it('then a queued run, with its place in line when it has one', () => {
    const queued = run({ id: 'q', status: 'queued', createdAt: ago(5 * 60_000) });
    expect(latestRun([queued], NOW, () => 2)).toMatchObject({
      label: 'Queued',
      detail: '2 in line',
    });
    expect(latestRun([queued], NOW)).toMatchObject({ label: 'Queued', detail: '5m ago' });
  });

  it('else the newest, by when it ended', () => {
    const older = run({ id: 'a', createdAt: ago(3 * HOUR) });
    const newest = run({
      id: 'b',
      status: 'failed',
      createdAt: ago(2 * HOUR),
      finishedAt: ago(HOUR),
    });
    expect(latestRun([older, newest], NOW)).toMatchObject({
      tone: 'failed',
      label: 'Failed',
      detail: '1h ago',
    });
    expect(latestRun([], NOW)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('says a length of time as a duration does', () => {
    expect(formatElapsed(400)).toBe('<1s');
    expect(formatElapsed(-5)).toBe('<1s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 5s');
    expect(formatElapsed(64 * 60_000)).toBe('1h 04m');
  });
});

describe('statusCountsInWords', () => {
  it('counts each outcome in the strip order', () => {
    expect(statusCountsInWords([run({ status: 'failed' }), run(), run()])).toBe(
      '2 completed, 1 failed',
    );
    expect(statusCountsInWords([])).toBe('');
  });
});

describe('runInsights', () => {
  const ended = (id: string, status: 'completed' | 'failed', endedAgo: number, tookMs: number) =>
    run({
      id,
      status,
      startedAt: ago(endedAgo + tookMs),
      finishedAt: ago(endedAgo),
      createdAt: ago(endedAgo + tookMs),
    });

  it('rates success over the runs that worked to an end, leaving out dismissed and live ones', () => {
    const runs = [
      run({ id: 'w', status: 'needs-approval' }),
      ended('a', 'completed', HOUR, 2_000),
      run({ id: 'd', status: 'rejected' }),
      ended('b', 'failed', 2 * HOUR, 4_000),
      ended('c', 'completed', 3 * HOUR, 6_000),
      ended('e', 'completed', 4 * HOUR, 60_000),
    ];
    const insights = runInsights(runs);
    expect(insights.total).toBe(6);
    expect(insights.successRate).toBe(0.75);
    expect(insights.medianMs).toBe(5_000);
    expect(insights.lastFailureAt).toBe(ago(2 * HOUR));
    expect(insights.streak).toEqual({ status: 'completed', count: 1 });
  });

  it('counts a streak of the same outcome from the newest', () => {
    const runs = [
      ended('a', 'failed', HOUR, 1),
      ended('b', 'failed', 2 * HOUR, 1),
      ended('c', 'completed', 3 * HOUR, 1),
    ];
    expect(runInsights(runs).streak).toEqual({ status: 'failed', count: 2 });
    expect(runInsights([ended('a', 'completed', HOUR, 1)]).streak).toEqual({
      status: 'completed',
      count: 1,
    });
  });

  it('has nothing to rate when nothing ended', () => {
    expect(runInsights([run({ status: 'queued' })])).toEqual({
      total: 1,
      successRate: null,
      medianMs: null,
      lastFailureAt: null,
      streak: null,
    });
  });
});

describe('runsByDay', () => {
  it('lays the last days out oldest first, today last, empty days kept', () => {
    const days = runsByDay([run({ id: 'today', createdAt: ago(60_000) })], NOW, 5);
    expect(days).toHaveLength(5);
    expect(days[4].day.getDate()).toBe(NOW.getDate());
    expect(days[4].runs.map((entry) => entry.id)).toEqual(['today']);
    expect(days.slice(0, 4).every((day) => day.runs.length === 0)).toBe(true);
  });

  it('puts each run on its local calendar day, newest first, and drops what is older', () => {
    const at = (daysBack: number, hour: number) =>
      new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysBack, hour).toISOString();
    const days = runsByDay(
      [
        run({ id: 'early', createdAt: at(2, 8) }),
        run({ id: 'late', createdAt: at(2, 20) }),
        run({ id: 'old', createdAt: at(9, 9) }),
      ],
      NOW,
      7,
    );
    expect(days[4].runs.map((entry) => entry.id)).toEqual(['late', 'early']);
    expect(days.flatMap((day) => day.runs).map((entry) => entry.id)).not.toContain('old');
  });
});

describe('runAgainTitle', () => {
  const agent = { id: 'review', kind: 'agent' as const, summary: 'Review action' };
  const fetch = { id: 'fresh', kind: 'run' as const, summary: 'git fetch', dryRun: true as const };
  const publish = { id: 'publish', kind: 'run' as const, summary: 'gh pr review' };
  const PREVIEW = 'Preview it again now; nothing changes until you approve';

  it('says an accepted notify steps entry starts its agent steps and dry_run: run commands at once', () => {
    expect(runAgainTitle({ mode: 'notify', kind: 'agent', steps: [agent, publish] })).toBe(
      'Run it again now. Runs review read-only; publish only reports.',
    );
    expect(runAgainTitle({ mode: 'notify', kind: 'agent', steps: [fetch, agent, publish] })).toBe(
      'Run it again now. Runs review read-only and fresh as you; publish only reports.',
    );
  });

  it('says a notify steps entry that only reports starts nothing', () => {
    expect(runAgainTitle({ mode: 'notify', kind: 'tool', steps: [publish] })).toBe(
      'Run it again now; it starts nothing and reports what it would run',
    );
  });

  it('previews an entry that asks first or waits for approval, and keeps the other words', () => {
    expect(
      runAgainTitle({ mode: 'notify', kind: 'agent', steps: [agent, publish], asksFirst: true }),
    ).toBe(PREVIEW);
    expect(runAgainTitle({ mode: 'confirm', kind: 'agent', steps: [agent] })).toBe(PREVIEW);
    expect(runAgainTitle({ mode: 'notify', kind: 'tool' })).toBe(PREVIEW);
    expect(runAgainTitle({ mode: 'auto', kind: 'agent', steps: [agent], asksFirst: true })).toBe(
      PREVIEW,
    );
    expect(runAgainTitle({ mode: 'auto', kind: 'agent', steps: [agent] })).toBe('Run it again now');
    expect(
      runAgainTitle({
        mode: 'notify',
        kind: 'agent',
        steps: [agent],
        problem: 'no scope named "api"',
      }),
    ).toBe('Not running: no scope named "api"');
  });
});

describe('approvalStep for a poll', () => {
  const run = { id: 'tell', kind: 'run' as const, summary: 'gh pr comment' };
  const agent = { id: 'review', kind: 'agent' as const, summary: 'Prompt' };

  it('has the person allow an auto poll first, never approve its first run', () => {
    const node = {
      kind: 'approve',
      title: 'You allow it first',
      detail: 'Then it checks, and runs on its own',
    };
    expect(
      approvalStep({ mode: 'auto', kind: 'agent', source: 'poll', needsAllow: true }),
    ).toMatchObject(node);
    expect(approvalStep({ mode: 'auto', kind: 'agent', source: 'poll' }, true)).toMatchObject(node);
    expect(approvalStep({ mode: 'auto', kind: 'agent', source: 'poll' })).toBeNull();
  });

  it('says a notify poll runs dry runs once allowed, instead of asking once', () => {
    expect(
      approvalStep({ mode: 'notify', kind: 'agent', source: 'poll', steps: [agent, run] }),
    ).toMatchObject({
      kind: 'notify',
      title: 'Runs dry runs once you allow it',
      detail: 'Runs review read-only; tell only reports.',
    });
  });

  it('says a notify poll whose steps only report still checks', () => {
    expect(
      approvalStep({ mode: 'notify', kind: 'tool', source: 'poll', steps: [run] }),
    ).toMatchObject({
      kind: 'notify',
      title: 'Checks once you allow it',
      detail: 'Its check command runs as you; its steps only report.',
    });
  });

  it("keeps today's words for cron, event and manual entries", () => {
    for (const source of ['cron', 'event', 'manual'] as const) {
      expect(
        approvalStep({ mode: 'notify', kind: 'agent', source, steps: [agent, run] })?.title,
      ).toBe('Asks once, then runs');
      expect(approvalStep({ mode: 'notify', kind: 'tool', source, steps: [run] })?.title).toBe(
        'Tells you what it would do',
      );
      expect(approvalStep({ mode: 'auto', kind: 'agent', source }, true)?.title).toBe(
        'You approve its first run',
      );
    }
  });
});

describe('approvalStep', () => {
  it('is a person approving each run in confirm mode, worded by what runs', () => {
    expect(approvalStep({ mode: 'confirm', kind: 'tool' })).toMatchObject({
      kind: 'approve',
      title: 'You approve each run',
      detail: 'It previews first; nothing changes until you approve',
    });
    expect(approvalStep({ mode: 'confirm', kind: 'agent' })?.detail).toBe(
      'Its session starts when you press Start',
    );
  });

  it('is approving the next run for an auto entry that asks first, and nothing once trusted', () => {
    expect(approvalStep({ mode: 'auto', kind: 'tool', asksFirst: true })).toMatchObject({
      title: 'You approve its next run',
      // The user's decision of 2026-11-21: approving a run an agent asked for trusts nothing.
      detail:
        'New or changed since you last did. Once you approve a run no agent asked for, it runs on its own',
    });
    expect(approvalStep({ mode: 'auto', kind: 'tool' })).toBeNull();
  });

  it('is approving the first run for a template that runs on its own', () => {
    expect(approvalStep({ mode: 'auto', kind: 'agent' }, true)).toMatchObject({
      title: 'You approve its first run',
      detail: 'Then it runs on its own',
    });
    expect(approvalStep({ mode: 'confirm', kind: 'tool' }, true)?.title).toBe(
      'You approve each run',
    );
  });

  it('is being told, for notify', () => {
    expect(approvalStep({ mode: 'notify', kind: 'agent' })).toMatchObject({
      kind: 'notify',
      detail: 'Starts nothing',
    });
  });

  it('says what a notify steps entry really runs', () => {
    const agent = { id: 'review', kind: 'agent' as const, summary: 'Review action' };
    const fetch = {
      id: 'fresh',
      kind: 'run' as const,
      summary: 'git fetch',
      dryRun: true as const,
    };
    const publish = { id: 'publish', kind: 'run' as const, summary: 'gh pr review' };
    expect(approvalStep({ mode: 'notify', kind: 'agent', steps: [agent, publish] })).toMatchObject({
      title: 'Asks once, then runs',
      detail: 'Runs review read-only; publish only reports.',
    });
    expect(
      approvalStep({ mode: 'notify', kind: 'agent', steps: [fetch, agent, publish] })?.detail,
    ).toBe('Runs review read-only and fresh as you; publish only reports.');
    expect(approvalStep({ mode: 'notify', kind: 'tool', steps: [fetch] })?.detail).toBe(
      'Runs fresh as you.',
    );
    const second = { id: 'summarise', kind: 'agent' as const, summary: 'Summarise action' };
    const fetchMore = {
      id: 'fetch',
      kind: 'run' as const,
      summary: 'git fetch',
      dryRun: true as const,
    };
    expect(
      approvalStep({
        mode: 'notify',
        kind: 'agent',
        steps: [fetch, agent, fetchMore, second, publish],
      })?.detail,
    ).toBe('Runs review and summarise read-only and fresh and fetch as you; publish only reports.');
    // A loop's own row runs nothing and reports nothing: only its steps are named (3-A code review M4).
    const loop = { id: 'polish', kind: 'repeat' as const, summary: 'Up to 3 rounds' };
    const look = { ...agent, id: 'look', loop: 'polish' };
    const fix = { ...publish, id: 'fix', loop: 'polish' };
    expect(
      approvalStep({ mode: 'notify', kind: 'agent', steps: [loop, look, fix, publish] })?.detail,
    ).toBe('Runs look read-only; fix, publish only report.');
    // Nothing starts: every step is a command that only reports.
    expect(approvalStep({ mode: 'notify', kind: 'tool', steps: [publish] })).toMatchObject({
      detail: 'Starts nothing',
    });
    // Other modes.
    expect(approvalStep({ mode: 'confirm', kind: 'tool', steps: [publish] })?.detail).toBe(
      'Its steps run when you press Start',
    );
    expect(
      approvalStep({ mode: 'auto', kind: 'agent', steps: [agent], asksFirst: true })?.title,
    ).toBe('You approve its next run');
  });

  it('says what a command node does by mode', () => {
    expect(commandFoot({}, 'notify')).toBe('Reports what it would run');
    expect(commandFoot({ dryRun: true }, 'notify')).toBe('Runs as you');
    expect(commandFoot({}, 'confirm')).toBe('Runs as you');
  });
});

describe('runKindCounts', () => {
  it('counts what each kind would list, keeping the rest of the filter', () => {
    const runs = [
      run({ id: 'a', kind: 'agent', automationId: 'review' }),
      run({ id: 'b', kind: 'tool', automationId: 'tidy' }),
      run({ id: 'c', kind: 'request', automationId: 'consola#delete_session', status: 'failed' }),
      run({ id: 'd', kind: 'tool', automationId: 'tidy', status: 'failed' }),
    ];
    expect(runKindCounts(runs, by(), NOW)).toEqual({ all: 4, agent: 1, tool: 3, failed: 2 });
    expect(runKindCounts(runs, by({ automation: 'tidy', kind: 'failed' }), NOW)).toEqual({
      all: 2,
      agent: 0,
      tool: 2,
      failed: 1,
    });
  });
});

describe('snapshotRunCounts', () => {
  const runs = [
    run({ id: 'a', kind: 'agent', automationId: 'review' }),
    run({ id: 'b', kind: 'tool', automationId: 'tidy' }),
    run({ id: 'c', kind: 'tool', automationId: 'tidy', status: 'failed' }),
    run({
      id: 'old',
      kind: 'tool',
      createdAt: ago(31 * DAY),
      updatedAt: ago(31 * DAY),
      finishedAt: ago(31 * DAY),
    }),
  ];

  it('says the total and each kind as counted, when the snapshot holds every run', () => {
    expect(snapshotRunCounts({ runs, hasOlder: false }, by(), NOW)).toEqual({
      all: '3',
      kinds: { all: '3', agent: '1', tool: '2', failed: '1' },
    });
  });

  it('says each as at least that many when the snapshot leaves older runs out', () => {
    // The snapshot holds the newest 200 ended runs (and every live one): past them, its counts are floors.
    expect(snapshotRunCounts({ runs, hasOlder: true }, by(), NOW)).toEqual({
      all: '3+',
      kinds: { all: '3+', agent: '1+', tool: '2+', failed: '1+' },
    });
  });
});

describe('groupRunsByDay', () => {
  const at = (daysBack: number, hour: number) =>
    new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysBack, hour).toISOString();

  it('splits a newest-first list by local day, keeping its order', () => {
    const groups = groupRunsByDay(
      [
        run({ id: 'late', createdAt: at(0, 11) }),
        run({ id: 'early', createdAt: at(0, 1) }),
        run({ id: 'yesterday', createdAt: at(1, 9) }),
        run({ id: 'week', createdAt: at(3, 9) }),
        run({ id: 'old', createdAt: at(12, 9) }),
      ],
      NOW,
    );
    expect(
      groups.map((group) => [group.label.split(',')[0], group.runs.map((entry) => entry.id)]),
    ).toEqual([
      ['Today', ['late', 'early']],
      ['Yesterday', ['yesterday']],
      [new Date(at(3, 9)).toLocaleDateString(undefined, { weekday: 'long' }), ['week']],
      [
        new Date(at(12, 9)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        ['old'],
      ],
    ]);
    expect(groupRunsByDay([], NOW)).toEqual([]);
  });
});

describe('templateModeWords', () => {
  it('says how an added template treats the person', () => {
    expect(templateModeWords('confirm')).toBe('You approve each run');
    expect(templateModeWords('auto')).toBe('Asks once, then runs on its own');
    expect(templateModeWords('notify')).toBe('Only tells you what it would do');
  });

  it("keeps today's words for cron, event and manual entries", () => {
    for (const source of ['cron', 'event', 'manual'] as const) {
      expect(templateModeWords('auto', source)).toBe('Asks once, then runs on its own');
    }
  });

  it('says a poll starts once allowed', () => {
    expect(templateModeWords('auto', 'poll')).toBe(
      'Starts once you allow it, then runs on its own',
    );
  });
});

describe('yamlTokens', () => {
  const kinds = (tokens: YamlToken[]) =>
    tokens.filter((token) => token.kind !== 'space').map((token) => `${token.kind}:${token.text}`);

  it('splits keys from values and shades values by type', () => {
    const [first, second, third, fourth] = yamlTokens(
      '- name: clean-up\n  trigger: { cron: "0 9 * * *" }\n  args:\n    olderThanDays: 14 # two weeks',
    );
    expect(kinds(first)).toEqual(['dash:-', 'key:name', 'colon::', 'plain:clean-up']);
    expect(kinds(second)).toEqual([
      'key:trigger',
      'colon::',
      'punct:{',
      'key:cron',
      'colon::',
      'string:"0 9 * * *"',
      'punct:}',
    ]);
    expect(kinds(third)).toEqual(['key:args', 'colon::']);
    expect(kinds(fourth)).toEqual([
      'key:olderThanDays',
      'colon::',
      'number:14',
      'comment:# two weeks',
    ]);
  });

  it('keeps a block scalar body as text, whatever it looks like', () => {
    const lines = yamlTokens(
      '  prompt: |\n    Review this: carefully\n\n    - not a list\n  mode: confirm',
    );
    expect(kinds(lines[0])).toEqual(['key:prompt', 'colon::', 'literal:|']);
    expect(kinds(lines[1])).toEqual(['string:Review this: carefully']);
    expect(kinds(lines[3])).toEqual(['string:- not a list']);
    expect(kinds(lines[4])).toEqual(['key:mode', 'colon::', 'plain:confirm']);
  });

  it('shades inside an inline map and list, a tool reference staying one word', () => {
    const [line] = yamlTokens(
      '  run: { tool: consola#cleanup, with: { pr_states: [merged, closed], days: 14 } }',
    );
    expect(kinds(line)).toEqual([
      'key:run',
      'colon::',
      'punct:{',
      'key:tool',
      'colon::',
      'plain:consola#cleanup',
      'punct:,',
      'key:with',
      'colon::',
      'punct:{',
      'key:pr_states',
      'colon::',
      'punct:[',
      'plain:merged',
      'punct:,',
      'plain:closed',
      'punct:]',
      'punct:,',
      'key:days',
      'colon::',
      'number:14',
      'punct:}',
      'punct:}',
    ]);
  });

  it('reads quoted strings and literals, and leaves the text whole', () => {
    const source = "  title: 'Hi # there'\n  enabled: true";
    const lines = yamlTokens(source);
    expect(kinds(lines[0])).toEqual(['key:title', 'colon::', "string:'Hi # there'"]);
    expect(kinds(lines[1])).toEqual(['key:enabled', 'colon::', 'literal:true']);
    expect(lines.map((tokens) => tokens.map((token) => token.text).join('')).join('\n')).toBe(
      source,
    );
  });
});

describe('the assigned reviews banner', () => {
  it('says who reviews, who posts, that it never approves, and that it asks first', () => {
    expect(ASSIGNED_REVIEWS_OFFER).toMatch(/asks for your review or is assigned to you/);
    expect(ASSIGNED_REVIEWS_OFFER).toMatch(/a read-only agent reviews it in a checkout of its own/);
    expect(ASSIGNED_REVIEWS_OFFER).toMatch(
      /Consola posts the review on GitHub as you, as a comment or a request for changes, never an approval/,
    );
    expect(ASSIGNED_REVIEWS_OFFER).toMatch(/skips a commit it already reviewed/);
    expect(ASSIGNED_REVIEWS_OFFER).toMatch(/asks you once first, with every command shown/);
    // No action to name: the entry needs none.
    expect(ASSIGNED_REVIEWS_OFFER).not.toMatch(/action/);
  });
});

describe('runOnRows', () => {
  const row = (repo: string, number: number, label = `${repo}#${number}`) => ({
    target: { workItem: { repo, number, type: 'pr' as const } },
    label,
    url: `https://github.com/${repo}/pull/${number}`,
  });

  it('lists a work item once: in its last check, not again from the Inbox', () => {
    const rows = runOnRows({
      takesItem: 'pr',
      acceptsUrl: true,
      items: [row('sprocket/catalog-portal', 51)],
      // The Inbox names the repository in its own case: the same pull request.
      inbox: [
        row('Sprocket/Catalog-Portal', 51, 'from the Inbox'),
        row('sprocket/catalog-portal', 52),
      ],
    });
    expect(rows.items).toEqual([row('sprocket/catalog-portal', 51)]);
    expect(rows.inbox).toEqual([row('sprocket/catalog-portal', 52)]);
  });

  it('keeps an issue and a pull request of one number apart, and key items as they are', () => {
    const issue = {
      target: { workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'issue' as const } },
      label: 'issue 51',
      url: 'https://github.com/sprocket/catalog-portal/issues/51',
    };
    const keyed = { target: { key: 'T-1' }, label: '“Ticket”', url: '' };
    const rows = runOnRows({
      takesItem: 'pr-or-issue',
      acceptsUrl: true,
      items: [row('sprocket/catalog-portal', 51), keyed],
      inbox: [issue],
    });
    expect(rows.items).toEqual([row('sprocket/catalog-portal', 51), keyed]);
    expect(rows.inbox).toEqual([issue]);
  });
});

describe('lastRunWords', () => {
  const lastRun = (status: RunRecord['status'], at: string) => ({ id: 'r', status, at });

  it.each([
    [undefined, 'never run'],
    [lastRun('completed', ago(2 * DAY)), 'ran 2 days ago'],
    [lastRun('failed', ago(DAY)), 'failed yesterday'],
    [lastRun('running', ago(HOUR)), 'running now'],
    [lastRun('needs-approval', ago(HOUR)), 'waiting for you'],
    [lastRun('completed', ago(3 * HOUR)), 'ran 3 hours ago'],
    [lastRun('completed', ago(10 * 60_000)), 'ran 10 minutes ago'],
  ])('says %j as %s', (input, words) => {
    expect(lastRunWords(input, NOW)).toBe(words);
  });

  it('says when a dismissed run was dismissed', () => {
    expect(lastRunWords({ id: 'r', status: 'rejected', at: ago(2 * DAY) }, NOW)).toBe(
      'dismissed 2 days ago',
    );
    // One turned away after it started was not dismissed (3-A code review M6).
    expect(
      lastRunWords({ id: 'r', status: 'rejected', at: ago(2 * DAY), started: true }, NOW),
    ).toBe('rejected 2 days ago');
  });
});

describe('a run found by a poll or run on an item', () => {
  const item = { key: 'k', url: '', title: 'Fix the cart' };

  it("says its check found it, and shows its item's title", () => {
    const found = run({ trigger: { kind: 'poll', at: '', item } });
    expect(triggerLabel(found)).toBe('check');
    expect(triggerInWords(found)).toBe('Found by its check');
    expect(runAbout(found)).toBe('Fix the cart');
    expect(runRowWords(found).about).toBe('Fix the cart');
  });

  it("is run by you, and shows its item's title, when a person ran it on an item", () => {
    const manual = run({ trigger: { kind: 'manual', at: '', by: 'person', item } });
    expect(triggerLabel(manual)).toBe('run now');
    expect(triggerInWords(manual)).toBe('Run by you');
    expect(runAbout(manual)).toBe('Fix the cart');
    expect(runRowWords(manual).about).toBe('Fix the cart');
  });
});

describe('runAgainTarget', () => {
  const base = { key: 'github:sprocket/catalog-portal:pr:51', url: 'u', title: 'Fix the cart' };

  it('is the work item of an event run', () => {
    const event = run({
      trigger: {
        kind: 'event',
        at: '',
        item: { ...base, repo: 'sprocket/catalog-portal', number: 51, type: 'pr' },
      },
    });
    expect(runAgainTarget(event as RunRecord)).toEqual({
      workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' },
    });
  });

  it('is the key of a poll run on a key-only item', () => {
    const poll = run({
      trigger: { kind: 'poll', at: '', item: { key: 'ticket-7', url: '', title: 'T' } },
    });
    expect(runAgainTarget(poll as RunRecord)).toEqual({ key: 'ticket-7' });
  });

  it('is the key of a manual run on a key item', () => {
    const manual = run({
      trigger: {
        kind: 'manual',
        at: '',
        by: 'person',
        item: { key: 'ticket-7', url: '', title: 'T' },
      },
    });
    expect(runAgainTarget(manual as RunRecord)).toEqual({ key: 'ticket-7' });
  });

  it('is the URL of an event run whose item kept no identity', () => {
    const event = run({ trigger: { kind: 'event', at: '', connection: 'github', item: base } });
    expect(runAgainTarget(event as RunRecord)).toEqual({ url: 'u' });
  });

  it('is nothing for a schedule run, or an event run from before its item had a type', () => {
    expect(runAgainTarget(run() as RunRecord)).toBeNull();
    const old = run({
      trigger: {
        kind: 'event',
        at: '',
        item: { ...base, repo: 'sprocket/catalog-portal', number: 51 },
      },
    });
    expect(runAgainTarget(old as RunRecord)).toBeNull();
  });
});

describe('issuesByFile', () => {
  it('groups by file in first-seen order, issues in theirs, a file-less one under factory.yml', () => {
    const a = { message: 'a', path: 'tools', line: 4, file: 'agents/reviewer.md' };
    const b = { message: 'b', path: 'mode', line: 3, file: 'automations/catalog-review.yaml' };
    const c = { message: 'c', path: 'model', line: 5, file: 'agents/reviewer.md' };
    const d = { message: 'd', path: 'automations[0].mode', line: 6 };
    const e = { message: 'e', path: '', file: 'factory.yml' };
    expect(issuesByFile([a, b, c, d, e])).toEqual([
      { file: 'agents/reviewer.md', issues: [a, c] },
      { file: 'automations/catalog-review.yaml', issues: [b] },
      { file: 'factory.yml', issues: [d, e] },
    ]);
    expect(issuesByFile([])).toEqual([]);
  });
});

describe('issuesTitle', () => {
  const view = { name: 'catalog-review' } as AutomationsSnapshot['automations'][number];
  it('says the factory did not load when nothing is listed', () => {
    expect(issuesTitle(snapshot([]))).toBe('The factory did not load');
  });

  it('says some entries did not load when others are listed', () => {
    expect(issuesTitle(snapshot([], [view]))).toBe('Some entries did not load');
  });

  it('says what keeps the changes from applying while the folder does not apply', () => {
    const standing = {
      message:
        "Your changes didn't apply: 1 problem in agents/reviewer.md. The version from 08:00 keeps running.",
      appliedAt: '2026-11-12T08:00:00.000Z',
      removed: [],
    };
    expect(issuesTitle({ ...snapshot([], [view]), standing })).toBe(
      'What keeps your changes from applying',
    );
    expect(issuesTitle({ ...snapshot([]), standing })).toBe(
      'What keeps your changes from applying',
    );
  });
});

describe('noticesLine', () => {
  it('is null with none', () => {
    expect(noticesLine([])).toBeNull();
  });

  it('holds every notice in one line, each after its place', () => {
    const line = noticesLine([
      {
        message:
          '`environments/` is read from slice 3 (write steps); its files have no effect yet.',
      },
      {
        message: '`opus-x` is not among the models Claude work lists.',
        file: 'agents/reviewer.md',
        line: 3,
      },
      { message: 'Something about a file.', file: 'agents/noter.md' },
    ]);
    expect(line).toBe(
      '`environments/` is read from slice 3 (write steps); its files have no effect yet. ' +
        'agents/reviewer.md:3: `opus-x` is not among the models Claude work lists. ' +
        'agents/noter.md: Something about a file.',
    );
    expect(line).not.toContain('\n');
  });
});

// Slice 3 (review S2): a run a person rejected at a gate reads as rejected, never as turned down.
describe('a run rejected at a gate', () => {
  const T = ago(HOUR);
  const rejectedRun = run({
    id: 'rg',
    status: 'rejected',
    steps: [
      {
        id: 'decide',
        kind: 'gate',
        status: 'completed',
        attempt: 1,
        gate: { askedAt: T, decision: 'reject', by: 'person', at: T },
      },
    ],
  } as Partial<RunListEntry>);
  const turnedDownRun = run({ id: 'td', status: 'rejected' });

  it("calls a run rejected at a gate 'rejected', and one turned down 'dismissed'", () => {
    expect(rejectedAtGate(rejectedRun)).toBe('decide');
    expect(runStatusWord(rejectedRun)).toBe('rejected');
    expect(runStatusWord(turnedDownRun)).toBe('dismissed');
    expect(runStatusWord(run({ status: 'failed' }))).toBe('failed');
  });

  it('gives a duration to a run that worked, a run rejected after it started included (3-A code review M5)', () => {
    // Rejected at a gate (its records say so), and turned away after it started: both worked.
    expect(runWorked(rejectedRun)).toBe(true);
    expect(runWorked(run({ status: 'rejected', startedAt: ago(2 * HOUR) }))).toBe(true);
    expect(
      runWorked(
        run({
          status: 'rejected',
          startedAt: ago(2 * HOUR),
          step: { id: 'decide', status: 'completed', index: 2, count: 3, kind: 'gate', gate: true },
        }),
      ),
    ).toBe(true);
    expect(runWorked(turnedDownRun)).toBe(false);
    for (const status of ['completed', 'failed', 'running'] as const)
      expect(runWorked(run({ status }))).toBe(true);
    for (const status of ['queued', 'needs-approval', 'waiting'] as const)
      expect(runWorked(run({ status }))).toBe(false);
  });

  it("calls a run turned away after it started 'rejected', never 'dismissed' (3-A code review M6)", () => {
    // Its entry's retry started it again, and by then a person had started the review by hand.
    const turnedAway = run({
      id: 'ta',
      status: 'rejected',
      startedAt: ago(2 * HOUR),
      summary: 'Already started by hand: “Review”.',
    });
    expect(runStatusWord(turnedAway)).toBe('rejected');
    expect(runStatusLabel(turnedAway)).toBe('Rejected');
    expect(runStatusWord(turnedDownRun)).toBe('dismissed');
    expect(runStatusLabel(turnedDownRun)).toBe('Dismissed');
  });

  it("labels them 'Rejected' and 'Dismissed', from a record or a list entry (review S2)", () => {
    expect(runStatusLabel(rejectedRun)).toBe('Rejected');
    expect(runStatusLabel(turnedDownRun)).toBe('Dismissed');
    expect(
      runStatusLabel({
        status: 'rejected',
        step: {
          id: 'decide',
          status: 'completed',
          index: 3,
          count: 5,
          kind: 'gate',
          gate: true,
        },
      }),
    ).toBe('Rejected');
    // A list entry whose step is no gate's: turned down, as before.
    expect(
      runStatusLabel({
        status: 'rejected',
        step: { id: 'review', status: 'not-run', index: 1, count: 2, kind: 'agent' },
      }),
    ).toBe('Dismissed');
    expect(runStatusLabel(run({ status: 'waiting' }))).toBe('On hold');
    // A list entry waiting at a gate names that gate too: it is on hold, not rejected.
    expect(
      runStatusLabel({
        status: 'waiting',
        step: { id: 'decide', status: 'waiting', index: 3, count: 5, kind: 'gate', gate: true },
      }),
    ).toBe('On hold');
  });

  it('names the gate the run was rejected at, after an earlier one it went past', () => {
    const twoGates = run({
      status: 'rejected',
      steps: [
        {
          id: 'decide',
          kind: 'gate',
          status: 'completed',
          attempt: 1,
          outputs: { decision: 'approve' },
          gate: { askedAt: T, decision: 'approve', by: 'person', at: T },
        },
        {
          id: 'confirm',
          kind: 'gate',
          status: 'completed',
          attempt: 1,
          gate: { askedAt: T, decision: 'reject', by: 'person', at: T },
        },
      ],
    } as Partial<RunListEntry>);
    expect(rejectedAtGate(twoGates)).toBe('confirm');
  });

  it('counts a run rejected at a gate apart in the strip (review S2)', () => {
    const runs = [run(), rejectedRun, turnedDownRun];
    expect(recentRunsInWords(runs)).toBe('Last 3 runs: 1 completed, 1 rejected, 1 dismissed');
    expect(recentRunsInWords([rejectedRun, rejectedRun])).toBe('Last 2 runs: all rejected');
    // The insights' colours keep one bucket per status.
    expect(statusCounts(runs)).toEqual([
      { status: 'completed', count: 1 },
      { status: 'rejected', count: 2 },
    ]);
  });
});

// Slice 3: Activity's "Waiting for you", the list rows' words, Run on…'s last run.
describe('a parked run in the lists', () => {
  const RETRY_AT = '2026-11-12T12:42:00.000Z';
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const gateStep = {
    id: 'decide',
    status: 'waiting' as const,
    index: 3,
    count: 5,
    kind: 'gate' as const,
    gate: true as const,
  };

  it.each([
    [{ status: 'waiting', step: gateStep }, 'waiting for you at decide'],
    [
      {
        status: 'running',
        step: {
          id: 'review',
          status: 'running',
          index: 3,
          count: 5,
          kind: 'agent',
          round: 2,
          max: 3,
          loop: 'polish',
        },
      },
      'round 2 of 3 · review',
    ],
    [
      {
        status: 'waiting',
        step: {
          id: 'fix',
          status: 'waiting',
          index: 2,
          count: 4,
          kind: 'agent',
          retryAt: RETRY_AT,
        },
      },
      `retrying fix at ${clock(RETRY_AT)}`,
    ],
    // The entry's own retry (3-A code review M1): the run waits, at the step it failed at or before any.
    [
      {
        status: 'waiting',
        retryAt: RETRY_AT,
        step: { id: 'look', status: 'failed', index: 1, count: 2, kind: 'agent' },
      },
      `retrying the run at ${clock(RETRY_AT)}`,
    ],
    [{ status: 'waiting', retryAt: RETRY_AT }, `retrying the run at ${clock(RETRY_AT)}`],
    // A step that waits is what the run waits on, whatever time an older record left on the run.
    [
      {
        status: 'waiting',
        retryAt: '2026-11-12T23:00:00.000Z',
        step: {
          id: 'fix',
          status: 'waiting',
          index: 2,
          count: 4,
          kind: 'agent',
          retryAt: RETRY_AT,
        },
      },
      `retrying fix at ${clock(RETRY_AT)}`,
    ],
  ])('words a list row %#', (entry, words) => {
    expect(stepWords(run(entry as Partial<RunListEntry>))).toBe(words);
  });

  it('says a run failed at the step inside the loop that failed (review S10)', () => {
    expect(
      stepWords(
        run({
          status: 'failed',
          step: {
            id: 'address',
            status: 'failed',
            index: 6,
            count: 7,
            kind: 'agent',
            round: 2,
            max: 3,
            loop: 'polish',
          },
        }),
      ),
    ).toBe('failed at address');
    // Waiting for a slot inside a loop keeps its words.
    expect(
      stepWords(
        run({
          status: 'running',
          step: {
            id: 'review',
            status: 'queued',
            index: 3,
            count: 5,
            kind: 'agent',
            round: 2,
            max: 3,
            loop: 'polish',
          },
        }),
      ),
    ).toBe('waiting for a slot before review');
  });

  it("says what a run held by another run's gate waits for", () => {
    const held = {
      waitingFor: { gate: { automation: 'review-assigned-prs-gated', run: 'r1', step: 'decide' } },
    };
    expect(waitingForWords(held)).toBe(
      'waiting for you at `decide` in `review-assigned-prs-gated`',
    );
    expect(waitingForWords({})).toBeNull();
    // On its row, in place of the checkout's own words.
    expect(
      stepWords(run({ status: 'queued', summary: "waiting for this item's checkout", ...held })),
    ).toBe('waiting for you at `decide` in `review-assigned-prs-gated`');
  });

  it('puts only runs waiting at a gate first, oldest first, and leaves them out of their day (review S7)', () => {
    const newer = run({ id: 'g2', status: 'waiting', step: gateStep, createdAt: ago(HOUR) });
    const older = run({ id: 'g1', status: 'waiting', step: gateStep, createdAt: ago(3 * HOUR) });
    const retrying = run({
      id: 'w',
      status: 'waiting',
      createdAt: ago(2 * HOUR),
      step: { ...gateStep, id: 'fix', kind: 'agent', gate: undefined, retryAt: RETRY_AT },
    });
    const done = run({ id: 'd', createdAt: ago(4 * HOUR) });
    // Rejected at a gate: its list entry names that gate, and it waits for no one.
    const rejected = run({
      id: 'x',
      status: 'rejected',
      createdAt: ago(5 * HOUR),
      step: { ...gateStep, status: 'completed' },
    });
    const runs = [newer, retrying, older, done, rejected];
    const first = waitingForYouRuns(runs);
    expect(first.map((one) => one.id)).toEqual(['g1', 'g2']);
    const rest = runs.filter((one) => !first.includes(one));
    expect(groupRunsByDay(rest, NOW).flatMap((group) => group.runs.map((one) => one.id))).toEqual([
      'w',
      'd',
      'x',
    ]);
  });

  it("names the run an automation's page asks you about: one awaiting approval, else one at a gate (3-A code review M3)", () => {
    const parked = run({ id: 'g', status: 'waiting', step: gateStep, createdAt: ago(HOUR) });
    const asking = run({ id: 'a', status: 'needs-approval', createdAt: ago(2 * HOUR) });
    const retrying = run({
      id: 'w',
      status: 'waiting',
      step: { ...gateStep, id: 'fix', kind: 'agent', gate: undefined, retryAt: RETRY_AT },
    });
    expect(runWaitingForYou([parked, asking, retrying])?.id).toBe('a');
    expect(runWaitingForYou([retrying, parked])?.id).toBe('g');
    // A retry's wait asks no one.
    expect(runWaitingForYou([retrying, run({ status: 'running' })])).toBeUndefined();
  });

  it("speaks for a run waiting at a gate on its automation's row before a running one (review S1)", () => {
    const running = run({
      id: 'r',
      status: 'running',
      startedAt: ago(60_000),
      createdAt: ago(HOUR),
    });
    const atGate = run({
      id: 'g',
      status: 'waiting',
      step: gateStep,
      createdAt: ago(2 * HOUR),
      updatedAt: ago(3 * 60_000),
    });
    expect(latestRun([atGate, running], NOW)).toMatchObject({
      tone: 'waiting',
      label: 'On hold',
      detail: 'asked 3m ago',
    });
    expect(latestRun([atGate, running], NOW)?.run.id).toBe('g');
    const asking = run({ id: 'a', status: 'needs-approval', createdAt: ago(DAY) });
    expect(latestRun([asking, atGate], NOW)?.run.id).toBe('a');
    const retrying = run({
      id: 'w',
      status: 'waiting',
      step: { ...gateStep, id: 'fix', kind: 'agent', gate: undefined, retryAt: RETRY_AT },
    });
    expect(latestRun([retrying], NOW)).toMatchObject({
      label: 'On hold',
      detail: `retries at ${clock(RETRY_AT)}`,
    });
    // The whole run's wait, on the run itself.
    expect(latestRun([run({ id: 'e', status: 'waiting', retryAt: RETRY_AT })], NOW)).toMatchObject({
      detail: `retries at ${clock(RETRY_AT)}`,
    });
    // A full record says it by its rows.
    const record = run({
      id: 'f',
      status: 'waiting',
      updatedAt: ago(4 * 60_000),
      steps: [
        { id: 'decide', kind: 'gate', status: 'waiting', attempt: 1, gate: { askedAt: ago(HOUR) } },
      ],
    } as Partial<RunListEntry>);
    expect(latestRun([record, running], NOW)).toMatchObject({ detail: 'asked 4m ago' });
    expect(latestRun([record, running], NOW)?.run.id).toBe('f');
    const retryRecord = run({
      id: 'rr',
      status: 'waiting',
      steps: [{ id: 'fix', kind: 'agent', status: 'waiting', attempt: 1, retryAt: RETRY_AT }],
    } as Partial<RunListEntry>);
    expect(latestRun([retryRecord], NOW)?.detail).toBe(`retries at ${clock(RETRY_AT)}`);
    // A run rejected at a gate is labelled so.
    const rejected = run({
      id: 'x',
      status: 'rejected',
      step: { ...gateStep, status: 'completed' },
      finishedAt: ago(HOUR),
    });
    expect(latestRun([rejected], NOW)?.label).toBe('Rejected');
  });

  it("says Run on…'s last run waited, retried or was rejected at a gate", () => {
    expect(lastRunWords({ id: 'r', status: 'waiting', at: ago(HOUR), gate: 'decide' }, NOW)).toBe(
      'waiting for you at decide',
    );
    expect(lastRunWords({ id: 'r', status: 'waiting', at: ago(HOUR) }, NOW)).toBe('retrying');
    expect(
      lastRunWords({ id: 'r', status: 'rejected', at: ago(2 * DAY), gate: 'decide' }, NOW),
    ).toBe('rejected at `decide` 2 days ago');
    expect(lastRunWords({ id: 'r', status: 'rejected', at: ago(2 * DAY) }, NOW)).toBe(
      'dismissed 2 days ago',
    );
  });
});
