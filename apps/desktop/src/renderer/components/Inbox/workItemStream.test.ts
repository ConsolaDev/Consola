import { describe, expect, it } from 'vitest';
import type {
  WorkItemCommitItem,
  WorkItemEvent,
  WorkItemPerson,
  WorkItemReviewItem,
  WorkItemThread,
  WorkItemTimelineItem,
} from '../../../shared/workItemDetails';
import {
  buildStream,
  closeLabel,
  commitRunSentence,
  eventSentence,
  labelColors,
  labelContrast,
  mergeGate,
  mergeRefusal,
  mergeRows,
  parsePatch,
  quoteReply,
  rangeLabel,
  reopenLabel,
  rowAnchor,
  selectionRange,
  sentenceText,
  suggestionText,
  threadLocation,
  threadRow,
} from './workItemDetailPresentation';

const person = (login: string): WorkItemPerson => ({ login, isBot: false });
const simon = person('simon-sprocket');
const ellen = person('ellen-sprocket');
const at = (minute: number) => `2026-10-08T09:${String(minute).padStart(2, '0')}:00Z`;

const event = (kind: string, minute: number, fields: object = {}, actor = simon) =>
  ({ kind, id: `${kind}-${minute}`, createdAt: at(minute), actor, ...fields }) as WorkItemEvent;
const review = (id: string, state: WorkItemReviewItem['state'], body = '', author = ellen): WorkItemReviewItem =>
  ({ kind: 'review', id, state, body, author, url: '', createdAt: at(10), reactions: [], viewerCanEdit: false });
const commit = (id: string, author = simon): WorkItemCommitItem =>
  ({ kind: 'commit', id, oid: id.padEnd(40, '0'), headline: `Commit ${id}`, author, url: '', createdAt: at(1) });
const thread = (id: string, reviewId: string, fields: Partial<WorkItemThread> = {}, pending = false): WorkItemThread => ({
  id, path: 'src/stock.ts', line: 17, side: 'RIGHT', diffHunk: '', isResolved: false, isOutdated: false,
  viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: [{ id: `${id}-c`, author: ellen, body: 'Here', url: '', createdAt: at(10), reactions: [], viewerCanEdit: false, pending, viewerCanDelete: false, reviewId }],
  ...fields,
});

const sentence = (item: WorkItemEvent, type: 'pr' | 'issue' = 'pr') => sentenceText(eventSentence(item, type).sentence);

describe('event sentences', () => {
  it('words each event as GitHub does', () => {
    const label = { name: 'frontend', color: '1d76db' };
    expect(sentence(event('labeled', 1, { label }))).toBe('added frontend');
    expect(sentence(event('renamed', 1, { from: 'Old', to: 'New' }))).toBe('changed the title Old New');
    expect(sentence(event('force-pushed', 1, { ref: 'feat/x', before: '1e50c34', after: 'f978427' }))).toBe('force-pushed feat/x from 1e50c34 to f978427');
    expect(sentence(event('review-requested', 1, { reviewer: 'ellen-sprocket' }))).toBe('requested a review from ellen-sprocket');
    expect(sentence(event('assigned', 1, { assignee: 'mateo-sprocket' }))).toBe('assigned mateo-sprocket');
    expect(sentence(event('assigned', 1, { assignee: 'simon-sprocket' }))).toBe('self-assigned this');
    const source = { type: 'pr', repo: 'sprocket/catalog-portal', number: 48, title: 'Rework catalog search', url: '', state: 'open' };
    expect(sentence(event('cross-referenced', 1, { source, willClose: false }))).toBe('mentioned this in Rework catalog search #48');
    expect(sentence(event('merged', 1, { commit: 'abc1234', base: 'main' }))).toBe('merged commit abc1234 into main');
    expect(sentence(event('head-ref-deleted', 1, { ref: 'feat/x' }))).toBe('deleted the feat/x branch');
  });

  it('colours closes by what they mean, and tells an issue’s reasons apart', () => {
    expect(eventSentence(event('closed', 1), 'pr')).toMatchObject({ icon: 'pr-closed', tone: 'error' });
    expect(eventSentence(event('closed', 1, { stateReason: 'completed' }), 'issue')).toMatchObject({ tone: 'merged' });
    expect(sentence(event('closed', 1, { stateReason: 'completed' }), 'issue')).toBe('closed this as completed');
    expect(eventSentence(event('closed', 1, { stateReason: 'not-planned' }), 'issue')).toMatchObject({ icon: 'not-planned', tone: 'neutral' });
  });
});

describe('the stream', () => {
  it('runs consecutive commits together, whoever wrote them', () => {
    const timeline: WorkItemTimelineItem[] = [commit('a'), commit('b', ellen), event('reopened', 3), commit('c')];
    const entries = buildStream(timeline, [], 'pr');
    expect(entries.map((entry) => entry.kind)).toEqual(['commits', 'event', 'commits']);
    const first = entries[0] as Extract<(typeof entries)[number], { kind: 'commits' }>;
    expect(first.commits.map((item) => item.id)).toEqual(['a', 'b']);
    expect(commitRunSentence(first.commits)).toEqual({ actor: simon, text: 'and others added 2 commits' });
    expect(commitRunSentence([commit('c')]).text).toBe('added 1 commit');
  });

  it('folds one person’s labelling in the same minute into one line', () => {
    const label = (name: string) => ({ label: { name, color: '000000' } });
    const timeline = [event('labeled', 1, label('a')), event('labeled', 1, label('b')), event('unlabeled', 1, label('c')), event('labeled', 5, label('d'))];
    const entries = buildStream(timeline, [], 'pr');
    expect(entries.map((entry) => entry.kind === 'event' && sentenceText(entry.sentence))).toEqual(['added a b and removed c', 'added d']);
  });

  it('makes a card of a review that says something, a line of a bare verdict, and nothing of a bare reply', () => {
    const timeline = [review('r1', 'CHANGES_REQUESTED', 'Needs validation.'), review('r2', 'APPROVED'), review('r3', 'COMMENTED'), review('r4', 'COMMENTED')];
    const threads = [thread('t1', 'r1'), thread('t4', 'r4')];
    // r3 only replied: its comment sits in r1's thread.
    threads[0].comments.push({ ...threads[0].comments[0], id: 'reply', reviewId: 'r3' });
    const entries = buildStream(timeline, threads, 'pr');
    expect(entries.map((entry) => [entry.kind, entry.kind === 'review' ? entry.threads.map((t) => t.id) : entry.kind === 'event' ? sentenceText(entry.sentence) : null]))
      .toEqual([['review', ['t1']], ['event', 'approved these changes'], ['review', ['t4']]]);
    expect(entries[1]).toMatchObject({ icon: 'approved', tone: 'success' });
  });

  it('keeps a thread whose review is missing, and leaves pending ones to Files changed', () => {
    const entries = buildStream([event('reopened', 5), event('reopened', 20)], [thread('lost', 'gone'), thread('draft', 'mine', {}, true)], 'pr');
    expect(entries.map((entry) => entry.kind)).toEqual(['event', 'review', 'event']);
    expect(entries[1]).toMatchObject({ kind: 'review', threads: [{ id: 'lost' }] });
  });

  it('quotes a comment for a reply', () => {
    expect(quoteReply('One\n\nTwo\n')).toBe('> One\n>\n> Two\n\n');
  });
});

describe('the merge card', () => {
  const base = {
    isDraft: false, reviewDecision: 'APPROVED', mergeState: 'CLEAN', baseBranch: 'main',
    reviewers: [{ who: ellen, isTeam: false, state: 'approved' as const }],
    checks: [{ name: 'a', state: 'SUCCESS', url: '' }],
  };

  it('has a row for each thing that stands in the way, in GitHub’s words', () => {
    expect(mergeRows(base).map((row) => [row.key, row.tone, row.title])).toEqual([
      ['reviews', 'success', 'Approved'], ['checks', 'success', 'All checks have passed'], ['branch', 'success', 'No conflicts with the base branch'],
    ]);
    const blocked = mergeRows({
      ...base, reviewDecision: 'CHANGES_REQUESTED', mergeState: 'BEHIND',
      reviewers: [{ who: ellen, isTeam: false, state: 'changes-requested' }, { who: simon, isTeam: false, state: 'requested' }],
      checks: [{ name: 'a', state: 'FAILURE', url: '' }, { name: 'b', state: 'SUCCESS', url: '' }],
    });
    expect(blocked.map((row) => [row.tone, row.title, row.detail])).toEqual([
      ['error', 'Changes requested', '1 review requesting changes · 1 awaiting review'],
      ['error', 'Some checks were not successful', '1 failing · 1 passed'],
      ['warning', 'This branch is behind main', 'Merge the latest changes from main into this branch.'],
    ]);
    expect(mergeRows({ ...base, mergeState: 'DIRTY' }).at(-1)).toMatchObject({ tone: 'error', title: 'This branch has conflicts' });
    expect(mergeRows({ ...base, mergeState: 'UNKNOWN' }).at(-1)).toMatchObject({ title: 'Checking mergeability…' });
    expect(mergeRows({ ...base, checks: [] }).map((row) => row.key)).toEqual(['reviews', 'branch']);
    expect(mergeRows({ ...base, reviewDecision: 'REVIEW_REQUIRED', reviewers: [] })[0]).toMatchObject({ tone: 'warning', title: 'Review required' });
  });

  it('is one row for a draft', () => {
    expect(mergeRows({ ...base, isDraft: true })).toEqual([expect.objectContaining({ key: 'draft', title: 'This pull request is still a draft' })]);
  });

  it('says why GitHub refuses only when no row already does', () => {
    const rows = mergeRows({ ...base, mergeState: 'BLOCKED' });
    expect(mergeRefusal(rows, mergeGate('BLOCKED'), 'BLOCKED', 'main')).toBe('Can’t merge yet: blocked until requirements pass.');
    const explained = mergeRows({ ...base, mergeState: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' });
    expect(mergeRefusal(explained, mergeGate('BLOCKED'), 'BLOCKED', 'main')).toBe('');
    expect(mergeRefusal(mergeRows(base), mergeGate('CLEAN'), 'CLEAN', 'main')).toBe('');
  });
});

describe('the comment box', () => {
  it('takes typed text along when closing or reopening', () => {
    expect(closeLabel('pr', false)).toBe('Close pull request');
    expect(closeLabel('issue', false)).toBe('Close issue');
    expect(closeLabel('issue', true)).toBe('Close with comment');
    expect(reopenLabel('pr', false)).toBe('Reopen pull request');
    expect(reopenLabel('issue', true)).toBe('Reopen with comment');
  });
});

describe('commenting on lines', () => {
  const rows = parsePatch('@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+more\n@@ -20,2 +21,2 @@\n tail\n+end');

  it('anchors added and unchanged lines on the new side, removed lines on the old', () => {
    expect(rows.map(rowAnchor)).toEqual([
      null, { side: 'RIGHT', line: 1 }, { side: 'LEFT', line: 2 }, { side: 'RIGHT', line: 2 }, { side: 'RIGHT', line: 3 },
      null, { side: 'RIGHT', line: 21 }, { side: 'RIGHT', line: 22 },
    ]);
  });

  it('makes a range within one hunk, either way round, and refuses one across hunks', () => {
    expect(selectionRange(rows, 3, 3)).toEqual({ side: 'RIGHT', line: 2 });
    expect(selectionRange(rows, 4, 2)).toEqual({ side: 'RIGHT', line: 3, startSide: 'LEFT', startLine: 2 });
    expect(selectionRange(rows, 3, 6)).toBeNull();
    expect(selectionRange(rows, 0, 1)).toBeNull();
    expect(rangeLabel({ side: 'RIGHT', line: 22, startSide: 'RIGHT', startLine: 21 })).toBe('Commenting on lines +21 to +22');
    expect(rangeLabel({ side: 'LEFT', line: 2 })).toBe('Commenting on line −2');
  });

  it('suggests a change from the new side only', () => {
    expect(suggestionText(rows, 1, 4)).toBe('keep\nnew\nmore');
    expect(suggestionText(rows, 2, 2)).toBeNull();
  });

  it('finds the row a thread sits under', () => {
    expect(threadRow(rows, { line: 3, side: 'RIGHT' })).toBe(4);
    expect(threadRow(rows, { line: 2, side: 'LEFT' })).toBe(2);
    expect(threadRow(rows, { line: undefined, side: 'RIGHT' })).toBe(-1);
    expect(threadLocation({ path: 'src/stock.ts', line: 17 })).toBe('stock.ts:17');
    expect(threadLocation({ path: 'src/stock.ts', line: undefined, originalLine: 9 })).toBe('stock.ts:9');
  });
});

describe('label colours', () => {
  const colors = ['ffffff', '000000', 'fef2c0', '0e8a16', 'd73a4a', 'a2eeef', '7057ff', 'fbca04', '1d76db', '5319e7', 'bfdadc', '333333'];

  it('keeps every label’s text readable on its pill in both themes, near-white and near-black included', () => {
    for (const color of colors) {
      expect(labelContrast(color, 'dark')).toBeGreaterThanOrEqual(4.5);
      expect(labelContrast(color, 'light')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('tints the pill with the label’s own colour, and keeps its hue in the text', () => {
    expect(labelColors('d73a4a')).toMatchObject({ fill: 'rgba(215, 58, 74, 0.18)', border: 'rgba(215, 58, 74, 0.4)' });
    const { dark, light } = labelColors('0e8a16');
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16) > parseInt(hex.slice(1, 3), 16);
    expect(green(dark) && green(light)).toBe(true);
  });
});
