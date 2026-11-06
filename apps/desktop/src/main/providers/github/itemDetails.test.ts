import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubDriver } from './GitHubDriver';
import type { WorkItemMutation } from '../../../shared/workItemDetails';

const fixture = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');
const detailsDir = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/details');
const ref = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 } as const;
const HEAD = '1234567890123456789012345678901234567890';
let dir: string;
let previous: string | undefined;
let driver: GitHubDriver;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-details-'));
  previous = process.env.CONSOLA_GH_PATH;
  process.env.CONSOLA_GH_PATH = fixture;
  env = { PATH: process.env.PATH, GH_TOKEN: 'stub-workspace-account', STUB_GH_LOG: path.join(dir, 'argv') };
  driver = new GitHubDriver(() => env);
});
afterEach(() => {
  if (previous === undefined) delete process.env.CONSOLA_GH_PATH;
  else process.env.CONSOLA_GH_PATH = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});
const log = () => (fs.existsSync(path.join(dir, 'argv')) ? fs.readFileSync(path.join(dir, 'argv'), 'utf8') : '');
const calls = () => log().trim().split('\n').filter(Boolean);
/** The GraphQL operations run, by name, in order. */
const operations = () => calls().map((line) => line.match(/query=(?:query|mutation) (Consola\w+)/)?.[1]).filter(Boolean);

/** A copy of the fixture directory with one file replaced, for replies GitHub should never send. */
function detailsWith(file: string, contents: unknown): string {
  const copy = path.join(dir, 'details');
  fs.cpSync(detailsDir, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, file), JSON.stringify(contents));
  return copy;
}

describe('GitHub item details', () => {
  it('reads a pull request: description, whole timeline, threads, reviewers, checks and files', async () => {
    const details = await driver.fetchDetails(ref, env);
    expect(details).toMatchObject({
      title: 'Extract billing client', state: 'open', isDraft: false, author: 'simon-sprocket',
      headOid: HEAD, baseBranch: 'main', mergeState: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
      additions: 10, deletions: 4, canUpdateBranch: true,
      viewer: { login: 'JaviDev', isBot: false },
      labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'billing', color: 'd93f0b' }],
      assignees: [{ login: 'JaviDev' }],
    });
    expect(details.description).toMatchObject({
      author: { login: 'simon-sprocket', avatarUrl: expect.stringContaining('simon-sprocket') },
      editedAt: '2026-10-06T09:20:00Z',
      reactions: [{ content: 'THUMBS_UP', count: 2, viewerReacted: true }, { content: 'HEART', count: 1, viewerReacted: false }],
    });
    expect(details.reviewers).toEqual([
      expect.objectContaining({ who: expect.objectContaining({ login: 'ellen-sprocket' }), state: 'changes-requested' }),
      expect.objectContaining({ who: expect.objectContaining({ login: 'mateo-sprocket' }), state: 'requested' }),
      { who: { login: 'catalog-maintainers', isBot: false }, isTeam: true, state: 'requested' },
    ]);
    expect(details.timeline.map((item) => item.kind)).toEqual([
      'commit', 'commit', 'labeled', 'labeled', 'review-requested', 'review-requested', 'comment', 'review',
      'force-pushed', 'commit', 'renamed', 'comment', 'comment', 'cross-referenced', 'review',
    ]);
    expect(details.timeline.find((item) => item.kind === 'force-pushed')).toMatchObject({ before: '1e50c34', after: 'f978427' });
    expect(details.timeline.find((item) => item.kind === 'cross-referenced')).toMatchObject({
      source: { type: 'pr', repo: 'sprocket/catalog-portal', number: 48, title: 'Rework catalog search', state: 'open' },
    });
    const bot = details.timeline.find((item) => item.id === 'IC_2');
    expect(bot).toMatchObject({ author: { login: 'sprocket-ci', isBot: true }, minimized: 'outdated' });
    expect(details.timeline.find((item) => item.id === 'IC_3')).toMatchObject({ viewerCanEdit: true });
    expect(details.threads.map((thread) => [thread.id, thread.line, thread.isResolved, thread.isOutdated])).toEqual([
      ['PRRT_1', 7, false, false], ['PRRT_2', 4, true, false], ['PRRT_3', undefined, false, true],
    ]);
    expect(details.threads[0].comments.map((comment) => [comment.author.login, comment.reviewId, comment.pending])).toEqual([
      ['ellen-sprocket', 'PRR_ellen', false], ['mateo-sprocket', 'PRR_mateo', false],
    ]);
    expect(details.threads[0].diffHunk).toContain('Number.isFinite');
    expect(details.threads[2].originalLine).toBe(7);
    expect(details.pendingReview).toBeUndefined();
    expect(details.checks).toEqual([
      { name: 'Unit tests', state: 'FAILURE', url: 'https://github.com/sprocket/catalog-portal/actions/runs/1' },
      { name: 'Build', state: 'SUCCESS', url: 'https://github.com/sprocket/catalog-portal/actions/runs/2' },
    ]);
    expect(details.files.map((file) => file.path)).toEqual(['src/billing.ts', 'src/billing/client.ts']);

    // As the workspace's account, against github.com, paginating the lists to the end.
    expect(operations()).toEqual(expect.arrayContaining(['ConsolaPullRequest', 'ConsolaPullRequestTimeline', 'ConsolaReviewThreads']));
    for (const line of calls()) expect(line).toMatch(/--hostname github\.com .*GH_TOKEN=stub-workspace-account$/);
    expect(calls().filter((line) => line.includes('--paginate --slurp'))).toHaveLength(3);
    expect(log()).toContain('-f owner=sprocket -f name=catalog-portal -F number=51');
  });

  it('carries the viewer’s pending review and its comments', async () => {
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'pending-review'), '');
    const details = await driver.fetchDetails(ref, { ...env, STUB_GH_STATE_DIR: state });
    expect(details.pendingReview).toEqual({ id: 'PRR_pending1', commentCount: 1 });
    expect(details.threads.at(-1)?.comments[0]).toMatchObject({ pending: true, viewerCanEdit: true, viewerCanDelete: true });
  });

  it('reads an issue without asking for anything only a pull request has', async () => {
    const details = await driver.fetchDetails({ ...ref, type: 'issue' }, env);
    expect(details).toMatchObject({ title: 'Rate limit returns 500', state: 'open', files: [], threads: [], reviewers: [] });
    expect(details.timeline.map((item) => item.kind)).toEqual(['labeled', 'assigned', 'comment']);
    expect(operations()).toEqual(expect.arrayContaining(['ConsolaIssue', 'ConsolaIssueTimeline']));
    expect(log()).not.toContain('/pulls/');
    expect(log()).not.toContain('ConsolaReviewThreads');
  });

  it('reads a closed issue’s reason', async () => {
    const issue = JSON.parse(fs.readFileSync(path.join(detailsDir, 'ConsolaIssue.json'), 'utf8'));
    Object.assign(issue.data.repository.issue, { state: 'CLOSED', stateReason: 'NOT_PLANNED' });
    const details = await driver.fetchDetails({ ...ref, type: 'issue' }, { ...env, STUB_GH_DETAILS_DIR: detailsWith('ConsolaIssue.json', issue) });
    expect(details).toMatchObject({ state: 'closed', stateReason: 'not-planned' });
  });

  it('refuses a timeline it does not recognise rather than show an empty history', async () => {
    const timeline = JSON.parse(fs.readFileSync(path.join(detailsDir, 'ConsolaPullRequestTimeline.json'), 'utf8'));
    timeline[0].data.repository.pullRequest.timelineItems.nodes.push({ __typename: 'SomethingNew', id: 'X' });
    const broken = { ...env, STUB_GH_DETAILS_DIR: detailsWith('ConsolaPullRequestTimeline.json', timeline) };
    await expect(driver.fetchDetails(ref, broken)).rejects.toThrow(/Unrecognised timeline from GitHub/);
  });

  it('refuses a malformed thread and a missing pull request', async () => {
    const threads = JSON.parse(fs.readFileSync(path.join(detailsDir, 'ConsolaReviewThreads.json'), 'utf8'));
    delete threads[0].data.repository.pullRequest.reviewThreads.nodes[0].isResolved;
    await expect(driver.fetchDetails(ref, { ...env, STUB_GH_DETAILS_DIR: detailsWith('ConsolaReviewThreads.json', threads) }))
      .rejects.toThrow(/Unrecognised review threads/);
    const header = { data: { viewer: { __typename: 'User', login: 'JaviDev', avatarUrl: null }, repository: { pullRequest: null } } };
    await expect(driver.fetchDetails(ref, { ...env, STUB_GH_DETAILS_DIR: detailsWith('ConsolaPullRequest.json', header) }))
      .rejects.toThrow('did not return this pull request');
  });

  it('completes a thread with more comments than its first page', async () => {
    const threads = JSON.parse(fs.readFileSync(path.join(detailsDir, 'ConsolaReviewThreads.json'), 'utf8'));
    threads[0].data.repository.pullRequest.reviewThreads.nodes[0].comments.totalCount = 3;
    const first = threads[0].data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0];
    const extra = path.join(dir, 'details');
    detailsWith('ConsolaReviewThreads.json', threads);
    fs.writeFileSync(path.join(extra, 'ConsolaThreadComments.json'), JSON.stringify([
      { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [first, first, { ...first, id: 'PRRC_9', body: 'Third' }] } } } },
    ]));
    const details = await driver.fetchDetails(ref, { ...env, STUB_GH_DETAILS_DIR: extra });
    expect(details.threads[0].comments.map((comment) => comment.body)).toEqual(['Handle empty input here.', 'Handle empty input here.', 'Third']);
    expect(log()).toContain('-f id=PRRT_1');
  });
});

describe('GitHub item actions', () => {
  it('sends each explicit action to the correct repo without bypassing rules', async () => {
    const actions: WorkItemMutation[] = [
      { kind: 'comment', body: 'A multiline\ncomment with `code` and $(literal)' },
      { kind: 'edit', title: 'New title', body: 'Description' },
      { kind: 'review', event: 'approve', body: '' },
      { kind: 'review', event: 'request-changes', body: 'Add tests' },
      { kind: 'close', comment: 'Superseded by #48' }, { kind: 'reopen' }, { kind: 'ready', draft: true },
      { kind: 'merge', method: 'squash', headOid: 'a'.repeat(40), auto: true },
      { kind: 'update-branch' },
    ];
    for (const action of actions) await driver.mutateItem(ref, action, env);
    expect(log()).toContain('--body A multiline comment with `code` and $(literal)');
    expect(log()).toContain('--approve');
    expect(log()).toContain('--request-changes --body Add tests');
    expect(log()).toContain('pr close 51 --repo github.com/sprocket/catalog-portal --comment Superseded by #48');
    expect(log()).toContain('--undo');
    expect(log()).toContain(`--squash --match-head-commit ${'a'.repeat(40)} --auto`);
    expect(log()).toContain('pr update-branch 51 --repo github.com/sprocket/catalog-portal');
    expect(log()).not.toContain('--rebase');
    expect(log()).not.toContain('--admin');
    expect(log().match(/GH_TOKEN=stub-workspace-account/g)).toHaveLength(actions.length);
  });

  it('closes an issue as not planned', async () => {
    await driver.mutateItem({ ...ref, type: 'issue' }, { kind: 'close', reason: 'not-planned' }, env);
    expect(log()).toContain('issue close 51 --repo github.com/sprocket/catalog-portal --reason not planned');
    await expect(driver.mutateItem(ref, { kind: 'close', reason: 'completed' }, env)).rejects.toThrow('Only an issue');
  });

  it('checks that an id belongs to this item before writing to it', async () => {
    await driver.mutateItem(ref, { kind: 'reply', threadId: 'PRRT_1', body: 'Done', pendingReviewId: 'PRR_pending1' }, env);
    await driver.mutateItem(ref, { kind: 'resolve-thread', threadId: 'PRRT_1', resolved: true }, env);
    await driver.mutateItem(ref, { kind: 'resolve-thread', threadId: 'PRRT_2', resolved: false }, env);
    await driver.mutateItem(ref, { kind: 'edit-comment', target: 'comment', id: 'IC_3', body: 'Edited' }, env);
    await driver.mutateItem(ref, { kind: 'edit-comment', target: 'review-comment', id: 'PRRC_pending', body: 'Edited' }, env);
    await driver.mutateItem(ref, { kind: 'delete-comment', id: 'PRRC_pending' }, env);
    await driver.mutateItem(ref, { kind: 'review', event: 'request-changes', body: '', pendingReviewId: 'PRR_pending1' }, env);
    await driver.mutateItem(ref, { kind: 'discard-review', reviewId: 'PRR_pending1' }, env);
    expect(operations()).toEqual([
      'ConsolaNodeOwners', 'ConsolaReply', 'ConsolaNodeOwners', 'ConsolaResolveThread', 'ConsolaNodeOwners', 'ConsolaUnresolveThread',
      'ConsolaNodeOwners', 'ConsolaEditComment', 'ConsolaNodeOwners', 'ConsolaEditReviewComment', 'ConsolaNodeOwners',
      'ConsolaDeleteReviewComment', 'ConsolaNodeOwners', 'ConsolaSubmitReview', 'ConsolaNodeOwners', 'ConsolaDiscardReview',
    ]);
    expect(log()).toContain('-f threadId=PRRT_1 -f body=Done -f reviewId=PRR_pending1');
    expect(log()).toContain('-f id=PRR_pending1 -f event=REQUEST_CHANGES GH_TOKEN');
  });

  it('refuses an id from another item, or of another kind, without writing', async () => {
    await expect(driver.mutateItem(ref, { kind: 'reply', threadId: 'PRRT_1', body: 'Done' }, { ...env, STUB_GH_OWNER_NUMBER: '52' }))
      .rejects.toThrow('does not belong to this item');
    await expect(driver.mutateItem(ref, { kind: 'resolve-thread', threadId: 'IC_1', resolved: true }, env))
      .rejects.toThrow('does not belong to this item');
    expect(operations()).toEqual(['ConsolaNodeOwners', 'ConsolaNodeOwners']);
  });

  it('posts a single line comment on the head the diff was read at', async () => {
    await driver.mutateItem(ref, {
      kind: 'line-comment', mode: 'single', headOid: HEAD, path: 'src/billing.ts', line: 8, side: 'RIGHT',
      startLine: 7, startSide: 'RIGHT', body: '@not-a-file and `code`',
    }, env);
    expect(log()).toContain(
      `api --hostname github.com repos/sprocket/catalog-portal/pulls/51/comments --method POST -f body=@not-a-file and \`code\` -f commit_id=${HEAD} -f path=src/billing.ts -F line=8 -f side=RIGHT -F start_line=7 -f start_side=RIGHT`
    );
  });

  it('starts a review for the first comment held, and adds to it after', async () => {
    const comment = { kind: 'line-comment', mode: 'review', headOid: HEAD, path: 'src/billing.ts', line: 12, side: 'LEFT', body: 'Later' } as const;
    await driver.mutateItem(ref, comment, env);
    expect(operations()).toEqual(['ConsolaPullRequestId', 'ConsolaStartReview', 'ConsolaAddThread']);
    expect(log()).toContain(`-f pullRequestId=PR_kwDOsprocket51 -f commit=${HEAD}`);
    expect(log()).toContain('-f reviewId=PRR_pending1 -f body=Later -f path=src/billing.ts -F line=12 -f side=LEFT GH_TOKEN');
    fs.rmSync(path.join(dir, 'argv'));
    await driver.mutateItem(ref, { ...comment, pendingReviewId: 'PRR_pending1' }, env);
    expect(operations()).toEqual(['ConsolaNodeOwners', 'ConsolaAddThread']);
  });

  it('rejects malformed actions before spawning', async () => {
    const line = { kind: 'line-comment', mode: 'single', headOid: HEAD, path: 'a.ts', line: 3, side: 'RIGHT', body: 'x' } as const;
    await expect(driver.mutateItem({ ...ref, type: 'issue' }, { kind: 'review', event: 'approve', body: '' }, env)).rejects.toThrow('pull request');
    await expect(driver.mutateItem(ref, { kind: 'review', event: 'request-changes', body: '' }, env)).rejects.toThrow('required');
    await expect(driver.mutateItem(ref, { ...line, startLine: 3, startSide: 'RIGHT' }, env)).rejects.toThrow('start before');
    await expect(driver.mutateItem(ref, { ...line, startLine: 2 } as WorkItemMutation, env)).rejects.toThrow('both');
    await expect(driver.mutateItem(ref, { ...line, line: 0 }, env)).rejects.toThrow();
    await expect(driver.mutateItem(ref, { kind: 'reply', threadId: 'PRRT_1 } }', body: 'x' }, env)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'argv'))).toBe(false);
  });

  it('surfaces provider rejection for a write', async () => {
    const failure = path.join(dir, 'fail'); fs.writeFileSync(failure, '');
    const rejecting = { ...env, STUB_GH_MUTATION_FAILURE_FILE: failure };
    await expect(driver.mutateItem(ref, { kind: 'close' }, rejecting)).rejects.toThrow('repository rules');
    await expect(driver.mutateItem(ref, { kind: 'resolve-thread', threadId: 'PRRT_1', resolved: true }, rejecting)).rejects.toThrow('repository rules');
  });
});
