import { vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import { workItemUrl } from '../../shared/workItems';
import type { GitProviderDriver } from './GitProviderDriver';

/**
 * The one canned `GitProviderDriver` every provider-layer test builds on.
 *
 * `.test-helpers.ts` rather than `.test.ts` on purpose: vitest's `src/**\/*.test.ts`
 * glob would otherwise try to run this as a suite with no tests in it.
 *
 * Not gh: using this instead of a bespoke inline object is itself part of
 * the proof that InboxService, launchWorkItem and cloneRepo hold nothing
 * GitHub-specific — only what GitProviderDriver promises. `id` is 'github'
 * only because it is the union's sole member today; none of these callers
 * read it. Callers override whatever a given case needs to assert on
 * (a login-dependent token, a cloneRepo that touches disk, a rejecting
 * fetchInbox, ...) — the defaults here just mean a test that doesn't care
 * about a method never has to spell it out.
 */
export function createStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'GH_TOKEN',
    probe: vi.fn(async () => ({ available: true, accounts: [] })),
    token: vi.fn(async () => 'gho_test'),
    fetchInbox: vi.fn(async () => []),
    checkout: vi.fn(async () => undefined),
    cloneRepo: vi.fn(async () => undefined),
    // owner/name, case-insensitively, against the remote's last two path segments.
    matchesRemote: (remoteUrl: string, repo: string) => {
      const segments = remoteUrl
        .trim()
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
      if (segments.length < 2) return false;
      const lastTwo = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
      return lastTwo.toLowerCase() === repo.toLowerCase();
    },
    workItemUrl: (ref: WorkItemRef) => workItemUrl(ref),
    seedHeader: (ref: WorkItemRef, item?: InboxItem) =>
      `stub header for #${ref.number}${item ? ` (${item.title})` : ''}`,
    ...overrides,
  };
}
