import type { Workspace, Session } from '../../desktop/src/shared/workspace';
import type { Harness } from '../../desktop/src/shared/harness';
import type { InboxItem } from '../../desktop/src/shared/workItems';
import type { WorkItemDetails, WorkItemPerson, WorkItemPost, WorkItemTimelineItem } from '../../desktop/src/shared/workItemDetails';
import type { GitDiffResult } from '../../desktop/src/renderer/types/electron';
import acmeIcon from './assets/acme.png?inline';
import personalIcon from './assets/personal.png?inline';

const now = Date.now();
export const harnesses: Harness[] = [
  { id: 'claude-work', driverId: 'claude', name: 'Claude Code · Work', accentColor: '#f97316', configDir: '~/.claude-work', enabled: true, archived: false, isBuiltIn: true, extraArgs: [], createdAt: now, updatedAt: now },
  { id: 'codex-personal', driverId: 'codex', name: 'Codex · Personal', accentColor: '#14b8a6', configDir: '~/.codex-personal', enabled: true, archived: false, isBuiltIn: false, extraArgs: [], createdAt: now, updatedAt: now },
];
export function session(workspaceId: string, id: string, name: string, groupId: string, harnessId: string): Session {
  return { id, name, nameIsUserSet: true, workspaceId, instanceId: `demo-${id}`, claudeSessionId: id, hasStarted: true, harnessId, scopeId: `${workspaceId}-repo`, groupId, kind: 'interactive', createdAt: now, lastActiveAt: now };
}
export const workspaces: Workspace[] = [
  {
    id: 'acme', name: 'Acme', icon: { type: 'image', dataUrl: acmeIcon }, defaultHarnessId: 'claude-work',
    provider: { id: 'github', accountLogin: 'alex-work', org: 'acme' },
    scopes: [{ id: 'acme-repo', name: 'platform', path: '/demo/acme/platform', isGitRepo: true, createdAt: now }],
    groups: [{ id: 'features', name: 'features', emoji: '🚀', createdAt: now }, { id: 'reviews', name: 'pr-reviews', emoji: '✅', createdAt: now }, { id: 'research', name: 'research', emoji: '🔎', createdAt: now }],
    actions: [
      { id: 'review', name: 'Review PR', appliesTo: ['pr'], groupId: 'reviews', prompt: 'Review this PR for correctness and edge cases. Check retry limits and error handling. Run the relevant tests and summarize your findings before making changes.' },
      { id: 'fix-ci', name: 'Fix CI', appliesTo: ['pr'], groupId: 'features', prompt: 'Investigate failing checks on this PR. Fix the underlying issue and run the relevant tests.' },
      { id: 'implement', name: 'Implement', appliesTo: ['issue'], groupId: 'features', prompt: 'Investigate this issue, implement a focused fix, and add a regression test.' },
    ],
    sectionDefaults: { 'needs-your-review': 'review', 'needs-action': 'fix-ci', issues: 'implement' },
    sessions: [session('acme', 'onboarding', 'Build onboarding flow', 'features', 'claude-work'), { ...session('acme', 'retry', 'Review retry logic', 'reviews', 'claude-work'), workItem: { provider: 'github', repo: 'acme/platform', type: 'pr', number: 248 }, workItemAction: 'Review PR' }, session('acme', 'api', 'Explore the API', 'research', 'claude-work')],
    createdAt: now, updatedAt: now,
  },
  {
    id: 'personal', name: 'Personal', icon: { type: 'image', dataUrl: personalIcon }, defaultHarnessId: 'codex-personal',
    provider: { id: 'github', accountLogin: 'alex-builds' },
    scopes: [{ id: 'personal-repo', name: 'weekend-app', path: '/demo/personal/weekend-app', isGitRepo: true, createdAt: now }],
    groups: [{ id: 'weekend', name: 'weekend-app', emoji: '🌱', createdAt: now }, { id: 'ideas', name: 'ideas', emoji: '💡', createdAt: now }],
    actions: [{ id: 'personal-review', name: 'Review', appliesTo: ['pr'], groupId: 'weekend', prompt: 'Review the PR and suggest small improvements.' }],
    sectionDefaults: { 'needs-your-review': 'personal-review' },
    sessions: [session('personal', 'landing', 'Build the landing page', 'weekend', 'codex-personal'), session('personal', 'weekend-ideas', 'Explore weekend ideas', 'ideas', 'codex-personal')],
    createdAt: now, updatedAt: now,
  },
];
function item(number: number, title: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const changed = sampleFiles[number] || [];
  return { workItem: { provider: 'github', repo: 'acme/platform', type: 'pr', number }, title, author: 'mia', roles: ['review-requested-direct'], isDraft: false, state: 'open', reviewDecision: 'review-required', ciStatus: 'passing', checks: { passed: 8, failed: 0, pending: 0, total: 8 }, commentCount: 2, additions: changed.reduce((sum, f) => sum + f.additions, 0), deletions: changed.reduce((sum, f) => sum + f.deletions, 0), updatedAt: new Date(now - number * 12000).toISOString(), url: '#sample-pr', ...overrides };
}
export const oldCode = `export async function requestWithRetry(request: Request) {\n  try {\n    return await send(request);\n  } catch (error) {\n    return retry(request);\n  }\n}\n`;
export const newCode = `export async function requestWithRetry(request: Request) {\n  try {\n    return await send(request);\n  } catch (error) {\n    if (!isRetryable(error)) {\n      throw error;\n    }\n    return retry(request, { maxAttempts: 3 });\n  }\n}\n`;
export const testCode = `it('stops on non-retryable client errors', async () => {\n  server.respondWith(400);\n  await expect(requestWithRetry(request)).rejects.toThrow();\n  expect(server.attempts).toBe(1);\n});\n`;
type ChangedFile = WorkItemDetails['files'][number];
function changedFile(path: string, status: string, patch: string): ChangedFile {
  const lines = patch.split('\n');
  return { path, status, patch, additions: lines.filter(l => l.startsWith('+')).length, deletions: lines.filter(l => l.startsWith('-')).length };
}
// What each sample pull request changes. #248 is the change before the demo's
// fix: it retries every error, which the terminal's review then finds.
const sampleFiles: Record<number, ChangedFile[]> = {
  248: [changedFile('src/lib/retry.ts', 'modified', `@@ -1,3 +1,7 @@
 export async function requestWithRetry(request: Request) {
-  return send(request);
+  try {
+    return await send(request);
+  } catch (error) {
+    return retry(request);
+  }
 }`)],
  246: [changedFile('src/navigation/workspaceNav.ts', 'modified', `@@ -8,9 +8,6 @@ export function nextView(state: NavState, target: Target): View {
   if (target.kind === 'session') {
     return { activeSessionId: target.id, isInboxOpen: false };
   }
-  if (target.kind === 'inbox' && state.isInboxOpen) {
-    return { ...state, isInboxOpen: true };
-  }
   if (target.kind === 'inbox') {
     return { ...state, isInboxOpen: true };
   }`)],
  243: [changedFile('src/auth/session.test.ts', 'modified', `@@ -12,5 +12,9 @@ describe('refreshSession', () => {
   it('refreshes a token that is about to expire', async () => {
     const session = await refreshSession(expiringToken);
     expect(session.token).not.toBe(expiringToken);
   });
+
+  it('signs out when the refresh token is revoked', async () => {
+    await expect(refreshSession(revokedToken)).rejects.toThrow('Signed out');
+  });
 });`)],
  12: [changedFile('src/readingList.ts', 'added', `@@ -0,0 +1,7 @@
+export interface Book { title: string; author: string; done: boolean }
+
+export function addBook(list: Book[], title: string, author: string): Book[] {
+  return [...list, { title, author, done: false }];
+}
+
+export const unread = (list: Book[]) => list.filter(book => !book.done);`)],
};
// The description, then the conversation, oldest first.
const conversations: Record<number, string[][]> = {
  248: [['Retries failed requests in `requestWithRetry`, so one flaky response no longer fails a whole sync.'], ['sam', 'Does this retry 4xx responses too? A 400 fails the same way on every attempt.'], ['mia', 'Fair point. A second opinion on which errors count as transient would help.']],
  246: [['Opening the Inbox no longer special-cases a workspace that already had it open: both branches did the same thing.'], ['mia', 'Nice cleanup.'], ['sam', 'Thanks! Ready for another look.']],
  243: [['Covers a revoked refresh token, which should sign the person out.'], ['sam', 'The new test fails on CI: `revokedToken` is not exported from the fixtures.'], ['alex-work', 'Good catch, exporting it.']],
  239: [['People with an expired session see a blank screen instead of the sign-in page.\n\n1. Sign in\n2. Wait for the session to expire\n3. Reload the page'], ['mia', 'Reproduced on the latest build.'], ['sam', 'Probably the refresh call throwing before the redirect runs.']],
  12: [['A simple reading list: add books, then filter the unread ones.'], ['jules', 'First pass. Storage comes in a follow-up.'], ['alex-builds', 'Looks good so far.']],
};
export const inboxes: Record<string, InboxItem[]> = {
  acme: [item(248, 'Add retry logic to the API client'), item(246, 'Simplify workspace navigation', { author: 'sam' }), item(243, 'Update authentication tests', { author: 'alex-work', roles: ['author'], ciStatus: 'failing', checks: { passed: 6, failed: 2, pending: 0, total: 8 } }), item(239, 'Handle expired sessions gracefully', { workItem: { provider: 'github', repo: 'acme/platform', type: 'issue', number: 239 }, roles: ['assignee'], reviewDecision: 'none', checks: undefined, ciStatus: undefined })],
  personal: [item(12, 'Add a reading list', { workItem: { provider: 'github', repo: 'alex-builds/weekend-app', type: 'pr', number: 12 }, author: 'jules' })],
};
const CHECK_NAMES = ['build', 'lint', 'typecheck', 'unit (node 22)', 'unit (node 24)', 'integration', 'e2e', 'license'];
const REVIEW_DECISIONS = { approved: 'APPROVED', 'changes-requested': 'CHANGES_REQUESTED', 'review-required': 'REVIEW_REQUIRED', none: undefined } as const;
const person = (login: string): WorkItemPerson => ({ login, isBot: false });
/** What GitHub's merge button would say: approved with nothing failing goes, anything else waits. */
export function mergeStateOf(details: Pick<WorkItemDetails, 'reviewDecision' | 'checks'>) {
  return details.reviewDecision === 'APPROVED' && !details.checks.some(c => c.state === 'FAILURE') ? 'CLEAN' : 'BLOCKED';
}
/**
 * An Inbox item as its pane reads it, built from the row so the two agree.
 * Sample content only: no avatars and no real links, so nothing leaves the page.
 */
export function details(item: InboxItem, viewer: string): WorkItemDetails {
  const { number, type } = item.workItem;
  const isPr = type === 'pr';
  const [[body], ...comments] = conversations[number] || [['A sample work item for the Consola demo.']];
  const reviewer = item.roles.includes('author') ? 'sam' : viewer;
  const failed = item.checks?.failed || 0;
  const pending = item.checks?.pending || 0;
  const head = ((number * 0x9e3779b1) >>> 0).toString(16).padStart(8, '0').repeat(5);
  const post = (id: string, login: string, text: string, minutesAgo: number): WorkItemPost => ({ id, author: person(login), body: text, url: item.url, createdAt: new Date(now - minutesAgo * 60_000).toISOString(), reactions: [], viewerCanEdit: login === viewer });
  const timeline: WorkItemTimelineItem[] = isPr
    ? [{ kind: 'commit', id: `commit-${number}`, createdAt: new Date(now - 200 * 60_000).toISOString(), oid: head, headline: item.title, author: person(item.author), url: item.url, checkState: failed ? 'FAILURE' : 'SUCCESS' }, { kind: 'review-requested', id: `request-${number}`, createdAt: new Date(now - 190 * 60_000).toISOString(), actor: person(item.author), reviewer }]
    : [];
  comments.forEach(([login, text], i) => timeline.push({ kind: 'comment', ...post(`comment-${number}-${i}`, login, text, 120 - i * 60) }));
  const result: WorkItemDetails = {
    title: item.title, body, state: item.state, isDraft: item.isDraft, author: item.author, url: item.url, viewer: person(viewer),
    description: post(`description-${number}`, item.author, body, 240),
    labels: [isPr ? { name: 'enhancement', color: 'a2eeef' } : { name: 'bug', color: 'd73a4a' }],
    assignees: item.roles.includes('assignee') ? [person(viewer)] : [],
    reviewers: isPr ? [{ who: person(reviewer), isTeam: false, state: 'requested' }] : [],
    timeline, threads: [],
    checks: Array.from({ length: item.checks?.total || 0 }, (_, i) => ({ name: CHECK_NAMES[i] || `check ${i + 1}`, state: i < failed ? 'FAILURE' : i < failed + pending ? 'PENDING' : 'SUCCESS', url: item.url })),
    files: sampleFiles[number] || [],
  };
  if (!isPr) return result;
  Object.assign(result, { additions: item.additions, deletions: item.deletions, headOid: head, headBranch: `feat/${number}`, baseBranch: 'main', reviewDecision: REVIEW_DECISIONS[item.reviewDecision], canUpdateBranch: false });
  return { ...result, mergeState: mergeStateOf(result) };
}
export const files = { 'src/lib/retry.ts': newCode, 'src/lib/retry.test.ts': testCode, 'README.md': '# Platform\n\nA sample repository for the Consola demo.\n' };
export function diff(filePath: string, staged: boolean): GitDiffResult {
  const isNew = filePath.endsWith('.test.ts');
  const oldContent = isNew ? '' : oldCode;
  const newContent = isNew ? testCode : newCode;
  const removed = oldContent.trimEnd().split('\n');
  const added = newContent.trimEnd().split('\n');
  const lines: GitDiffResult['hunks'][number]['lines'] = isNew
    ? added.map((content, i) => ({ type: 'add', content, newLineNumber: i + 1 }))
    : [
      ...removed.slice(0, 4).map((content, i) => ({ type: 'context' as const, content, oldLineNumber: i + 1, newLineNumber: i + 1 })),
      { type: 'remove', content: removed[4], oldLineNumber: 5 },
      ...added.slice(4, 8).map((content, i) => ({ type: 'add' as const, content, newLineNumber: i + 5 })),
      ...removed.slice(5).map((content, i) => ({ type: 'context' as const, content, oldLineNumber: i + 6, newLineNumber: i + 9 })),
    ];
  return { filePath, staged, oldContent, newContent, isBinary: false, isNew, isDeleted: false, hunks: [{ oldStart: isNew ? 0 : 1, oldLines: isNew ? 0 : removed.length, newStart: 1, newLines: added.length, lines }] };
}
