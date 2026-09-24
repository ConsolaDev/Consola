import type { Workspace, Session } from '../../desktop/src/shared/workspace';
import type { Harness } from '../../desktop/src/shared/harness';
import type { InboxItem } from '../../desktop/src/shared/workItems';
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
  return { workItem: { provider: 'github', repo: 'acme/platform', type: 'pr', number }, title, author: 'mia', roles: ['review-requested-direct'], isDraft: false, state: 'open', reviewDecision: 'review-required', ciStatus: 'passing', checks: { passed: 8, failed: 0, pending: 0, total: 8 }, commentCount: 2, additions: 24, deletions: 8, updatedAt: new Date(now - number * 12000).toISOString(), url: '#sample-pr', ...overrides };
}
export const inboxes: Record<string, InboxItem[]> = {
  acme: [item(248, 'Add retry logic to the API client'), item(246, 'Simplify workspace navigation', { author: 'sam' }), item(243, 'Update authentication tests', { author: 'alex-work', roles: ['author'], ciStatus: 'failing', checks: { passed: 6, failed: 2, pending: 0, total: 8 } }), item(239, 'Handle expired sessions gracefully', { workItem: { provider: 'github', repo: 'acme/platform', type: 'issue', number: 239 }, roles: ['assignee'], reviewDecision: 'none', checks: undefined, ciStatus: undefined })],
  personal: [item(12, 'Add a reading list', { workItem: { provider: 'github', repo: 'alex-builds/weekend-app', type: 'pr', number: 12 }, author: 'jules' })],
};

export const oldCode = `export async function requestWithRetry(request: Request) {\n  try {\n    return await send(request);\n  } catch (error) {\n    return retry(request);\n  }\n}\n`;
export const newCode = `export async function requestWithRetry(request: Request) {\n  try {\n    return await send(request);\n  } catch (error) {\n    if (!isRetryable(error)) {\n      throw error;\n    }\n    return retry(request, { maxAttempts: 3 });\n  }\n}\n`;
export const testCode = `it('stops on non-retryable client errors', async () => {\n  server.respondWith(400);\n  await expect(requestWithRetry(request)).rejects.toThrow();\n  expect(server.attempts).toBe(1);\n});\n`;
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
