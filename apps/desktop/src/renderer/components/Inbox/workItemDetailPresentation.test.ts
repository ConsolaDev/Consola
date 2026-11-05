import { describe, expect, it } from 'vitest';
import {
  checkLabel,
  checkOutcome,
  checksSentence,
  commentAge,
  commentVerb,
  diffBlocks,
  fileStatus,
  isFailingCheck,
  itemStatus,
  mergeGate,
  mergeStateMeta,
  parsePatch,
  reviewMeta,
  sortChecks,
  splitPath,
  summarizeChecks,
} from './workItemDetailPresentation';

describe('checks', () => {
  it('groups GitHub states by what they mean for a merge', () => {
    expect(checkOutcome('SUCCESS')).toBe('passing');
    expect(checkOutcome('FAILURE')).toBe('failing');
    expect(checkOutcome('CANCELLED')).toBe('failing');
    expect(checkOutcome('SKIPPED')).toBe('skipped');
    expect(checkOutcome('NEUTRAL')).toBe('skipped');
    expect(checkOutcome('IN_PROGRESS')).toBe('pending');
    expect(checkOutcome('SOMETHING_NEW')).toBe('pending');
  });

  it('keeps the set that offers "Fix failing checks" unchanged', () => {
    for (const state of ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      expect(isFailingCheck(state)).toBe(true);
    }
    expect(isFailingCheck('SUCCESS')).toBe(false);
    expect(isFailingCheck('PENDING')).toBe(false);
  });

  it('labels states in sentence case, falling back for unknown ones', () => {
    expect(checkLabel('IN_PROGRESS')).toBe('In progress');
    expect(checkLabel('SUCCESS')).toBe('Passed');
    expect(checkLabel('BRAND_NEW_STATE')).toBe('Brand new state');
  });

  it('summarises and sorts failing first, keeping order within a group', () => {
    const checks = [
      { name: 'a', state: 'SUCCESS', url: '' },
      { name: 'b', state: 'FAILURE', url: '' },
      { name: 'c', state: 'IN_PROGRESS', url: '' },
      { name: 'd', state: 'SKIPPED', url: '' },
      { name: 'e', state: 'SUCCESS', url: '' },
    ];
    expect(summarizeChecks(checks)).toEqual({ failing: 1, pending: 1, passing: 2, skipped: 1, total: 5 });
    expect(sortChecks(checks).map((check) => check.name)).toEqual(['b', 'c', 'a', 'e', 'd']);
    expect(checksSentence(summarizeChecks(checks))).toBe('1 failing · 1 pending · 2 passed · 1 skipped');
    expect(checksSentence(summarizeChecks([]))).toBe('No checks');
  });
});

describe('item status', () => {
  it('reads like GitHub for each pull request and issue state', () => {
    expect(itemStatus('pr', 'open', false)).toMatchObject({ label: 'Open', tone: 'success', kind: 'pr-open' });
    expect(itemStatus('pr', 'open', true)).toMatchObject({ label: 'Draft', tone: 'neutral', kind: 'pr-draft' });
    expect(itemStatus('pr', 'merged', false)).toMatchObject({ label: 'Merged', tone: 'merged' });
    expect(itemStatus('pr', 'closed', false)).toMatchObject({ label: 'Closed', tone: 'error' });
    expect(itemStatus('issue', 'closed', false)).toMatchObject({ label: 'Closed', tone: 'merged', kind: 'issue-closed' });
  });

  it('uses the Inbox row wording for review decisions', () => {
    expect(reviewMeta('CHANGES_REQUESTED')).toEqual({ label: 'Changes requested', tone: 'error' });
    expect(reviewMeta('REVIEW_REQUIRED')).toEqual({ label: 'Awaiting approval', tone: 'warning' });
    expect(reviewMeta(undefined)).toEqual({ label: 'No review yet', tone: 'neutral' });
  });

  it('explains merge states, naming the base branch when behind', () => {
    expect(mergeStateMeta('BEHIND', 'main')).toEqual({ label: 'Behind main', tone: 'warning' });
    expect(mergeStateMeta('DIRTY', 'main')).toEqual({ label: 'Merge conflicts', tone: 'error' });
    expect(mergeStateMeta('CLEAN', 'main').tone).toBe('success');
    expect(mergeStateMeta('NEW_STATE', 'main')).toEqual({ label: 'New state', tone: 'neutral' });
  });

  it('greens the merge button only when nothing blocks the merge, as GitHub does', () => {
    expect(mergeGate('CLEAN')).toEqual({ button: 'go', canQueue: false });
    expect(mergeGate('HAS_HOOKS')).toEqual({ button: 'go', canQueue: false });
    // Optional checks failing: GitHub merges on request, without the green.
    expect(mergeGate('UNSTABLE')).toEqual({ button: 'plain', canQueue: false });
  });

  it('disables the merge button whenever GitHub would refuse, offering auto-merge only for requirements', () => {
    expect(mergeGate('BLOCKED')).toEqual({ button: 'disabled', canQueue: true });
    expect(mergeGate('BEHIND')).toEqual({ button: 'disabled', canQueue: true });
    for (const state of ['DIRTY', 'UNKNOWN', 'DRAFT', 'NEW_STATE', undefined]) {
      expect(mergeGate(state)).toEqual({ button: 'disabled', canQueue: false });
    }
  });
});

describe('conversation', () => {
  const base = { id: '1', author: 'ellen-sprocket', body: '', url: '', createdAt: '' };

  it('describes each kind of entry, colouring only verdicts', () => {
    expect(commentVerb({ ...base, kind: 'review', state: 'APPROVED' })).toEqual({ verb: 'approved these changes', tone: 'success' });
    expect(commentVerb({ ...base, kind: 'review', state: 'CHANGES_REQUESTED' })).toEqual({ verb: 'requested changes', tone: 'error' });
    expect(commentVerb({ ...base, kind: 'review', state: 'COMMENTED' })).toEqual({ verb: 'reviewed' });
    expect(commentVerb({ ...base, kind: 'inline', path: 'src/a.ts' })).toEqual({ verb: 'commented on' });
    expect(commentVerb({ ...base, kind: 'comment' })).toEqual({ verb: 'commented' });
  });

  it('gives a relative age, a date once it is old, and nothing when unknown', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(commentAge('2026-10-10T09:00:00Z', now)).toBe('3h ago');
    expect(commentAge('2026-08-01T09:00:00Z', now)).toMatch(/Aug/);
    expect(commentAge('', now)).toBe('');
    expect(commentAge('not a date', now)).toBe('');
  });
});

describe('files', () => {
  it('numbers both sides of each hunk and keeps the sign in the text', () => {
    const rows = parsePatch('@@ -8,3 +8,4 @@ class A {\n keep\n-old\n+new\n+more\n\\ No newline at end of file');
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -8,3 +8,4 @@ class A {' },
      { kind: 'context', text: ' keep', oldLine: 8, newLine: 8 },
      { kind: 'del', text: '-old', oldLine: 9 },
      { kind: 'add', text: '+new', newLine: 9 },
      { kind: 'add', text: '+more', newLine: 10 },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('drops the empty line a trailing newline leaves behind', () => {
    expect(parsePatch('@@ -1 +1 @@\n-a\n+b\n')).toHaveLength(3);
  });

  it('draws a five-block diffstat in proportion, never hiding a side', () => {
    expect(diffBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(diffBlocks(4, 2)).toEqual(['add', 'add', 'add', 'del', 'del']);
    expect(diffBlocks(500, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(0, 52)).toEqual(['del', 'del', 'del', 'del', 'del']);
  });

  it('splits a path so the file name can stand out', () => {
    expect(splitPath('src/legacy/client.ts')).toEqual({ dir: 'src/legacy/', name: 'client.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });

  it('names file statuses as GitHub does', () => {
    expect(fileStatus('removed')).toEqual({ label: 'Deleted', tone: 'error' });
    expect(fileStatus('added').tone).toBe('success');
    expect(fileStatus('modified').label).toBe('Modified');
  });
});
