# Inbox v2 Phase B — Seam + Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the provider seam the last design promised underneath the shipped Inbox — a `GitProviderDriver` with GitHub as its only driver, provider-neutral inbox/launch/clone services, `provider:*` / `inbox:*` channels and bridges — and bring workspace state to v7 (a provider binding, actions with per-section defaults, a mutable session ↔ work-item link carrying an action-name snapshot) so Phases A, C and D build on one model. The user sees no change: the same Inbox, the same one-click launch, and `tests/e2e/inbox.spec.ts` passes without an edit.

**Architecture:** Everything `gh`-shaped moves behind `src/main/providers/github/GitHubDriver.ts` (it absorbs `GhBroker`, the GraphQL query and parser, `gh pr checkout`, `gh repo clone`, remote matching and the seed header); `InboxService`, `launchWorkItem`, `cloneWorkspaceRepo` and `WorktreeService` receive a driver through their deps and never name `'github'`, which a stub driver in their tests proves. Shared pure modules carry the vocabulary later phases need — `providers.ts`, `workItems.ts`, `inboxSections.ts`, `workItemActions.ts`, `workItemPrompt.ts` — and `workspace.ts` gains the v6 → v7 rung. The renderer only follows the renames.

**Tech Stack:** Electron 28 (main + preload + renderer), React 19, Zustand, `gh` CLI as subprocess, git worktrees, vitest (co-located, node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-inbox-actions-and-provider-seam-design.md` (sections "Domain model (state v7)", "Migration v6 → v7", "The provider seam", "Error handling", "Testing"; Phasing row "B — Seam + model").

## Global Constraints

- **Bridge pattern is binding**: renderer code never touches `window.*API` directly; all access goes through `src/renderer/services/*Bridge.ts`. New bridges this phase: `inboxBridge.ts` and `providerBridge.ts`; `githubBridge.ts` is deleted.
- **Every IPC channel name lives in `IPC_CHANNELS`** in `src/shared/constants.ts`. Added this phase (exact strings): `PROVIDER_PROBE: 'provider:probe'`, `PROVIDER_RESOLVE_REPOS: 'provider:resolve-repos'`, `PROVIDER_LAUNCH_WORK_ITEM: 'provider:launch-work-item'`, `PROVIDER_CLONE_REPO: 'provider:clone-repo'`, `INBOX_GET: 'inbox:get'`, `INBOX_REFRESH: 'inbox:refresh'`, `INBOX_CHANGED: 'inbox:changed'`, `WORKSPACE_SET_PROVIDER_BINDING: 'workspace:set-provider-binding'`, `WORKSPACE_SET_ACTIONS: 'workspace:set-actions'`. Removed: `GH_PROBE`, `GITHUB_GET_INBOX`, `GITHUB_REFRESH_INBOX`, `GITHUB_RESOLVE_REPOS`, `GITHUB_LAUNCH_WORK_ITEM`, `GITHUB_CLONE_REPO`, `GITHUB_INBOX_CHANGED`, `WORKSPACE_SET_GITHUB_BINDING`.
- **Preload globals (exact)**: `window.inboxAPI: InboxAPI` (`getInbox`, `refreshInbox`, `onInboxChanged`) and `window.providerAPI: ProviderAPI` (`probe(id)`, `resolveRepos`, `launchWorkItem`, `cloneRepo`); `window.githubAPI` is gone.
- **`PROVIDER_META.github` (verbatim)**: `id: 'github'`, `displayName: 'GitHub'`, `cliName: 'gh'`, `loginHint: 'gh auth login'`, `installHint: 'brew install gh (or see cli.github.com)'`.
- **Seed header templates (verbatim, in `PROVIDER_META.github.seedHeaderTemplate`)** — pr: `This session is for pull request #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user's own checkout stays untouched. Start with \`gh pr view {{number}}\` to read it.` — issue: `This session is for issue #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user's own checkout stays untouched. Start with \`gh issue view {{number}}\` to read it.`
- **Prompt placeholders**: `{{number}} {{repo}} {{title}} {{url}} {{type}}`; `type` renders as `pull request` / `issue`; `title` falls back to `PR #n` / `Issue #n`, `url` to `workItemUrl(ref)`; a template with no placeholders passes through untouched.
- **Default actions (verbatim; ids minted with `generateId()`)**: Review · pr · `Review the changes and summarise your findings before writing any review comments.` — Address review · pr · `Read every unresolved review thread with \`gh pr view {{number}} --comments\`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.` — Fix CI · pr · `Find the failing checks with \`gh pr checks {{number}}\`, reproduce locally, fix, push.` — Implement · issue · `Investigate it and propose a plan before changing anything.` — Triage · issue · `Reproduce, label the severity, and comment your findings. Do not change code.`
- **Default `sectionDefaults` (paired by action NAME)**: needs-your-review → Review, needs-team-review → Review, needs-action → Address review, waiting → Fix CI, issues → Implement. `your-drafts` and `ready-to-merge` have none.
- **Section display order and labels (verbatim)**: needs-your-review "Needs your review", needs-team-review "Needs your teams' review", your-drafts "Your drafts", waiting "Waiting for review or checks", needs-action "Needs action", ready-to-merge "Ready to merge", issues "Issues assigned to you". Collapsed by default: needs-team-review, your-drafts, ready-to-merge. There is no `SECTION_ITEM_TYPE` record — use `sectionItemType(section)`.
- **Presence semantics on session updates**: `workItem` joins `groupId` — `'workItem' in updates` with `undefined` means unlink, and an explicitly-undefined key must survive `allowedSessionUpdates`. `scopeId`, `cwd`, `kind`, `harnessId` and `model` stay off the allow-list. One `SessionUpdates` type, defined in `src/shared/workspace.ts` and re-exported from `src/main/state/updateFilters.ts`; every layer imports it.
- **Link refusals live in `WorkspaceService.updateSession`** (a `kind: 'conductor'` session; a session already linked to a *different* item — both throw); ref *shape* validation (`isValidWorkItemRef`) runs in the `WORKSPACE_SESSION_UPDATE` handler before the service is called.
- **`setProviderBinding(workspaceId, null)` deletes only the `provider` key** — actions and section defaults are untouched; a non-null binding seeds `createDefaultActions()` / `createDefaultSectionDefaults()` ONLY when `actions.length === 0`.
- **Tokens never cross IPC.** They are borrowed inside main (`driver.token`) and layered under `driver.tokenEnvVar` (`GH_TOKEN` for GitHub) onto subprocess and PTY envs by `layerProviderToken` / `composeProviderEnv` in `src/main/providers/index.ts`. `stripTokenLines` keeps scrubbing both `probe()` and `token()` failure text.
- **Nothing outside `src/main/providers/` branches on a provider id.** `getProviderDriver(id)` throws on an unknown id; the live callers (`TerminalService.borrowProviderToken`, `InboxService.doRefresh`, launch, clone, `WorktreeService.resolveRepo`) resolve it inside their existing degrade paths. The one renderer-side exception: `ProviderBindingPanel` hardcodes `'github'`.
- **`CONSOLA_GH_PATH` stays a live `process.env` lookup** on every binary resolution — the Playwright rig sets it on the spawned Electron process. `GitHubDriver.matchesRemote` enforces host `github.com` (a documented tightening); `normalizeRemote` is deleted.
- **Degrade, never dialog:** a missing `gh`, an expired token, offline, a malformed payload all become a labelled stale Inbox; a driver must throw on an unrecognised reply, never return an empty list.
- **Never type into a confirmation menu:** the seed prompt still rides `initialPrompt` → `TerminalService.queuePrompt`. B's interim `buildSeedPrompt(driver, ref, item)` = `driver.seedHeader(ref, item) + '\n\n' + <default body for the item type>` (Review for PRs, Implement for issues); Phase C replaces it with action rendering.
- **Commands:** `npm test` (vitest, node environment, `src/**/*.test.ts` only — no jsdom, no testing-library; React components are covered by `npm run typecheck` + Playwright, pure helpers by vitest), `npx vitest run <path>`, `npm run typecheck` (main + preload + renderer tsconfigs), `npm run build`, then `npx playwright test tests/e2e/inbox.spec.ts` (e2e launches `dist/main/main/index.js`, so build first). `tests/e2e/terminal.spec.ts` fails standalone on main — not a regression signal.
- **Typecheck goes red in the middle of this plan and that is expected:** `src/shared` is compiled by all three tsconfigs, so from Task 3 (which removes `Workspace.github`) until Task 11 (main), Task 12 (preload) and Task 14 (renderer) `npm run typecheck` reports errors in not-yet-migrated files. `npm test` must stay green after every task — vitest resolves imports at run time, which is why old modules are deleted only once their last vitest-loaded importer has moved.
- **Commit messages:** conventional prefix (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), a body that explains why, and the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Comments say why**, in the repo's existing voice. No emoji in code, comments, or UI copy (the `⑂` U+2442 glyph is a symbol and is allowed; nothing in B uses it).

---

### Task 1: Shared provider vocabulary — `providers.ts` and `workItems.ts`

**Files:**
- Create: `src/shared/providers.ts`
- Create: `src/shared/providers.test.ts`
- Create: `src/shared/workItems.ts`
- Move: `src/shared/github.test.ts` → `src/shared/workItems.test.ts` (rewritten against `./workItems`, with `isValidWorkItemRef` cases added)
- Keep untouched: `src/shared/github.ts` — every not-yet-migrated module still imports it; Task 14 deletes it once the last renderer importer has moved.

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `src/shared/providers.ts`: `type GitProviderId = 'github'`; `interface ProviderBinding { accountLogin: string; org?: string }`; `interface ProviderAccount { login: string; active: boolean }`; `interface ProviderProbeResult { available: boolean; resolvedBinary?: string; version?: string; accounts: ProviderAccount[]; error?: string }`; `interface ProviderMeta { id; displayName; cliName; loginHint; installHint; seedHeaderTemplate: Record<'pr' | 'issue', string> }`; `const PROVIDER_META: Record<GitProviderId, ProviderMeta>`; `function isGitProviderId(value: unknown): value is GitProviderId`.
  - `src/shared/workItems.ts`: `type InboxRole`; `interface WorkItemRef { provider: GitProviderId; repo: string; type: 'pr' | 'issue'; number: number }`; `interface InboxItem` (spec shape: `workItem, title, author, roles, isDraft, state, reviewDecision, ciStatus?, checks?, commentCount, additions?, deletions?, updatedAt, url`); `interface InboxSnapshot { workspaceId; items; fetchedAt; error? }`; `sameWorkItem(a?, b?)`, `workItemKey(ref)`, `workItemUrl(ref)`, `isValidWorkItemRef(value: unknown): value is WorkItemRef`.

- [ ] **Step 1: Write the failing providers test**

```ts
// src/shared/providers.test.ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_META, isGitProviderId, type GitProviderId } from './providers';

describe('isGitProviderId', () => {
  it('accepts every registered provider id', () => {
    for (const id of Object.keys(PROVIDER_META)) {
      expect(isGitProviderId(id)).toBe(true);
    }
  });

  it('rejects unknown ids, non-strings and Object.prototype names', () => {
    expect(isGitProviderId('gitlab')).toBe(false);
    expect(isGitProviderId(42)).toBe(false);
    expect(isGitProviderId(undefined)).toBe(false);
    // `'toString' in PROVIDER_META` is true. An IPC payload naming a
    // prototype member must not pass as a provider.
    expect(isGitProviderId('toString')).toBe(false);
  });
});

describe('PROVIDER_META', () => {
  it('keys every entry by its own id', () => {
    for (const [key, meta] of Object.entries(PROVIDER_META)) {
      expect(meta.id).toBe(key as GitProviderId);
    }
  });

  it('describes GitHub through its gh CLI', () => {
    expect(PROVIDER_META.github.displayName).toBe('GitHub');
    expect(PROVIDER_META.github.cliName).toBe('gh');
    expect(PROVIDER_META.github.loginHint).toBe('gh auth login');
    expect(PROVIDER_META.github.installHint).toBe('brew install gh (or see cli.github.com)');
  });

  it('seeds every header template with the item number and a read command for its own CLI', () => {
    for (const meta of Object.values(PROVIDER_META)) {
      for (const template of Object.values(meta.seedHeaderTemplate)) {
        expect(template).toContain('{{number}}');
        expect(template).toContain(`\`${meta.cliName} `);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: FAIL — cannot resolve `./providers`.

- [ ] **Step 3: Create `src/shared/providers.ts`**

```ts
/**
 * Git hosting providers a workspace can be bound to.
 *
 * Shared by main and renderer: the renderer reads display copy from
 * PROVIDER_META, main resolves a driver by id. Token-free by construction —
 * a provider's credential is borrowed inside main and never described here.
 */

/**
 * A union, like HarnessDriverId: supporting another provider means adding a
 * member here, an entry below, and a driver under src/main/providers/ —
 * nothing else may branch on the value.
 */
export type GitProviderId = 'github';

/** What a workspace stores about the account it acts as. */
export interface ProviderBinding {
  accountLogin: string;
  /** Scopes the Inbox query; absent = every repo the account can see. */
  org?: string;
}

/** One account the provider CLI's keyring holds. */
export interface ProviderAccount {
  login: string;
  /** Whether the CLI itself would use this account today. */
  active: boolean;
}

/** What probing a provider CLI found. Feeds the binding panel. */
export interface ProviderProbeResult {
  /** The binary was found and runs. */
  available: boolean;
  /** Path actually resolved, when one was found. */
  resolvedBinary?: string;
  version?: string;
  /** Empty when nobody is signed in — the UI offers the login hint. */
  accounts: ProviderAccount[];
  error?: string;
}

export interface ProviderMeta {
  id: GitProviderId;
  /** "GitHub" */
  displayName: string;
  /** The binary the user installs, e.g. "gh". */
  cliName: string;
  /** The command that signs an account in, e.g. "gh auth login". */
  loginHint: string;
  installHint: string;
  /**
   * The fixed context header prepended to every action body, per item type.
   * Placeholders are the ones workItemPrompt.ts substitutes.
   */
  seedHeaderTemplate: Record<'pr' | 'issue', string>;
}

export const PROVIDER_META: Record<GitProviderId, ProviderMeta> = {
  github: {
    id: 'github',
    displayName: 'GitHub',
    cliName: 'gh',
    loginHint: 'gh auth login',
    installHint: 'brew install gh (or see cli.github.com)',
    seedHeaderTemplate: {
      pr: 'This session is for pull request #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user\'s own checkout stays untouched. Start with `gh pr view {{number}}` to read it.',
      issue: 'This session is for issue #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user\'s own checkout stays untouched. Start with `gh issue view {{number}}` to read it.',
    },
  },
};

/**
 * Whether an unknown value names a provider Consola has a driver for.
 *
 * An own-property check rather than `in`: this guards IPC payloads, and
 * `'toString' in PROVIDER_META` would be true.
 */
export function isGitProviderId(value: unknown): value is GitProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_META, value);
}
```

- [ ] **Step 4: Run the providers test to verify it passes**

Run: `npx vitest run src/shared/providers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Move the work-item test and add the `isValidWorkItemRef` cases**

```bash
git mv src/shared/github.test.ts src/shared/workItems.test.ts
```

Then replace the whole file with:

```ts
// src/shared/workItems.test.ts
import { describe, expect, it } from 'vitest';
import {
  isValidWorkItemRef,
  sameWorkItem,
  workItemKey,
  workItemUrl,
  type WorkItemRef,
} from './workItems';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

describe('sameWorkItem', () => {
  it('matches identical refs', () => {
    expect(sameWorkItem(pr51, { ...pr51 })).toBe(true);
  });

  it('matches case-insensitively on repo — GitHub repo names are case-insensitive', () => {
    expect(sameWorkItem(pr51, { ...pr51, repo: 'Sympower/Controller-App' })).toBe(true);
  });

  it('distinguishes number, type, and repo', () => {
    expect(sameWorkItem(pr51, { ...pr51, number: 52 })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, type: 'issue' })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, repo: 'sympower/flex-portal' })).toBe(false);
  });

  it('is false when either side is absent — sessions without a workItem match nothing', () => {
    expect(sameWorkItem(undefined, pr51)).toBe(false);
    expect(sameWorkItem(pr51, undefined)).toBe(false);
    expect(sameWorkItem(undefined, undefined)).toBe(false);
  });
});

describe('workItemKey', () => {
  it('is stable across repo casing', () => {
    expect(workItemKey(pr51)).toBe(workItemKey({ ...pr51, repo: 'SYMPOWER/controller-app' }));
  });

  it('differs across type', () => {
    expect(workItemKey(pr51)).not.toBe(workItemKey({ ...pr51, type: 'issue' }));
  });
});

describe('workItemUrl', () => {
  it('builds the pull URL for PRs', () => {
    expect(workItemUrl(pr51)).toBe('https://github.com/sympower/controller-app/pull/51');
  });

  it('builds the issues URL for issues', () => {
    expect(workItemUrl({ ...pr51, type: 'issue', number: 87 })).toBe(
      'https://github.com/sympower/controller-app/issues/87'
    );
  });
});

describe('isValidWorkItemRef', () => {
  // This runs on an IPC payload before WorkspaceService links a session, so
  // every field is checked as an unknown, not trusted as a WorkItemRef.
  it('accepts a well-formed ref for a known provider', () => {
    expect(isValidWorkItemRef(pr51)).toBe(true);
    expect(isValidWorkItemRef({ ...pr51, type: 'issue', number: 87 })).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(isValidWorkItemRef({ ...pr51, provider: 'gitlab' })).toBe(false);
  });

  it('rejects a repo that is not owner/name', () => {
    expect(isValidWorkItemRef({ ...pr51, repo: 'controller-app' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: 'sympower/controller-app/extra' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: 'sym power/controller-app' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: '' })).toBe(false);
  });

  it('rejects a type other than pr or issue', () => {
    expect(isValidWorkItemRef({ ...pr51, type: 'pull' })).toBe(false);
  });

  it('rejects a number that is not a positive integer', () => {
    expect(isValidWorkItemRef({ ...pr51, number: 1.5 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: 0 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: -3 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: '51' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidWorkItemRef(null)).toBe(false);
    expect(isValidWorkItemRef('github:sympower/controller-app:pr:51')).toBe(false);
    expect(isValidWorkItemRef(undefined)).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/shared/workItems.test.ts`
Expected: FAIL — cannot resolve `./workItems`.

- [ ] **Step 7: Create `src/shared/workItems.ts`**

```ts
import type { GitProviderId } from './providers';
import { isGitProviderId } from './providers';

/**
 * Work-item shapes shared by main and renderer.
 *
 * Deliberately token-free: a token is borrowed from the provider CLI inside
 * the main process at the moment it is needed and never crosses IPC. Anything
 * defined here may end up in a renderer, so nothing here may carry a credential.
 */

/**
 * Why an item is in the inbox. An item can carry several: a PR you authored
 * and were also asked to review is both, and the sections care which.
 */
export type InboxRole =
  | 'review-requested-direct'
  | 'review-requested-team'
  | 'author'
  | 'assignee'
  | 'involved';

/**
 * A remote work item a session is about. Mutable on the session since v7:
 * a hand-made session can be linked to one after the fact, or unlinked.
 */
export interface WorkItemRef {
  provider: GitProviderId;
  /** "owner/name", e.g. "sympower/controller-app". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}

/**
 * One PR or issue in a workspace's Inbox, provider-neutral.
 *
 * Remote-driven on purpose: items exist whether or not the repo is cloned
 * locally. Everything the renderer shows comes from this shape — it holds no
 * token and no local path.
 */
export interface InboxItem {
  workItem: WorkItemRef;
  title: string;
  /** Login of whoever opened it. */
  author: string;
  /** Every reason this item is in the inbox; see sectionFor. */
  roles: InboxRole[];
  isDraft: boolean;
  /** Lowercased provider state, e.g. 'open'. */
  state: string;
  /** Normalised review verdict; 'none' for issues and unreviewed PRs. */
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none';
  /** Rolled-up CI verdict; absent when the item has no checks (issues, no CI). */
  ciStatus?: 'pending' | 'passing' | 'failing';
  /** Check counts, when the provider reports them. Phase D fills this in. */
  checks?: { passed: number; failed: number; pending: number; total: number };
  commentCount: number;
  additions?: number;
  deletions?: number;
  /** ISO timestamp from the provider, used for ordering. */
  updatedAt: string;
  url: string;
}

/**
 * One workspace's cached Inbox. Main owns it; renderers receive it on
 * inbox:changed and via inbox:get.
 *
 * On a failed refresh the previous items and fetchedAt are carried forward and
 * `error` is set — "degrade, never dialog": the UI labels the staleness, it
 * never loses the last good list.
 */
export interface InboxSnapshot {
  workspaceId: string;
  items: InboxItem[];
  /** Epoch ms of the last successful fetch; 0 when nothing ever succeeded. */
  fetchedAt: number;
  error?: string;
}

/** Whether two refs name the same work item. Repo casing is not identity. */
export function sameWorkItem(a?: WorkItemRef, b?: WorkItemRef): boolean {
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.type === b.type &&
    a.number === b.number
  );
}

/** Stable map key for a work item, casing-normalised like sameWorkItem. */
export function workItemKey(ref: WorkItemRef): string {
  return `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`;
}

/**
 * Canonical web URL for a work item, for when no fetched item carries one.
 *
 * Renderer-reachable on purpose (the strip needs a link with no driver round
 * trip); the GitHub driver's own workItemUrl delegates here.
 */
export function workItemUrl(ref: WorkItemRef): string {
  return `https://github.com/${ref.repo}/${ref.type === 'pr' ? 'pull' : 'issues'}/${ref.number}`;
}

/** Exactly one slash, no whitespace on either side of it. */
const OWNER_NAME_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * Shape-validate an unknown value as a WorkItemRef before it reaches
 * WorkspaceService: a known provider id, "owner/name", pr | issue, and a
 * positive integer number. Pure; the WORKSPACE_SESSION_UPDATE handler runs
 * it on the link payload, where TypeScript's types are long gone.
 */
export function isValidWorkItemRef(value: unknown): value is WorkItemRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isGitProviderId(ref.provider) &&
    typeof ref.repo === 'string' &&
    OWNER_NAME_PATTERN.test(ref.repo) &&
    (ref.type === 'pr' || ref.type === 'issue') &&
    typeof ref.number === 'number' &&
    Number.isInteger(ref.number) &&
    ref.number > 0
  );
}
```

- [ ] **Step 8: Run both tests, the suite, and typecheck**

Run: `npx vitest run src/shared/workItems.test.ts src/shared/providers.test.ts`
Expected: PASS (19 tests).

Run: `npm test`
Expected: 40 files, 464 tests pass (the 453 baseline, minus the 8 moved cases, plus 14 in `workItems.test.ts` and 5 in `providers.test.ts`).

Run: `npm run typecheck`
Expected: clean — both modules are additive and `github.ts` is untouched.

- [ ] **Step 9: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts src/shared/workItems.ts src/shared/workItems.test.ts
git commit -m "feat: shared provider vocabulary and provider-neutral work-item shapes" -m "PROVIDER_META gives the renderer its display copy and the seed header templates without a driver round trip; workItems.ts is github.ts reshaped to the spec's InboxItem (roles, author, isDraft, normalised reviewDecision) plus the ref validator the link door will need. github.ts stays until its last importer moves.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared sections, actions and prompt rendering

**Files:**
- Create: `src/shared/ids.ts`, `src/shared/ids.test.ts`
- Modify: `src/shared/workspace.ts:88-90` (`generateId` moves to `ids.ts` and is re-exported — see Step 3 for why)
- Create: `src/shared/inboxSections.ts`, `src/shared/inboxSections.test.ts`
- Create: `src/shared/workItemActions.ts`, `src/shared/workItemActions.test.ts`
- Create: `src/shared/workItemPrompt.ts`, `src/shared/workItemPrompt.test.ts`

**Interfaces:**
- Consumes: `InboxItem`, `WorkItemRef`, `workItemUrl` from Task 1's `src/shared/workItems.ts`; `PROVIDER_META` from `src/shared/providers.ts`.
- Produces:
  - `src/shared/ids.ts`: `generateId(): string` (the function that lived in `workspace.ts`; `workspace.ts` keeps exporting it).
  - `src/shared/inboxSections.ts`: `type InboxSection`; `sectionItemType(section): 'pr' | 'issue'`; `sectionFor(item: InboxItem): InboxSection | null`; `INBOX_SECTIONS: ReadonlyArray<{ id: InboxSection; label: string }>`; `DEFAULT_COLLAPSED_SECTIONS: ReadonlySet<InboxSection>`.
  - `src/shared/workItemActions.ts` (exactly these exports): `interface WorkItemAction { id; name; appliesTo: Array<'pr' | 'issue'>; prompt }`; `createDefaultActions(): WorkItemAction[]`; `createDefaultSectionDefaults(actions): Partial<Record<InboxSection, string>>`; `defaultActionNameForType(type): string`; `interface ActionsWrite { actions; sectionDefaults }`; `type ActionsValidationResult = { ok: true } | { ok: false; message: string }`; `validateActionsWrite(write): ActionsValidationResult`.
  - `src/shared/workItemPrompt.ts`: `fallbackWorkItemTitle(ref)`, `substitutePlaceholders(template, ref, item?)`, `renderSeedHeader(templates, ref, item?)`.

- [ ] **Step 1: Write the failing ids test**

```ts
// src/shared/ids.test.ts
import { describe, expect, it } from 'vitest';
import { generateId } from './ids';

describe('generateId', () => {
  it('mints a different id on every call, even within one millisecond', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  it('is plain base36 text — safe as a JSON key and a DOM id', () => {
    expect(generateId()).toMatch(/^[0-9a-z]+$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/ids.test.ts`
Expected: FAIL — cannot resolve `./ids`.

- [ ] **Step 3: Create `src/shared/ids.ts` and re-export it from `workspace.ts`**

```ts
// src/shared/ids.ts
/**
 * Random record ids.
 *
 * A module of its own rather than a workspace.ts helper because
 * workItemActions.ts mints ids for the default actions while workspace.ts
 * imports those defaults for the v7 migration — kept in workspace.ts, the two
 * files would import each other.
 */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}
```

In `src/shared/workspace.ts`, change the import block at the top from:

```ts
import { BUILT_IN_HARNESS_ID } from './constants';
import type { WorkItemRef } from './github';
```

to:

```ts
import { BUILT_IN_HARNESS_ID } from './constants';
import type { WorkItemRef } from './github';
import { generateId } from './ids';

export { generateId };
```

and delete the old definition (lines 88–90):

```ts
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}
```

Nothing outside `workspace.ts` imports `generateId` today, but the re-export keeps `workspace.ts`'s surface unchanged for Task 3 and for the renderer.

- [ ] **Step 4: Run the ids test and the workspace test**

Run: `npx vitest run src/shared/ids.test.ts src/shared/workspace.test.ts`
Expected: PASS — the migration and record factories still mint ids through the re-export.

- [ ] **Step 5: Write the failing sections test**

```ts
// src/shared/inboxSections.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from './workItems';
import {
  DEFAULT_COLLAPSED_SECTIONS,
  INBOX_SECTIONS,
  sectionFor,
  sectionItemType,
  type InboxSection,
} from './inboxSections';

function pr(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    author: 'anna',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    commentCount: 0,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    ...overrides,
  };
}

function issue(overrides: Partial<InboxItem> = {}): InboxItem {
  return pr({
    workItem: { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 },
    title: 'Rate limit returns 500',
    roles: ['assignee'],
    reviewDecision: 'none',
    url: 'https://github.com/sympower/msa-resource-bff/issues/87',
    ...overrides,
  });
}

describe('sectionFor', () => {
  it('needs-your-review: a PR whose review was requested of you directly', () => {
    expect(sectionFor(pr({ roles: ['review-requested-direct'] }))).toBe('needs-your-review');
  });

  it('needs-team-review: a PR whose review was requested of a team you are on', () => {
    expect(sectionFor(pr({ roles: ['review-requested-team'] }))).toBe('needs-team-review');
  });

  it('your-drafts: your own draft PR', () => {
    expect(sectionFor(pr({ isDraft: true }))).toBe('your-drafts');
  });

  it('needs-action: your PR with changes requested, or with failing CI', () => {
    expect(sectionFor(pr({ reviewDecision: 'changes-requested' }))).toBe('needs-action');
    expect(sectionFor(pr({ ciStatus: 'failing' }))).toBe('needs-action');
  });

  it('ready-to-merge: your approved PR whose checks pass or do not exist', () => {
    expect(sectionFor(pr({ reviewDecision: 'approved', ciStatus: 'passing' }))).toBe('ready-to-merge');
    expect(sectionFor(pr({ reviewDecision: 'approved' }))).toBe('ready-to-merge');
  });

  it('waiting: every other PR of yours — review pending, or approved with checks still running', () => {
    expect(sectionFor(pr())).toBe('waiting');
    expect(sectionFor(pr({ reviewDecision: 'approved', ciStatus: 'pending' }))).toBe('waiting');
  });

  it('issues: an issue assigned to you', () => {
    expect(sectionFor(issue())).toBe('issues');
  });

  it('first match wins: a review request outranks authorship, drafts and failing CI', () => {
    expect(
      sectionFor(pr({ roles: ['author', 'review-requested-direct'], isDraft: true, ciStatus: 'failing' }))
    ).toBe('needs-your-review');
    expect(sectionFor(pr({ roles: ['author', 'review-requested-team'], isDraft: true }))).toBe(
      'needs-team-review'
    );
  });

  it('has no section for items you are merely involved in, or issues you did not get assigned', () => {
    // Absent from the Inbox view; Phase D's "Involves me" view still lists them.
    expect(sectionFor(pr({ roles: ['involved'] }))).toBeNull();
    expect(sectionFor(issue({ roles: ['author'] }))).toBeNull();
    expect(sectionFor(issue({ roles: ['review-requested-direct'] }))).toBeNull();
  });
});

describe('sectionItemType', () => {
  it('holds issues only in the issues section', () => {
    const sections = INBOX_SECTIONS.map((section) => section.id);
    expect(sections.filter((id) => sectionItemType(id) === 'issue')).toEqual(['issues']);
    expect(sections.filter((id) => sectionItemType(id) === 'pr')).toHaveLength(6);
  });
});

describe('INBOX_SECTIONS', () => {
  it("lists every section once, in GitHub's display order with Issues last", () => {
    expect(INBOX_SECTIONS.map((section) => section.id)).toEqual<InboxSection[]>([
      'needs-your-review',
      'needs-team-review',
      'your-drafts',
      'waiting',
      'needs-action',
      'ready-to-merge',
      'issues',
    ]);
  });

  it('labels sections the way GitHub does', () => {
    expect(INBOX_SECTIONS.map((section) => section.label)).toEqual([
      'Needs your review',
      "Needs your teams' review",
      'Your drafts',
      'Waiting for review or checks',
      'Needs action',
      'Ready to merge',
      'Issues assigned to you',
    ]);
  });
});

describe('DEFAULT_COLLAPSED_SECTIONS', () => {
  it('starts the low-urgency sections collapsed and the rest open', () => {
    expect([...DEFAULT_COLLAPSED_SECTIONS].sort()).toEqual([
      'needs-team-review',
      'ready-to-merge',
      'your-drafts',
    ]);
    expect(DEFAULT_COLLAPSED_SECTIONS.has('needs-your-review')).toBe(false);
    expect(DEFAULT_COLLAPSED_SECTIONS.has('issues')).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/shared/inboxSections.test.ts`
Expected: FAIL — cannot resolve `./inboxSections`.

- [ ] **Step 7: Create `src/shared/inboxSections.ts`**

```ts
import type { InboxItem } from './workItems';

/**
 * The Inbox's sections — GitHub's own PR inbox, verbatim, plus the issues
 * assigned to you. Pure over InboxItem so the renderer sections the cache
 * and the settings panel filters actions by section without a round trip.
 */
export type InboxSection =
  | 'needs-your-review'
  | 'needs-team-review'
  | 'your-drafts'
  | 'needs-action'
  | 'ready-to-merge'
  | 'waiting'
  | 'issues';

/** Which item type a section holds. Every section but `issues` is PR-only. */
export function sectionItemType(section: InboxSection): 'pr' | 'issue' {
  return section === 'issues' ? 'issue' : 'pr';
}

/**
 * Display order (GitHub's, with Issues last). Precedence when an item
 * qualifies for several sections is sectionFor's business, not this list's.
 */
export const INBOX_SECTIONS: ReadonlyArray<{ id: InboxSection; label: string }> = [
  { id: 'needs-your-review', label: 'Needs your review' },
  { id: 'needs-team-review', label: "Needs your teams' review" },
  { id: 'your-drafts', label: 'Your drafts' },
  { id: 'waiting', label: 'Waiting for review or checks' },
  { id: 'needs-action', label: 'Needs action' },
  { id: 'ready-to-merge', label: 'Ready to merge' },
  { id: 'issues', label: 'Issues assigned to you' },
];

/** Sections that start collapsed: nothing in them is waiting on you. */
export const DEFAULT_COLLAPSED_SECTIONS: ReadonlySet<InboxSection> = new Set<InboxSection>([
  'needs-team-review',
  'your-drafts',
  'ready-to-merge',
]);

/**
 * The one section an item belongs to, or null when it belongs to none.
 *
 * First match wins, in the spec's order: the reason you were asked (a review
 * request) outranks the reason you are merely attached (authorship). An item
 * matching no row is absent from the Inbox view but still in "Involves me".
 */
export function sectionFor(item: InboxItem): InboxSection | null {
  const { roles } = item;
  if (item.workItem.type === 'pr') {
    if (roles.includes('review-requested-direct')) return 'needs-your-review';
    if (roles.includes('review-requested-team')) return 'needs-team-review';
    if (!roles.includes('author')) return null;
    if (item.isDraft) return 'your-drafts';
    if (item.reviewDecision === 'changes-requested' || item.ciStatus === 'failing') {
      return 'needs-action';
    }
    if (
      item.reviewDecision === 'approved' &&
      (item.ciStatus === 'passing' || item.ciStatus === undefined)
    ) {
      return 'ready-to-merge';
    }
    return 'waiting';
  }
  return roles.includes('assignee') ? 'issues' : null;
}
```

- [ ] **Step 8: Run the sections test to verify it passes**

Run: `npx vitest run src/shared/inboxSections.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Write the failing actions test**

```ts
// src/shared/workItemActions.test.ts
import { describe, expect, it } from 'vitest';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  defaultActionNameForType,
  validateActionsWrite,
  type WorkItemAction,
} from './workItemActions';

function idOf(actions: WorkItemAction[], name: string): string {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`no default action named ${name}`);
  return action.id;
}

describe('createDefaultActions', () => {
  it('seeds the five defaults in order, typed by what they apply to', () => {
    const actions = createDefaultActions();
    expect(actions.map((action) => [action.name, action.appliesTo])).toEqual([
      ['Review', ['pr']],
      ['Address review', ['pr']],
      ['Fix CI', ['pr']],
      ['Implement', ['issue']],
      ['Triage', ['issue']],
    ]);
  });

  it('carries the spec bodies verbatim', () => {
    expect(createDefaultActions().map((action) => action.prompt)).toEqual([
      'Review the changes and summarise your findings before writing any review comments.',
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
      'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
      'Investigate it and propose a plan before changing anything.',
      'Reproduce, label the severity, and comment your findings. Do not change code.',
    ]);
  });

  it('mints fresh, unique ids on every call so two workspaces never share a record', () => {
    const first = createDefaultActions();
    const second = createDefaultActions();
    expect(new Set(first.map((action) => action.id)).size).toBe(5);
    expect(first.map((action) => action.id)).not.toEqual(second.map((action) => action.id));
    expect(first[0].appliesTo).not.toBe(second[0].appliesTo);
  });
});

describe('createDefaultSectionDefaults', () => {
  it('points each section at the default action of that name, by id', () => {
    const actions = createDefaultActions();
    expect(createDefaultSectionDefaults(actions)).toEqual({
      'needs-your-review': idOf(actions, 'Review'),
      'needs-team-review': idOf(actions, 'Review'),
      'needs-action': idOf(actions, 'Address review'),
      waiting: idOf(actions, 'Fix CI'),
      issues: idOf(actions, 'Implement'),
    });
  });

  it('leaves drafts and ready-to-merge without a default', () => {
    const defaults = createDefaultSectionDefaults(createDefaultActions());
    expect(defaults).not.toHaveProperty('your-drafts');
    expect(defaults).not.toHaveProperty('ready-to-merge');
  });

  it('omits a section whose named action is missing rather than pointing at nothing', () => {
    const withoutReview = createDefaultActions().filter((action) => action.name !== 'Review');
    const defaults = createDefaultSectionDefaults(withoutReview);
    expect(defaults).not.toHaveProperty('needs-your-review');
    expect(defaults).not.toHaveProperty('needs-team-review');
    expect(defaults.issues).toBe(idOf(withoutReview, 'Implement'));
  });
});

describe('defaultActionNameForType', () => {
  it("is Review for PRs and Implement for issues — the split today's hardcoded prompt made", () => {
    expect(defaultActionNameForType('pr')).toBe('Review');
    expect(defaultActionNameForType('issue')).toBe('Implement');
  });
});

describe('validateActionsWrite', () => {
  const actions = createDefaultActions();
  const sectionDefaults = createDefaultSectionDefaults(actions);

  it('accepts the seeded defaults', () => {
    expect(validateActionsWrite({ actions, sectionDefaults })).toEqual({ ok: true });
  });

  it('accepts an empty list with no defaults — an unbound workspace', () => {
    expect(validateActionsWrite({ actions: [], sectionDefaults: {} })).toEqual({ ok: true });
  });

  it('rejects duplicate ids', () => {
    const duplicated = [...actions, { ...actions[0], name: 'Review again' }];
    expect(validateActionsWrite({ actions: duplicated, sectionDefaults })).toEqual({
      ok: false,
      message: `Duplicate action id: ${actions[0].id}`,
    });
  });

  it('rejects an action that applies to nothing', () => {
    const write = { actions: [{ ...actions[0], appliesTo: [] }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({
      ok: false,
      message: '"Review" must apply to pull requests, issues, or both.',
    });
  });

  it('rejects an action that applies to an item type that does not exist', () => {
    const write = {
      actions: [{ ...actions[0], appliesTo: ['pull'] as unknown as WorkItemAction['appliesTo'] }],
      sectionDefaults: {},
    };
    expect(validateActionsWrite(write)).toEqual({
      ok: false,
      message: '"Review" applies to an unknown item type.',
    });
  });

  it('rejects an empty prompt — whitespace counts as empty', () => {
    const write = { actions: [{ ...actions[0], prompt: '   ' }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: '"Review" needs a prompt.' });
  });

  it('rejects an empty name', () => {
    const write = { actions: [{ ...actions[0], name: ' ' }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: 'Every action needs a name.' });
  });

  it('rejects a default pointing at an action that does not exist', () => {
    expect(
      validateActionsWrite({ actions, sectionDefaults: { issues: 'gone' } })
    ).toEqual({
      ok: false,
      message: 'The default for "issues" points at an action that does not exist.',
    });
  });

  it('rejects a default whose action does not apply to the section item type', () => {
    expect(
      validateActionsWrite({ actions, sectionDefaults: { issues: idOf(actions, 'Review') } })
    ).toEqual({
      ok: false,
      message: '"Review" cannot be the default for "issues": it does not apply to issues.',
    });
    expect(
      validateActionsWrite({ actions, sectionDefaults: { waiting: idOf(actions, 'Implement') } })
    ).toEqual({
      ok: false,
      message: '"Implement" cannot be the default for "waiting": it does not apply to pull requests.',
    });
  });

  it('rejects a section it does not know', () => {
    const write = {
      actions,
      sectionDefaults: { merged: idOf(actions, 'Review') } as unknown as typeof sectionDefaults,
    };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: 'Unknown inbox section: merged' });
  });

  it('rejects payloads that are not a list and an object — what IPC can deliver', () => {
    expect(
      validateActionsWrite({ actions: 'nope' as unknown as WorkItemAction[], sectionDefaults: {} })
    ).toEqual({ ok: false, message: 'Actions must be a list.' });
    expect(
      validateActionsWrite({ actions: [], sectionDefaults: null as unknown as typeof sectionDefaults })
    ).toEqual({ ok: false, message: 'Section defaults must be an object.' });
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run src/shared/workItemActions.test.ts`
Expected: FAIL — cannot resolve `./workItemActions`.

- [ ] **Step 11: Create `src/shared/workItemActions.ts`**

```ts
import { generateId } from './ids';
import { INBOX_SECTIONS, sectionItemType, type InboxSection } from './inboxSections';

/**
 * Actions: the verbs a workspace offers on a work item.
 *
 * Records on the workspace rather than code, so "fix CI" or "run a security
 * pass" is a settings edit. Consola prepends the provider's fixed context
 * header; the body here is the editable part and may be a bare slash command.
 */
export interface WorkItemAction {
  id: string;
  /** "Review", "Fix CI" — also the name snapshot a launched session keeps. */
  name: string;
  /** Non-empty. */
  appliesTo: Array<'pr' | 'issue'>;
  /** Body only, non-empty; the header is the provider's. */
  prompt: string;
}

const DEFAULT_ACTION_TEMPLATES: ReadonlyArray<Omit<WorkItemAction, 'id'>> = [
  {
    name: 'Review',
    appliesTo: ['pr'],
    prompt: 'Review the changes and summarise your findings before writing any review comments.',
  },
  {
    name: 'Address review',
    appliesTo: ['pr'],
    prompt:
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
  },
  {
    name: 'Fix CI',
    appliesTo: ['pr'],
    prompt: 'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
  },
  {
    name: 'Implement',
    appliesTo: ['issue'],
    prompt: 'Investigate it and propose a plan before changing anything.',
  },
  {
    name: 'Triage',
    appliesTo: ['issue'],
    prompt: 'Reproduce, label the severity, and comment your findings. Do not change code.',
  },
];

/** Which default each section highlights, by action NAME — ids are minted per workspace. */
const DEFAULT_SECTION_ACTION_NAMES: Partial<Record<InboxSection, string>> = {
  'needs-your-review': 'Review',
  'needs-team-review': 'Review',
  'needs-action': 'Address review',
  waiting: 'Fix CI',
  issues: 'Implement',
};

/** Fresh records with fresh ids — never shared by reference between callers. */
export function createDefaultActions(): WorkItemAction[] {
  return DEFAULT_ACTION_TEMPLATES.map((template) => ({
    id: generateId(),
    name: template.name,
    appliesTo: [...template.appliesTo],
    prompt: template.prompt,
  }));
}

/**
 * Section defaults paired to the ids `createDefaultActions` just minted.
 *
 * Paired by name because that is the only stable handle across calls; a
 * section whose named action is missing gets no default rather than a
 * dangling id.
 */
export function createDefaultSectionDefaults(
  actions: WorkItemAction[]
): Partial<Record<InboxSection, string>> {
  const defaults: Partial<Record<InboxSection, string>> = {};
  for (const [section, name] of Object.entries(DEFAULT_SECTION_ACTION_NAMES) as Array<
    [InboxSection, string]
  >) {
    const action = actions.find((candidate) => candidate.name === name);
    if (action) defaults[section] = action.id;
  }
  return defaults;
}

/**
 * The name backfilled onto a pre-v7 session's workItemAction, by item type.
 *
 * The role a session was launched under was never persisted, so the type is
 * the best the migration can do — and today's hardcoded prompt was exactly
 * this split.
 */
export function defaultActionNameForType(type: 'pr' | 'issue'): string {
  return type === 'pr' ? 'Review' : 'Implement';
}

export interface ActionsWrite {
  actions: WorkItemAction[];
  sectionDefaults: Partial<Record<InboxSection, string>>;
}

export type ActionsValidationResult = { ok: true } | { ok: false; message: string };

function isKnownSection(value: string): value is InboxSection {
  return INBOX_SECTIONS.some((section) => section.id === value);
}

/**
 * Pure validation for workspace:set-actions: unique ids, a name, non-empty
 * appliesTo and prompt per action, every default pointing at an existing
 * action of a matching type. Shape checks come first because this runs on an
 * IPC payload, where TypeScript's types are long gone. Side-effect-free so
 * it is unit-testable without a running WorkspaceService; the whole write is
 * rejected on the first failure and the message is shown inline.
 */
export function validateActionsWrite(write: ActionsWrite): ActionsValidationResult {
  if (!Array.isArray(write.actions)) return { ok: false, message: 'Actions must be a list.' };
  if (typeof write.sectionDefaults !== 'object' || write.sectionDefaults === null) {
    return { ok: false, message: 'Section defaults must be an object.' };
  }

  const seen = new Set<string>();
  for (const action of write.actions) {
    if (typeof action?.id !== 'string' || action.id === '') {
      return { ok: false, message: 'Every action needs an id.' };
    }
    if (seen.has(action.id)) return { ok: false, message: `Duplicate action id: ${action.id}` };
    seen.add(action.id);
    if (typeof action.name !== 'string' || action.name.trim() === '') {
      return { ok: false, message: 'Every action needs a name.' };
    }
    if (!Array.isArray(action.appliesTo) || action.appliesTo.length === 0) {
      return { ok: false, message: `"${action.name}" must apply to pull requests, issues, or both.` };
    }
    if (action.appliesTo.some((type) => type !== 'pr' && type !== 'issue')) {
      return { ok: false, message: `"${action.name}" applies to an unknown item type.` };
    }
    if (typeof action.prompt !== 'string' || action.prompt.trim() === '') {
      return { ok: false, message: `"${action.name}" needs a prompt.` };
    }
  }

  for (const [section, actionId] of Object.entries(write.sectionDefaults)) {
    if (actionId === undefined) continue;
    if (!isKnownSection(section)) return { ok: false, message: `Unknown inbox section: ${section}` };
    const action = write.actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      return {
        ok: false,
        message: `The default for "${section}" points at an action that does not exist.`,
      };
    }
    const wanted = sectionItemType(section);
    if (!action.appliesTo.includes(wanted)) {
      return {
        ok: false,
        message: `"${action.name}" cannot be the default for "${section}": it does not apply to ${
          wanted === 'pr' ? 'pull requests' : 'issues'
        }.`,
      };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 12: Run the actions test to verify it passes**

Run: `npx vitest run src/shared/workItemActions.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 13: Write the failing prompt-rendering test**

```ts
// src/shared/workItemPrompt.test.ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_META } from './providers';
import type { InboxItem, WorkItemRef } from './workItems';
import { fallbackWorkItemTitle, renderSeedHeader, substitutePlaceholders } from './workItemPrompt';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

describe('fallbackWorkItemTitle', () => {
  it('names the item by type and number when the inbox has no title for it', () => {
    expect(fallbackWorkItemTitle(pr51)).toBe('PR #51');
    expect(fallbackWorkItemTitle(issue87)).toBe('Issue #87');
  });
});

describe('substitutePlaceholders', () => {
  it('fills every placeholder from the cached item', () => {
    expect(
      substitutePlaceholders('{{type}} {{number}} in {{repo}}: "{{title}}" ({{url}})', pr51, item51)
    ).toBe(
      'pull request 51 in sympower/controller-app: "Extract billing client" (https://github.com/sympower/controller-app/pull/51)'
    );
  });

  it('falls back to a plain title and the canonical URL when the inbox has no item', () => {
    expect(substitutePlaceholders('{{title}} at {{url}}', issue87)).toBe(
      'Issue #87 at https://github.com/sympower/msa-resource-bff/issues/87'
    );
  });

  it('renders {{type}} as "issue" for issues', () => {
    expect(substitutePlaceholders('this {{type}}', issue87)).toBe('this issue');
  });

  it('substitutes every occurrence and tolerates whitespace inside the braces', () => {
    expect(substitutePlaceholders('{{ number }}/{{number}}', pr51)).toBe('51/51');
  });

  it('passes a template with no placeholders through untouched — a bare slash command', () => {
    expect(substitutePlaceholders('/review', pr51, item51)).toBe('/review');
  });

  it('leaves a placeholder it does not know alone rather than blanking it', () => {
    expect(substitutePlaceholders('see {{branch}}', pr51)).toBe('see {{branch}}');
  });
});

describe('renderSeedHeader', () => {
  it('picks the template by item type and renders the GitHub header verbatim', () => {
    expect(renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, pr51, item51)).toBe(
      'This session is for pull request #51 ("Extract billing client") in sympower/controller-app. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh pr view 51` to read it.'
    );
    expect(renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, issue87)).toBe(
      'This session is for issue #87 ("Issue #87") in sympower/msa-resource-bff. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh issue view 87` to read it.'
    );
  });
});
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run src/shared/workItemPrompt.test.ts`
Expected: FAIL — cannot resolve `./workItemPrompt`.

- [ ] **Step 15: Create `src/shared/workItemPrompt.ts`**

```ts
import type { InboxItem, WorkItemRef } from './workItems';
import { workItemUrl } from './workItems';

/**
 * Prompt rendering for work-item sessions.
 *
 * Shared because both sides render: main composes the seed prompt at launch,
 * and the settings panel previews the header above an editable body.
 */

/** "PR #51" / "Issue #87" — the title when the inbox holds no item. */
export function fallbackWorkItemTitle(ref: WorkItemRef): string {
  return ref.type === 'pr' ? `PR #${ref.number}` : `Issue #${ref.number}`;
}

/** Only these names are substituted; anything else in braces is left as typed. */
const PLACEHOLDER_PATTERN = /\{\{\s*(number|repo|title|url|type)\s*\}\}/g;

/**
 * Fill `{{number}} {{repo}} {{title}} {{url}} {{type}}` from the ref and, when
 * the inbox has one, the cached item. A template with no placeholders comes
 * back untouched, which is what lets a body be a bare slash command.
 */
export function substitutePlaceholders(template: string, ref: WorkItemRef, item?: InboxItem): string {
  const values: Record<string, string> = {
    number: String(ref.number),
    repo: ref.repo,
    title: item?.title ?? fallbackWorkItemTitle(ref),
    url: item?.url ?? workItemUrl(ref),
    type: ref.type === 'pr' ? 'pull request' : 'issue',
  };
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => values[key]);
}

/** The provider's fixed context header for this item, rendered. */
export function renderSeedHeader(
  templates: Record<'pr' | 'issue', string>,
  ref: WorkItemRef,
  item?: InboxItem
): string {
  return substitutePlaceholders(templates[ref.type], ref, item);
}
```

- [ ] **Step 16: Run every new test, the suite, and typecheck**

Run: `npx vitest run src/shared`
Expected: PASS — `ids`, `inboxSections`, `workItemActions`, `workItemPrompt`, `providers`, `workItems`, `workspace`, `terminalStatus` all green.

Run: `npm test`
Expected: 44 files, 505 tests pass (464 + 2 ids + 13 sections + 18 actions + 8 prompt).

Run: `npm run typecheck`
Expected: clean — everything in this task is additive, and `workspace.ts` still exports `generateId`.

- [ ] **Step 17: Commit**

```bash
git add src/shared/ids.ts src/shared/ids.test.ts src/shared/workspace.ts src/shared/inboxSections.ts src/shared/inboxSections.test.ts src/shared/workItemActions.ts src/shared/workItemActions.test.ts src/shared/workItemPrompt.ts src/shared/workItemPrompt.test.ts
git commit -m "feat: shared inbox sections, work-item actions and prompt rendering" -m "The pure vocabulary every later phase reads: sectionFor with the spec's precedence, the default actions and their per-section defaults paired by name, validateActionsWrite for the set-actions door, and placeholder substitution for the provider header. generateId moves to ids.ts (re-exported from workspace.ts) so workspace.ts can import the defaults for the v7 migration without the two modules importing each other.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Workspace state v7 — provider binding, actions, mutable link, migration

**Files:**
- Modify: `src/shared/workspace.ts` (imports; `Session` lines 43–44; `Workspace` lines 74–79; `CURRENT_WORKSPACE_STATE_VERSION`; `createWorkspaceRecord`; `NewSessionFields`; new `SessionUpdates`; migration doc + new rung)
- Modify: `src/shared/workspace.test.ts` (the "already-current" and "whole ladder" tests, a new v6 → v7 block, the `createWorkspaceRecord` test)
- Modify: `src/main/state/WorkspaceService.test.ts:202-233` (the import-migration test asserts the v7 fields)

**Interfaces:**
- Consumes: `GitProviderId` (Task 1), `InboxSection` (Task 2), `WorkItemAction`, `createDefaultActions`, `createDefaultSectionDefaults`, `defaultActionNameForType` (Task 2), `WorkItemRef` (Task 1's `workItems.ts`).
- Produces: `interface WorkspaceProvider { id: GitProviderId; accountLogin: string; org?: string }`; `Workspace.provider?: WorkspaceProvider`, `Workspace.actions: WorkItemAction[]`, `Workspace.sectionDefaults: Partial<Record<InboxSection, string>>` (and no `Workspace.github`); `Session.workItemAction?: string`; `NewSessionFields` accepting `workItemAction`; `type SessionUpdates = Partial<Pick<Session, 'name' | 'nameIsUserSet' | 'lastActiveAt' | 'hasStarted' | 'groupId' | 'workItem'>>`; `CURRENT_WORKSPACE_STATE_VERSION = 7`; `migrateWorkspaceState` with the v7 rung.

After this task `npm run typecheck` is red (every reader of `workspace.github`: `WorkspaceService.ts`, `SessionLauncher.ts`, `ipc-handlers.ts`, the `src/main/github/*` modules, the renderer) and stays red until Tasks 11, 12 and 14 restore main, preload and renderer in turn. `npm test` stays green.

- [ ] **Step 1: Write the failing migration tests**

In `src/shared/workspace.test.ts`, first update the existing "leaves an already-current state alone" test so its fixture is v7-shaped. Replace its `workspaces: [ { ... } ]` entry and the assertions with:

```ts
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          defaultHarnessId: 'work',
          scopes: [
            { id: 'scope-1', name: 'consola', path: '/code/consola', isGitRepo: true, createdAt: 1 },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [session],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, CURRENT_WORKSPACE_STATE_VERSION) as {
      workspaces: any[];
    };

    expect(migrated.workspaces[0].sessions[0]).toEqual(session);
    expect(migrated.workspaces[0].defaultHarnessId).toBe('work');
    expect(migrated.workspaces[0].scopes).toHaveLength(1);
    expect(migrated.workspaces[0].actions).toEqual([]);
    expect(migrated.workspaces[0]).not.toHaveProperty('provider');
```

Then rename the test `'carries a v2 workspace through the whole ladder to v6'` to `'carries a v2 workspace through the whole ladder'` and append two assertions at its end:

```ts
    // v7: a local-only workspace gains the two empty fields and nothing else.
    expect(workspace.actions).toEqual([]);
    expect(workspace.sectionDefaults).toEqual({});
```

Then add this block after the closing `});` of `describe('migrateWorkspaceState', ...)` and before `describe('createWorkspaceRecord', ...)`:

```ts
describe('migrateWorkspaceState v6 -> v7', () => {
  function v6Session(overrides: Record<string, unknown> = {}) {
    return {
      id: 's1',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'w1',
      instanceId: 'i1',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-1',
      kind: 'interactive',
      createdAt: 1,
      lastActiveAt: 2,
      ...overrides,
    };
  }

  function v6Workspace(overrides: Record<string, unknown> = {}) {
    return {
      id: 'w1',
      name: 'Sympower',
      defaultHarnessId: 'default',
      scopes: [
        { id: 'scope-1', name: 'controller-app', path: '/repos/controller-app', isGitRepo: true, createdAt: 1 },
      ],
      groups: [],
      sessions: [],
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  it('turns the github binding into a provider binding and seeds the default actions', () => {
    const state = {
      workspaces: [v6Workspace({ github: { accountLogin: 'SymJavi', org: 'sympower' } })],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.provider).toEqual({ id: 'github', accountLogin: 'SymJavi', org: 'sympower' });
    expect(workspace).not.toHaveProperty('github');
    expect(workspace.actions.map((action: { name: string }) => action.name)).toEqual([
      'Review',
      'Address review',
      'Fix CI',
      'Implement',
      'Triage',
    ]);
    const idOf = (name: string) =>
      workspace.actions.find((action: { name: string }) => action.name === name).id;
    expect(workspace.sectionDefaults).toEqual({
      'needs-your-review': idOf('Review'),
      'needs-team-review': idOf('Review'),
      'needs-action': idOf('Address review'),
      waiting: idOf('Fix CI'),
      issues: idOf('Implement'),
    });
  });

  it('omits org from the provider binding when the github binding had none', () => {
    const state = { workspaces: [v6Workspace({ github: { accountLogin: 'personal' } })] };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };

    expect(migrated.workspaces[0].provider).toEqual({ id: 'github', accountLogin: 'personal' });
  });

  it('leaves a local-only workspace byte-for-byte alone apart from the two empty fields', () => {
    const input = v6Workspace({ sessions: [v6Session()] });

    const migrated = migrateWorkspaceState({ workspaces: [input] }, 6) as { workspaces: any[] };

    // Key order matters here: JSON.stringify is how the file is written, and
    // "identical apart from the two new fields" is the spec's promise.
    expect(JSON.stringify(migrated.workspaces[0])).toBe(
      JSON.stringify({ ...input, actions: [], sectionDefaults: {} })
    );
    expect(migrated.workspaces[0]).not.toHaveProperty('provider');
  });

  it('backfills workItemAction by item type: Review for PRs, Implement for issues', () => {
    const pr = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
    const issue = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 };
    const state = {
      workspaces: [
        v6Workspace({
          github: { accountLogin: 'SymJavi' },
          sessions: [
            v6Session({ id: 's-pr', workItem: pr }),
            v6Session({ id: 's-issue', workItem: issue }),
            v6Session({ id: 's-kept', workItem: pr, workItemAction: 'Fix CI' }),
            v6Session({ id: 's-plain' }),
          ],
        }),
      ],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };
    const [prSession, issueSession, keptSession, plainSession] = migrated.workspaces[0].sessions;

    expect(prSession.workItemAction).toBe('Review');
    expect(issueSession.workItemAction).toBe('Implement');
    // A name already on the record is history, not something to rewrite.
    expect(keptSession.workItemAction).toBe('Fix CI');
    expect(plainSession).not.toHaveProperty('workItemAction');
  });

  it('does not reseed a workspace that somehow already carries actions', () => {
    const existing = [{ id: 'a1', name: 'Mine', appliesTo: ['pr'], prompt: 'Do the thing.' }];
    const state = {
      workspaces: [
        v6Workspace({
          github: { accountLogin: 'SymJavi' },
          actions: existing,
          sectionDefaults: { waiting: 'a1' },
        }),
      ],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };

    expect(migrated.workspaces[0].actions).toEqual(existing);
    expect(migrated.workspaces[0].sectionDefaults).toEqual({ waiting: 'a1' });
  });

  it('leaves an already-v7 bound workspace untouched at version 7', () => {
    const workspace = {
      ...v6Workspace(),
      provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
      actions: [{ id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }],
      sectionDefaults: { 'needs-your-review': 'a1' },
      sessions: [
        v6Session({
          workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
          workItemAction: 'Review',
        }),
      ],
    };

    const migrated = migrateWorkspaceState({ workspaces: [workspace] }, 7) as { workspaces: any[] };

    expect(migrated.workspaces[0]).toEqual(workspace);
  });
});
```

Finally, in `describe('createWorkspaceRecord', ...)` replace `expect(workspace.github).toBeUndefined();` with:

```ts
    expect(workspace.provider).toBeUndefined();
    expect(workspace.actions).toEqual([]);
    expect(workspace.sectionDefaults).toEqual({});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/workspace.test.ts`
Expected: FAIL — the v7 block fails on `provider`/`actions`/`workItemAction` (no rung exists), the already-current test passes its `actions` check only because the fixture carries it, and `createWorkspaceRecord` has no `actions`.

- [ ] **Step 3: Bring `src/shared/workspace.ts` to v7**

Replace the import block (the top of the file, as Task 2 left it) with:

```ts
import { BUILT_IN_HARNESS_ID } from './constants';
import { generateId } from './ids';
import type { InboxSection } from './inboxSections';
import type { GitProviderId } from './providers';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  defaultActionNameForType,
  type WorkItemAction,
} from './workItemActions';
import type { WorkItemRef } from './workItems';

export { generateId };
```

In `interface Session`, replace:

```ts
  // The remote item this session was launched from, when it was. Immutable.
  workItem?: WorkItemRef;
```

with:

```ts
  // The remote item this session is about. Mutable since v7: a hand-made
  // session can be linked to an item after the fact, or unlinked — the
  // relation says why the session exists, never where it runs.
  workItem?: WorkItemRef;
  // The action's NAME at launch — "Review", "Fix CI" — a label for the
  // sidebar and the strip. A name rather than an id so renaming or deleting
  // the action later never rewrites what a past session was. Absent for
  // sessions linked by hand.
  workItemAction?: string;
```

Insert before `export interface Workspace {`:

```ts
/** Which provider a workspace acts on, and as whom. */
export interface WorkspaceProvider {
  id: GitProviderId;
  accountLogin: string;            // Which keyring account of the provider CLI
  org?: string;                    // Scopes the Inbox query; absent = all repos
}
```

In `interface Workspace`, replace:

```ts
  // Absent = pure local workspace, exactly today's behavior. Present = every
  // session PTY in this workspace gets GH_TOKEN for this account.
  github?: {
    accountLogin: string;          // Which `gh` keyring account
    org?: string;                  // Scopes the Inbox query; absent = all repos
  };
```

with:

```ts
  // Absent = pure local workspace, exactly today's behavior. Present = every
  // session PTY in this workspace gets the provider's token for this account.
  provider?: WorkspaceProvider;
  // Ordered; [] for an unbound workspace. Seeded with the defaults when a
  // provider is bound, and edited as one validated write (set-actions).
  actions: WorkItemAction[];
  // Which action the Inbox pane highlights per section, by action id.
  sectionDefaults: Partial<Record<InboxSection, string>>;
```

Change the version constant:

```ts
/** Shape version of the persisted workspace list. */
export const CURRENT_WORKSPACE_STATE_VERSION = 7;
```

In `createWorkspaceRecord`, change the returned literal's `groups: [],` / `sessions: [],` lines to:

```ts
    groups: [],
    actions: [],
    sectionDefaults: {},
    sessions: [],
```

Replace `NewSessionFields`:

```ts
export type NewSessionFields = Pick<
  Session,
  'name' | 'workspaceId' | 'instanceId' | 'harnessId' | 'model' | 'scopeId'
> &
  Partial<Pick<Session, 'cwd' | 'groupId' | 'kind' | 'workItem' | 'workItemAction'>>;
```

Insert after `createSessionRecord`:

```ts
/**
 * What a session update may carry across IPC.
 *
 * Defined once, here, and imported by the filter, the service, the API
 * types, preload, the bridge and the store — six copies had drifted apart.
 * `workItem` is the mutable link, with presence semantics: an explicitly
 * undefined key means unlink. Everything that fixes a session's identity
 * (`scopeId`, `cwd`, `kind`, `harnessId`, `model`) is absent on purpose.
 */
export type SessionUpdates = Partial<
  Pick<Session, 'name' | 'nameIsUserSet' | 'lastActiveAt' | 'hasStarted' | 'groupId' | 'workItem'>
>;
```

In the `migrateWorkspaceState` doc comment add a line after the v6 one:

```ts
 * v5 -> v6 folds the workspace folder into a single scope and binds sessions to it;
 * v6 -> v7 turns the github binding into a provider binding, seeds actions, and
 *          labels every work-item session with the action it amounted to.
```

Append this rung after the `version < 6` block, before `return state;`:

```ts
  if (state.workspaces && version < 7) {
    // v6 -> v7: the GitHub-shaped binding becomes a provider binding, and a
    // bound workspace receives the default actions so the Inbox has verbs to
    // offer on first paint. A session launched from a work item gets the
    // action name today's hardcoded prompt amounted to — the role it was
    // launched under was never persisted, so the item type is the best this
    // rung can do. A local-only workspace gains only the two empty fields,
    // and gains them in place, so it round-trips byte-for-byte otherwise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.workspaces = state.workspaces.map((ws: any) => {
      const { github, ...rest } = ws;
      const provider: WorkspaceProvider | undefined =
        ws.provider ??
        (github
          ? {
              id: 'github',
              accountLogin: github.accountLogin,
              ...(github.org ? { org: github.org } : {}),
            }
          : undefined);
      const actions: WorkItemAction[] = ws.actions ?? (provider ? createDefaultActions() : []);
      const migrated = {
        ...rest,
        ...(provider ? { provider } : {}),
        actions,
        sectionDefaults:
          ws.sectionDefaults ?? (provider ? createDefaultSectionDefaults(actions) : {}),
      };
      // Assigned rather than spread in, so the key keeps its position.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrated.sessions = (ws.sessions ?? []).map((s: any) =>
        s.workItem && s.workItemAction === undefined
          ? { ...s, workItemAction: defaultActionNameForType(s.workItem.type) }
          : s
      );
      return migrated;
    });
  }
```

- [ ] **Step 4: Run the workspace test to verify it passes**

Run: `npx vitest run src/shared/workspace.test.ts`
Expected: PASS (24 tests: the previous 18 plus the six v7 cases).

- [ ] **Step 5: Extend the import-migration test in `src/main/state/WorkspaceService.test.ts`**

In the test `'runs the migration ladder on imported state'`, append after the existing three assertions:

```ts
    // v7 reached through the same ladder: empty verbs for a local-only import.
    expect(service.getAll()[0].actions).toEqual([]);
    expect(service.getAll()[0].sectionDefaults).toEqual({});
    expect(service.getAll()[0]).not.toHaveProperty('provider');
```

Run: `npx vitest run src/main/state/WorkspaceService.test.ts`
Expected: PASS — `WorkspaceService.migrate` delegates to `migrateWorkspaceState`, so the v7 rung already runs on import.

- [ ] **Step 6: Run the suite and note the red typecheck**

Run: `npm test`
Expected: 44 files, 511 tests pass.

Run: `npm run typecheck`
Expected: RED, only in files this plan has not reached yet — `src/main/state/WorkspaceService.ts` (`github` destructure), `src/main/SessionLauncher.ts`, `src/main/ipc-handlers.ts`, `src/main/github/*`, `src/renderer/components/{GitHub,Inbox,Sidebar,Layout,WorkspaceSettings}/*`. No error may point at `src/shared/`.

- [ ] **Step 7: Commit**

```bash
git add src/shared/workspace.ts src/shared/workspace.test.ts src/main/state/WorkspaceService.test.ts
git commit -m "feat: workspace state v7 — provider binding, actions, mutable work-item link" -m "Workspace.github becomes Workspace.provider (id + account + org), every workspace carries actions and sectionDefaults, and Session.workItem is now a mutable relation with a workItemAction name snapshot beside it. The v7 rung seeds the defaults for bound workspaces only and backfills the snapshot by item type; a local-only workspace round-trips byte-for-byte apart from the two empty fields. SessionUpdates now has one definition, here.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Shared API types and IPC channels

**Files:**
- Modify: `src/shared/types.ts:11` (imports), `:40-47` (`TerminalCreateOptions.workspaceId` doc), `:261-270` (`GitHubAPI`), `:317-328` (`GitHubInboxAPI`), `:349-366` (`WorkspaceAPI.updateSession` / `setGitHubBinding`), `:411-421` (`Window`)
- Modify: `src/shared/constants.ts:39`, `:66-68`, `:89-97`

**Interfaces:**
- Consumes: `GitProviderId`, `ProviderProbeResult` (Task 1), `InboxSnapshot`, `WorkItemRef` (Task 1), `InboxSection` (Task 2), `WorkItemAction` (Task 2), `SessionUpdates`, `WorkspaceProvider` (Task 3).
- Produces: `interface InboxAPI { getInbox; refreshInbox; onInboxChanged }`; `interface ProviderAPI { probe(id: GitProviderId); resolveRepos; launchWorkItem(workspaceId, workItem); cloneRepo }`; `WorkspaceAPI.updateSession(workspaceId, sessionId, updates: SessionUpdates)`, `WorkspaceAPI.setProviderBinding(workspaceId, binding: WorkspaceProvider | null)`, `WorkspaceAPI.setActions(workspaceId, actions, sectionDefaults)`; `Window.inboxAPI`, `Window.providerAPI`; the nine `IPC_CHANNELS` entries from Global Constraints. `WorkItemLaunchResult` and `CloneRepoResult` are unchanged in this phase (Phase C reshapes the launch result).

This task changes only type declarations and string constants, so it carries no vitest of its own; its proof is the typecheck that Tasks 11, 12 and 14 turn green against exactly these names.

- [ ] **Step 1: Update the imports and doc comments in `src/shared/types.ts`**

Replace line 11:

```ts
import type { GhProbeResult, InboxSnapshot, WorkItemRef } from './github';
```

with:

```ts
import type { SessionUpdates, WorkspaceProvider } from './workspace';
import type { InboxSection } from './inboxSections';
import type { GitProviderId, ProviderProbeResult } from './providers';
import type { WorkItemAction } from './workItemActions';
import type { InboxSnapshot, WorkItemRef } from './workItems';
```

In `TerminalCreateOptions`, replace the `workspaceId` doc comment:

```ts
    /**
     * Workspace this session belongs to. Main resolves it to the workspace's
     * provider binding (if any) and borrows the token itself — the renderer
     * names the workspace precisely so it never has to see a token.
     */
    workspaceId: string;
```

- [ ] **Step 2: Replace the GitHub API interfaces**

Delete the `GitHubAPI` interface (lines 261–270, doc comment included). Replace the `GitHubInboxAPI` interface (lines 317–328) with:

```ts
/**
 * The Inbox surface of preload. Read-only against the provider by
 * construction: there is no method here that writes to it.
 */
export interface InboxAPI {
    getInbox: (workspaceId: string) => Promise<InboxSnapshot | null>;
    refreshInbox: (workspaceId: string) => Promise<void>;
    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) => () => void;
}

/**
 * Provider operations exposed to the renderer: probe a CLI, map remote repos
 * to clones, launch a work item, clone a repo. Tokens are borrowed inside the
 * main process at call time and have no representation on this API at all.
 */
export interface ProviderAPI {
    probe: (id: GitProviderId) => Promise<ProviderProbeResult>;
    resolveRepos: (workspaceId: string, repos: string[]) => Promise<Record<string, string | null>>;
    launchWorkItem: (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult>;
    cloneRepo: (workspaceId: string, repo: string, destinationDir: string) => Promise<CloneRepoResult>;
}
```

- [ ] **Step 3: Update `WorkspaceAPI` and `Window`**

In `WorkspaceAPI`, replace the `updateSession` member with:

```ts
    updateSession: (workspaceId: string, sessionId: string, updates: SessionUpdates) => Promise<void>;
```

and replace `setGitHubBinding` with:

```ts
    setProviderBinding: (workspaceId: string, binding: WorkspaceProvider | null) => Promise<void>;
    /** Replaces actions and section defaults in one validated write; rejects with the validation message. */
    setActions: (
        workspaceId: string,
        actions: WorkItemAction[],
        sectionDefaults: Partial<Record<InboxSection, string>>
    ) => Promise<void>;
```

In `declare global { interface Window { ... } }`, replace `githubAPI: GitHubAPI & GitHubInboxAPI;` with:

```ts
        inboxAPI: InboxAPI;
        providerAPI: ProviderAPI;
```

- [ ] **Step 4: Rename the channels in `src/shared/constants.ts`**

Replace line 39 (`WORKSPACE_SET_GITHUB_BINDING`) with:

```ts
    WORKSPACE_SET_PROVIDER_BINDING: 'workspace:set-provider-binding',
    WORKSPACE_SET_ACTIONS: 'workspace:set-actions',    // actions + sectionDefaults, one validated write
```

Delete lines 66–68 (the `GH_PROBE` entry and its two comment lines). Replace lines 89–97 (both `GitHub inbox` blocks) with:

```ts
    // Provider operations (renderer -> main). Tokens are borrowed inside main
    // at call time and never cross this boundary.
    PROVIDER_PROBE: 'provider:probe',                   // Is the CLI installed, who is signed in
    PROVIDER_RESOLVE_REPOS: 'provider:resolve-repos',   // Which remote repos have a local clone in this workspace
    PROVIDER_LAUNCH_WORK_ITEM: 'provider:launch-work-item', // Resolve -> worktree -> session record; returns the session
    PROVIDER_CLONE_REPO: 'provider:clone-repo',         // Clone an un-cloned repo into a chosen directory

    // Inbox (renderer -> main; main owns the cache)
    INBOX_GET: 'inbox:get',                             // Cached snapshot, or null (a refresh is kicked off)
    INBOX_REFRESH: 'inbox:refresh',                     // Manual refresh; result arrives on the push channel

    // Inbox (main -> every renderer)
    INBOX_CHANGED: 'inbox:changed',                     // One workspace's InboxSnapshot
```

- [ ] **Step 5: Confirm the shared project compiles on its own**

Run: `npx tsc -p tsconfig.preload.json --noEmit 2>&1 | grep 'src/shared/' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no `src/shared/` lines — the only errors are in `src/preload/preload.ts`, which Task 12 rewrites.

Run: `npm test`
Expected: 44 files, 511 tests pass (nothing under test imports these declarations at run time).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "refactor: provider and inbox IPC contracts replace the github-shaped ones" -m "github:* becomes provider:* and inbox:*, workspace:set-github-binding becomes workspace:set-provider-binding with workspace:set-actions beside it, and window.githubAPI splits into inboxAPI and providerAPI so the seam is visible from the renderer. Type-only; main, preload and the renderer follow in later tasks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The driver interface and GitHub's inbox query

**Files:**
- Create: `src/main/providers/GitProviderDriver.ts`
- Move: `src/main/github/parseInbox.ts` → `src/main/providers/github/inboxQuery.ts` (rewritten: fragment gains `isDraft`, `author { login }`, `comments { totalCount }`; the parser merges roles instead of picking one)
- Move: `src/main/github/parseInbox.test.ts` → `src/main/providers/github/inboxQuery.test.ts` (rewritten)
- Modify: `tests/fixtures/stub-gh/graphql-inbox.json` (every node gains `author`, `comments`; PR nodes gain `isDraft`)
- Keep (for now): `src/main/github/parseInbox.ts` is *copied* rather than deleted — `GitHubService.ts` still imports it and its test still runs; Task 7 deletes both.

**Interfaces:**
- Consumes: `GitProviderId`, `ProviderBinding`, `ProviderProbeResult` (Task 1); `InboxItem`, `InboxRole`, `WorkItemRef`, `workItemKey` (Task 1).
- Produces:
  - `src/main/providers/GitProviderDriver.ts`: `interface GitProviderDriver { readonly id; readonly tokenEnvVar; probe(); token(accountLogin); fetchInbox(binding, env); checkout(worktreeDir, ref, env); cloneRepo(repo, destinationDir, env); matchesRemote(remoteUrl, repo); workItemUrl(ref); seedHeader(ref, item?) }` — exactly the spec's signatures.
  - `src/main/providers/github/inboxQuery.ts`: `INBOX_QUERY: string`; `searchStrings(accountLogin, org?): { assigned; authored; reviewRequested }`; `parseInboxPayload(payload: unknown): InboxItem[]`.

- [ ] **Step 1: Create the driver interface**

```ts
// src/main/providers/GitProviderDriver.ts
import type { GitProviderId, ProviderBinding, ProviderProbeResult } from '../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';

/**
 * What Consola needs from a git hosting provider in order to run its Inbox.
 *
 * The mirror of HarnessDriver one layer over: Consola coordinates the
 * provider's own CLI rather than speaking its API, so a driver describes how
 * to borrow a credential, fetch the inbox, check a work item out and clone a
 * repo — never how a PR looks. Every method corresponds to something that
 * genuinely differs between providers. Nothing outside src/main/providers/
 * may branch on `id`; the registry in ./index.ts is the only place that does.
 */
export interface GitProviderDriver {
    readonly id: GitProviderId;

    /**
     * Environment variable carrying the borrowed token into subprocesses and
     * PTYs ('GH_TOKEN' for GitHub). Named per driver so the layering code
     * never has to know which CLI reads what.
     */
    readonly tokenEnvVar: string;

    /** Binary present? Who is signed in? Feeds the binding panel. Never throws. */
    probe(): Promise<ProviderProbeResult>;

    /**
     * Borrow a token for one account. Cached briefly in memory, never
     * persisted, never put on IPC. Throws with the CLI's own reason on
     * failure — the caller decides how to degrade.
     */
    token(accountLogin: string): Promise<string>;

    /**
     * One request, provider-neutral items. Must throw on an unrecognised
     * reply: a plausible-looking empty list would read as "nothing to do".
     */
    fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]>;

    /**
     * Check a work item out inside an existing detached worktree. Every git
     * mechanic around it (add, prune, branch) is WorktreeService's; this is
     * only the provider-specific fetch.
     */
    checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<void>;

    /** Clone `repo` to `destinationDir` (the clone's own directory, not its parent). */
    cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void>;

    /** Whether a git remote URL names `repo` on this provider. */
    matchesRemote(remoteUrl: string, repo: string): boolean;

    workItemUrl(ref: WorkItemRef): string;

    /** The fixed context header prepended to every action body. */
    seedHeader(ref: WorkItemRef, item?: InboxItem): string;
}
```

- [ ] **Step 2: Give the fixture the fields the new fragment asks for**

Replace `tests/fixtures/stub-gh/graphql-inbox.json` with:

```json
{
  "data": {
    "assigned": {
      "nodes": [
        {
          "__typename": "Issue",
          "title": "Rate limit returns 500",
          "number": 87,
          "state": "OPEN",
          "url": "https://github.com/sympower/msa-resource-bff/issues/87",
          "updatedAt": "2026-08-20T07:12:00Z",
          "author": { "login": "mira" },
          "comments": { "totalCount": 4 },
          "repository": { "nameWithOwner": "sympower/msa-resource-bff" }
        },
        {
          "__typename": "PullRequest",
          "title": "Fix auth retry loop",
          "number": 42,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/42",
          "updatedAt": "2026-08-20T08:05:00Z",
          "isDraft": false,
          "author": { "login": "kenji" },
          "comments": { "totalCount": 2 },
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 84,
          "deletions": 12,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
        }
      ]
    },
    "authored": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "Ingestion retry policy",
          "number": 204,
          "state": "OPEN",
          "url": "https://github.com/sympower/dt-shared-ingestion/pull/204",
          "updatedAt": "2026-08-20T06:40:00Z",
          "isDraft": false,
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 6 },
          "repository": { "nameWithOwner": "sympower/dt-shared-ingestion" },
          "reviewDecision": "CHANGES_REQUESTED",
          "additions": 120,
          "deletions": 30,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
        }
      ]
    },
    "reviewRequested": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "Fix auth retry loop",
          "number": 42,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/42",
          "updatedAt": "2026-08-20T08:05:00Z",
          "isDraft": false,
          "author": { "login": "kenji" },
          "comments": { "totalCount": 2 },
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 84,
          "deletions": 12,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
        },
        {
          "__typename": "PullRequest",
          "title": "Extract billing client",
          "number": 51,
          "state": "OPEN",
          "url": "https://github.com/sympower/controller-app/pull/51",
          "updatedAt": "2026-08-20T07:55:00Z",
          "isDraft": false,
          "author": { "login": "anna" },
          "comments": { "totalCount": 3 },
          "repository": { "nameWithOwner": "sympower/controller-app" },
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 210,
          "deletions": 88,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
        }
      ]
    }
  }
}
```

Run: `npx vitest run src/main/github/parseInbox.test.ts src/main/github/GitHubService.test.ts src/main/github/stubGh.test.ts`
Expected: PASS — the old parser ignores fields it does not read, so the extra keys change nothing yet.

- [ ] **Step 3: Move the parser test and rewrite it for role merging**

```bash
git mv src/main/github/parseInbox.test.ts src/main/providers/github/inboxQuery.test.ts
```

Replace the whole file with:

```ts
// src/main/providers/github/inboxQuery.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './inboxQuery';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

/** A minimal PullRequest node under one alias; overrides shape the case. */
function payloadWith(alias: string, node: Record<string, unknown>) {
  return {
    data: {
      assigned: { nodes: [] },
      authored: { nodes: [] },
      reviewRequested: { nodes: [] },
      [alias]: {
        nodes: [
          {
            __typename: 'PullRequest',
            title: 'A',
            number: 1,
            state: 'OPEN',
            url: 'https://github.com/o/r/pull/1',
            updatedAt: '2026-08-20T00:00:00Z',
            repository: { nameWithOwner: 'o/r' },
            ...node,
          },
        ],
      },
    },
  };
}

describe('searchStrings', () => {
  it('scopes every search to the org when one is set', () => {
    const searches = searchStrings('SymJavi', 'sympower');
    expect(searches.assigned).toBe('assignee:SymJavi is:open archived:false org:sympower');
    expect(searches.authored).toBe('author:SymJavi is:open archived:false org:sympower');
    expect(searches.reviewRequested).toBe(
      'review-requested:SymJavi is:open is:pr archived:false org:sympower'
    );
  });

  it('omits the org qualifier when the workspace has none — all repos for the account', () => {
    expect(searchStrings('SymJavi').assigned).toBe('assignee:SymJavi is:open archived:false');
  });
});

describe('INBOX_QUERY', () => {
  it('declares the three aliased searches the parser reads', () => {
    for (const alias of ['assigned:', 'authored:', 'reviewRequested:']) {
      expect(INBOX_QUERY).toContain(alias);
    }
  });

  it('asks for the fields the provider-neutral item is built from', () => {
    for (const field of ['isDraft', 'author { login }', 'comments { totalCount }', 'reviewDecision']) {
      expect(INBOX_QUERY).toContain(field);
    }
  });
});

describe('parseInboxPayload', () => {
  const items = parseInboxPayload(canned);

  it('parses the canned payload into deduplicated items', () => {
    // 5 nodes in the fixture, but PR #42 appears under two aliases.
    expect(items).toHaveLength(4);
  });

  it('merges the roles of an item that appears under several aliases, request first', () => {
    const pr42 = items.find((item) => item.workItem.number === 42);
    expect(pr42?.roles).toEqual(['review-requested-direct', 'assignee']);
  });

  it('maps PullRequest nodes to pr items with author, comments, CI and a normalised review verdict', () => {
    const pr51 = items.find((item) => item.workItem.number === 51);
    expect(pr51?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(pr51?.roles).toEqual(['review-requested-direct']);
    expect(pr51?.author).toBe('anna');
    expect(pr51?.isDraft).toBe(false);
    expect(pr51?.commentCount).toBe(3);
    expect(pr51?.ciStatus).toBe('failing');
    expect(pr51?.reviewDecision).toBe('review-required');
    expect(pr51?.additions).toBe(210);
    expect(pr51?.deletions).toBe(88);
    expect(pr51?.state).toBe('open');
    expect(pr51?.checks).toBeUndefined();
  });

  it('maps Issue nodes to issue items with no CI and no review verdict', () => {
    const issue87 = items.find((item) => item.workItem.number === 87);
    expect(issue87?.workItem.type).toBe('issue');
    expect(issue87?.roles).toEqual(['assignee']);
    expect(issue87?.author).toBe('mira');
    expect(issue87?.commentCount).toBe(4);
    expect(issue87?.isDraft).toBe(false);
    expect(issue87?.ciStatus).toBeUndefined();
    expect(issue87?.reviewDecision).toBe('none');
  });

  it('labels the authored alias as author', () => {
    const pr204 = items.find((item) => item.workItem.number === 204);
    expect(pr204?.roles).toEqual(['author']);
    expect(pr204?.reviewDecision).toBe('changes-requested');
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('maps SUCCESS to passing and PENDING to pending', () => {
    const passing = payloadWith('reviewRequested', {
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    });
    const pending = payloadWith('reviewRequested', {
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
    });
    expect(parseInboxPayload(passing)[0].ciStatus).toBe('passing');
    expect(parseInboxPayload(pending)[0].ciStatus).toBe('pending');
  });

  it('normalises APPROVED and treats a missing verdict as none', () => {
    expect(parseInboxPayload(payloadWith('authored', { reviewDecision: 'APPROVED' }))[0].reviewDecision).toBe('approved');
    expect(parseInboxPayload(payloadWith('authored', { reviewDecision: null }))[0].reviewDecision).toBe('none');
  });

  it('carries isDraft through and defaults author and comments when GitHub omits them', () => {
    const [draft] = parseInboxPayload(payloadWith('authored', { isDraft: true }));
    expect(draft.isDraft).toBe(true);
    expect(draft.author).toBe('');
    expect(draft.commentCount).toBe(0);
  });

  it('skips malformed nodes rather than throwing', () => {
    const payload = { data: { assigned: { nodes: [{ __typename: 'Issue', title: 'no repo' }] } } };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  it('returns [] for a payload with no data at all', () => {
    expect(parseInboxPayload({})).toEqual([]);
    expect(parseInboxPayload(null)).toEqual([]);
  });

  it('throws when the payload is not an object', () => {
    expect(() => parseInboxPayload('not an object')).toThrow('Inbox payload must be a JSON object');
    expect(() => parseInboxPayload(42)).toThrow();
    expect(() => parseInboxPayload(true)).toThrow();
    expect(() => parseInboxPayload([])).toThrow();
  });

  it('throws when payload.data is null', () => {
    expect(() => parseInboxPayload({ data: null })).toThrow('GitHub API returned no data');
  });

  it('throws when payload.errors exists with no data, carrying the error message', () => {
    expect(() => parseInboxPayload({ errors: [{ message: 'API rate limit exceeded' }] })).toThrow(
      'API rate limit exceeded'
    );
  });

  it('does not throw when errors exist but data is present and valid', () => {
    const payload = {
      data: { assigned: { nodes: [] }, authored: { nodes: [] }, reviewRequested: { nodes: [] } },
      errors: [{ message: 'Some warning' }],
    };
    expect(parseInboxPayload(payload)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/github/inboxQuery.test.ts`
Expected: FAIL — cannot resolve `./inboxQuery`.

- [ ] **Step 5: Create `src/main/providers/github/inboxQuery.ts`**

```bash
cp src/main/github/parseInbox.ts src/main/providers/github/inboxQuery.ts
```

Then replace the whole new file with:

```ts
import type { InboxItem, InboxRole } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Three aliased searches — assigned, authored, review-requested — in a single
 * request: GitHub's search syntax cannot OR those qualifiers in one string,
 * but one request keeps the spec's "one GraphQL request per workspace"
 * budget. `type: ISSUE` searches return both issues and PRs; `__typename`
 * tells them apart. Phase D grows this to the five-alias query.
 */
export const INBOX_QUERY = `
query($assigned: String!, $authored: String!, $reviewRequested: String!) {
  assigned: search(query: $assigned, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  authored: search(query: $authored, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  reviewRequested: search(query: $reviewRequested, type: ISSUE, first: 50) { nodes { ...inboxFields } }
}
fragment inboxFields on SearchResultItem {
  __typename
  ... on Issue {
    title number state url updatedAt
    author { login }
    comments { totalCount }
    repository { nameWithOwner }
  }
  ... on PullRequest {
    title number state url updatedAt isDraft
    author { login }
    comments { totalCount }
    repository { nameWithOwner }
    reviewDecision additions deletions
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }
}`;

/** The search strings for one workspace's account, org-scoped when org is set. */
export function searchStrings(
  accountLogin: string,
  org?: string
): { assigned: string; authored: string; reviewRequested: string } {
  const scope = org ? ` org:${org}` : '';
  return {
    assigned: `assignee:${accountLogin} is:open archived:false${scope}`,
    authored: `author:${accountLogin} is:open archived:false${scope}`,
    reviewRequested: `review-requested:${accountLogin} is:open is:pr archived:false${scope}`,
  };
}

interface SearchNode {
  __typename?: string;
  title?: string;
  number?: number;
  state?: string;
  url?: string;
  updatedAt?: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  comments?: { totalCount?: number } | null;
  repository?: { nameWithOwner?: string };
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> };
}

const CI_STATES: Record<string, InboxItem['ciStatus']> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

/** GitHub's enum, folded to the provider-neutral verdict; anything else is 'none'. */
const REVIEW_DECISIONS: Record<string, InboxItem['reviewDecision']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

function toItem(node: SearchNode, role: InboxRole): InboxItem | null {
  const repo = node.repository?.nameWithOwner;
  if (!repo || typeof node.number !== 'number' || !node.title || !node.url) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    workItem: {
      provider: 'github',
      repo,
      type: node.__typename === 'PullRequest' ? 'pr' : 'issue',
      number: node.number,
    },
    title: node.title,
    author: node.author?.login ?? '',
    roles: [role],
    isDraft: node.isDraft === true,
    state: (node.state ?? 'OPEN').toLowerCase(),
    reviewDecision: REVIEW_DECISIONS[node.reviewDecision ?? ''] ?? 'none',
    ciStatus: rollup ? CI_STATES[rollup] : undefined,
    commentCount: node.comments?.totalCount ?? 0,
    additions: node.additions,
    deletions: node.deletions,
    updatedAt: node.updatedAt ?? '',
    url: node.url,
  };
}

/**
 * Flatten a gh graphql payload into deduplicated, newest-first inbox items.
 *
 * An item can match several searches; it comes out once, carrying every
 * role, in the order below — the reason you were asked (a requested review)
 * ahead of the reason you are merely attached (assignee, author). The
 * sections decide what the roles mean. Malformed nodes are skipped, never
 * thrown on — a half-broken payload still yields the readable remainder.
 *
 * Throws when the top-level payload is malformed (not an object, data is null,
 * or errors exist without usable data), so InboxService can label the error
 * in the UI rather than silently treating it as empty.
 */
export function parseInboxPayload(payload: unknown): InboxItem[] {
  if (payload === null) {
    return [];
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Inbox payload must be a JSON object');
  }

  const payloadObj = payload as Record<string, unknown>;

  if ('data' in payloadObj && payloadObj.data === null) {
    throw new Error('GitHub API returned no data');
  }

  if (Array.isArray(payloadObj.errors) && payloadObj.errors.length > 0) {
    const hasData = 'data' in payloadObj && payloadObj.data !== null;
    if (!hasData) {
      const firstError =
        (payloadObj.errors[0] as { message?: string })?.message || 'Unknown GitHub API error';
      throw new Error(firstError);
    }
  }

  const data =
    (payloadObj as { data?: Record<string, { nodes?: SearchNode[] } | undefined> }).data ?? {};
  // B maps every review request to the direct role; D splits direct from team.
  const aliases: Array<[InboxRole, string]> = [
    ['review-requested-direct', 'reviewRequested'],
    ['assignee', 'assigned'],
    ['author', 'authored'],
  ];
  const byKey = new Map<string, InboxItem>();
  for (const [role, alias] of aliases) {
    for (const node of data[alias]?.nodes ?? []) {
      const item = toItem(node, role);
      if (!item) continue;
      const key = workItemKey(item.workItem);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, item);
      } else if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
```

- [ ] **Step 6: Run the parser test, then the suite**

Run: `npx vitest run src/main/providers/github/inboxQuery.test.ts`
Expected: PASS (19 tests).

Run: `npm test`
Expected: 44 files, 512 tests pass (the moved file's 18 cases are now 19; `src/main/github/parseInbox.ts` still backs `GitHubService.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/main/providers/GitProviderDriver.ts src/main/providers/github/inboxQuery.ts src/main/providers/github/inboxQuery.test.ts tests/fixtures/stub-gh/graphql-inbox.json
git commit -m "feat: GitProviderDriver interface and GitHub's inbox query behind it" -m "The seam's contract, mirroring HarnessDriver: borrow a token, fetch the inbox, check a work item out, clone, match a remote, render the header. The parser now emits the provider-neutral InboxItem — roles merged across aliases rather than first-match-wins, author, isDraft, comment count and a normalised review verdict — with three aliases kept until Phase D's five. parseInbox.ts stays until GitHubService, its last importer, goes in the next task.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `GitHubDriver` absorbs `GhBroker`; the provider registry

**Files:**
- Create: `src/main/providers/github/GitHubDriver.ts` (absorbs `GhBroker.ts`: `probe`, `token`, `stripTokenLines`, binary resolution with the live `CONSOLA_GH_PATH` lookup; adds `fetchInbox`, `checkout`, `cloneRepo`, `matchesRemote`, `workItemUrl`, `seedHeader`)
- Create: `src/main/providers/github/GitHubDriver.test.ts` (the `probe`/`token`/scrub/`CONSOLA_GH_PATH` cases moved verbatim from `GhBroker.test.ts`, plus the new verbs against the fixture `gh`)
- Delete: `src/main/github/GhBroker.test.ts` (its cases now live in `GitHubDriver.test.ts`; `GhBroker.ts` itself stays until Task 11 removes its last importer, `ipc-handlers.ts`)
- Modify: `tests/fixtures/stub-gh/gh` (a `STUB_GH_LOG` knob so argv and the token a call saw can be asserted)
- Move: `src/main/github/stubGh.test.ts` → `src/main/providers/github/stubGh.test.ts` (fixture path adjusted; one case added for the knob)
- Create: `src/main/providers/index.ts`, `src/main/providers/index.test.ts`

**Interfaces:**
- Consumes: `GitProviderDriver` (Task 5), `INBOX_QUERY`/`searchStrings`/`parseInboxPayload` (Task 5), `PROVIDER_META`, `ProviderAccount`, `ProviderBinding`, `ProviderProbeResult` (Task 1), `workItemUrl` (Task 1), `renderSeedHeader` (Task 2), `getLoginEnv` from `src/main/LoginEnvironment.ts`.
- Produces:
  - `class GitHubDriver implements GitProviderDriver` with `constructor(getEnv?: () => NodeJS.ProcessEnv, tokenTtlMs?: number)`, `readonly id = 'github'`, `readonly tokenEnvVar = 'GH_TOKEN'`.
  - `src/main/providers/index.ts`: `DEFAULT_PROVIDER_ID: GitProviderId`; `getProviderDriver(id: GitProviderId): GitProviderDriver` (throws `Unknown git provider "<id>".`); `layerProviderToken(env, tokenEnvVar: string | null, token: string | null): NodeJS.ProcessEnv`; `composeProviderEnv(driver, accountLogin): Promise<NodeJS.ProcessEnv>`; re-exports `type GitProviderDriver`.
  - Fixture knob: `STUB_GH_LOG=<path>` appends `<argv joined by spaces, newlines flattened> GH_TOKEN=<value>` per invocation.

- [ ] **Step 1: Write the failing driver test**

```ts
// src/main/providers/github/GitHubDriver.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { GitHubDriver } from './GitHubDriver';

/** The repo-wide canned gh, for the verbs that run real git underneath. */
const FIXTURE_GH = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');

/**
 * A stub `gh` on PATH returning canned output, so probe() and token() are
 * tested end-to-end — real process spawn, real stdout/stderr/exit codes —
 * without network or a keyring. `GH_STUB_LOG` records every invocation,
 * which is how the cache tests count subprocess calls. Its modes cover gh
 * wordings the fixture gh has no reason to reproduce.
 */
const STUB_SCRIPT = `#!/bin/sh
echo "$@" >> "$GH_STUB_LOG"
case "$1" in
  --version)
    echo "gh version 2.63.1 (2026-01-15)"
    ;;
  auth)
    case "$2" in
      status)
        if [ "$GH_STUB_MODE" = "logged-out" ]; then
          echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
          exit 1
        fi
        if [ "$GH_STUB_MODE" = "unparseable" ]; then
          # Simulates a gh wording parseAccounts doesn't recognize ("as"
          # instead of "account") while still reporting a masked token line,
          # exiting 0 the way a real success report would.
          cat <<'STATUS'
github.com
  ✓ Logged in to github.com as SymJavi (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
STATUS
          exit 0
        fi
        cat <<'STATUS'
github.com
  ✓ Logged in to github.com account SymJavi (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account javier-tarazaga (keyring)
  - Active account: false
  - Git operations protocol: https
STATUS
        ;;
      token)
        if [ "$GH_STUB_MODE" = "leaky-token-error" ]; then
          # A failure whose stderr carries a masked token line alongside a
          # plain-text reason — proves the scrub drops the token line and
          # keeps the rest, rather than either leaking it or losing the
          # whole message.
          echo "authentication error" >&2
          echo "Token: gho_leaked1234567890" >&2
          exit 1
        fi
        if [ "$4" = "SymJavi" ]; then
          echo "gho_stub_token_symjavi"
        else
          echo "no oauth token found for account $4" >&2
          exit 1
        fi
        ;;
    esac
    ;;
esac
`;

let dir: string;
let logPath: string;

function stubEnv(extra: Record<string, string> = {}): () => NodeJS.ProcessEnv {
  // The stub dir comes first so the stub shadows any real gh; /bin and
  // /usr/bin let the stub script itself find `cat` and `sh` builtins' helpers.
  return () => ({ PATH: `${dir}:/bin:/usr/bin`, GH_STUB_LOG: logPath, ...extra });
}

/** One line per subprocess call, from whichever stub wrote logPath. */
function invocations(): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

function writeStub(targetDir: string): string {
  const stubPath = path.join(targetDir, 'gh');
  fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
  return stubPath;
}

beforeEach(() => {
  // CONSOLA_GH_PATH is a real process.env override (not part of the injected
  // getEnv), so every test starts without it — otherwise a value left over
  // from one test, or from the host shell, would silently redirect another.
  delete process.env.CONSOLA_GH_PATH;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-'));
  logPath = path.join(dir, 'invocations.log');
  writeStub(dir);
});

afterEach(() => {
  delete process.env.CONSOLA_GH_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GitHubDriver.probe', () => {
  it('reports the binary, version and keyring accounts', async () => {
    const driver = new GitHubDriver(stubEnv());

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    expect(result.version).toBe('2.63.1');
    expect(result.accounts).toEqual([
      { login: 'SymJavi', active: true },
      { login: 'javier-tarazaga', active: false },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('degrades to unavailable when gh is not on PATH', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const driver = new GitHubDriver(() => ({ PATH: empty }));

    const result = await driver.probe();

    expect(result.available).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not installed|not on PATH/i);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('is available with zero accounts when nobody is signed in', async () => {
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'logged-out' }));

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not logged in/i);
  });

  it('never carries a token in its result', async () => {
    // This result crosses IPC to the settings UI: the masked token line in
    // `gh auth status` output must not survive parsing in any field.
    const driver = new GitHubDriver(stubEnv());

    const flat = JSON.stringify(await driver.probe());

    expect(flat).not.toContain('gho_');
  });

  it('never carries a token in its result when the account line is unparseable', async () => {
    // A gh wording parseAccounts doesn't recognize means zero accounts are
    // parsed, which falls back to the raw status text for `error` — this is
    // the one path where a masked token line could ride along unfiltered.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'unparseable' }));

    const result = await driver.probe();

    expect(result.accounts).toEqual([]);
    expect(result.error).toBeDefined();
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('gho_');
    expect(flat).not.toMatch(/token/i);
  });
});

describe('GitHubDriver.token', () => {
  it('returns the token gh prints for the account', async () => {
    const driver = new GitHubDriver(stubEnv());

    await expect(driver.token('SymJavi')).resolves.toBe('gho_stub_token_symjavi');
  });

  it("throws with gh's stderr for an unknown account", async () => {
    const driver = new GitHubDriver(stubEnv());

    await expect(driver.token('nobody')).rejects.toThrow(/no oauth token found/i);
  });

  it('caches per account within the TTL', async () => {
    const driver = new GitHubDriver(stubEnv());

    await driver.token('SymJavi');
    await driver.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const driver = new GitHubDriver(stubEnv(), 0);

    await driver.token('SymJavi');
    await driver.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('scrubs a leaked token out of a failing token() error, matching how probe() scrubs', async () => {
    // token()'s error rides into InboxService's InboxSnapshot.error, which is
    // broadcast to every renderer — "tokens never cross IPC" is absolute, so
    // this path must strip the same way probe() already does.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'leaky-token-error' }));

    await expect(driver.token('SymJavi')).rejects.toThrow('authentication error');
    await expect(driver.token('SymJavi')).rejects.not.toThrow(/gho_|token/i);
  });
});

describe('GitHubDriver CONSOLA_GH_PATH override', () => {
  // This is the seam the unit tests and the Playwright rig depend on to
  // point at a stub `gh` without touching the real binary or the real PATH.

  it('resolves through CONSOLA_GH_PATH even when PATH has nothing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const driver = new GitHubDriver(() => ({ PATH: empty, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('takes priority over a gh that PATH would also have resolved', async () => {
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-onpath-'));
    writeStub(pathDir);
    const driver = new GitHubDriver(() => ({ PATH: pathDir, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await driver.probe();

    // Both stubs would answer identically; only the resolved path proves
    // which one actually ran.
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(pathDir, { recursive: true, force: true });
  });

  it('falls back to login-shell PATH resolution when unset', async () => {
    delete process.env.CONSOLA_GH_PATH;
    const driver = new GitHubDriver(stubEnv());

    const result = await driver.probe();

    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
  });
});

// --- The fixture gh: real argv, real env, real git for the seam's other verbs. ---

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 };
const binding = { accountLogin: 'SymJavi', org: 'sympower' };

/** What a caller composes: the process env plus the borrowed token, plus the fixture's log knob. */
function fixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, STUB_GH_LOG: logPath, GH_TOKEN: 'gho_test', ...extra };
}

function initCloneWithCommit(target: string): void {
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', target]);
  execFileSync('git', ['-C', target, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', target, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture');
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, 'commit', '-q', '-m', 'init']);
}

function currentBranch(target: string): string {
  return execFileSync('git', ['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

describe('GitHubDriver.fetchInbox', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs one gh api graphql request for the three searches and returns merged items', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    const items = await driver.fetchInbox(binding, fixtureEnv());

    expect(items).toHaveLength(4);
    expect(items.find((item) => item.workItem.number === 42)?.roles).toEqual([
      'review-requested-direct',
      'assignee',
    ]);
    const [call] = invocations();
    expect(call).toContain('api graphql -f query=');
    expect(call).toContain('-f assigned=assignee:SymJavi is:open archived:false org:sympower');
    expect(call).toContain(
      '-f reviewRequested=review-requested:SymJavi is:open is:pr archived:false org:sympower'
    );
    expect(call).toMatch(/GH_TOKEN=gho_test$/);
  });

  it('rejects with gh stderr when the request fails', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.fetchInbox(binding, fixtureEnv({ STUB_GH_FAIL: '1' }))).rejects.toThrow(
      /canned failure/
    );
  });

  it('throws on a reply it does not recognise rather than returning an empty inbox', async () => {
    // A gh answering with a JSON string, not an object: the driver must
    // refuse, or a broken gh would read as "nothing to do".
    const garbage = path.join(dir, 'garbage-gh');
    fs.writeFileSync(garbage, '#!/bin/sh\necho \'"not an inbox"\'\n', { mode: 0o755 });
    process.env.CONSOLA_GH_PATH = garbage;
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.fetchInbox(binding, fixtureEnv())).rejects.toThrow(
      'Inbox payload must be a JSON object'
    );
  });
});

describe('GitHubDriver.checkout', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs gh pr checkout inside the worktree with the token in its env', async () => {
    const clone = path.join(dir, 'controller-app');
    initCloneWithCommit(clone);
    const worktree = path.join(dir, 'controller-app-pr-51');
    execFileSync('git', ['-C', clone, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' });
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.checkout(worktree, pr51, fixtureEnv());

    expect(currentBranch(worktree)).toBe('stub-pr-51'); // the stub's checkout branch
    expect(invocations()).toEqual(['pr checkout 51 GH_TOKEN=gho_test']);
  }, 30_000);

  it('does nothing for an issue — there is no remote branch to fetch', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.checkout(dir, issue87, fixtureEnv());

    expect(invocations()).toEqual([]);
  });

  it('rejects with gh stderr when the checkout fails', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.checkout(dir, pr51, fixtureEnv({ STUB_GH_FAIL: '1' }))).rejects.toThrow(
      /gh: canned failure \(STUB_GH_FAIL=1\)/
    );
  });
});

describe('GitHubDriver.cloneRepo', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs gh repo clone <repo> <dir> with the token in its env', async () => {
    const source = path.join(dir, 'origin', 'msa-resource-bff');
    initCloneWithCommit(source);
    const target = path.join(dir, 'clones', 'msa-resource-bff');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.cloneRepo('sympower/msa-resource-bff', target, fixtureEnv({ STUB_GH_CLONE_FROM: source }));

    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(invocations()).toEqual([`repo clone sympower/msa-resource-bff ${target} GH_TOKEN=gho_test`]);
  }, 30_000);

  it('rejects with gh stderr when the clone fails, creating nothing', async () => {
    const target = path.join(dir, 'msa-resource-bff');
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(
      driver.cloneRepo('sympower/msa-resource-bff', target, fixtureEnv({ STUB_GH_FAIL: '1' }))
    ).rejects.toThrow(/canned failure/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('GitHubDriver.matchesRemote', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));

  it('matches scp-style, https and ssh remotes, ignoring .git and case', () => {
    expect(driver.matchesRemote('git@github.com:Sympower/Controller-App.git', 'sympower/controller-app')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sympower/flex-portal.git', 'sympower/flex-portal')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sympower/flex-portal', 'Sympower/Flex-Portal')).toBe(true);
    expect(driver.matchesRemote('ssh://git@github.com/sympower/flextools.git', 'sympower/flextools')).toBe(true);
  });

  it('does not match a different repo', () => {
    expect(driver.matchesRemote('git@github.com:sympower/controller-app.git', 'sympower/flex-portal')).toBe(false);
  });

  it('does not match the same owner/name on another host — that is a different repository', () => {
    expect(driver.matchesRemote('git@gitlab.com:sympower/controller-app.git', 'sympower/controller-app')).toBe(false);
    expect(driver.matchesRemote('https://gitlab.com/sympower/controller-app', 'sympower/controller-app')).toBe(false);
  });

  it('does not match remotes it cannot read', () => {
    expect(driver.matchesRemote('/some/local/path', 'sympower/controller-app')).toBe(false);
    expect(driver.matchesRemote('', 'sympower/controller-app')).toBe(false);
  });
});

describe('GitHubDriver identity, URLs and header', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));
  const item51: InboxItem = {
    workItem: pr51,
    title: 'Extract billing client',
    author: 'anna',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    commentCount: 3,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
  };

  it('hands its token to subprocesses as GH_TOKEN — the variable gh reads', () => {
    expect(driver.id).toBe('github');
    expect(driver.tokenEnvVar).toBe('GH_TOKEN');
  });

  it('builds github.com URLs', () => {
    expect(driver.workItemUrl(pr51)).toBe('https://github.com/sympower/controller-app/pull/51');
    expect(driver.workItemUrl(issue87)).toBe('https://github.com/sympower/msa-resource-bff/issues/87');
  });

  it('renders the GitHub seed header, titled from the inbox item when there is one', () => {
    expect(driver.seedHeader(pr51, item51)).toBe(
      'This session is for pull request #51 ("Extract billing client") in sympower/controller-app. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh pr view 51` to read it.'
    );
    expect(driver.seedHeader(issue87)).toContain('issue #87 ("Issue #87") in sympower/msa-resource-bff');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/github/GitHubDriver.test.ts`
Expected: FAIL — cannot resolve `./GitHubDriver`.

- [ ] **Step 3: Create `src/main/providers/github/GitHubDriver.ts`**

```ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PROVIDER_META } from '../../../shared/providers';
import type {
    GitProviderId,
    ProviderAccount,
    ProviderBinding,
    ProviderProbeResult,
} from '../../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { workItemUrl } from '../../../shared/workItems';
import { renderSeedHeader } from '../../../shared/workItemPrompt';
import { getLoginEnv } from '../../LoginEnvironment';
import type { GitProviderDriver } from '../GitProviderDriver';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './inboxQuery';

const execFileAsync = promisify(execFile);

/**
 * GitHub, driven through the `gh` CLI.
 *
 * Consola stores zero GitHub credentials: `gh` owns the keyring, and this
 * driver borrows a per-account token at the moment it is needed. Tokens live
 * in memory for minutes — only so an account change is picked up promptly;
 * the tokens themselves are long-lived — and are never persisted and never
 * put on an IPC channel. There is deliberately no `gh auth switch` anywhere:
 * two workspaces on two accounts must be able to run at the same time.
 *
 * Everything gh-shaped lives here: the GraphQL fetch, `gh pr checkout`,
 * `gh repo clone`, remote-URL matching, the seed header. The services above
 * only ever see the GitProviderDriver interface.
 */

const BINARY_NAME = 'gh';
const RUN_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const WEB_HOST = 'github.com';

interface RunResult {
    stdout: string;
    stderr: string;
    failed: boolean;
    errorMessage?: string;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Trim `gh version 2.63.1 (2026-01-15)` down to the version itself. */
function parseVersion(stdout: string): string | undefined {
    const match = stdout.match(/gh version (\S+)/);
    return match?.[1];
}

/**
 * The accounts `gh auth status` lists, with their active flags.
 *
 * Parsed line-by-line: an account line opens an entry and the following
 * `Active account:` line closes it. The masked token lines are deliberately
 * never captured — this result crosses IPC.
 */
function parseAccounts(text: string): ProviderAccount[] {
    const accounts: ProviderAccount[] = [];
    for (const line of text.split('\n')) {
        const login = line.match(/Logged in to \S+ account (\S+)/);
        if (login) {
            accounts.push({ login: login[1], active: false });
            continue;
        }
        const active = line.match(/Active account:\s*(true|false)/);
        if (active && accounts.length > 0) {
            accounts[accounts.length - 1].active = active[1] === 'true';
        }
    }
    return accounts;
}

/**
 * Drop any line that could carry a credential, for text that ends up in
 * `ProviderProbeResult.error` or an InboxSnapshot's error — both cross IPC.
 *
 * `parseAccounts` only recognizes today's `gh auth status` wording; a future
 * or unusual wording could slip past it while the masked `Token:` line is
 * still present, so the fallback text is scrubbed independently of parsing
 * rather than trusted just because parsing found nothing. Matches on the
 * word "token" (catches `Token:` and `Token scopes:`) and on gh's own token
 * prefixes, so a stray raw or masked token survives neither.
 */
function stripTokenLines(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/token/i.test(line) && !/\bgh[oprsu]_|\bgithub_pat_/i.test(line))
        .join('\n')
        .trim();
}

/**
 * `owner/repo` (lowercased) from a git remote URL that names github.com, or
 * null for anything else.
 *
 * Lowercased because GitHub treats repo names case-insensitively while
 * remembering the display casing — a clone made from a differently-cased URL
 * must still resolve. The host is checked because the same owner/name on
 * another host is a different repository entirely, and matching it would
 * point an agent's `gh` calls at the wrong one.
 */
function parseGitHubRemote(url: string): string | null {
    const trimmed = url.trim().replace(/\.git$/, '');
    if (!trimmed) return null;
    // scp-style: git@github.com:owner/repo
    const scp = trimmed.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
    // url-style: https://github.com/owner/repo or ssh://git@github.com/owner/repo
    const web = trimmed.match(/^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
    const host = (scp?.[1] ?? web?.[1])?.toLowerCase();
    const repoPath = (scp?.[2] ?? web?.[2])?.replace(/^\/+/, '');
    if (host !== WEB_HOST || !repoPath) return null;
    const parts = repoPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

export class GitHubDriver implements GitProviderDriver {
    readonly id: GitProviderId = 'github';
    readonly tokenEnvVar = 'GH_TOKEN';

    private readonly tokenCache = new Map<string, { token: string; fetchedAt: number }>();

    constructor(
        private readonly getEnv: () => NodeJS.ProcessEnv = getLoginEnv,
        private readonly tokenTtlMs: number = TOKEN_TTL_MS
    ) {}

    /**
     * Whether `gh` is installed, its version, and the keyring accounts.
     *
     * Feeds the binding panel's account picker and its "install gh" empty
     * state. Deliberately uncached: it runs when the panel opens, and
     * installing `gh` or running `gh auth login` must take effect without an
     * app restart.
     */
    public async probe(): Promise<ProviderProbeResult> {
        const binary = this.resolveBinary();
        if (!binary) {
            return {
                available: false,
                accounts: [],
                error: '`gh` is not installed or not on PATH.',
            };
        }

        const version = await this.run(binary, ['--version']);
        if (version.failed) {
            return {
                available: false,
                resolvedBinary: binary,
                accounts: [],
                error:
                    stripTokenLines(version.stderr) ||
                    version.errorMessage ||
                    `\`${binary}\` did not run.`,
            };
        }

        // `gh auth status` exits non-zero and writes to stderr when nobody is
        // signed in (and historically wrote its report to stderr even on
        // success), so both streams are parsed and a failure is not fatal.
        const status = await this.run(binary, ['auth', 'status']);
        const accounts = parseAccounts(`${status.stdout}\n${status.stderr}`);

        return {
            available: true,
            resolvedBinary: binary,
            version: parseVersion(version.stdout),
            accounts,
            // Scrubbed rather than raw: this field crosses IPC, and a gh
            // version whose account-line wording parseAccounts doesn't
            // recognize would otherwise carry its masked `Token:` line
            // straight through here.
            ...(accounts.length === 0
                ? {
                      error:
                          stripTokenLines(`${status.stderr}\n${status.stdout}`) ||
                          'No GitHub accounts are signed in. Run `gh auth login`.',
                  }
                : {}),
        };
    }

    /**
     * A token for one keyring account, via `gh auth token --user <login>`.
     *
     * Cached in memory for a few minutes and nowhere else. Throws with gh's
     * own stderr on failure — the caller decides how to degrade.
     */
    public async token(accountLogin: string): Promise<string> {
        const cached = this.tokenCache.get(accountLogin);
        if (cached && Date.now() - cached.fetchedAt < this.tokenTtlMs) {
            return cached.token;
        }

        const binary = this.resolveBinary();
        if (!binary) {
            throw new Error('`gh` is not installed or not on PATH.');
        }

        const result = await this.run(binary, ['auth', 'token', '--user', accountLogin]);
        if (result.failed) {
            // Scrubbed like probe()'s failures: this error reaches
            // InboxService's InboxSnapshot.error, which is broadcast to
            // every renderer, so no raw subprocess text may cross that line.
            throw new Error(
                stripTokenLines(result.stderr) ||
                    result.errorMessage ||
                    `gh auth token failed for ${accountLogin}.`
            );
        }

        const token = result.stdout.trim();
        if (!token) {
            throw new Error(`gh returned an empty token for ${accountLogin}.`);
        }

        this.tokenCache.set(accountLogin, { token, fetchedAt: Date.now() });
        return token;
    }

    /**
     * One `gh api graphql` call, three searches, parsed into neutral items.
     *
     * `env` is the caller's composed environment — the login env plus
     * GH_TOKEN — so the request runs as the workspace's account rather than
     * whatever the keyring considers active. Parse failures propagate: an
     * unrecognised reply must never read as an empty inbox.
     */
    public async fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]> {
        const searches = searchStrings(binding.accountLogin, binding.org);
        const stdout = await this.exec(
            [
                'api',
                'graphql',
                '-f',
                `query=${INBOX_QUERY}`,
                '-f',
                `assigned=${searches.assigned}`,
                '-f',
                `authored=${searches.authored}`,
                '-f',
                `reviewRequested=${searches.reviewRequested}`,
            ],
            env
        );
        return parseInboxPayload(JSON.parse(stdout));
    }

    /**
     * `gh pr checkout <n>` inside the worktree — gh owns the branch naming
     * and the fetch, with GH_TOKEN in `env`. An issue has no branch on
     * GitHub to fetch; WorktreeService creates its local `consola/issue-<n>`
     * branch itself, so for an issue there is nothing to do here.
     */
    public async checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<void> {
        if (ref.type !== 'pr') return;
        await this.exec(['pr', 'checkout', String(ref.number)], env, worktreeDir);
    }

    /**
     * `gh repo clone` rather than bare `git clone`: gh authenticates from
     * GH_TOKEN in the subprocess env, so private repos clone as the
     * workspace's account and Consola still stores zero credentials.
     */
    public async cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void> {
        await this.exec(['repo', 'clone', repo, destinationDir], env);
    }

    public matchesRemote(remoteUrl: string, repo: string): boolean {
        return parseGitHubRemote(remoteUrl) === repo.toLowerCase();
    }

    public workItemUrl(ref: WorkItemRef): string {
        return workItemUrl(ref);
    }

    public seedHeader(ref: WorkItemRef, item?: InboxItem): string {
        return renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, ref, item);
    }

    /**
     * Absolute path to `gh`, or null when nothing was found.
     *
     * `CONSOLA_GH_PATH` wins first — the seam the unit tests and the
     * Playwright rig use to point at a stub `gh` without touching the real
     * PATH or a real install. Otherwise this searches the login-shell PATH
     * like every binary Consola drives: a Dock-launched app inherits a
     * minimal environment, and getLoginEnv restores whatever the user's shell
     * profile puts on PATH — including Homebrew.
     *
     * Deliberately uncached (both branches) so installing `gh`, or changing
     * the override, takes effect without a restart.
     */
    private resolveBinary(): string | null {
        // No hardcoded fallback locations (unlike ClaudeDriver): getLoginEnv
        // already reproduces the user's real PATH, and machine-wide fallbacks
        // would make "gh is absent" untestable — and would override a user's
        // intentional PATH choice.
        const override = process.env.CONSOLA_GH_PATH;
        if (override) return override;

        const searchPath = this.getEnv().PATH ?? '';
        for (const dir of searchPath.split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, BINARY_NAME);
            if (isExecutable(candidate)) return candidate;
        }
        return null;
    }

    /** probe/token: run in the ambient login env, never throw, hand back both streams. */
    private run(binary: string, args: string[]): Promise<RunResult> {
        return new Promise((resolve) => {
            execFile(
                binary,
                args,
                {
                    env: this.getEnv() as { [key: string]: string },
                    timeout: RUN_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout, stderr) =>
                    resolve({
                        stdout,
                        stderr,
                        failed: error !== null,
                        errorMessage: error?.message,
                    })
            );
        });
    }

    /**
     * fetch/checkout/clone: run in the caller's composed env, surfacing
     * stderr as the Error message.
     *
     * The binary is resolved fresh on every call — a PATH scan is a handful
     * of stat calls — so CONSOLA_GH_PATH and a newly installed gh both take
     * effect at once. A bare `gh` when nothing resolves lets the spawn fail
     * loudly rather than inventing a location.
     */
    private async exec(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
        const binary = this.resolveBinary() ?? BINARY_NAME;
        try {
            const { stdout } = await execFileAsync(binary, args, {
                cwd,
                env: env as { [key: string]: string },
                maxBuffer: 10 * 1024 * 1024,
            });
            return stdout;
        } catch (error) {
            const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
            throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
        }
    }
}
```

- [ ] **Step 4: Run the driver test — the fixture verbs still fail**

Run: `npx vitest run src/main/providers/github/GitHubDriver.test.ts`
Expected: the `probe`, `token`, `CONSOLA_GH_PATH`, `matchesRemote` and identity blocks PASS; the `fetchInbox`, `checkout` and `cloneRepo` blocks FAIL on `invocations()` (empty) — the fixture `gh` does not log yet. The next step adds the knob.

- [ ] **Step 5: Give the fixture `gh` a `STUB_GH_LOG` knob**

In `tests/fixtures/stub-gh/gh`, replace the header comment (lines 2–8) with:

```bash
# Canned `gh` for tests. Keyed on argv so every consumer — GitHubDriver
# probes and fetches, WorktreeService checkouts, the clone flow, and the
# Playwright inbox spec — runs deterministically without network or a keyring.
#
# Env knobs:
#   STUB_GH_FAIL=1           every invocation exits 1 with a canned stderr line
#   STUB_GH_CLONE_FROM=path  `repo clone` clones from this local repo instead of GitHub
#   STUB_GH_LOG=path         append one line per invocation: argv (newlines
#                            flattened — the GraphQL query spans lines) then
#                            the GH_TOKEN the call saw
```

and insert after `here="$(cd ...)"` (line 10), before the `STUB_GH_FAIL` check:

```bash
if [[ -n "${STUB_GH_LOG:-}" ]]; then
  # printf '%s' rather than echo so the only newline is the one added after
  # flattening; a trailing space would otherwise ride into every assertion.
  printf '%s' "$* GH_TOKEN=${GH_TOKEN:-}" | tr '\n' ' ' >> "$STUB_GH_LOG"
  printf '\n' >> "$STUB_GH_LOG"
fi
```

Run: `npx vitest run src/main/providers/github/GitHubDriver.test.ts`
Expected: PASS (28 tests).

- [ ] **Step 6: Move the fixture smoke test and cover the knob**

```bash
git mv src/main/github/stubGh.test.ts src/main/providers/github/stubGh.test.ts
```

Replace the whole file with:

```ts
// src/main/providers/github/stubGh.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const STUB = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');

function runStub(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(STUB, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('stub gh fixture', () => {
  it('answers --version', () => {
    expect(runStub(['--version'])).toContain('gh version');
  });

  it('prints a token derived from the requested account', () => {
    expect(runStub(['auth', 'token', '--user', 'SymJavi']).trim()).toBe(
      'gho_stub_token_for_SymJavi'
    );
  });

  it('answers api graphql with the canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(payload.data.reviewRequested.nodes.length).toBeGreaterThan(0);
  });

  it('fails every call with a canned stderr when STUB_GH_FAIL=1', () => {
    expect(() => runStub(['api', 'graphql'], { STUB_GH_FAIL: '1' })).toThrow(/canned failure/);
  });

  it('rejects argv it does not know, so a drifted caller fails loudly', () => {
    expect(() => runStub(['pr', 'merge', '51'])).toThrow();
  });

  it('records argv and the token it saw, one line per call, when STUB_GH_LOG is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-log-'));
    const log = path.join(dir, 'calls.log');

    runStub(['--version'], { STUB_GH_LOG: log, GH_TOKEN: 'gho_a' });
    runStub(['api', 'graphql', '-f', 'query=line one\nline two'], { STUB_GH_LOG: log, GH_TOKEN: 'gho_b' });

    expect(fs.readFileSync(log, 'utf8')).toBe(
      '--version GH_TOKEN=gho_a\napi graphql -f query=line one line two GH_TOKEN=gho_b\n'
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

Run: `npx vitest run src/main/providers/github/stubGh.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Write the failing registry test**

```ts
// src/main/providers/index.test.ts
import { describe, expect, it, vi } from 'vitest';

// composeProviderEnv layers onto the login env; pin it so the assertion is
// about the layering, not about this machine's shell profile.
vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: '/usr/bin' }) }));

import type { GitProviderDriver } from './GitProviderDriver';
import { composeProviderEnv, getProviderDriver, layerProviderToken } from './index';

function fakeDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'FAKE_TOKEN',
    probe: async () => ({ available: true, accounts: [] }),
    token: async (login) => `tok-${login}`,
    fetchInbox: async () => [],
    checkout: async () => undefined,
    cloneRepo: async () => undefined,
    matchesRemote: () => false,
    workItemUrl: () => '',
    seedHeader: () => '',
    ...overrides,
  };
}

describe('getProviderDriver', () => {
  it('resolves the GitHub driver, the same instance every time', () => {
    const driver = getProviderDriver('github');

    expect(driver.id).toBe('github');
    expect(driver.tokenEnvVar).toBe('GH_TOKEN');
    // A registry, not a factory: one token cache per provider for the app.
    expect(getProviderDriver('github')).toBe(driver);
  });

  it('throws for an id it does not know — callers degrade inside their own paths', () => {
    // Unlike getDriver (harnesses), which falls back so a spawn survives a
    // stale id, a wrong provider must not silently become GitHub: it would
    // fetch and push to the wrong host. Every live caller catches this.
    expect(() => getProviderDriver('gitlab' as never)).toThrow('Unknown git provider "gitlab".');
  });
});

describe('layerProviderToken', () => {
  it("adds the token under the driver's variable, on a copy of the env", () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerProviderToken(base, 'GH_TOKEN', 'gho_x');

    expect(layered).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'gho_x' });
    expect(base).not.toHaveProperty('GH_TOKEN');
  });

  it('returns a token-free copy when there is no token', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerProviderToken(base, 'GH_TOKEN', null);

    expect(layered).toEqual({ PATH: '/usr/bin' });
    expect(layered).not.toBe(base);
  });

  it('returns a token-free copy when there is no variable to put it in', () => {
    expect(layerProviderToken({ PATH: '/usr/bin' }, null, 'gho_x')).toEqual({ PATH: '/usr/bin' });
  });
});

describe('composeProviderEnv', () => {
  it("layers the account's token onto the login environment under the driver's variable", async () => {
    await expect(composeProviderEnv(fakeDriver(), 'SymJavi')).resolves.toEqual({
      PATH: '/usr/bin',
      FAKE_TOKEN: 'tok-SymJavi',
    });
  });

  it('propagates a token failure so the caller can degrade', async () => {
    const driver = fakeDriver({
      token: async () => {
        throw new Error('no oauth token found');
      },
    });

    await expect(composeProviderEnv(driver, 'nobody')).rejects.toThrow('no oauth token found');
  });
});
```

Run: `npx vitest run src/main/providers/index.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 8: Create `src/main/providers/index.ts`**

```ts
import type { GitProviderId } from '../../shared/providers';
import { getLoginEnv } from '../LoginEnvironment';
import type { GitProviderDriver } from './GitProviderDriver';
import { GitHubDriver } from './github/GitHubDriver';

/**
 * The git hosting providers Consola can act on.
 *
 * Supporting another provider means adding its driver here and nothing
 * else: the inbox, launch, clone, worktree and terminal layers all go
 * through `getProviderDriver`.
 */
const DRIVERS: Record<GitProviderId, GitProviderDriver> = {
    github: new GitHubDriver(),
};

export const DEFAULT_PROVIDER_ID: GitProviderId = 'github';

/**
 * The driver for an id. Throws on an unknown one.
 *
 * Deliberately not the harness registry's fall-back: a session persisted by
 * a newer build with a provider this build lacks must not quietly fetch
 * from and push to GitHub instead. Every live call site — token borrow,
 * inbox refresh, launch, clone, repo resolution — already wraps this in the
 * degrade path it has for the provider CLI failing.
 */
export function getProviderDriver(id: GitProviderId): GitProviderDriver {
    const driver = DRIVERS[id];
    if (!driver) throw new Error(`Unknown git provider "${id}".`);
    return driver;
}

/**
 * A copy of `env` with the token layered on under the driver's variable, or
 * a plain copy when there is no token (or nowhere to put it).
 *
 * Always a copy: the base environment is shared (getLoginEnv caches it), and
 * mutating it would leak one workspace's token into every other spawn.
 */
export function layerProviderToken(
    env: NodeJS.ProcessEnv,
    tokenEnvVar: string | null,
    token: string | null
): NodeJS.ProcessEnv {
    return tokenEnvVar && token ? { ...env, [tokenEnvVar]: token } : { ...env };
}

/**
 * Login env plus this account's token — composed here and only here, so a
 * token never crosses IPC and never lands in a renderer-bound payload.
 * Rejects when the token cannot be borrowed; the caller labels the failure.
 */
export async function composeProviderEnv(
    driver: GitProviderDriver,
    accountLogin: string
): Promise<NodeJS.ProcessEnv> {
    return layerProviderToken(getLoginEnv(), driver.tokenEnvVar, await driver.token(accountLogin));
}

export type { GitProviderDriver } from './GitProviderDriver';
```

Run: `npx vitest run src/main/providers/index.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Retire the broker's test file and run the suite**

```bash
git rm src/main/github/GhBroker.test.ts
```

`GhBroker.ts` itself stays: `TerminalService.ts` (Task 9) and `ipc-handlers.ts` (Task 11) still import it, and `TerminalService.test.ts` loads it through `TerminalService`.

Run: `npm test`
Expected: 45 files, 533 tests pass (512 − 15 broker cases + 28 driver + 1 new stub case + 7 registry).

Run: `npx tsc -p tsconfig.main.json --noEmit 2>&1 | grep 'src/main/providers/' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no `src/main/providers/` lines — the new directory compiles; main stays red only in the files Tasks 7–11 still own.

- [ ] **Step 10: Commit**

```bash
git add src/main/providers/github/GitHubDriver.ts src/main/providers/github/GitHubDriver.test.ts src/main/providers/github/stubGh.test.ts src/main/providers/index.ts src/main/providers/index.test.ts tests/fixtures/stub-gh/gh
git rm --cached -q src/main/github/GhBroker.test.ts 2>/dev/null; git add -A src/main/github/GhBroker.test.ts
git commit -m "feat: GitHubDriver absorbs GhBroker; provider registry with token layering" -m "Every gh-shaped operation now lives behind one class: probe and token (with their token scrubbing, moved verbatim), the GraphQL fetch, gh pr checkout, gh repo clone, host-checked remote matching and the seed header. getProviderDriver throws on an unknown id on purpose — a wrong provider must not quietly become GitHub — and composeProviderEnv layers the token under whatever variable the driver names, so no caller spells GH_TOKEN. The fixture gh gains STUB_GH_LOG so argv and env can be asserted through a real subprocess.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `InboxService`, `launchWorkItem` and `cloneWorkspaceRepo` against a stub driver

**Files:**
- Move: `src/main/github/GitHubService.ts` → `src/main/providers/InboxService.ts` (rewritten to take a driver)
- Move: `src/main/github/GitHubService.test.ts` → `src/main/providers/InboxService.test.ts` (rewritten against a stub `GitProviderDriver`)
- Move: `src/main/github/launchWorkItem.ts` → `src/main/providers/launchWorkItem.ts`
- Move: `src/main/github/launchWorkItem.test.ts` → `src/main/providers/launchWorkItem.test.ts`
- Move: `src/main/github/cloneRepo.ts` → `src/main/providers/cloneRepo.ts`
- Move: `src/main/github/cloneRepo.test.ts` → `src/main/providers/cloneRepo.test.ts` (rewritten against a stub driver; the real `gh repo clone` mechanics are covered by `GitHubDriver.test.ts`)
- Delete: `src/main/github/parseInbox.ts` (its last importer, `GitHubService.ts`, goes in this task)

**Interfaces:**
- Consumes: `GitProviderDriver` (Task 5); `GitProviderId`, `ProviderBinding` (Task 1); `InboxItem`, `InboxSnapshot`, `WorkItemRef`, `sameWorkItem`, `workItemKey` (Task 1); `createDefaultActions`, `defaultActionNameForType` (Task 2); `Workspace`, `NewSessionFields`, `Session`, `generateSessionInstanceId` (Task 3's `workspace.ts`); `WorkItemLaunchResult`, `CloneRepoResult` (Task 4).
- Produces:
  - `src/main/providers/InboxService.ts`: `INBOX_REFRESH_INTERVAL_MS`; `interface InboxServiceDeps { getWorkspace(workspaceId); getBoundWorkspaceIds(); resolveDriver(id: GitProviderId); composeEnv(driver, accountLogin); broadcast(snapshot) }`; `class InboxService { constructor(deps); start(); stop(); onWindowFocus(); getSnapshot(workspaceId); findItem(workspaceId, ref); refresh(workspaceId) }`.
  - `src/main/providers/launchWorkItem.ts`: `interface WorkItemLaunchDeps { getWorkspace; createSession; resolveRepo; ensureWorktree(clonePath, workItem, env); composeEnv(driver, accountLogin); findItem; pathExists; resolveDriver(id) }` (these names are fixed; Phase C keeps them and only deletes `pathExists`); `workItemSessionName(workItem, item?)`; `buildSeedPrompt(driver, workItem, item?)`; `launchWorkItem(deps, workspaceId, workItem)`; `createLaunchCoalescer(deps)`.
  - `src/main/providers/cloneRepo.ts`: `interface CloneRepoDeps { resolveDriver(id); composeEnv(driver, accountLogin); addScope(workspaceId, dirPath) }`; `cloneWorkspaceRepo(deps, workspace, repo, destinationDir)`.

- [ ] **Step 1: Move and rewrite the inbox service test**

```bash
git mv src/main/github/GitHubService.ts src/main/providers/InboxService.ts
git mv src/main/github/GitHubService.test.ts src/main/providers/InboxService.test.ts
```

Replace `src/main/providers/InboxService.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { InboxService, INBOX_REFRESH_INTERVAL_MS, type InboxServiceDeps } from './InboxService';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

const issue87: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 },
  title: 'Rate limit returns 500',
  author: 'mira',
  roles: ['assignee'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'none',
  commentCount: 4,
  updatedAt: '2026-08-20T07:12:00Z',
  url: 'https://github.com/sympower/msa-resource-bff/issues/87',
};

/**
 * A driver that is not gh: the proof that nothing in InboxService branches
 * on GitHub. `id` is 'github' only because it is the union's sole member;
 * the service never reads it.
 */
function makeStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'STUB_TOKEN',
    probe: vi.fn(async () => ({ available: true, accounts: [] })),
    token: vi.fn(async (login: string) => `tok-${login}`),
    fetchInbox: vi.fn(async () => [item51, issue87]),
    checkout: vi.fn(async () => undefined),
    cloneRepo: vi.fn(async () => undefined),
    matchesRemote: () => false,
    workItemUrl: (ref) => `stub://${ref.repo}/${ref.number}`,
    seedHeader: (ref) => `stub header for #${ref.number}`,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [],
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeService(overrides: Partial<InboxServiceDeps> = {}, driver = makeStubDriver()) {
  const broadcasts: InboxSnapshot[] = [];
  const workspace = makeWorkspace();
  const service = new InboxService({
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getBoundWorkspaceIds: () => [workspace.id],
    resolveDriver: () => driver,
    // What composeProviderEnv does, minus the login shell: the token under
    // the driver's own variable.
    composeEnv: async (resolved, login) => ({ [resolved.tokenEnvVar]: await resolved.token(login) }),
    broadcast: (snapshot) => broadcasts.push(snapshot),
    ...overrides,
  });
  return { service, broadcasts, workspace, driver };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InboxService.refresh', () => {
  it('fetches through the driver with the binding and the composed env, caches, and broadcasts', async () => {
    const { service, broadcasts, driver } = makeService();

    await service.refresh('ws-1');

    expect(driver.fetchInbox).toHaveBeenCalledWith(
      { accountLogin: 'SymJavi', org: 'sympower' },
      { STUB_TOKEN: 'tok-SymJavi' }
    );
    const snapshot = service.getSnapshot('ws-1');
    expect(snapshot?.items).toEqual([item51, issue87]);
    expect(snapshot?.fetchedAt).toBeGreaterThan(0);
    expect(snapshot?.error).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].workspaceId).toBe('ws-1');
  });

  it('keeps the last good items and stamps the error when the driver throws', async () => {
    const { service, driver } = makeService();

    await service.refresh('ws-1');
    const good = service.getSnapshot('ws-1')!;

    vi.mocked(driver.fetchInbox).mockRejectedValueOnce(new Error('gh: canned failure (STUB_GH_FAIL=1)'));
    await service.refresh('ws-1');
    const degraded = service.getSnapshot('ws-1')!;

    expect(degraded.items).toEqual(good.items);
    expect(degraded.fetchedAt).toBe(good.fetchedAt);
    expect(degraded.error).toContain('canned failure');
  });

  it('degrades the same way when the token cannot be borrowed', async () => {
    const { service } = makeService({
      composeEnv: async () => {
        throw new Error('gh: no accounts logged in');
      },
    });

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1')!;
    expect(snapshot.items).toEqual([]);
    expect(snapshot.error).toContain('no accounts logged in');
  });

  it('degrades — never throws — when the workspace names a provider this build lacks', async () => {
    const { service, driver } = makeService({
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    await expect(service.refresh('ws-1')).resolves.toBeUndefined();

    expect(service.getSnapshot('ws-1')?.error).toContain('Unknown git provider');
    expect(driver.fetchInbox).not.toHaveBeenCalled();
  });

  it('does nothing for a workspace without a provider binding', async () => {
    const { service, broadcasts, driver } = makeService({
      getWorkspace: () => makeWorkspace({ provider: undefined }),
    });

    await service.refresh('ws-1');

    expect(service.getSnapshot('ws-1')).toBeNull();
    expect(broadcasts).toHaveLength(0);
    expect(driver.fetchInbox).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes of one workspace', async () => {
    const { service, broadcasts, driver } = makeService();

    await Promise.all([service.refresh('ws-1'), service.refresh('ws-1')]);

    expect(driver.fetchInbox).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
  });
});

describe('InboxService.findItem', () => {
  it('finds a cached item by work-item ref, case-insensitively', async () => {
    const { service } = makeService();
    await service.refresh('ws-1');

    const item = service.findItem('ws-1', {
      provider: 'github',
      repo: 'Sympower/Controller-App',
      type: 'pr',
      number: 51,
    });
    expect(item?.title).toBe('Extract billing client');
  });
});

describe('InboxService cadence', () => {
  it('polls every bound workspace on the 3-minute timer', () => {
    vi.useFakeTimers();
    const getBoundWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getBoundWorkspaceIds });

    service.start();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
    service.stop();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
  });

  it('debounces window-focus refreshes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
    const getBoundWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getBoundWorkspaceIds });

    service.onWindowFocus();
    service.onWindowFocus();
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-20T09:01:00Z'));
    service.onWindowFocus();
    expect(getBoundWorkspaceIds).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/InboxService.test.ts`
Expected: FAIL — `InboxService` is not exported (the moved file still exports `GitHubService` and imports `./parseInbox`, which no longer resolves from this directory).

- [ ] **Step 3: Rewrite `src/main/providers/InboxService.ts`**

```ts
import type { GitProviderId } from '../../shared/providers';
import type { InboxItem, InboxSnapshot, WorkItemRef } from '../../shared/workItems';
import { sameWorkItem } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';

/** Spec cadence: a timer refresh every 3 minutes. */
export const INBOX_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
/** Focus events arrive in bursts (click-through between windows); refresh once. */
const FOCUS_REFRESH_MIN_GAP_MS = 30 * 1000;

export interface InboxServiceDeps {
  getWorkspace(workspaceId: string): Workspace | undefined;
  /** Every workspace with a provider binding — the set the timer and focus poll. */
  getBoundWorkspaceIds(): string[];
  /** getProviderDriver — throws on an unknown id; the message becomes the label. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  /** Login env plus this account's token, under the driver's variable. Throws when the token cannot be borrowed. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** Push one workspace's snapshot to every renderer. */
  broadcast(snapshot: InboxSnapshot): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The per-workspace Inbox: one fetcher, one cache, one rate budget.
 *
 * Renderers never fetch. Main refreshes on window focus, on a manual intent,
 * and on a timer; results land in an in-memory cache and go out on
 * inbox:changed. A failed refresh never discards the last good list — it
 * re-broadcasts it with `error` set, and the UI labels the staleness. Which
 * provider does the fetching is the workspace's binding's business; this
 * service only ever holds a GitProviderDriver.
 */
export class InboxService {
  private readonly snapshots = new Map<string, InboxSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastFocusRefresh = 0;

  constructor(private readonly deps: InboxServiceDeps) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), INBOX_REFRESH_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public onWindowFocus(): void {
    const now = Date.now();
    if (now - this.lastFocusRefresh < FOCUS_REFRESH_MIN_GAP_MS) return;
    this.lastFocusRefresh = now;
    void this.refreshAll();
  }

  public getSnapshot(workspaceId: string): InboxSnapshot | null {
    return this.snapshots.get(workspaceId) ?? null;
  }

  /** The cached item for a work item, for seed prompts and session names. */
  public findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined {
    return this.snapshots
      .get(workspaceId)
      ?.items.find((item) => sameWorkItem(item.workItem, ref));
  }

  /** Refresh one workspace, coalescing concurrent calls into one fetch. */
  public refresh(workspaceId: string): Promise<void> {
    const running = this.inFlight.get(workspaceId);
    if (running) return running;
    const job = this.doRefresh(workspaceId).finally(() => this.inFlight.delete(workspaceId));
    this.inFlight.set(workspaceId, job);
    return job;
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(this.deps.getBoundWorkspaceIds().map((id) => this.refresh(id)));
  }

  private async doRefresh(workspaceId: string): Promise<void> {
    const workspace = this.deps.getWorkspace(workspaceId);
    const provider = workspace?.provider;
    if (!provider) {
      // Unbound (or unbound since last fetch): nothing to show, nothing stale.
      this.snapshots.delete(workspaceId);
      return;
    }

    const previous = this.snapshots.get(workspaceId);
    try {
      // Resolved inside the try on purpose: an unknown provider id is one
      // more way the fetch cannot happen, and it degrades like the others.
      const driver = this.deps.resolveDriver(provider.id);
      const env = await this.deps.composeEnv(driver, provider.accountLogin);
      const items = await driver.fetchInbox(
        { accountLogin: provider.accountLogin, org: provider.org },
        env
      );
      this.adopt({ workspaceId, items, fetchedAt: Date.now() });
    } catch (error) {
      // Degrade, never dialog: keep the last good list and its age, label why.
      this.adopt({
        workspaceId,
        items: previous?.items ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: describeError(error),
      });
    }
  }

  private adopt(snapshot: InboxSnapshot): void {
    this.snapshots.set(snapshot.workspaceId, snapshot);
    this.deps.broadcast(snapshot);
  }
}
```

- [ ] **Step 4: Run the inbox service test to verify it passes**

Run: `npx vitest run src/main/providers/InboxService.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Move and rewrite the launch test against the stub driver**

```bash
git mv src/main/github/launchWorkItem.ts src/main/providers/launchWorkItem.ts
git mv src/main/github/launchWorkItem.test.ts src/main/providers/launchWorkItem.test.ts
```

Replace `src/main/providers/launchWorkItem.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import {
  buildSeedPrompt,
  createLaunchCoalescer,
  launchWorkItem,
  workItemSessionName,
  type WorkItemLaunchDeps,
} from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 87 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

const REVIEW_BODY =
  'Review the changes and summarise your findings before writing any review comments.';
const IMPLEMENT_BODY = 'Investigate it and propose a plan before changing anything.';

/** Not gh: the launch must work with any driver that honours the interface. */
function makeStubDriver(): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'STUB_TOKEN',
    probe: vi.fn(async () => ({ available: true, accounts: [] })),
    token: vi.fn(async (login: string) => `tok-${login}`),
    fetchInbox: vi.fn(async () => []),
    checkout: vi.fn(async () => undefined),
    cloneRepo: vi.fn(async () => undefined),
    matchesRemote: () => false,
    workItemUrl: (ref) => `stub://${ref.repo}/${ref.number}`,
    seedHeader: (ref, item) => `stub header for #${ref.number}${item ? ` (${item.title})` : ''}`,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-container', name: 'sympower', path: '/repos', isGitRepo: false, createdAt: now },
      { id: 'scope-controller', name: 'controller-app', path: '/repos/controller-app', isGitRepo: true, createdAt: now },
    ],
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
  const driver = makeStubDriver();
  const deps: WorkItemLaunchDeps = {
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    createSession: (workspaceId, fields) => {
      created.push(fields);
      return {
        ...fields,
        id: 'session-new',
        claudeSessionId: 'uuid-new',
        hasStarted: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      } as Session;
    },
    resolveRepo: () => '/repos/controller-app',
    ensureWorktree: vi.fn(async () => '/worktrees/controller-app-pr-51'),
    composeEnv: vi.fn(async (resolved, login) => ({ [resolved.tokenEnvVar]: `tok-${login}` })),
    findItem: () => item51,
    pathExists: () => true,
    resolveDriver: () => driver,
    ...overrides,
  };
  return { deps, created, driver };
}

function existingSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-existing',
    name: 'PR #51 - Extract billing client',
    workspaceId: 'ws-1',
    instanceId: 'inst-existing',
    claudeSessionId: 'uuid-existing',
    hasStarted: true,
    harnessId: 'default',
    scopeId: 'scope-controller',
    cwd: '/worktrees/controller-app-pr-51',
    kind: 'interactive',
    workItem: pr51,
    workItemAction: 'Review',
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

describe('launchWorkItem', () => {
  it('re-attaches to an existing session for the same work item, touching nothing', async () => {
    // Casing differs on purpose: repo identity is case-insensitive.
    const existing = existingSession({ workItem: { ...pr51, repo: 'Sympower/Controller-App' } });
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('re-ensures a deleted worktree before re-attaching, with the env the driver composed', async () => {
    const existing = existingSession();
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created, driver } = makeDeps(workspace, { pathExists: () => false });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.composeEnv).toHaveBeenCalledWith(driver, 'SymJavi');
    expect(deps.ensureWorktree).toHaveBeenCalledWith('/repos/controller-app', pr51, {
      STUB_TOKEN: 'tok-SymJavi',
    });
  });

  it('re-attaches without ensuring anything when the clone itself is gone too', async () => {
    const workspace = makeWorkspace({ sessions: [existingSession()] });
    const { deps } = makeDeps(workspace, { pathExists: () => false, resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    // The clone can't be resolved, so there's nothing to rebuild the
    // worktree from — the honest answer is today's re-attach, which hands
    // the user the existing terminal's "working folder not found" notice.
    expect(result).toMatchObject({ ok: true, reattached: true });
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('surfaces ensureWorktree failure as the launch error rather than re-attaching into a broken directory', async () => {
    const workspace = makeWorkspace({ sessions: [existingSession()] });
    const { deps } = makeDeps(workspace, {
      pathExists: () => false,
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: unable to recreate worktree');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: unable to recreate worktree' });
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  it('creates the record with the matched scope, worktree cwd, work item and the action name', async () => {
    const { deps, created } = makeDeps(makeWorkspace());

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reattached).toBe(false);
    // The driver's header, a blank line, then the type's default body.
    expect(result.seedPrompt).toBe(`stub header for #51 (Extract billing client)\n\n${REVIEW_BODY}`);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      workItemAction: 'Review',
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
  });

  it('labels an issue launch Implement and seeds the Implement body', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => '/worktrees/controller-app-issue-87'),
      findItem: () => undefined,
    });

    const result = await launchWorkItem(deps, 'ws-1', issue87);

    expect(result).toMatchObject({
      ok: true,
      seedPrompt: `stub header for #87\n\n${IMPLEMENT_BODY}`,
    });
    expect(created[0]).toMatchObject({ name: 'Issue #87', workItemAction: 'Implement' });
  });

  it('errors plainly for a workspace without a provider binding', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ provider: undefined }));

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'This workspace has no provider account bound.',
    });
    expect(created).toHaveLength(0);
  });

  it('errors, creating nothing, when the provider is unknown to this build', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown git provider "gitlab".' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });
});

describe('createLaunchCoalescer', () => {
  it('coalesces concurrent launches of the same work item into one call', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    // Not reachable through the UI (the renderer's `launching[key]` disables
    // the button), but this proves the main-side defence: two overlapping
    // calls must not each pass the "existing session" check and mint a
    // rival session for the same work item.
    const [first, second] = await Promise.all([launch('ws-1', pr51), launch('ws-1', pr51)]);

    expect(created).toHaveLength(1);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('does not coalesce launches of different work items', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51), launch('ws-1', issue87)]);

    expect(created).toHaveLength(2);
  });

  it('runs a later launch of the same item fresh once the first has settled', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    const first = await launch('ws-1', pr51);
    if (!first.ok) throw new Error('expected the first launch to succeed');
    // The real session now exists in `workspace.sessions` (as it would once
    // WorkspaceService persists it), so this second, non-overlapping call
    // re-attaches rather than launching fresh.
    workspace.sessions = [first.session];
    const second = await launch('ws-1', pr51);

    expect(created).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, reattached: true });
  });
});

describe('buildSeedPrompt', () => {
  it("is the driver's header, a blank line, and the Review body for a PR", () => {
    expect(buildSeedPrompt(makeStubDriver(), pr51, item51)).toBe(
      `stub header for #51 (Extract billing client)\n\n${REVIEW_BODY}`
    );
  });

  it('is the header and the Implement body for an issue, with no cached item', () => {
    expect(buildSeedPrompt(makeStubDriver(), issue87)).toBe(`stub header for #87\n\n${IMPLEMENT_BODY}`);
  });
});

describe('workItemSessionName', () => {
  it('uses the title when the inbox holds one, a plain label when not', () => {
    expect(workItemSessionName(pr51, item51)).toBe('PR #51 - Extract billing client');
    expect(workItemSessionName(pr51)).toBe('PR #51');
    expect(workItemSessionName(issue87)).toBe('Issue #87');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/launchWorkItem.test.ts`
Expected: FAIL — the moved module still imports `../../shared/github` (which resolves, but) reads `workspace.github`, so every case reports "no GitHub account bound", and `buildSeedPrompt` rejects the driver argument.

- [ ] **Step 7: Rewrite `src/main/providers/launchWorkItem.ts`**

```ts
import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { WorkItemLaunchResult } from '../../shared/types';
import { createDefaultActions, defaultActionNameForType } from '../../shared/workItemActions';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import { sameWorkItem, workItemKey } from '../../shared/workItems';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus this account's token, under the driver's variable. Composed main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
  /** Whether a path exists on disk — used to notice a re-attach whose worktree was deleted. */
  pathExists(target: string): boolean;
  /** getProviderDriver — throws on an unknown id, which becomes the launch error. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The deepest scope whose path contains the clone — its home in the sidebar. */
function scopeIdForPath(workspace: Workspace, clonePath: string): string {
  let best: Workspace['scopes'][number] | undefined;
  for (const scope of workspace.scopes) {
    const matches = clonePath === scope.path || clonePath.startsWith(scope.path + path.sep);
    if (matches && (!best || scope.path.length > best.path.length)) best = scope;
  }
  return (best ?? workspace.scopes[0]).id;
}

/** Sidebar name for a work-item session, titled when the inbox knows the title. */
export function workItemSessionName(workItem: WorkItemRef, item?: InboxItem): string {
  const label = workItem.type === 'pr' ? `PR #${workItem.number}` : `Issue #${workItem.number}`;
  return item ? `${label} - ${item.title}` : label;
}

/**
 * The body seeded until Phase C renders the chosen action: the default
 * action for the item type, read from the same defaults a bound workspace is
 * seeded with, so the two can never say different things.
 */
function defaultBodyForType(type: 'pr' | 'issue'): string {
  const name = defaultActionNameForType(type);
  const action = createDefaultActions().find((candidate) => candidate.name === name);
  if (!action) throw new Error(`No default action named ${name}.`);
  return action.prompt;
}

/**
 * The prompt seeded into the fresh session: the provider's context header,
 * a blank line, the body.
 *
 * Delivered through the existing guarded queue (TerminalService.queuePrompt via
 * TerminalCreateOptions.initialPrompt), so it can never answer a trust gate or
 * permission menu. The header tells the agent where it is and to read the
 * item with the provider's CLI first — the token in its env makes that work
 * as the workspace's account.
 */
export function buildSeedPrompt(
  driver: GitProviderDriver,
  workItem: WorkItemRef,
  item?: InboxItem
): string {
  return `${driver.seedHeader(workItem, item)}\n\n${defaultBodyForType(workItem.type)}`;
}

/**
 * One click on an Inbox item: resolve -> worktree -> record.
 *
 * Atomic in that order — the worktree exists before the record does, and the
 * record exists before any PTY spawns (the spawn happens when the session pane
 * mounts, exactly like every hand-made session). On any failure nothing is
 * created and the message is surfaced on the Inbox item.
 *
 * Re-attach: one work item, one session, forever. A second click returns the
 * existing session rather than minting a rival. (Phase C replaces this with
 * "always a new session"; the shared worktree is what makes that safe.)
 */
export async function launchWorkItem(
  deps: WorkItemLaunchDeps,
  workspaceId: string,
  workItem: WorkItemRef
): Promise<WorkItemLaunchResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) {
    return { ok: false, reason: 'error', message: `Unknown workspace: ${workspaceId}` };
  }
  const provider = workspace.provider;
  if (!provider) {
    return { ok: false, reason: 'error', message: 'This workspace has no provider account bound.' };
  }

  // Resolved up front: a provider this build lacks is a launch error like
  // any other, shown on the item, never a crash in the handler.
  let driver: GitProviderDriver;
  try {
    driver = deps.resolveDriver(provider.id);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  const existing = workspace.sessions.find((session) =>
    sameWorkItem(session.workItem, workItem)
  );
  if (existing) {
    // A present cwd stays on the fast path untouched — no subprocess on the
    // common re-attach. Only a *missing* cwd (the worktree directory was
    // deleted out from under the session) re-ensures it before handing the
    // session back, so TerminalService never has to reject the spawn with
    // "Working folder not found" for a directory ensureWorktree can just
    // recreate.
    if (existing.cwd && !deps.pathExists(existing.cwd)) {
      const clonePath = deps.resolveRepo(workspace, workItem.repo);
      if (clonePath) {
        try {
          const env = await deps.composeEnv(driver, provider.accountLogin);
          await deps.ensureWorktree(clonePath, workItem, env);
        } catch (error) {
          return { ok: false, reason: 'error', message: describeError(error) };
        }
      }
      // clonePath === null means the clone itself is gone too — there is
      // nothing to rebuild from, so fall through to the honest re-attach
      // below; the user gets today's terminal notice rather than a launch
      // failure for a problem this call cannot fix.
    }
    return { ok: true, session: existing, reattached: true };
  }

  const clonePath = deps.resolveRepo(workspace, workItem.repo);
  if (!clonePath) return { ok: false, reason: 'not-cloned' };

  let worktreePath: string;
  try {
    const env = await deps.composeEnv(driver, provider.accountLogin);
    worktreePath = await deps.ensureWorktree(clonePath, workItem, env);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  const item = deps.findItem(workspaceId, workItem);
  const session = deps.createSession(workspaceId, {
    name: workItemSessionName(workItem, item),
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scopeIdForPath(workspace, clonePath),
    cwd: worktreePath,
    kind: 'interactive',
    workItem,
    // The label the sidebar and strip show: which verb this session was
    // started as. Phase C makes it the chosen action; until then it is the
    // type's default, matching what the v7 migration wrote for older sessions.
    workItemAction: defaultActionNameForType(workItem.type),
  });
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return {
    ok: true,
    session,
    seedPrompt: buildSeedPrompt(driver, workItem, item),
    reattached: false,
  };
}

/**
 * Coalesces concurrent launches of the *same* work item into one in-flight
 * call — the same in-flight-Map pattern `InboxService.refresh` already uses
 * for concurrent inbox refreshes of one workspace.
 *
 * Not reachable through the UI today (the renderer's `launching[key]` disables
 * the button, and one workspace belongs to one window), but two overlapping
 * calls would each pass the "existing session" check before either created
 * one, minting two sessions for one work item. It would also let two
 * concurrent `ensureWorktree` calls for the same item race — one call's
 * failure cleanup removing a worktree directory the other just fast-pathed
 * onto. Keyed by workspace id plus work-item key, so concurrent launches of
 * *different* items still run in parallel.
 */
export function createLaunchCoalescer(
  deps: WorkItemLaunchDeps
): (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult> {
  const inFlight = new Map<string, Promise<WorkItemLaunchResult>>();
  return (workspaceId, workItem) => {
    const key = `${workspaceId}:${workItemKey(workItem)}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = launchWorkItem(deps, workspaceId, workItem).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
```

Run: `npx vitest run src/main/providers/launchWorkItem.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 8: Move and rewrite the clone test against the stub driver**

```bash
git mv src/main/github/cloneRepo.ts src/main/providers/cloneRepo.ts
git mv src/main/github/cloneRepo.test.ts src/main/providers/cloneRepo.test.ts
```

Replace `src/main/providers/cloneRepo.test.ts` with:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { cloneWorkspaceRepo, type CloneRepoDeps } from './cloneRepo';

// Every dir handed out by tmpDir(), swept in one afterAll — these tests spin
// up several independent destinations rather than sharing one temp dir.
const createdDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(
  scopePaths: Array<{ path: string; isGitRepo: boolean }>,
  overrides: Partial<Workspace> = {}
): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: scopePaths.map((scope, index) => ({
      id: `scope-${index}`,
      name: path.basename(scope.path),
      path: scope.path,
      isGitRepo: scope.isGitRepo,
      createdAt: now,
    })),
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Not gh: a driver whose clone leaves a `.git` marker, so the tests can tell
 * a clone happened without running git. The real `gh repo clone` mechanics
 * are GitHubDriver.test.ts's business.
 */
function makeStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return {
    id: 'github',
    tokenEnvVar: 'STUB_TOKEN',
    probe: vi.fn(async () => ({ available: true, accounts: [] })),
    token: vi.fn(async (login: string) => `tok-${login}`),
    fetchInbox: vi.fn(async () => []),
    checkout: vi.fn(async () => undefined),
    cloneRepo: vi.fn(async (_repo: string, destinationDir: string) => {
      fs.mkdirSync(path.join(destinationDir, '.git'), { recursive: true });
    }),
    matchesRemote: () => false,
    workItemUrl: () => '',
    seedHeader: () => '',
    ...overrides,
  };
}

function makeDeps(driver: GitProviderDriver = makeStubDriver(), overrides: Partial<CloneRepoDeps> = {}) {
  const addScope = vi.fn();
  const deps: CloneRepoDeps = {
    resolveDriver: () => driver,
    composeEnv: vi.fn(async (resolved, login) => ({ [resolved.tokenEnvVar]: `tok-${login}` })),
    addScope,
    ...overrides,
  };
  return { deps, addScope, driver };
}

describe('cloneWorkspaceRepo', () => {
  it('clones through the driver into <destination>/<repo basename> with the composed env, leaving scopes alone when a scope covers it', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, addScope, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    const target = path.join(container, 'msa-resource-bff');
    expect(result).toEqual({ ok: true, path: target });
    expect(driver.cloneRepo).toHaveBeenCalledWith('sympower/msa-resource-bff', target, {
      STUB_TOKEN: 'tok-SymJavi',
    });
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(addScope).not.toHaveBeenCalled();
  });

  it('adds a scope for a destination no scope covers', async () => {
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps, addScope } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(true);
    expect(addScope).toHaveBeenCalledWith('ws-1', outside);
  });

  it('refuses when the destination directory does not exist', async () => {
    const missing = path.join(tmpDir('consola-clone-parent-'), 'does-not-exist');
    const workspace = makeWorkspace([{ path: missing, isGitRepo: false }]);
    const { deps, addScope, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', missing);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Destination not found');
    expect(result.error).toContain(missing);
    expect(driver.cloneRepo).not.toHaveBeenCalled();
    expect(addScope).not.toHaveBeenCalled();
  });

  it('refuses when the target directory already exists', async () => {
    const container = tmpDir('consola-clone-dst-');
    fs.mkdirSync(path.join(container, 'msa-resource-bff'));
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
    expect(driver.cloneRepo).not.toHaveBeenCalled();
  });

  it("returns the driver's error on a failed clone, creating nothing", async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(
      makeStubDriver({
        cloneRepo: vi.fn(async () => {
          throw new Error('gh: canned failure (STUB_GH_FAIL=1)');
        }),
      })
    );

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'gh: canned failure (STUB_GH_FAIL=1)' });
    expect(fs.existsSync(path.join(container, 'msa-resource-bff'))).toBe(false);
  });

  it('errors when the provider is unknown to this build', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(makeStubDriver(), {
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'Unknown git provider "gitlab".' });
  });

  it('errors plainly for a workspace without a provider binding', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }], { provider: undefined });
    const { deps, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'This workspace has no provider account bound.' });
    expect(driver.cloneRepo).not.toHaveBeenCalled();
  });

  it('reports the clone succeeded even when adding the scope afterwards throws', async () => {
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps } = makeDeps(makeStubDriver(), {
      addScope: vi.fn(() => {
        throw new Error('No workspace ws-1');
      }),
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(path.join(outside, 'msa-resource-bff'));
    expect(result.error).toContain('No workspace ws-1');
    // The clone itself must not be undone just because the scope-add failed.
    expect(fs.existsSync(path.join(outside, 'msa-resource-bff', '.git'))).toBe(true);
  });
});
```

Run: `npx vitest run src/main/providers/cloneRepo.test.ts`
Expected: FAIL — the moved module reads `workspace.github` and takes `ghBinary`, not `resolveDriver`.

- [ ] **Step 9: Rewrite `src/main/providers/cloneRepo.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { CloneRepoResult } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';

export interface CloneRepoDeps {
  /** getProviderDriver — throws on an unknown id, which becomes the clone error. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  /** Login env plus this account's token, under the driver's variable. Main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** WorkspaceService's scope-add. Fires onChange. */
  addScope(workspaceId: string, dirPath: string): void;
}

/**
 * Clone an un-cloned inbox repo into a chosen directory.
 *
 * The driver does the cloning as the workspace's account (its CLI reads the
 * token from the env it is handed), so private repos clone and Consola still
 * stores zero credentials. When the destination is not inside any existing
 * scope, it becomes one — otherwise resolveRepo would still answer null and
 * the launch could never continue.
 */
export async function cloneWorkspaceRepo(
  deps: CloneRepoDeps,
  workspace: Workspace,
  repo: string,
  destinationDir: string
): Promise<CloneRepoResult> {
  const provider = workspace.provider;
  if (!provider) {
    return { ok: false, error: 'This workspace has no provider account bound.' };
  }
  if (!fs.existsSync(destinationDir)) {
    return { ok: false, error: `Destination not found: ${destinationDir}` };
  }
  const name = repo.split('/').pop() ?? repo;
  const target = path.join(destinationDir, name);
  if (fs.existsSync(target)) {
    return { ok: false, error: `${target} already exists.` };
  }

  try {
    const driver = deps.resolveDriver(provider.id);
    const env = await deps.composeEnv(driver, provider.accountLogin);
    await driver.cloneRepo(repo, target, env);
  } catch (error) {
    // The driver already surfaces its CLI's stderr as the message.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const covered = workspace.scopes.some(
    (scope) => target === scope.path || target.startsWith(scope.path + path.sep)
  );
  if (!covered) {
    try {
      deps.addScope(workspace.id, destinationDir);
    } catch (error) {
      // The clone already landed on disk; a scope-add failure (e.g. an
      // unknown workspace id) must not be reported as if nothing happened.
      // Name the path so the user can find and register it by hand.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Cloned to ${target}, but could not add ${destinationDir} as a scope: ${message}`,
      };
    }
  }
  return { ok: true, path: target };
}
```

Run: `npx vitest run src/main/providers/cloneRepo.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 10: Delete the old parser and run the suite**

```bash
git rm src/main/github/parseInbox.ts
ls src/main/github
```

Expected listing: only `GhBroker.ts` remains (Task 11 removes it).

Run: `npm test`
Expected: 45 files, 538 tests pass (533 − 8 − 14 − 6 old service/launch/clone cases + 9 + 16 + 8 new).

Run: `npx tsc -p tsconfig.main.json --noEmit 2>&1 | grep 'src/main/providers/' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no `src/main/providers/` lines.

- [ ] **Step 11: Commit**

```bash
git add -A src/main/providers src/main/github
git commit -m "refactor: inbox, launch and clone go through the provider driver" -m "InboxService (was GitHubService), launchWorkItem and cloneWorkspaceRepo now take a driver through their deps and never name gh or GitHub: the inbox is driver.fetchInbox, the clone is driver.cloneRepo, the seed prompt is driver.seedHeader plus the item type's default body, and an unknown provider id degrades like any other failure. Their tests run against a stub driver, which is the proof the seam holds. A launched session now records the action name it started as, matching what the v7 migration wrote.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `WorktreeService` delegates checkout and remote matching to the driver

**Files:**
- Modify: `src/main/WorktreeService.ts` (imports `:1-7`; delete `normalizeRemote` `:11-30`; class doc, cache and constructor `:38-57`; `resolveRepo` `:63-75`; `originOf` `:91-106`; `ensureWorktree` doc and PR branch `:147-198`)
- Modify: `src/main/WorktreeService.test.ts` (drop the `normalizeRemote` block; v7 fixture; `CONSOLA_GH_PATH` in `beforeEach`; constructor calls; three new cases)

**Interfaces:**
- Consumes: `getProviderDriver`, `GitProviderDriver` (Task 6); `GitProviderId` (Task 1); `WorkItemRef` from `src/shared/workItems.ts`; `Workspace` (Task 3).
- Produces: `class WorktreeService { constructor(root?: string, resolveDriver?: (id: GitProviderId) => GitProviderDriver) }` — `resolveRepo`, `ensureWorktree`, `prune`, `invalidate` keep their signatures; `worktreeDirName` unchanged; `normalizeRemote` is gone. `resolveRepo` returns `null` for a workspace with no provider binding or an unknown provider id.

- [ ] **Step 1: Rewrite the test file's head — imports, fixture, env, and the `normalizeRemote` block's removal**

In `src/main/WorktreeService.test.ts`, replace lines 1–7 (the imports) with:

```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemRef } from '../shared/workItems';
import type { Scope, Workspace } from '../shared/workspace';
import { getProviderDriver, type GitProviderDriver } from './providers';
import { WorktreeService, worktreeDirName } from './WorktreeService';

const STUB_GH = path.resolve(__dirname, '../../tests/fixtures/stub-gh/gh');

// The service resolves its driver from the registry, and the GitHub driver
// resolves `gh` through CONSOLA_GH_PATH on every call — so pointing that at
// the fixture is the whole test seam, exactly as the Playwright rig does it.
beforeEach(() => {
  process.env.CONSOLA_GH_PATH = STUB_GH;
});

afterEach(() => {
  delete process.env.CONSOLA_GH_PATH;
});
```

Replace `makeWorkspace` (lines 35–48) with a v7 fixture that needs no cast:

```ts
function makeWorkspace(scopes: Scope[], overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes,
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
```

Delete the whole `describe('normalizeRemote', ...)` block (lines 50–76) — those cases moved to `GitHubDriver.test.ts` in Task 6. Delete the later `const STUB_GH = ...` line (line 148), now declared at the top.

- [ ] **Step 2: Rewrite the constructor calls and add the new cases**

In `describe('WorktreeService.resolveRepo', ...)`, every `new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh')` becomes `new WorktreeService(tmpDir('consola-wt-root-'))`. Then append two cases inside that block:

```ts
  it('resolves nothing for a workspace without a provider binding', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const workspace = makeWorkspace([makeScope(repoScope, true)], { provider: undefined });

    // Which URLs count as this repo is the provider's call; with no
    // provider there is nothing to match against.
    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });

  it('resolves nothing, rather than throwing, when the provider is unknown to this build', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), () => {
      throw new Error('Unknown git provider "gitlab".');
    });
    const workspace = makeWorkspace([makeScope(repoScope, true)]);

    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });
```

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: FAIL — `resolveRepo` matches `sympower/controller-app` for the unbound workspace (the service still parses remotes itself) and the unknown-provider case throws nothing because the second constructor argument is still `ghBinary`.

- [ ] **Step 3: Delegate in `src/main/WorktreeService.ts`**

Replace the imports (lines 1–7) with:

```ts
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { GitProviderId } from '../shared/providers';
import type { WorkItemRef } from '../shared/workItems';
import type { Workspace } from '../shared/workspace';
import { getProviderDriver, type GitProviderDriver } from './providers';
```

Delete `normalizeRemote` (its doc comment and function, lines 11–30). Then replace the class doc, the cache field and the constructor (lines 38–57) with:

```ts
/**
 * Owns work-item worktrees under ~/.consola/worktrees/ and the mapping from
 * remote repos to local clones.
 *
 * The mapping scans the workspace's scopes: a repo scope matches on its origin
 * remote; a container scope scans its direct children. Whether a remote URL
 * names a repo is the provider's call (host, casing), so matching goes
 * through the workspace's driver; the raw URL is what gets cached — per
 * directory, invalidated when scopes change (wired to
 * WorkspaceService.onChange) — because a `git remote get-url` per directory
 * per scan would otherwise run on every Inbox paint, and a cached
 * provider-derived value would go stale if the binding changed.
 */
export class WorktreeService {
  /** Directory -> raw origin remote URL (or null for non-repos). */
  private readonly remoteCache = new Map<string, string | null>();

  constructor(
    private readonly root: string = process.env.CONSOLA_WORKTREES_DIR ??
      path.join(os.homedir(), '.consola', 'worktrees'),
    private readonly resolveDriver: (id: GitProviderId) => GitProviderDriver = getProviderDriver
  ) {}
```

Replace `resolveRepo` (lines 63–75) with:

```ts
  /**
   * Local clone for a remote repo, found through the workspace's scopes.
   *
   * An unbound workspace — or one bound to a provider this build lacks — has
   * nothing to match against and resolves nothing; the launch path then
   * offers the clone flow, which reports the real reason.
   */
  public resolveRepo(workspace: Workspace, repo: string): string | null {
    const driver = this.driverFor(workspace);
    if (!driver) return null;
    for (const scope of workspace.scopes) {
      if (this.matches(driver, scope.path, repo)) return scope.path;
      if (!scope.isGitRepo) {
        for (const child of this.childDirs(scope.path)) {
          if (this.matches(driver, child, repo)) return child;
        }
      }
    }
    return null;
  }

  private driverFor(workspace: Workspace): GitProviderDriver | null {
    const provider = workspace.provider;
    if (!provider) return null;
    try {
      return this.resolveDriver(provider.id);
    } catch {
      return null; // A provider this build lacks: nothing can match, so nothing does.
    }
  }

  private matches(driver: GitProviderDriver, dir: string, repo: string): boolean {
    const origin = this.originOf(dir);
    return origin !== null && driver.matchesRemote(origin, repo);
  }
```

Replace `originOf` (lines 91–106) with:

```ts
  private originOf(dir: string): string | null {
    const cached = this.remoteCache.get(dir);
    if (cached !== undefined) return cached;
    let origin: string | null = null;
    try {
      origin =
        execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || null;
    } catch {
      origin = null; // Not a repo, or no origin — either way, not a match.
    }
    this.remoteCache.set(dir, origin);
    return origin;
  }
```

In the `ensureWorktree` doc comment, replace the last paragraph:

```ts
   * PRs: `git worktree add --detach`, then the provider's checkout inside it
   * (for GitHub, `gh pr checkout <n>` — gh owns the branch naming and the
   * fetch, with the token in `env`). Issues: a `consola/issue-<n>` branch,
   * created on first use, reused after; there is nothing remote to fetch.
```

and in the PR branch of `ensureWorktree`, replace the `try` body:

```ts
      try {
        await this.resolveDriver(workItem.provider).checkout(dir, workItem, env);
      } catch (error) {
        await this.removeCreatedWorktree(clonePath, dir);
        throw error;
      }
```

(`resolveDriver` is inside the `try` on purpose: an unknown provider must unwind the worktree it just added, exactly like a failed checkout.)

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: PASS — every original `ensureWorktree` and `prune` case, the `resolveRepo` cases, and the two new ones (the fixture `gh` is reached through `CONSOLA_GH_PATH`).

- [ ] **Step 4: Prove a second launch on the same item skips the checkout**

The spec's "one worktree per work item, shared by all its sessions" rests on this. In `describe('WorktreeService.ensureWorktree', ...)`, change `setup()` to accept a driver resolver and add a counting wrapper above it:

```ts
  /**
   * The real GitHub driver with its checkout counted. Every method is
   * forwarded explicitly: spreading a class instance would drop its
   * prototype methods.
   */
  function countingDriver(): { driver: GitProviderDriver; checkout: ReturnType<typeof vi.fn> } {
    const real = getProviderDriver('github');
    const checkout = vi.fn((dir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv) =>
      real.checkout(dir, ref, env)
    );
    const driver: GitProviderDriver = {
      id: real.id,
      tokenEnvVar: real.tokenEnvVar,
      probe: () => real.probe(),
      token: (login) => real.token(login),
      fetchInbox: (binding, env) => real.fetchInbox(binding, env),
      checkout,
      cloneRepo: (repo, destination, env) => real.cloneRepo(repo, destination, env),
      matchesRemote: (url, repo) => real.matchesRemote(url, repo),
      workItemUrl: (ref) => real.workItemUrl(ref),
      seedHeader: (ref, item) => real.seedHeader(ref, item),
    };
    return { driver, checkout };
  }

  function setup(resolveDriver?: (id: GitProviderId) => GitProviderDriver) {
    const clone = path.join(tmpDir('consola-wt-clone-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const root = tmpDir('consola-wt-worktrees-');
    const service = new WorktreeService(root, resolveDriver);
    return { clone, root, service };
  }
```

(add `import type { GitProviderId } from '../shared/providers';` to the test's imports). Every other `new WorktreeService(..., async () => STUB_GH)` in the file becomes `new WorktreeService(<root>)`. Then add, after the "is idempotent" case:

```ts
  it('a second launch on the same item returns the same directory without a second checkout', async () => {
    const { driver, checkout } = countingDriver();
    const { clone, service } = setup(() => driver);

    const first = await service.ensureWorktree(clone, pr51, { ...process.env });
    const second = await service.ensureWorktree(clone, pr51, { ...process.env });

    // Shared by every session on the item: the fast path must not re-run the
    // provider's checkout, which would reset a branch someone is working on.
    expect(second).toBe(first);
    expect(checkout).toHaveBeenCalledTimes(1);
  }, 30_000);
```

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: PASS (18 tests: 7 `resolveRepo`, 1 `worktreeDirName`, 8 `ensureWorktree`, 2 `prune` — the 4 `normalizeRemote` cases are gone).

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: 45 files, 537 tests pass (538 − 4 moved `normalizeRemote` cases + 3 new).

```bash
git add src/main/WorktreeService.ts src/main/WorktreeService.test.ts
git commit -m "refactor: WorktreeService asks the provider driver to check out and to match remotes" -m "The PR path's gh pr checkout and the owner/name parsing were the last gh-shaped code outside the driver. The worktree mechanics — add, prune, the common-dir check, the issue branch — stay here; the driver decides which remote URLs name a repo (GitHub now insists on the github.com host) and how a PR is fetched into a detached worktree. The cache holds the raw remote URL, never a provider-derived value, so a changed binding cannot leave it stale.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `TerminalService` and `SessionLauncher` borrow the token through the driver

**Files:**
- Modify: `src/main/TerminalService.ts` (`:9` import; `:78-83` options; `:225` and `:248-251` in `initClaude`; `:321-343` `borrowGhToken`)
- Modify: `src/main/SessionLauncher.ts:130-133`
- Modify: `src/main/SessionLauncher.test.ts:30` (fixture) and `:116` (assertion)
- Unchanged: `src/main/TerminalService.test.ts` — it mocks `./LoginEnvironment` and `./drivers`, passes no provider fields, and so never borrows a token.

**Interfaces:**
- Consumes: `getProviderDriver`, `layerProviderToken` (Task 6); `PROVIDER_META`, `isGitProviderId`, `GitProviderId` (Task 1); `Workspace.provider` (Task 3).
- Produces: `TerminalServiceOptions.providerId?: GitProviderId` and `TerminalServiceOptions.providerAccountLogin?: string` (replacing `githubAccountLogin`); both call sites that build these options — `SessionLauncher.launchSession` here, `TERMINAL_CREATE` in Task 11 — resolve them from `workspace.provider`.

- [ ] **Step 1: Update the launcher test's fixture and assertion**

In `src/main/SessionLauncher.test.ts`, replace the fixture line `github: { accountLogin: 'octocat' },` with:

```ts
        provider: { id: 'github', accountLogin: 'octocat' },
        actions: [],
        sectionDefaults: {},
```

and in the first test's `expect.objectContaining({ ... })`, replace `githubAccountLogin: 'octocat',` with:

```ts
                providerId: 'github',
                providerAccountLogin: 'octocat',
```

Run: `npx vitest run src/main/SessionLauncher.test.ts`
Expected: FAIL — `startHeadless` is called with `githubAccountLogin: undefined` and neither provider field.

- [ ] **Step 2: Resolve the binding in `src/main/SessionLauncher.ts`**

Replace lines 130–133 (the comment and the `githubAccountLogin` line inside `startHeadless`'s options) with:

```ts
            // The workspace's provider binding, resolved here the same way the
            // TERMINAL_CREATE handler resolves it: TerminalService turns the
            // login into a token at spawn time, under the driver's variable.
            providerId: workspace.provider?.id,
            providerAccountLogin: workspace.provider?.accountLogin,
```

`SessionRecordStore.updateSession`'s `Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>` stays as it is: it is a structural slice the launcher needs, and `WorkspaceService.updateSession`'s wider `SessionUpdates` (Task 10) still satisfies it.

Run: `npx vitest run src/main/SessionLauncher.test.ts`
Expected: PASS (6 tests) once `TerminalServiceOptions` accepts the fields — which is Step 3; until then vitest passes (it does not typecheck) and `tsc` reports the two unknown properties.

- [ ] **Step 3: Borrow through the driver in `src/main/TerminalService.ts`**

Replace line 9:

```ts
import { ghBroker, layerGhToken } from './github/GhBroker';
```

with:

```ts
import { PROVIDER_META, isGitProviderId, type GitProviderId } from '../shared/providers';
import { getProviderDriver, layerProviderToken } from './providers';
```

Replace the `githubAccountLogin` member of `TerminalServiceOptions` (lines 78–83, doc comment included) with:

```ts
    /**
     * Provider whose token this session's PTY gets, and as which account.
     * Resolved from the workspace's binding by whoever builds these options;
     * both absent for workspaces without a binding, which then spawn exactly
     * as before. The variable the token lands in is the driver's to name.
     */
    providerId?: GitProviderId;
    providerAccountLogin?: string;
```

In `initClaude`, replace `const ghToken = await this.borrowGhToken();` with:

```ts
        const borrowed = await this.borrowProviderToken();
```

and the spawn's `env:` expression with:

```ts
                env: layerProviderToken(
                    this.driver.composeEnv(this.harness, getLoginEnv()),
                    borrowed?.envVar ?? null,
                    borrowed?.token ?? null
                ) as { [key: string]: string },
```

Replace `borrowGhToken` (its doc comment and body, lines 321–343) with:

```ts
    /**
     * The provider token for this session's workspace account, with the
     * variable it belongs in, or null.
     *
     * Null is the whole degradation story: no binding means no token and a
     * spawn identical to pre-v6 Consola. A binding whose token cannot be
     * borrowed — or whose provider this build lacks — also launches, but with
     * a visible notice, because an agent silently running the provider CLI
     * as whatever account happens to be active in its keyring is exactly the
     * cross-account accident bindings exist to prevent.
     */
    private async borrowProviderToken(): Promise<{ envVar: string; token: string } | null> {
        const { providerId, providerAccountLogin: login } = this.options;
        if (!providerId || !login) return null;
        try {
            const driver = getProviderDriver(providerId);
            return { envVar: driver.tokenEnvVar, token: await driver.token(login) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const meta = isGitProviderId(providerId) ? PROVIDER_META[providerId] : undefined;
            this.writeNotice(
                `Could not borrow a ${meta?.displayName ?? providerId} token for ${login}: ${message} ` +
                    `This session runs without one — check \`${meta?.cliName ?? providerId} auth status\`.`
            );
            return null;
        }
    }
```

- [ ] **Step 4: Run both test files and check main's remaining errors**

Run: `npx vitest run src/main/TerminalService.test.ts src/main/SessionLauncher.test.ts`
Expected: PASS (11 tests). `TerminalService.test.ts` now transitively imports `./providers` → `GitHubDriver` → `./LoginEnvironment`, which the file already mocks; no provider fields are passed, so no token is borrowed.

Run: `npx tsc -p tsconfig.main.json --noEmit 2>&1 | grep -v 'ipc-handlers.ts\|state/WorkspaceService.ts\|github/GhBroker.ts' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no lines — the only main-process errors left are in the three files Tasks 10 and 11 rewrite.

- [ ] **Step 5: Commit**

```bash
git add src/main/TerminalService.ts src/main/SessionLauncher.ts src/main/SessionLauncher.test.ts
git commit -m "refactor: PTYs borrow their provider token through the driver" -m "TerminalServiceOptions carries providerId and providerAccountLogin instead of a GitHub login; the token is borrowed from getProviderDriver(providerId) and layered under driver.tokenEnvVar, so the terminal layer no longer spells GH_TOKEN or imports the broker. Both option builders — SessionLauncher here, TERMINAL_CREATE next — read workspace.provider. A binding whose provider this build lacks degrades the same way a failed borrow always has: the session launches, with a notice.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: The mutable link, the provider binding and the actions write in `WorkspaceService`

**Files:**
- Modify: `src/main/state/updateFilters.ts` (`:1` import; delete `:74-76`; `:78-108` `allowedSessionUpdates`)
- Modify: `src/main/state/updateFilters.test.ts:224-242` (one case rewritten, two added)
- Modify: `src/main/state/WorkspaceService.ts` (imports `:1-16`; `setGitHubBinding` `:167-188` → `setProviderBinding` + `setActions`; `updateSession` `:277-295`)
- Modify: `src/main/state/WorkspaceService.test.ts:336-351` (`setGitHubBinding` case → `setProviderBinding` cases; `setActions` and `updateSession` cases added)

**Interfaces:**
- Consumes: `SessionUpdates`, `WorkspaceProvider`, `Workspace`, `Session` (Task 3); `WorkItemAction`, `createDefaultActions`, `createDefaultSectionDefaults`, `validateActionsWrite` (Task 2); `InboxSection` (Task 2); `sameWorkItem` (Task 1).
- Produces: `updateFilters.ts` re-exports `type SessionUpdates` and `allowedSessionUpdates` passes `workItem` through with presence semantics; `WorkspaceService.setProviderBinding(workspaceId, binding: WorkspaceProvider | null)`; `WorkspaceService.setActions(workspaceId, actions: WorkItemAction[], sectionDefaults: Partial<Record<InboxSection, string>>)` (throws the validation message, commits nothing); `WorkspaceService.updateSession(workspaceId, sessionId, updates: SessionUpdates)` (throws on linking a conductor or a session already linked elsewhere; unlinking also clears `workItemAction`).

- [ ] **Step 1: Rewrite the immutability case and add the presence cases**

In `src/main/state/updateFilters.test.ts`, replace the last test of `describe('allowedSessionUpdates', ...)` (`'drops scopeId, cwd, kind and workItem even alongside a legitimate field'`) with these three:

```ts
  it('drops scopeId, cwd and kind even alongside a legitimate field — but passes workItem through', () => {
    // The session's place, working directory and nature are fixed at
    // creation, exactly like harnessId and model: immutable by omission.
    // The work item is the one identity-adjacent field that moves: linking
    // a session to an item after the fact is an act of triage, not a change
    // of where or how it runs.
    const workItem = { provider: 'github', repo: 'a/b', type: 'pr', number: 1 } as const;
    const payload = {
      scopeId: 'other-scope',
      cwd: '/somewhere/else',
      kind: 'conductor',
      workItem,
      name: 'Legit rename',
    } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).not.toHaveProperty('scopeId');
    expect(result).not.toHaveProperty('cwd');
    expect(result).not.toHaveProperty('kind');
    expect(result.workItem).toEqual(workItem);
    expect(result.name).toBe('Legit rename');
  });

  it('preserves an explicit workItem: undefined as an own key, so unlinking reaches the service', () => {
    const result = allowedSessionUpdates({ workItem: undefined });

    // Same mechanism as groupId: presence separates "unlink" from "leave it".
    expect('workItem' in result).toBe(true);
    expect(result.workItem).toBeUndefined();
  });

  it('omits workItem entirely when the key is absent from the input', () => {
    expect('workItem' in allowedSessionUpdates({ name: 'Renamed' })).toBe(false);
  });
```

Run: `npx vitest run src/main/state/updateFilters.test.ts`
Expected: FAIL — the first and second new cases: `workItem` is dropped.

- [ ] **Step 2: Let `workItem` through in `src/main/state/updateFilters.ts`**

Replace line 1 with:

```ts
import type { Group, Scope, SessionUpdates, Workspace } from '../../shared/workspace';
import type { HarnessUpdates } from '../../shared/harness';

// The one definition lives in shared/workspace.ts; re-exported so the
// handlers keep importing the filter and its payload type from one place.
export type { SessionUpdates } from '../../shared/workspace';
```

(and delete the original second line, `import type { HarnessUpdates } ...`, which the block above now carries). Delete the local `SessionUpdates` type (lines 74–76). Replace the `allowedSessionUpdates` doc comment and function with:

```ts
/**
 * The ones that matter most: `harnessId` — and since v6 `scopeId`, `cwd`
 * and `kind` — are deliberately not on the list.
 *
 * A session's harness is fixed for its lifetime — the transcript lives inside
 * that harness's config directory and `--resume` only finds it there — so a
 * rewritten `harnessId` would silently orphan the conversation rather than
 * failing where anyone could see it. The scope, working directory and kind
 * are the session's identity in the same way: where it belongs, where it
 * runs, what drives it. `groupId` and, since v7, `workItem` are mutable —
 * regrouping and linking are acts of organisation and triage, not identity
 * changes — and both clear by presence. `id`, `workspaceId`, `instanceId`
 * and `claudeSessionId` name the session and its terminal; `createdAt` is
 * history.
 */
export function allowedSessionUpdates(updates: SessionUpdates): SessionUpdates {
    const allowed: SessionUpdates = {};
    // These three are required on the record and none is clearable, so
    // `undefined` can only ever be a bug: absence and explicit-undefined are
    // treated alike. Contrast groupId and workItem below, where `undefined`
    // is a value.
    if (updates.name !== undefined) allowed.name = updates.name;
    // Optional on the record but set-only in practice: `undefined` never
    // means "clear the flag", so it is treated like the required fields.
    if (updates.nameIsUserSet !== undefined) allowed.nameIsUserSet = updates.nameIsUserSet;
    if (updates.lastActiveAt !== undefined) allowed.lastActiveAt = updates.lastActiveAt;
    if (updates.hasStarted !== undefined) allowed.hasStarted = updates.hasStarted;
    // `undefined` IS the value here — "leave the group", "unlink from the
    // item". Structured clone preserves an explicitly-undefined key, so
    // presence is what separates "clear this" from "leave it alone".
    if ('groupId' in updates) allowed.groupId = updates.groupId;
    if ('workItem' in updates) allowed.workItem = updates.workItem;
    return allowed;
}
```

Run: `npx vitest run src/main/state/updateFilters.test.ts`
Expected: PASS (26 tests).

- [ ] **Step 3: Write the failing service cases**

In `src/main/state/WorkspaceService.test.ts`, add `import type { WorkItemAction } from '../../shared/workItemActions';` after the `Workspace` import, and replace the `'setGitHubBinding sets, replaces and clears the binding'` test with:

```ts
  it('setProviderBinding sets, replaces and clears the binding, seeding actions once', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    expect(workspace.actions).toEqual([]);

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'SymJavi', org: 'sympower' });
    const bound = service.getAll()[0];
    expect(bound.provider).toEqual({ id: 'github', accountLogin: 'SymJavi', org: 'sympower' });
    // Binding is what switches the Inbox on, so it is what seeds the verbs.
    expect(bound.actions.map((action) => action.name)).toEqual([
      'Review', 'Address review', 'Fix CI', 'Implement', 'Triage',
    ]);
    expect(Object.keys(bound.sectionDefaults).sort()).toEqual([
      'issues', 'needs-action', 'needs-team-review', 'needs-your-review', 'waiting',
    ]);

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'personal' });
    expect(service.getAll()[0].provider).toEqual({ id: 'github', accountLogin: 'personal' });
    // Rebinding keeps the actions the user may have edited since.
    expect(service.getAll()[0].actions).toEqual(bound.actions);

    service.setProviderBinding(workspace.id, null);
    // Absent, not null: absence is what "pure local workspace" means on disk.
    expect(service.getAll()[0]).not.toHaveProperty('provider');
    // Unbinding clears only the binding — the actions are the user's.
    expect(service.getAll()[0].actions).toEqual(bound.actions);
    expect(service.getAll()[0].sectionDefaults).toEqual(bound.sectionDefaults);

    const reloaded = build();
    expect(reloaded.getAll()[0]).not.toHaveProperty('provider');
    expect(reloaded.getAll()[0].actions).toEqual(bound.actions);
  });

  it('setProviderBinding does not reseed a workspace that already has actions', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const mine: WorkItemAction[] = [{ id: 'a1', name: 'Mine', appliesTo: ['pr'], prompt: 'Do the thing.' }];
    service.setActions(workspace.id, mine, { waiting: 'a1' });

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'SymJavi' });

    expect(service.getAll()[0].actions).toEqual(mine);
    expect(service.getAll()[0].sectionDefaults).toEqual({ waiting: 'a1' });
  });

  it('setActions replaces actions and defaults in one write and persists them', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const actions: WorkItemAction[] = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' },
      { id: 'a2', name: 'Triage', appliesTo: ['issue'], prompt: 'Triage it.' },
    ];

    service.setActions(workspace.id, actions, { 'needs-your-review': 'a1', issues: 'a2' });

    const reloaded = build().getAll()[0];
    expect(reloaded.actions).toEqual(actions);
    expect(reloaded.sectionDefaults).toEqual({ 'needs-your-review': 'a1', issues: 'a2' });
  });

  it('setActions rejects an invalid write with its message and commits nothing', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const listener = vi.fn();
    service.onChange(listener);
    const actions: WorkItemAction[] = [{ id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }];

    expect(() => service.setActions(workspace.id, actions, { issues: 'a1' })).toThrow(
      '"Review" cannot be the default for "issues": it does not apply to issues.'
    );

    expect(listener).not.toHaveBeenCalled();
    expect(service.getAll()[0].actions).toEqual([]);
  });

  it('setActions keeps only the record fields — an IPC payload cannot ride extra keys in', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const payload = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.', extra: 'nope' },
    ] as unknown as WorkItemAction[];

    service.setActions(workspace.id, payload, {});

    expect(service.getAll()[0].actions).toEqual([
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' },
    ]);
  });
```

Then add these cases after `'createSession returns undefined for an unknown scope'`:

```ts
  const pr51 = { provider: 'github' as const, repo: 'sympower/controller-app', type: 'pr' as const, number: 51 };
  const issue87 = { provider: 'github' as const, repo: 'sympower/msa-resource-bff', type: 'issue' as const, number: 87 };

  function sessionIn(workspace: Workspace, extra: Partial<Parameters<typeof service.createSession>[1]> = {}) {
    const session = service.createSession(workspace.id, {
      name: 'By hand',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: workspace.scopes[0].id,
      ...extra,
    });
    if (!session) throw new Error('fixture session was refused');
    return session;
  }

  it('updateSession links an unlinked session and unlinks it again', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace);

    service.updateSession(workspace.id, session.id, { workItem: pr51 });
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
    // Linking never records an action: the session was not started as one.
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItemAction');

    service.updateSession(workspace.id, session.id, { workItem: undefined });
    // Absent on disk, not undefined-valued: JSON.stringify drops the key.
    expect(build().getAll()[0].sessions[0]).not.toHaveProperty('workItem');
  });

  it('updateSession treats re-linking to the same item as a no-op success', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51 });
    const listener = vi.fn();
    service.onChange(listener);

    expect(() =>
      service.updateSession(workspace.id, session.id, { workItem: { ...pr51, repo: 'Sympower/Controller-App' } })
    ).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
  });

  it('updateSession refuses to link a conductor session', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { kind: 'conductor' });

    expect(() => service.updateSession(workspace.id, session.id, { workItem: pr51 })).toThrow(
      'A conductor session cannot be linked to a work item.'
    );
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItem');
  });

  it('updateSession refuses to link a session already linked to a different item', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51 });

    expect(() => service.updateSession(workspace.id, session.id, { workItem: issue87 })).toThrow(
      /already linked to sympower\/controller-app pr #51/
    );
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
  });

  it('updateSession unlinking a launched session drops its action label with it', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51, workItemAction: 'Review' });

    service.updateSession(workspace.id, session.id, { workItem: undefined });

    // The label described a launch this session no longer belongs to.
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItem');
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItemAction');
  });
```

Run: `npx vitest run src/main/state/WorkspaceService.test.ts`
Expected: FAIL — `setProviderBinding` and `setActions` are not functions; the link refusals do not throw; the label survives an unlink.

- [ ] **Step 4: Implement the three doors in `src/main/state/WorkspaceService.ts`**

Replace the import block (lines 1–16) with:

```ts
import { JsonStateFile } from './JsonStateFile';
import type { InboxSection } from '../../shared/inboxSections';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  validateActionsWrite,
  type WorkItemAction,
} from '../../shared/workItemActions';
import { sameWorkItem } from '../../shared/workItems';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createGroupRecord,
  createScopeRecord,
  createSessionRecord,
  createWorkspaceRecord,
  migrateWorkspaceState,
  type Group,
  type NewGroupFields,
  type NewScopeFields,
  type NewSessionFields,
  type Scope,
  type Session,
  type SessionUpdates,
  type Workspace,
  type WorkspaceProvider,
} from '../../shared/workspace';
```

Replace `setGitHubBinding` (its doc comment and body, lines 167–188) with:

```ts
  /**
   * Bind this workspace to a provider account, or unbind with null.
   *
   * Unbinding removes the key entirely rather than storing null: an absent
   * `provider` is what "pure local workspace, today's behavior" means, and
   * every reader tests for absence. Only the binding goes — actions and
   * section defaults are the user's and survive an unbind and a rebind.
   * Binding a workspace that has no actions yet seeds the defaults, so the
   * Inbox has verbs to offer on first paint; one that already has some
   * keeps them, edits included.
   */
  public setProviderBinding(workspaceId: string, binding: WorkspaceProvider | null): void {
    this.commit(
      this.workspaces.map((candidate) => {
        if (candidate.id !== workspaceId) return candidate;
        if (binding === null) {
          const { provider: _provider, ...rest } = candidate;
          return { ...rest, updatedAt: Date.now() };
        }
        const seed = candidate.actions.length === 0;
        const actions = seed ? createDefaultActions() : candidate.actions;
        return {
          ...candidate,
          provider: binding,
          actions,
          sectionDefaults: seed ? createDefaultSectionDefaults(actions) : candidate.sectionDefaults,
          updatedAt: Date.now(),
        };
      })
    );
  }

  /**
   * Replace a workspace's actions and section defaults in one validated
   * write. The whole write is rejected on the first problem — the panel
   * shows the message inline — and nothing is committed. Records are rebuilt
   * from the allow-list of fields, updateFilters-style: this payload arrives
   * over IPC and is persisted verbatim.
   */
  public setActions(
    workspaceId: string,
    actions: WorkItemAction[],
    sectionDefaults: Partial<Record<InboxSection, string>>
  ): void {
    const verdict = validateActionsWrite({ actions, sectionDefaults });
    if (!verdict.ok) throw new Error(verdict.message);
    const records: WorkItemAction[] = actions.map(({ id, name, appliesTo, prompt }) => ({
      id,
      name,
      appliesTo: [...appliesTo],
      prompt,
    }));
    const defaults: Partial<Record<InboxSection, string>> = {};
    for (const [section, actionId] of Object.entries(sectionDefaults)) {
      if (actionId !== undefined) defaults[section as InboxSection] = actionId;
    }
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? { ...candidate, actions: records, sectionDefaults: defaults, updatedAt: Date.now() }
          : candidate
      )
    );
  }
```

Replace `updateSession` (lines 277–295) with:

```ts
  /**
   * Apply an already-filtered update (see allowedSessionUpdates).
   *
   * Linking is the one update with rules of its own: a conductor is never
   * about a work item, and a session already linked elsewhere must be
   * unlinked first — silently moving it would rewrite what the session is
   * about underneath a running agent. Re-linking to the same item changes
   * nothing and is left alone. Unlinking always succeeds and takes the
   * action label with it: the label described a launch this session no
   * longer belongs to. Both clear as absence, the way restoreGroup does.
   */
  public updateSession(workspaceId: string, sessionId: string, updates: SessionUpdates): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === sessionId);
    if (session && updates.workItem !== undefined) {
      if (session.kind === 'conductor') {
        throw new Error('A conductor session cannot be linked to a work item.');
      }
      if (session.workItem && sameWorkItem(session.workItem, updates.workItem)) return;
      if (session.workItem) {
        const { repo, type, number } = session.workItem;
        throw new Error(`This session is already linked to ${repo} ${type} #${number}. Unlink it first.`);
      }
    }
    const unlinking = 'workItem' in updates && updates.workItem === undefined;
    this.commit(
      this.workspaces.map((candidate) =>
        candidate.id === workspaceId
          ? {
              ...candidate,
              sessions: candidate.sessions.map((existing) =>
                existing.id === sessionId
                  ? { ...existing, ...updates, ...(unlinking ? { workItemAction: undefined } : {}) }
                  : existing
              ),
              updatedAt: Date.now(),
            }
          : candidate
      )
    );
  }
```

- [ ] **Step 5: Run the state tests, the suite, and commit**

Run: `npx vitest run src/main/state`
Expected: PASS — `WorkspaceService.test.ts` 35 tests, `updateFilters.test.ts` 26.

Run: `npm test`
Expected: 45 files, 548 tests pass.

Run: `npx tsc -p tsconfig.main.json --noEmit 2>&1 | grep -v 'ipc-handlers.ts' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no lines — `ipc-handlers.ts` is the last red file in main.

```bash
git add src/main/state/updateFilters.ts src/main/state/updateFilters.test.ts src/main/state/WorkspaceService.ts src/main/state/WorkspaceService.test.ts
git commit -m "feat: mutable work-item link, provider binding and validated actions write" -m "workItem joins groupId on the session allow-list with presence semantics; the service refuses to link a conductor or a session already linked elsewhere, treats a same-item re-link as a no-op, and drops the action label on unlink. setProviderBinding replaces setGitHubBinding, seeding the default actions only for a workspace that has none, and unbinding removes just the binding. setActions is the one door for actions and section defaults: validated as a whole, rebuilt from the record's fields, committed or rejected together.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Rewire `ipc-handlers.ts`; retire `src/main/github/`

**Files:**
- Modify: `src/main/ipc-handlers.ts` (imports `:12-17`, `:30`, `:42-49`; module state `:70-73`; `WORKSPACE_SESSION_UPDATE` `:185-193`; `WORKSPACE_SET_GITHUB_BINDING` `:227-241`; the gh/inbox block `:312-435`; `TERMINAL_CREATE` `:558-564` and `:597`; the GitHub queries section `:656-660`; `cleanupIpcHandlers` `:1238`, `:1252-1263`, `:1287-1288`)
- Delete: `src/main/github/GhBroker.ts` (and with it the now-empty `src/main/github/` directory)

**Interfaces:**
- Consumes: `getProviderDriver`, `composeProviderEnv` (Task 6); `InboxService` (Task 7); `createLaunchCoalescer`, `WorkItemLaunchDeps`, `cloneWorkspaceRepo` (Task 7); `WorktreeService` (Task 8); `isValidWorkItemRef`, `InboxSnapshot`, `WorkItemRef` (Task 1); `isGitProviderId`, `GitProviderId` (Task 1); `WorkItemAction` (Task 2); `InboxSection` (Task 2); `WorkspaceProvider` (Task 3); `IPC_CHANNELS.PROVIDER_*`, `INBOX_*`, `WORKSPACE_SET_PROVIDER_BINDING`, `WORKSPACE_SET_ACTIONS` (Task 4); `WorkspaceService.setProviderBinding` / `setActions` / `updateSession` (Task 10); `TerminalServiceOptions.providerId` / `providerAccountLogin` (Task 9).
- Produces: every main-side handler behind the channels in Global Constraints; `PROVIDER_PROBE` answers `{ available: false, accounts: [], error }` for an unknown id rather than rejecting; `WORKSPACE_SESSION_UPDATE` rejects a malformed link with `Invalid work item reference.`; `WORKSPACE_SET_PROVIDER_BINDING` rejects an unknown provider id. After this task `npx tsc -p tsconfig.main.json --noEmit` is clean.

This file has no vitest of its own (it needs Electron); its proof is main's typecheck going green and, in Task 14, the unchanged e2e spec.

- [ ] **Step 1: Swap the imports and module state**

Replace lines 12–17:

```ts
import { composeProviderEnv, getProviderDriver } from './providers';
import { InboxService } from './providers/InboxService';
import { createLaunchCoalescer, type WorkItemLaunchDeps } from './providers/launchWorkItem';
import { cloneWorkspaceRepo } from './providers/cloneRepo';
import { WorktreeService } from './WorktreeService';
```

(`getLoginEnv` is no longer imported here — `composeProviderEnv` owns that.) Replace line 30 (`import type { InboxSnapshot, WorkItemRef } from '../shared/github';`) with:

```ts
import type { InboxSection } from '../shared/inboxSections';
import { isGitProviderId, type GitProviderId } from '../shared/providers';
import type { WorkItemAction } from '../shared/workItemActions';
import { isValidWorkItemRef, type InboxSnapshot, type WorkItemRef } from '../shared/workItems';
```

Add `WorkspaceProvider,` after `Workspace,` in the `import type { ... } from '../shared/workspace'` block (lines 42–49). Replace the module-level state comment and declarations (lines 70–73) with:

```ts
// Provider organs: one inbox fetcher, one worktree owner — both main-side.
// The drivers themselves live in the registry under ./providers.
let inboxService: InboxService | null = null;
let worktreeService: WorktreeService | null = null;
```

- [ ] **Step 2: Validate the link and rename the binding door; add the actions door**

Replace the `WORKSPACE_SESSION_UPDATE` handler (lines 185–193) with:

```ts
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SESSION_UPDATE,
        (_event, workspaceId: string, sessionId: string, updates: SessionUpdates) => {
            // Filtering lives in updateFilters.ts, tested there: `harnessId` is
            // the field this keeps out, and `Partial<Pick<...>>` is gone by the
            // time a payload crosses IPC. A link carries a whole object, so its
            // shape is checked here too — the service assumes a real ref.
            if (updates.workItem !== undefined && !isValidWorkItemRef(updates.workItem)) {
                throw new Error('Invalid work item reference.');
            }
            workspaces.updateSession(workspaceId, sessionId, allowedSessionUpdates(updates));
        }
    );
```

Replace the `WORKSPACE_SET_GITHUB_BINDING` handler (lines 227–241) with:

```ts
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING,
        (_event, workspaceId: string, binding: WorkspaceProvider | null) => {
            // Rebuilt from an allow-list, updateFilters-style: IPC can deliver
            // any shape, and this object is persisted verbatim. An unknown
            // provider id is refused here, before it can reach disk.
            if (binding !== null && !isGitProviderId(binding.id)) {
                throw new Error(`Unknown git provider "${String(binding.id)}".`);
            }
            workspaces.setProviderBinding(
                workspaceId,
                binding === null
                    ? null
                    : {
                          id: binding.id,
                          accountLogin: String(binding.accountLogin),
                          ...(binding.org ? { org: String(binding.org) } : {}),
                      }
            );
        }
    );

    // One validated write for actions and their section defaults. The
    // service rebuilds the records and rejects the whole payload on the
    // first problem, so the panel can show the message inline.
    ipcMain.handle(
        IPC_CHANNELS.WORKSPACE_SET_ACTIONS,
        (
            _event,
            workspaceId: string,
            actions: WorkItemAction[],
            sectionDefaults: Partial<Record<InboxSection, string>>
        ) => workspaces.setActions(workspaceId, actions, sectionDefaults)
    );
```

- [ ] **Step 3: Replace the gh/inbox block with the provider organs**

Replace everything from the `// The gh binary, resolved once.` comment (line 312) through the end of the `GITHUB_CLONE_REPO` handler (line 435) with:

```ts
    const worktrees = new WorktreeService();
    worktreeService = worktrees;
    // The remote->path map is only as fresh as the scope list that feeds it.
    workspaces.onChange(() => worktrees.invalidate());

    const inbox = new InboxService({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        getBoundWorkspaceIds: () =>
            workspaces.getAll().filter((workspace) => workspace.provider).map((workspace) => workspace.id),
        resolveDriver: getProviderDriver,
        // Login env plus this account's token — composed in main and only in
        // main, so a token never crosses IPC and never lands in a
        // renderer-bound payload.
        composeEnv: composeProviderEnv,
        broadcast: (snapshot: InboxSnapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CHANNELS.INBOX_CHANGED, snapshot);
                }
            }
        },
    });
    inboxService = inbox;
    inbox.start();
    onBrowserWindowFocus = () => inbox.onWindowFocus();
    app.on('browser-window-focus', onBrowserWindowFocus);

    // Cached snapshot, or null. Null also kicks a background refresh, so the
    // first Inbox open populates itself through the push channel.
    ipcMain.handle(IPC_CHANNELS.INBOX_GET, (_event, workspaceId: string) => {
        const snapshot = inbox.getSnapshot(workspaceId);
        if (!snapshot) void inbox.refresh(workspaceId);
        return snapshot;
    });

    ipcMain.handle(IPC_CHANNELS.INBOX_REFRESH, (_event, workspaceId: string) =>
        inbox.refresh(workspaceId)
    );

    // Is the provider's CLI installed, and which accounts does its keyring
    // hold? Tokens are deliberately not reachable over IPC. An id this build
    // does not know degrades to an unavailable result, never a rejection —
    // the binding panel renders it like a missing binary.
    ipcMain.handle(IPC_CHANNELS.PROVIDER_PROBE, (_event, id: GitProviderId) => {
        if (!isGitProviderId(id)) {
            return { available: false, accounts: [], error: `Unknown git provider "${String(id)}".` };
        }
        return getProviderDriver(id).probe();
    });

    // Which of these remote repos have a local clone in this workspace's
    // scopes — the Inbox uses it to label buttons ("Review" vs "Clone into
    // scope..."), read-only and token-free.
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_RESOLVE_REPOS,
        (_event, workspaceId: string, repos: string[]) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const resolved: Record<string, string | null> = {};
            for (const repo of repos) {
                resolved[repo] = workspace ? worktrees.resolveRepo(workspace, repo) : null;
            }
            return resolved;
        }
    );

    // One click on an Inbox item. Worktree first, record second; the spawn is
    // third and happens when the renderer mounts the session pane — the same
    // terminal-create path every session uses.
    const launchWorkItemDeps: WorkItemLaunchDeps = {
        getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
        createSession: (id, fields) => workspaces.createSession(id, fields),
        resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
        ensureWorktree: (clonePath, item, env) => worktrees.ensureWorktree(clonePath, item, env),
        composeEnv: composeProviderEnv,
        findItem: (id, ref) => inbox.findItem(id, ref),
        pathExists: (target) => fs.existsSync(target),
        resolveDriver: getProviderDriver,
    };
    // Coalesced (not just called directly) so two overlapping launches of the
    // same work item can never mint two sessions for it — see
    // createLaunchCoalescer's doc comment.
    const launchWorkItem = createLaunchCoalescer(launchWorkItemDeps);
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM,
        (_event, workspaceId: string, workItem: WorkItemRef) =>
            launchWorkItem(workspaceId, workItem)
    );

    // "Clone into scope..." — the destination the user picked becomes the
    // clone's container. isGitRepo: false is load-bearing: resolveRepo only
    // scans a non-repo scope's children, and the clone lands one level down
    // (destinationDir/<repo-basename>), never at destinationDir itself.
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_CLONE_REPO,
        async (_event, workspaceId: string, repo: string, destinationDir: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            if (!workspace) return { ok: false, error: `Unknown workspace: ${workspaceId}` };
            const result = await cloneWorkspaceRepo(
                {
                    resolveDriver: getProviderDriver,
                    composeEnv: composeProviderEnv,
                    addScope: (id, dirPath) => {
                        workspaces.addScope(id, {
                            name: path.basename(dirPath),
                            path: dirPath,
                            isGitRepo: false,
                        });
                    },
                },
                workspace,
                repo,
                destinationDir
            );
            // A fresh clone changes what resolveRepo can find, scope or not.
            if (result.ok) worktreeService?.invalidate();
            return result;
        }
    );
```

- [ ] **Step 4: Resolve the provider in `TERMINAL_CREATE` and drop the GitHub queries section**

In the `TERMINAL_CREATE` handler, replace the comment and lookup (lines 558–564):

```ts
        // The workspace's provider binding, resolved here because this file
        // owns the workspace records. TerminalService turns the login into a
        // token at spawn time, under the driver's variable; the renderer
        // never sees either step.
        const workspace = workspaces
            .getAll()
            .find((candidate) => candidate.id === workspaceId);
        const providerId = workspace?.provider?.id;
        const providerAccountLogin = workspace?.provider?.accountLogin;
```

and in the `manager.ensure(instanceId, { ... })` options, replace `githubAccountLogin,` with:

```ts
            providerId,
            providerAccountLogin,
```

Delete the `// === GitHub queries ===` section (lines 656–660: the heading, the two comment lines and the `GH_PROBE` handler) — `PROVIDER_PROBE` in Step 3 replaced it.

- [ ] **Step 5: Rename the cleanup**

In `cleanupIpcHandlers`, replace `ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_GITHUB_BINDING);` with:

```ts
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING);
    ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET_ACTIONS);
```

Replace the block from `githubService?.stop();` through `ipcMain.removeHandler(IPC_CHANNELS.GITHUB_CLONE_REPO);` (lines 1252–1263) with:

```ts
    inboxService?.stop();
    inboxService = null;
    worktreeService = null;
    if (onBrowserWindowFocus) {
        app.removeListener('browser-window-focus', onBrowserWindowFocus);
        onBrowserWindowFocus = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_GET);
    ipcMain.removeHandler(IPC_CHANNELS.INBOX_REFRESH);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_PROBE);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_RESOLVE_REPOS);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM);
    ipcMain.removeHandler(IPC_CHANNELS.PROVIDER_CLONE_REPO);
```

and delete the two lines `// Remove GitHub query handlers` / `ipcMain.removeHandler(IPC_CHANNELS.GH_PROBE);` (lines 1287–1288).

- [ ] **Step 6: Retire the broker, typecheck main, run the suite, commit**

```bash
git rm src/main/github/GhBroker.ts
test -d src/main/github && echo "src/main/github still exists" || echo "src/main/github gone"
```

Expected: `src/main/github gone` (git removes the empty directory with its last file).

Run: `npx tsc -p tsconfig.main.json --noEmit ; echo "exit $?"`
Expected: `exit 0` — main and shared compile cleanly for the first time since Task 3.

Run: `grep -rn "github/\|GhBroker\|GitHubService\|githubAccountLogin\|GH_PROBE\|GITHUB_" src/main ; echo "exit $?"`
Expected: `exit 1` (no hits).

Run: `npm test`
Expected: 45 files, 548 tests pass.

```bash
git add src/main/ipc-handlers.ts
git add -A src/main/github
git commit -m "refactor: main wires the provider seam; src/main/github is gone" -m "ipc-handlers builds InboxService, WorktreeService, the launch coalescer and the clone flow from the provider registry and composeProviderEnv, so no closure here resolves gh or spells GH_TOKEN. The channels are provider:* and inbox:*; workspace:set-provider-binding refuses an unknown provider id, workspace:set-actions is the one validated write, and a link payload on workspace:session-update is shape-checked before it reaches the service. GhBroker.ts, the last file under src/main/github, goes with its last importer.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Preload and the renderer bridges

**Files:**
- Modify: `src/preload/preload.ts` (`:26-35` imports; `:117-145` the `githubAPI` block; `:175-180` `updateSession`; `:198-202` `setGitHubBinding`)
- Create: `src/renderer/services/inboxBridge.ts`, `src/renderer/services/providerBridge.ts`
- Delete: `src/renderer/services/githubBridge.ts`
- Modify: `src/renderer/services/workspaceBridge.ts` (`:1-15` imports; `:57-63` `updateSession`; `:86-91` `setGitHubBinding`)

**Interfaces:**
- Consumes: `InboxAPI`, `ProviderAPI`, `WorkspaceAPI` (Task 4); `IPC_CHANNELS` (Task 4); `SessionUpdates`, `WorkspaceProvider` (Task 3); `InboxSnapshot`, `WorkItemRef` (Task 1); `GitProviderId`, `ProviderProbeResult` (Task 1); `WorkItemAction`, `InboxSection` (Task 2).
- Produces: `window.inboxAPI` and `window.providerAPI` (preload); `inboxBridge` (`getInbox`, `refreshInbox`, `onInboxChanged`) and `providerBridge` (`probe(id)`, `resolveRepos`, `launchWorkItem`, `cloneRepo`) — null-guarded exactly like `githubBridge` was; `workspaceBridge.updateSession(workspaceId, sessionId, updates: SessionUpdates)`, `workspaceBridge.setProviderBinding(workspaceId, binding: WorkspaceProvider | null)`, `workspaceBridge.setActions(workspaceId, actions, sectionDefaults)`. After this task `npx tsc -p tsconfig.preload.json --noEmit` is clean; the renderer stays red until Task 14.

No vitest here: preload runs only under Electron, and the bridges are one-line pass-throughs whose behaviour `inboxStore.test.ts` (Task 13) exercises through mocks. The proof is the preload typecheck.

- [ ] **Step 1: Rewire `src/preload/preload.ts`**

Replace lines 26–35 (the `../shared/github` and `../shared/workspace` type imports) with:

```ts
import type { InboxSection } from '../shared/inboxSections';
import type { GitProviderId, ProviderProbeResult } from '../shared/providers';
import type { WorkItemAction } from '../shared/workItemActions';
import type { InboxSnapshot, WorkItemRef } from '../shared/workItems';
import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Session,
    SessionUpdates,
    Workspace,
    WorkspaceProvider,
} from '../shared/workspace';
```

Replace the whole `githubAPI` block (the comment on lines 117–118 through the closing `});` on line 145) with:

```ts
// The Inbox: main owns the cache; the renderer sends intents and listens for
// pushes. Read-only against the provider by construction.
contextBridge.exposeInMainWorld('inboxAPI', {
    getInbox: (workspaceId: string): Promise<InboxSnapshot | null> =>
        ipcRenderer.invoke(IPC_CHANNELS.INBOX_GET, workspaceId),

    refreshInbox: (workspaceId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.INBOX_REFRESH, workspaceId),

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) =>
        subscribe<InboxSnapshot>(IPC_CHANNELS.INBOX_CHANGED, callback),
});

// Provider operations. Tokens never cross this bridge — they are borrowed
// and consumed entirely inside the main process.
contextBridge.exposeInMainWorld('providerAPI', {
    probe: (id: GitProviderId): Promise<ProviderProbeResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_PROBE, id),

    resolveRepos: (workspaceId: string, repos: string[]): Promise<Record<string, string | null>> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_RESOLVE_REPOS, workspaceId, repos),

    launchWorkItem: (workspaceId: string, workItem: WorkItemRef): Promise<WorkItemLaunchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM, workspaceId, workItem),

    cloneRepo: (
        workspaceId: string,
        repo: string,
        destinationDir: string
    ): Promise<CloneRepoResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_CLONE_REPO, workspaceId, repo, destinationDir),
});
```

In `workspaceAPI`, replace the `updateSession` member (lines 175–180) with:

```ts
    updateSession: (workspaceId: string, sessionId: string, updates: SessionUpdates): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SESSION_UPDATE, workspaceId, sessionId, updates),
```

and `setGitHubBinding` (lines 198–202) with:

```ts
    setProviderBinding: (workspaceId: string, binding: WorkspaceProvider | null): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_PROVIDER_BINDING, workspaceId, binding),

    setActions: (
        workspaceId: string,
        actions: WorkItemAction[],
        sectionDefaults: Partial<Record<InboxSection, string>>
    ): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_ACTIONS, workspaceId, actions, sectionDefaults),
```

Run: `npx tsc -p tsconfig.preload.json --noEmit ; echo "exit $?"`
Expected: `exit 0`.

- [ ] **Step 2: Create the two bridges and retire the old one**

```bash
git rm src/renderer/services/githubBridge.ts
```

```ts
// src/renderer/services/inboxBridge.ts
import type { InboxSnapshot } from '../../shared/workItems';

function getAPI() {
    if (typeof window !== 'undefined' && window.inboxAPI) {
        return window.inboxAPI;
    }
    return null;
}

/**
 * Bridge to the Inbox cache in the main process.
 *
 * Main owns the cache; this bridge sends intents and listens for pushes.
 * Read-only against the provider by construction: nothing here writes to it.
 */
export const inboxBridge = {
    /** Cached snapshot, or null. A null result also kicks a background refresh. */
    getInbox: async (workspaceId: string): Promise<InboxSnapshot | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.getInbox(workspaceId);
    },

    /** Manual refresh; the result arrives on `onInboxChanged`. */
    refreshInbox: async (workspaceId: string): Promise<void> => {
        const api = getAPI();
        if (!api) return;
        await api.refreshInbox(workspaceId);
    },

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void): (() => void) => {
        const api = getAPI();
        if (!api) return () => {};
        return api.onInboxChanged(callback);
    },
};
```

```ts
// src/renderer/services/providerBridge.ts
import type { GitProviderId, ProviderProbeResult } from '../../shared/providers';
import type { CloneRepoResult, WorkItemLaunchResult } from '../../shared/types';
import type { WorkItemRef } from '../../shared/workItems';

function getAPI() {
    if (typeof window !== 'undefined' && window.providerAPI) {
        return window.providerAPI;
    }
    return null;
}

/**
 * Bridge to provider operations in the main process.
 *
 * Consola stores no provider credentials: the provider's CLI owns the
 * keyring, and this bridge only ever learns which accounts exist — never
 * their tokens. Launch and clone are intents; main does the work.
 */
export const providerBridge = {
    /** Whether the provider's CLI is installed, its version, and the keyring accounts. */
    probe: async (id: GitProviderId): Promise<ProviderProbeResult> => {
        const api = getAPI();
        if (!api) return { available: false, accounts: [] };
        return api.probe(id);
    },

    /** Which of these remote repos have a local clone in this workspace. */
    resolveRepos: async (
        workspaceId: string,
        repos: string[]
    ): Promise<Record<string, string | null>> => {
        const api = getAPI();
        if (!api) return {};
        return api.resolveRepos(workspaceId, repos);
    },

    /** One click on an Inbox item: resolve -> worktree -> session record. */
    launchWorkItem: async (
        workspaceId: string,
        workItem: WorkItemRef
    ): Promise<WorkItemLaunchResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.launchWorkItem(workspaceId, workItem);
    },

    /** Clone an un-cloned inbox repo into a chosen directory. */
    cloneRepo: async (
        workspaceId: string,
        repo: string,
        destinationDir: string
    ): Promise<CloneRepoResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.cloneRepo(workspaceId, repo, destinationDir);
    },
};
```

- [ ] **Step 3: Widen `src/renderer/services/workspaceBridge.ts`**

Replace the imports (lines 1–15) with:

```ts
import type {
    WorkspaceSnapshot,
    SessionFanOutIntent,
    SessionFanOutResult,
    ScopeRepo,
} from '../../shared/types';
import type { InboxSection } from '../../shared/inboxSections';
import type { WorkItemAction } from '../../shared/workItemActions';
import type {
    Group,
    NewGroupFields,
    NewScopeFields,
    NewSessionFields,
    Scope,
    Session,
    SessionUpdates,
    Workspace,
    WorkspaceProvider,
} from '../../shared/workspace';
```

Replace `updateSession` (lines 57–63) with:

```ts
    updateSession(workspaceId: string, sessionId: string, updates: SessionUpdates): Promise<void> {
        return window.workspaceAPI.updateSession(workspaceId, sessionId, updates);
    },
```

Replace `setGitHubBinding` (lines 86–91) with:

```ts
    setProviderBinding(workspaceId: string, binding: WorkspaceProvider | null): Promise<void> {
        return window.workspaceAPI.setProviderBinding(workspaceId, binding);
    },

    /** Replaces actions and section defaults in one validated write; rejects with the message. */
    setActions(
        workspaceId: string,
        actions: WorkItemAction[],
        sectionDefaults: Partial<Record<InboxSection, string>>
    ): Promise<void> {
        return window.workspaceAPI.setActions(workspaceId, actions, sectionDefaults);
    },
```

- [ ] **Step 4: Typecheck main and preload, run the suite, commit**

Run: `npx tsc -p tsconfig.main.json --noEmit && npx tsc -p tsconfig.preload.json --noEmit ; echo "exit $?"`
Expected: `exit 0`.

Run: `npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | grep -c 'error TS'`
Expected: a non-zero count, every error in `src/renderer/stores/inboxStore.ts`, `src/renderer/stores/workspaceStore.ts`, or `src/renderer/components/{GitHub,Inbox,WorkItemStrip,Sidebar,Layout,WorkspaceSettings}/` — Tasks 13 and 14's files.

Run: `npm test`
Expected: 44 files, 535 tests pass — `inboxStore.test.ts` fails to load (`vi.mock('../services/githubBridge')` targets a module that no longer exists) and is the one red file; Task 13 rewrites it. (The count: 548 minus that file's 13 cases.)

```bash
git add src/preload/preload.ts src/renderer/services/inboxBridge.ts src/renderer/services/providerBridge.ts src/renderer/services/workspaceBridge.ts
git add -A src/renderer/services/githubBridge.ts
git commit -m "refactor: inboxAPI and providerAPI replace githubAPI; bridges follow" -m "Preload exposes the Inbox and provider surfaces separately, so the renderer can see the seam: inboxBridge sends intents and listens for pushes, providerBridge probes a CLI by provider id and launches or clones through main. workspaceBridge takes the shared SessionUpdates and gains setProviderBinding and setActions. Main and preload typecheck clean; the renderer follows in the next two tasks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Renderer stores follow the bridges

**Files:**
- Modify: `src/renderer/stores/inboxStore.test.ts` (`:2` import; `:4-13` mocks; `:30` import; `:35-43` fixture; every `githubBridge.` call)
- Modify: `src/renderer/stores/inboxStore.ts` (`:2-4` imports; `:14` and `:90` comments; every `githubBridge.` call)
- Modify: `src/renderer/stores/workspaceStore.ts` (`:3-10` imports; `:30-34` `updateSession`; `:48-51` and `:105-106` `setGitHubBinding`)

**Interfaces:**
- Consumes: `inboxBridge`, `providerBridge`, `workspaceBridge.setProviderBinding` / `setActions` / `updateSession` (Task 12); `InboxItem`, `InboxSnapshot`, `workItemKey` (Task 1); `SessionUpdates`, `WorkspaceProvider` (Task 3); `WorkItemAction`, `InboxSection` (Task 2).
- Produces: `useInboxStore` unchanged in surface (`load`, `refresh`, `adoptSnapshot`, `launch`, `cloneAndLaunch`, `openClonePrompt`, `dismissClonePrompt`, `subscribeToEvents`, `launchKey`); `useWorkspaceStore.updateSession(workspaceId, sessionId, updates: SessionUpdates)`, `useWorkspaceStore.setProviderBinding(workspaceId, binding: WorkspaceProvider | null)`, `useWorkspaceStore.setActions(workspaceId, actions, sectionDefaults)`.

- [ ] **Step 1: Point the store test at the two bridges**

In `src/renderer/stores/inboxStore.test.ts`, replace line 2 with:

```ts
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';
```

Replace the `vi.mock('../services/githubBridge', ...)` block (lines 4–13) with:

```ts
vi.mock('../services/inboxBridge', () => ({
  inboxBridge: {
    getInbox: vi.fn(async () => null),
    refreshInbox: vi.fn(async () => undefined),
    onInboxChanged: vi.fn(() => () => {}),
  },
}));

vi.mock('../services/providerBridge', () => ({
  providerBridge: {
    probe: vi.fn(async () => ({ available: false, accounts: [] })),
    resolveRepos: vi.fn(async () => ({})),
    launchWorkItem: vi.fn(),
    cloneRepo: vi.fn(),
  },
}));
```

Replace line 30 (`import { githubBridge } from '../services/githubBridge';`) with:

```ts
import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
```

Replace the `item51` fixture (lines 35–43) with the provider-neutral shape:

```ts
const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};
```

Then retarget every remaining call — the substitutions are mechanical, so apply them as such:

```bash
sed -i '' \
  -e 's/githubBridge\.getInbox/inboxBridge.getInbox/g' \
  -e 's/githubBridge\.refreshInbox/inboxBridge.refreshInbox/g' \
  -e 's/githubBridge\.resolveRepos/providerBridge.resolveRepos/g' \
  -e 's/githubBridge\.launchWorkItem/providerBridge.launchWorkItem/g' \
  -e 's/githubBridge\.cloneRepo/providerBridge.cloneRepo/g' \
  src/renderer/stores/inboxStore.test.ts
grep -c 'githubBridge' src/renderer/stores/inboxStore.test.ts
```

Expected: `0`.

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: FAIL — the store still imports `../services/githubBridge`, which no longer exists.

- [ ] **Step 2: Rewire `src/renderer/stores/inboxStore.ts`**

Replace lines 2–4 (the `../../shared/github` and `githubBridge` imports) with:

```ts
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';
import { workItemKey } from '../../shared/workItems';
import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
```

Replace the `snapshots` doc comment (line 14) with:

```ts
  /** Per-workspace snapshots, fed by main's inbox:changed pushes. */
```

and the comment inside `launch` that reads `// Only reachable when window.githubAPI itself is missing (a broken` with:

```ts
        // Only reachable when window.providerAPI itself is missing (a broken
```

Then retarget the calls, the same way as the test:

```bash
sed -i '' \
  -e 's/githubBridge\.getInbox/inboxBridge.getInbox/g' \
  -e 's/githubBridge\.refreshInbox/inboxBridge.refreshInbox/g' \
  -e 's/githubBridge\.onInboxChanged/inboxBridge.onInboxChanged/g' \
  -e 's/githubBridge\.resolveRepos/providerBridge.resolveRepos/g' \
  -e 's/githubBridge\.launchWorkItem/providerBridge.launchWorkItem/g' \
  -e 's/githubBridge\.cloneRepo/providerBridge.cloneRepo/g' \
  src/renderer/stores/inboxStore.ts
grep -c 'githubBridge\|githubAPI\|shared/github' src/renderer/stores/inboxStore.ts
```

Expected: `0`.

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: PASS (13 tests) — the store's behaviour is untouched; only which bridge answers changed.

- [ ] **Step 3: Widen `src/renderer/stores/workspaceStore.ts`**

Replace lines 3–10 (the `../../shared/workspace` type import) with:

```ts
import type { InboxSection } from '../../shared/inboxSections';
import type { WorkItemAction } from '../../shared/workItemActions';
import {
  type Group,
  type NewGroupFields,
  type NewSessionFields,
  type Scope,
  type Session,
  type SessionUpdates,
  type Workspace,
  type WorkspaceProvider,
} from '../../shared/workspace';
```

In `interface WorkspaceState`, replace the `updateSession` member (lines 30–34) with:

```ts
  updateSession: (workspaceId: string, sessionId: string, updates: SessionUpdates) => Promise<void>;
```

and `setGitHubBinding` (lines 48–51) with:

```ts
  setProviderBinding: (workspaceId: string, binding: WorkspaceProvider | null) => Promise<void>;
  /** Replaces actions and section defaults in one validated write; rejects with the message. */
  setActions: (
    workspaceId: string,
    actions: WorkItemAction[],
    sectionDefaults: Partial<Record<InboxSection, string>>
  ) => Promise<void>;
```

In the store body, replace the `setGitHubBinding` implementation (lines 105–106) with:

```ts
  setProviderBinding: (workspaceId, binding) =>
    workspaceBridge.setProviderBinding(workspaceId, binding),

  setActions: (workspaceId, actions, sectionDefaults) =>
    workspaceBridge.setActions(workspaceId, actions, sectionDefaults),
```

- [ ] **Step 4: Run the suite and commit**

Run: `npm test`
Expected: 45 files, 548 tests pass.

Run: `npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | grep 'src/renderer/stores/' ; echo "exit ${PIPESTATUS[0]}"`
Expected: no `stores/` lines — the remaining renderer errors are all under `components/`, Task 14's.

```bash
git add src/renderer/stores/inboxStore.ts src/renderer/stores/inboxStore.test.ts src/renderer/stores/workspaceStore.ts
git commit -m "refactor: renderer stores read the inbox and provider bridges" -m "inboxStore asks inboxBridge for the cache and providerBridge for repos, launches and clones; its behaviour and tests are otherwise unchanged. workspaceStore takes the shared SessionUpdates and gains setProviderBinding and setActions for the binding panel and the coming actions editor.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Renderer components follow; `src/shared/github.ts` goes; full verification

**Files:**
- Modify: `src/renderer/components/Inbox/inboxPresentation.ts` (whole file) and `inboxPresentation.test.ts` (whole file)
- Modify: `src/renderer/components/Inbox/index.tsx:3-4`, `:46-47`, `:77-78`
- Modify: `src/renderer/components/WorkItemStrip/index.tsx:2`
- Modify: `src/renderer/components/Sidebar/index.tsx:38-41`, `:119`
- Modify: `src/renderer/components/Layout/MainContent.tsx:25`
- Modify: `src/renderer/components/WorkspaceSettings/ManifestHeader.tsx:1-3`, `:92`
- Modify: `src/renderer/components/WorkspaceSettings/WorkspaceSettingsSection.tsx:3`, `:14`, `:42`
- Move: `src/renderer/components/GitHub/GitHubBindingPanel.tsx` → `src/renderer/components/Provider/ProviderBindingPanel.tsx` (rewritten); `GitHub/index.ts` → `Provider/index.ts`; `GitHub/styles.css` → `Provider/styles.css` (class names kept as `github-*`; one comment line)
- Delete: `src/shared/github.ts` (its last importers move in this task)
- Verify unchanged: `tests/e2e/inbox.spec.ts`

**Interfaces:**
- Consumes: `InboxItem`, `InboxRole`, `sameWorkItem`, `workItemUrl` (Task 1); `PROVIDER_META`, `ProviderProbeResult` (Task 1); `providerBridge` (Task 12); `useWorkspaceStore.setProviderBinding` (Task 13); `Workspace.provider` (Task 3).
- Produces: `ProviderBindingPanel` at `src/renderer/components/Provider/index.ts`, props `{ workspace: Workspace }`, not self-wrapped (the caller supplies `<section className="ws-panel">`) — the surface Phase A mounts; `primaryRole(item)`, `roleLabelFor`, `metaLineFor`, `actionFor`, `dotClassFor`, `formatAge` reading `roles`. After this task `npm run typecheck`, `npm test`, `npm run build` and `tests/e2e/inbox.spec.ts` are all green.

- [ ] **Step 1: Rewrite the presentation test for `roles`**

Replace `src/renderer/components/Inbox/inboxPresentation.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import {
  actionFor,
  dotClassFor,
  formatAge,
  metaLineFor,
  primaryRole,
  roleLabelFor,
} from './inboxPresentation';

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    author: 'anna',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    commentCount: 3,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    additions: 210,
    deletions: 88,
    ...overrides,
  };
}

const issue87 = { provider: 'github', repo: 'o/r', type: 'issue', number: 87 } as const;

describe('formatAge', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');
  it('labels fresh, minutes, hours, and never', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now');
    expect(formatAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(0, now)).toBe('never');
  });

  it('rolls over to days once 24 hours have passed', () => {
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('primaryRole', () => {
  it('leads with the reason you were asked over the reason you are attached', () => {
    expect(primaryRole(makeItem({ roles: ['author', 'assignee', 'review-requested-team'] }))).toBe(
      'review-requested-team'
    );
    expect(primaryRole(makeItem({ roles: ['author', 'assignee'] }))).toBe('assignee');
    expect(primaryRole(makeItem({ roles: ['author'] }))).toBe('author');
    expect(primaryRole(makeItem({ roles: [] }))).toBeUndefined();
  });
});

describe('actionFor', () => {
  it('is Open session whenever a session exists, regardless of anything else', () => {
    expect(actionFor(makeItem(), true, false)).toEqual({ label: 'Open session', kind: 'open' });
  });

  it('offers the clone path when the repo has no local clone', () => {
    expect(actionFor(makeItem(), false, false)).toEqual({
      label: 'Clone into scope...',
      kind: 'clone',
    });
  });

  it('labels launches by role: Review, Address review, Start work', () => {
    expect(actionFor(makeItem(), false, true).label).toBe('Review');
    expect(actionFor(makeItem({ roles: ['author'] }), false, true).label).toBe('Address review');
    // Asked to review your own PR: the request wins, as it did when the
    // parser picked one role.
    expect(actionFor(makeItem({ roles: ['author', 'review-requested-direct'] }), false, true).label).toBe('Review');
    expect(actionFor(makeItem({ roles: ['assignee'], workItem: issue87 }), false, true).label).toBe('Start work');
  });
});

describe('metaLineFor and roleLabelFor', () => {
  it('joins repo, role, CI, review state, and diff stats', () => {
    expect(metaLineFor(makeItem())).toBe(
      'controller-app · review requested · CI failing · +210 −88'
    );
  });

  it('labels authored items as yours', () => {
    expect(roleLabelFor(makeItem({ roles: ['author'] }))).toBe('your PR');
    expect(roleLabelFor(makeItem({ roles: ['author'], workItem: issue87 }))).toBe('your issue');
  });

  it('labels assigned items, and team requests like direct ones', () => {
    expect(roleLabelFor(makeItem({ roles: ['assignee'] }))).toBe('assigned to you');
    expect(roleLabelFor(makeItem({ roles: ['review-requested-team'] }))).toBe('review requested');
    expect(roleLabelFor(makeItem({ roles: ['involved'] }))).toBe('involves you');
  });

  it('mentions changes requested when the provider says so', () => {
    expect(metaLineFor(makeItem({ reviewDecision: 'changes-requested' }))).toContain(
      'changes requested'
    );
  });

  it('mentions approved when the provider says so', () => {
    expect(metaLineFor(makeItem({ reviewDecision: 'approved' }))).toContain('approved');
  });

  it('omits CI status and diff stats entirely when the item carries neither, as issues do', () => {
    expect(
      metaLineFor(
        makeItem({
          workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 12 },
          ciStatus: undefined,
          reviewDecision: 'none',
          additions: undefined,
          deletions: undefined,
        })
      )
    ).toBe('controller-app · review requested');
  });
});

describe('dotClassFor', () => {
  it('flags failing CI red, requested reviews attention, the rest idle', () => {
    expect(dotClassFor(makeItem())).toBe('inbox-dot--err');
    expect(dotClassFor(makeItem({ ciStatus: 'passing' }))).toBe('inbox-dot--att');
    expect(dotClassFor(makeItem({ ciStatus: 'passing', roles: ['review-requested-team'] }))).toBe('inbox-dot--att');
    expect(dotClassFor(makeItem({ ciStatus: 'passing', roles: ['assignee'] }))).toBe('inbox-dot--idle');
  });
});
```

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: FAIL — `primaryRole` is not exported and every role case reads `item.role`.

- [ ] **Step 2: Rewrite `src/renderer/components/Inbox/inboxPresentation.ts`**

```ts
import type { InboxItem, InboxRole } from '../../../shared/workItems';

/** Human age of a fetch: 'just now', '2m ago', '3h ago', '2d ago', 'never'. */
export function formatAge(fetchedAt: number, now: number = Date.now()): string {
  if (!fetchedAt) return 'never';
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The one role a row leads with: the reason you were asked (a requested
 * review) outranks the reason you are merely attached (assignee, author) —
 * the precedence the parser used to apply before items carried every role.
 */
const ROLE_PRECEDENCE: InboxRole[] = [
  'review-requested-direct',
  'review-requested-team',
  'assignee',
  'author',
  'involved',
];

export function primaryRole(item: InboxItem): InboxRole | undefined {
  return ROLE_PRECEDENCE.find((role) => item.roles.includes(role));
}

export function roleLabelFor(item: InboxItem): string {
  switch (primaryRole(item)) {
    case 'review-requested-direct':
    case 'review-requested-team':
      return 'review requested';
    case 'assignee':
      return 'assigned to you';
    case 'author':
      return item.workItem.type === 'pr' ? 'your PR' : 'your issue';
    default:
      return 'involves you';
  }
}

/** The one-line subtitle under an item: repo · role · CI · review · +a −d. */
export function metaLineFor(item: InboxItem): string {
  const parts: string[] = [
    item.workItem.repo.split('/').pop() ?? item.workItem.repo,
    roleLabelFor(item),
  ];
  if (item.ciStatus) parts.push(`CI ${item.ciStatus}`);
  if (item.reviewDecision === 'changes-requested') parts.push('changes requested');
  if (item.reviewDecision === 'approved') parts.push('approved');
  if (item.additions !== undefined || item.deletions !== undefined) {
    parts.push(`+${item.additions ?? 0} −${item.deletions ?? 0}`);
  }
  return parts.join(' · ');
}

export interface InboxAction {
  label: string;
  kind: 'launch' | 'open' | 'clone';
}

/**
 * The one button an item shows.
 *
 * A session wins over everything: one work item, one session, re-attached
 * forever. An unresolved repo offers the clone path instead of failing.
 * Otherwise the label names the likely job, by the row's leading role.
 */
export function actionFor(item: InboxItem, hasSession: boolean, cloned: boolean): InboxAction {
  if (hasSession) return { label: 'Open session', kind: 'open' };
  if (!cloned) return { label: 'Clone into scope...', kind: 'clone' };
  if (item.workItem.type === 'issue') return { label: 'Start work', kind: 'launch' };
  if (primaryRole(item) === 'author') return { label: 'Address review', kind: 'launch' };
  return { label: 'Review', kind: 'launch' };
}

/** Status dot class: failing CI screams, requested reviews nudge, rest idle. */
export function dotClassFor(item: InboxItem): string {
  if (item.ciStatus === 'failing') return 'inbox-dot--err';
  const role = primaryRole(item);
  if (role === 'review-requested-direct' || role === 'review-requested-team') return 'inbox-dot--att';
  return 'inbox-dot--idle';
}
```

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 3: Follow the renames in the small components**

`src/renderer/components/Inbox/index.tsx` — replace lines 3–4 with:

```ts
import type { InboxItem } from '../../../shared/workItems';
import { sameWorkItem } from '../../../shared/workItems';
```

replace lines 46–47 with:

```ts
  const provider = workspace.provider;
  if (!provider) return null;
```

and lines 77–78 (inside `.inbox-meta-account`) with:

```tsx
            {provider.accountLogin}
            {provider.org ? ` · ${provider.org}` : ''}
```

`src/renderer/components/WorkItemStrip/index.tsx` — replace line 2 with:

```ts
import { sameWorkItem, workItemUrl } from '../../../shared/workItems';
```

`src/renderer/components/Sidebar/index.tsx` — replace lines 38–41 with:

```ts
  // Prime the inbox for provider-bound workspaces so the count is live even
  // before the Inbox view is ever opened. Main answers from cache or kicks a
  // background refresh whose result arrives on the push channel.
  const providerAccount = workspace?.provider?.accountLogin;
```

then `githubAccount` → `providerAccount` on the two following lines (the `useEffect` body and its dependency list), and on line 119 replace `{workspace?.github && (` with `{workspace?.provider && (`.

`src/renderer/components/Layout/MainContent.tsx` — line 25: `if (isInboxOpen && workspace.provider) {`.

`src/renderer/components/WorkspaceSettings/ManifestHeader.tsx` — add after line 1:

```ts
import { PROVIDER_META } from '../../../shared/providers';
```

and replace line 92 with:

```tsx
        {workspace.provider && (
          <span className="ws-fact">
            {PROVIDER_META[workspace.provider.id].cliName} {workspace.provider.accountLogin}
          </span>
        )}
```

`src/renderer/components/WorkspaceSettings/WorkspaceSettingsSection.tsx` — line 3: `import { ProviderBindingPanel } from '../Provider';`; line 14: `end of life. Scoped to the active workspace, like the provider binding`; line 42: `<ProviderBindingPanel workspace={workspace} />`.

- [ ] **Step 4: Move the binding panel to `Provider/` and read its copy from `PROVIDER_META`**

```bash
git mv src/renderer/components/GitHub src/renderer/components/Provider
git mv src/renderer/components/Provider/GitHubBindingPanel.tsx src/renderer/components/Provider/ProviderBindingPanel.tsx
```

Replace `src/renderer/components/Provider/index.ts` with:

```ts
export { ProviderBindingPanel } from './ProviderBindingPanel';
```

In `src/renderer/components/Provider/styles.css`, replace the first comment line with `/* Provider binding panel (GitHub today), mounted inside the Workspace settings section —` (the `github-*` class names stay: they are the panel's own, and renaming them buys nothing).

Replace `src/renderer/components/Provider/ProviderBindingPanel.tsx` with the file below — this step gives everything above the `return`, Step 5 the JSX:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { PROVIDER_META, type ProviderProbeResult } from '../../../shared/providers';
import type { Workspace } from '../../../shared/workspace';
import { providerBridge } from '../../services/providerBridge';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

interface ProviderBindingPanelProps {
  workspace: Workspace;
}

/**
 * The one place in the renderer that names a provider: GitHub is the only
 * one there is, and the binding panel is where a workspace picks it. Every
 * other component reads `workspace.provider.id` and PROVIDER_META.
 */
const PROVIDER = PROVIDER_META.github;

/**
 * Bind a workspace to one keyring account of the provider's CLI. Mounted
 * inside the Workspace settings section, which supplies the workspace and
 * the panel chrome.
 *
 * Consola stores zero provider credentials. The CLI is the broker: this
 * panel only learns which accounts exist (via a main-process probe) and
 * records a login name on the workspace. Tokens are borrowed main-side at
 * spawn time and never reach this component.
 */
export function ProviderBindingPanel({ workspace }: ProviderBindingPanelProps) {
  const setProviderBinding = useWorkspaceStore((state) => state.setProviderBinding);

  const [probe, setProbe] = useState<ProviderProbeResult | null>(null);
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
  const [org, setOrg] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Availability is a live fact about the machine, so check when the section
  // is opened rather than polling in the background — same as harness health.
  const runProbe = useCallback(() => {
    setProbe(null);
    void providerBridge.probe(PROVIDER.id).then(setProbe);
  }, []);

  useEffect(() => {
    runProbe();
  }, [runProbe]);

  // Follow the workspace's stored binding whenever the workspace changes.
  useEffect(() => {
    setSelectedLogin(workspace.provider?.accountLogin ?? null);
    setOrg(workspace.provider?.org ?? '');
  }, [workspace.id, workspace.provider?.accountLogin, workspace.provider?.org]);

  const handleSave = async () => {
    // Belt and suspenders: selectedLogin can only ever be set from an
    // account.login the probe actually returned (see the radio group below),
    // never free text, but the guard stays here too since this is the one
    // place that can reach the IPC boundary. A binding with a missing or
    // empty accountLogin must never be constructible, let alone sent — main
    // coerces it with String(...) and would otherwise persist "undefined".
    if (!selectedLogin) return;
    setIsSaving(true);
    try {
      await setProviderBinding(workspace.id, {
        id: PROVIDER.id,
        accountLogin: selectedLogin,
        org: org.trim() || undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnbind = async () => {
    setIsSaving(true);
    try {
      await setProviderBinding(workspace.id, null);
    } finally {
      setIsSaving(false);
    }
  };

  const bound = workspace.provider;
  const isDirty =
    selectedLogin !== (bound?.accountLogin ?? null) || org.trim() !== (bound?.org ?? '');
```

- [ ] **Step 5: The panel's JSX — copy from `PROVIDER_META`, chrome unchanged**

Continue `ProviderBindingPanel.tsx` directly after the `isDirty` line of Step 4:

```tsx
  return (
    <>
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">
          {PROVIDER.displayName}
          {bound && <span className="github-bound-tag">bound: {bound.accountLogin}</span>}
        </h3>
        <button
          type="button"
          className="github-icon-button"
          onClick={runProbe}
          aria-label={`Re-check ${PROVIDER.cliName}`}
          title={`Re-check ${PROVIDER.cliName}`}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <p className="github-section-description">
        Bind this workspace to one <code>{PROVIDER.cliName}</code> account and every session in
        it runs <code>{PROVIDER.cliName}</code> as that account — no global account switching.
        Consola stores no credentials; the <code>{PROVIDER.cliName}</code> CLI holds them.
      </p>

      {probe === null && (
        <p className="github-section-status">Checking for the {PROVIDER.cliName} CLI…</p>
      )}

      {probe !== null && !probe.available && (
        <div className="github-empty-state">
          <p>
            {PROVIDER.displayName} features need the <code>{PROVIDER.cliName}</code> CLI, which
            was not found.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Install it with <code>{PROVIDER.installHint}</code>, sign in with{' '}
            <code>{PROVIDER.loginHint}</code>, then re-check. Everything else in Consola works
            without it.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length === 0 && (
        <div className="github-empty-state">
          <p>
            <code>{PROVIDER.cliName}</code> {probe.version ? `${probe.version} ` : ''}is
            installed, but no accounts are signed in.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Run <code>{PROVIDER.loginHint}</code> in a terminal (once per account), then
            re-check.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length > 0 && (
        <>
          <div
            className="ws-choice-list"
            role="radiogroup"
            aria-label={`${PROVIDER.displayName} account`}
          >
            {probe.accounts.map((account) => (
              <button
                key={account.login}
                type="button"
                role="radio"
                aria-checked={selectedLogin === account.login}
                className={`ws-choice-row ${
                  selectedLogin === account.login ? 'selected' : ''
                }`}
                onClick={() => setSelectedLogin(account.login)}
              >
                <span className="ws-choice-name">{account.login}</span>
                {account.active && (
                  <span className="github-account-hint">{PROVIDER.cliName}’s active account</span>
                )}
                {selectedLogin === account.login && <Check size={14} />}
              </button>
            ))}
          </div>

          <label className="github-org-field">
            <span>Organization (optional — narrows the Inbox)</span>
            <input
              type="text"
              value={org}
              onChange={(event) => setOrg(event.target.value)}
              placeholder="e.g. sympower"
              spellCheck={false}
            />
          </label>

          <div className="github-section-actions">
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void handleSave()}
              disabled={!selectedLogin || !isDirty || isSaving}
            >
              {bound ? 'Update binding' : 'Bind account'}
            </button>
            {bound && (
              <button
                type="button"
                className="github-unbind-button"
                onClick={() => void handleUnbind()}
                disabled={isSaving}
              >
                Unbind
              </button>
            )}
          </div>
          <p className="github-section-footnote">
            Applies to sessions the next time their terminal starts. Already-running
            terminals keep the environment they launched with.
          </p>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Retire `src/shared/github.ts` and typecheck everything**

```bash
git rm src/shared/github.ts
```

Run: `npm run typecheck ; echo "exit $?"`
Expected: `exit 0` — main, preload and renderer all clean, the first fully green typecheck since Task 3.

Run: `npm test`
Expected: 45 files, 549 tests pass (548 + the `primaryRole` case).

- [ ] **Step 7: Build and run the unchanged e2e spec**

Run: `npm run build ; echo "exit $?"`
Expected: `exit 0`.

Run: `git status --porcelain tests/e2e/inbox.spec.ts`
Expected: no output — the spec is byte-for-byte what it was at the start of the plan.

Run: `npx playwright test tests/e2e/inbox.spec.ts`
Expected: 1 passed. The spec seeds a `version: 6` file with a `github` binding; `WorkspaceService.load` runs the v7 rung in memory (binding → `provider`, actions seeded), the sidebar's Inbox row appears because `workspace.provider` is set, the stub `gh` answers through `GitHubDriver` behind `CONSOLA_GH_PATH`, "Review" launches through the coalescer and the driver's checkout lands `stub-pr-51`, the session record carries `workItem` plus a `workItemAction` the spec does not inspect, and "Open session" re-attaches. Every selector the spec uses (`.sidebar-inbox-row`, `.inbox-item-title`, `.inbox-tab`, `.inbox-item-action.ghost`, the `Review` / `Open session` buttons) is untouched.

- [ ] **Step 8: Prove nothing GitHub-shaped is left outside the driver**

Run: `grep -rn "shared/github\|githubBridge\|workspace\.github\|setGitHubBinding\|GITHUB_\|GH_PROBE\|githubAccountLogin" src/ ; echo "exit $?"`
Expected: `exit 1` (no hits).

Run: `grep -rln "'github'" src/main src/renderer | sort`
Expected exactly:

```
src/main/providers/github/GitHubDriver.ts
src/main/providers/github/inboxQuery.ts
src/main/providers/index.ts
src/renderer/components/Provider/ProviderBindingPanel.tsx
```

plus test files (`*.test.ts`) — fixtures name the only provider there is. `ProviderBindingPanel` is the documented renderer-side exception; the other three are inside `src/main/providers/`.

Run: `ls src/main/github src/renderer/components/GitHub 2>&1`
Expected: both report "No such file or directory".

- [ ] **Step 9: Commit**

```bash
git add -A src/renderer/components/Provider src/renderer/components/GitHub src/renderer/components/Inbox src/renderer/components/WorkItemStrip src/renderer/components/Sidebar src/renderer/components/Layout src/renderer/components/WorkspaceSettings
git add -A src/shared/github.ts
git commit -m "refactor: renderer reads workspace.provider and PROVIDER_META; shared/github.ts retired" -m "The binding panel becomes ProviderBindingPanel, taking its display name, CLI name, install and login hints from PROVIDER_META and probing by provider id — the one renderer component that names GitHub. Inbox rows, the strip, the sidebar, the manifest header and the main pane read workspace.provider and the roles-bearing InboxItem; a row still leads with the role the old parser would have picked. shared/github.ts goes with its last importer, and the inbox e2e spec passes without an edit: the v6 seed migrates through the new rung.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Done when

- `npm test`: 45 files, 549 tests, all green; `npm run typecheck`: clean; `npm run build`: clean; `npx playwright test tests/e2e/inbox.spec.ts`: 1 passed with the spec unchanged.
- `src/main/github/`, `src/renderer/components/GitHub/`, `src/renderer/services/githubBridge.ts` and `src/shared/github.ts` no longer exist; the grep in Task 14 Step 8 finds nothing.
- Phase A can mount `ProviderBindingPanel` from `src/renderer/components/Provider`; Phase C can read `Session.workItemAction`, link through `workspaceBridge.updateSession(..., { workItem })`, and write through `workspaceBridge.setActions`; Phase D can section with `sectionFor` and replace `inboxQuery.ts`'s three aliases with five.
