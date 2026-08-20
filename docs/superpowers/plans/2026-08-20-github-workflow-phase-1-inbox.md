# GitHub Workflow Phase 1 — Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily loop: a GitHub-bound workspace shows a remote-driven Inbox of PRs/issues, and one click resolves the repo, cuts an isolated worktree, creates a session record, and launches the agent with a seeded prompt — re-attaching to the same session forever after.

**Architecture:** A main-process `GitHubService` fetches one GraphQL search per workspace via a `gh api graphql` subprocess (token from Phase 0's `GhBroker`), caches in main, and pushes snapshots to every renderer; a `WorktreeService` maps remote repos to local clones through workspace scopes and owns worktrees under `~/.consola/worktrees/`. The renderer holds a push-fed zustand `inboxStore`, an Inbox view, a pinned sidebar row, and a work-item strip above the terminal. Launch is one IPC intent: main does worktree-then-record, the existing terminal-create-on-mount path does the spawn with the seeded prompt riding the guarded delivery queue.

**Tech Stack:** Electron 28 (main + preload + renderer), React 19, Zustand, `gh` CLI as subprocess, git worktrees, vitest (co-located, node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-github-workflow-design.md` (sections: "GitHub service and the Inbox", "Worktrees", "Launch flows", "Error handling", "Testing", Phasing row "1 — Inbox"). UI source of truth: `.superpowers/brainstorm/87378-1787218296/content/full-flow.html` scenes 1–3.

## Global Constraints

- **Bridge pattern is binding**: renderer code never touches `window.*API` directly; all access goes through `src/renderer/services/*Bridge.ts`.
- **Every IPC channel name lives in `IPC_CHANNELS`** in `src/shared/constants.ts`. New channels this phase (exact strings): `GITHUB_GET_INBOX: 'github:get-inbox'`, `GITHUB_REFRESH_INBOX: 'github:refresh-inbox'`, `GITHUB_INBOX_CHANGED: 'github:inbox-changed'`, `GITHUB_LAUNCH_WORK_ITEM: 'github:launch-work-item'`, `GITHUB_RESOLVE_REPOS: 'github:resolve-repos'`, `GITHUB_CLONE_REPO: 'github:clone-repo'`.
- **Main owns records; renderers send intents** and listen for pushes. The Inbox cache lives in main; renderers never fetch GitHub themselves.
- **The UI is read-only against GitHub.** No write action anywhere in Consola's UI; all writes happen through the agent running `gh` inside its terminal.
- **The Inbox never produces OS notifications.**
- **Degrade, never dialog:** `gh` missing, token expired, offline all render as labelled states in the Inbox header alongside the last fetch's age. No error dialogs.
- **Never type into a confirmation menu:** the seeded prompt reuses the existing `initialPrompt` → `TerminalService.queuePrompt` guarded delivery path. Do not invent a new prompt-delivery path.
- **Terminals outlive their views; every terminal message carries `instanceId`.** Launch atomicity order: worktree first, record second, spawn third (spawn happens renderer-side on pane mount, exactly like every other session).
- **Worktree naming (verbatim from spec/contract):** `~/.consola/worktrees/<repo-basename>-<type>-<number>` (e.g. `controller-app-pr-51`). Overridable for tests via `CONSOLA_WORKTREES_DIR`.
- **Session identity fields (`scopeId`, `cwd`, `kind`, `workItem`) are immutable** — Phase 0 keeps them out of `allowedSessionUpdates`; nothing in this phase updates them after creation.
- **Refresh cadence:** window focus, manual refresh, and a 3-minute timer. One GraphQL request per workspace per refresh.
- **Tokens never cross IPC.** `GH_TOKEN` is composed main-side (`GhBroker.token`) for subprocesses; PTY injection is Phase 0's and is not re-planned here.
- **Phase 0 contracts are consumed as given** (delivered before this phase runs): `src/shared/workspace.ts` v6 (`Workspace.scopes/groups/github?`, `Session.scopeId/cwd?/groupId?/kind/workItem?`, `NewSessionFields` including them), `src/shared/github.ts` (`GhAccount`, `GhProbeResult`, `WorkItemRef`), `src/main/github/GhBroker.ts` (`probe()`, `token(accountLogin)` — throws with gh's stderr), `TerminalCreateOptions.workspaceId` + main-side `GH_TOKEN` PTY injection.
- **Commands:** `npm test` (vitest, co-located `src/**/*.test.ts`, node environment — no jsdom, so React components are exercised by typecheck + Playwright, pure helpers by vitest), `npm run typecheck`, `npm run test:e2e`.
- No emoji in code, comments, or UI copy (repo convention).

## Cross-plan reconciliation (added at integration)

- Phase 0's scope API is `addScope(workspaceId, fields: { name; path; isGitRepo }): Scope`
  with name defaulting to the folder basename. Where this plan says "verify
  exact name at execution" for the clone-into-scope flow, that is the answer.
- Keep this plan's main-side instance-id helper private to the work-item launch
  module: Phase 2 moves `generateSessionInstanceId` into
  `src/shared/workspace.ts` and will re-point exactly one call site here, then
  delete the twin.

---

### Task 1: Shared contracts — inbox types, work-item helpers, IPC channels

**Files:**
- Modify: `src/shared/github.ts` (Phase 0 creates it with `GhAccount`, `GhProbeResult`, `WorkItemRef` — append to it)
- Modify: `src/shared/constants.ts` (after the `// Git operations` block, ~line 60)
- Modify: `src/shared/types.ts` (launch/clone result types + renderer API interface)
- Test: `src/shared/github.test.ts`

**Interfaces:**
- Consumes: `WorkItemRef` from Phase 0's `src/shared/github.ts`; `Session` from `src/shared/workspace.ts`.
- Produces (used by every later task):
  - `InboxItem`, `InboxSnapshot`, `sameWorkItem(a?: WorkItemRef, b?: WorkItemRef): boolean`, `workItemKey(ref: WorkItemRef): string`, `workItemUrl(ref: WorkItemRef): string` in `src/shared/github.ts`
  - `WorkItemLaunchResult`, `CloneRepoResult`, `GitHubInboxAPI` in `src/shared/types.ts`
  - Six `IPC_CHANNELS` entries listed in Global Constraints.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/github.test.ts
import { describe, expect, it } from 'vitest';
import { sameWorkItem, workItemKey, workItemUrl, type WorkItemRef } from './github';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/github.test.ts`
Expected: FAIL — `sameWorkItem`, `workItemKey`, `workItemUrl` are not exported from `./github`.

- [ ] **Step 3: Append the types and helpers to `src/shared/github.ts`**

Append below Phase 0's contents (which already export `WorkItemRef`):

```ts
/**
 * One PR or issue in a workspace's Inbox, as fetched from GitHub.
 *
 * Remote-driven on purpose: items exist whether or not the repo is cloned
 * locally. Everything the renderer shows comes from this shape — it holds no
 * token and no local path.
 */
export interface InboxItem {
  workItem: WorkItemRef;
  title: string;
  /** Lowercased GitHub state, e.g. 'open'. */
  state: string;
  /** Why this item is in the inbox. One role per item; see parseInboxPayload. */
  role: 'assigned' | 'author' | 'review-requested';
  /** Rolled-up CI verdict; absent when the item has no checks (issues, no CI). */
  ciStatus?: 'pending' | 'passing' | 'failing';
  /** GitHub's reviewDecision verbatim, e.g. 'CHANGES_REQUESTED'. PRs only. */
  reviewDecision?: string;
  /** ISO timestamp from GitHub, used for ordering. */
  updatedAt: string;
  url: string;
  additions?: number;
  deletions?: number;
}

/**
 * One workspace's cached Inbox. Main owns it; renderers receive it on
 * github:inbox-changed and via github:get-inbox.
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

/** Canonical GitHub URL for a work item, for when no fetched item carries one. */
export function workItemUrl(ref: WorkItemRef): string {
  return `https://github.com/${ref.repo}/${ref.type === 'pr' ? 'pull' : 'issues'}/${ref.number}`;
}
```

- [ ] **Step 4: Add the IPC channels to `src/shared/constants.ts`**

Insert after the `GENERATE_COMMIT_MESSAGE` entry, before `// Window identity`:

```ts
    // GitHub inbox (renderer -> main; main owns the cache)
    GITHUB_GET_INBOX: 'github:get-inbox',           // Cached snapshot, or null (a refresh is kicked off)
    GITHUB_REFRESH_INBOX: 'github:refresh-inbox',   // Manual refresh; result arrives on the push channel
    GITHUB_RESOLVE_REPOS: 'github:resolve-repos',   // Which remote repos have a local clone in this workspace
    GITHUB_LAUNCH_WORK_ITEM: 'github:launch-work-item', // Resolve -> worktree -> session record; returns the session
    GITHUB_CLONE_REPO: 'github:clone-repo',         // Clone an un-cloned repo into a chosen directory

    // GitHub inbox (main -> every renderer)
    GITHUB_INBOX_CHANGED: 'github:inbox-changed',   // One workspace's InboxSnapshot
```

- [ ] **Step 5: Add the result types and renderer API interface to `src/shared/types.ts`**

These live in `types.ts`, not `github.ts`, because they reference `Session` — `workspace.ts` imports `WorkItemRef` from `github.ts`, so `github.ts` importing `Session` back would be a cycle. Add near the other API interfaces:

```ts
import type { InboxSnapshot } from './github';
import type { WorkItemRef } from './github';

/**
 * Outcome of the one-click work-item launch.
 *
 * 'not-cloned' is a normal answer, not an error: the renderer responds by
 * offering the clone-into-scope dialog. 'error' carries the git/gh message and
 * is surfaced on the Inbox item — never a dialog.
 */
export type WorkItemLaunchResult =
  | { ok: true; session: Session; seedPrompt?: string; reattached: boolean }
  | { ok: false; reason: 'not-cloned' }
  | { ok: false; reason: 'error'; message: string };

export interface CloneRepoResult {
  ok: boolean;
  /** Absolute path of the fresh clone when ok. */
  path?: string;
  error?: string;
}

/**
 * Inbox surface of the github preload API. Read-only against GitHub by
 * construction: there is no method here that writes to GitHub.
 */
export interface GitHubInboxAPI {
  getInbox: (workspaceId: string) => Promise<InboxSnapshot | null>;
  refreshInbox: (workspaceId: string) => Promise<void>;
  resolveRepos: (workspaceId: string, repos: string[]) => Promise<Record<string, string | null>>;
  launchWorkItem: (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult>;
  cloneRepo: (workspaceId: string, repo: string, destinationDir: string) => Promise<CloneRepoResult>;
  onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) => () => void;
}
```

Then extend the `Window` declaration. Phase 0 exposes its probe surface on `window.githubAPI`; merge rather than duplicate — the final declaration should read (where `GitHubProbeAPI` is whatever Phase 0 named its probe interface; if Phase 0 exposed nothing on `window.githubAPI`, declare just `GitHubInboxAPI`):

```ts
declare global {
  interface Window {
    // ...existing entries unchanged...
    githubAPI: GitHubProbeAPI & GitHubInboxAPI;
  }
}
```

Note the existing `Session` import in `types.ts` already exists (`import type { NewSessionFields, Session, Workspace } from './workspace';`) — reuse it; merge the two `./github` imports into one line.

- [ ] **Step 6: Run the test and the typecheck**

Run: `npx vitest run src/shared/github.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (nothing consumes the new API yet).

- [ ] **Step 7: Commit**

```bash
git add src/shared/github.ts src/shared/github.test.ts src/shared/constants.ts src/shared/types.ts
git commit -m "feat: shared inbox contracts, work-item helpers, github IPC channels"
```

---

### Task 2: Stub `gh` fixture for deterministic tests

**Files:**
- Create: `tests/fixtures/stub-gh/gh` (executable shell script)
- Create: `tests/fixtures/stub-gh/graphql-inbox.json`
- Test: `src/main/github/stubGh.test.ts` (smoke test that the fixture answers each argv shape)

**Interfaces:**
- Consumes: nothing.
- Produces: an executable at `tests/fixtures/stub-gh/gh` answering `--version`, `auth status`, `auth token --user <login>`, `api graphql ...` (prints `graphql-inbox.json`), `pr checkout <n>` (checks out branch `stub-pr-<n>` in cwd), `repo clone <owner/name> <dir>` (clones from `$STUB_GH_CLONE_FROM`). Env knobs: `STUB_GH_FAIL=1` makes every call exit 1 with stderr `gh: canned failure (STUB_GH_FAIL=1)`. Consumed by Tasks 4, 6, 12, 14 and by Phase 0's GhBroker tests.

- [ ] **Step 1: Write the failing smoke test**

```ts
// src/main/github/stubGh.test.ts
import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/github/stubGh.test.ts`
Expected: FAIL — ENOENT spawning `tests/fixtures/stub-gh/gh`.

- [ ] **Step 3: Write the stub script**

```bash
#!/usr/bin/env bash
# Canned `gh` for tests. Keyed on argv so every consumer — GhBroker probes,
# GitHubService fetches, WorktreeService checkouts, the clone flow, and the
# Playwright inbox spec — runs deterministically without network or a keyring.
#
# Env knobs:
#   STUB_GH_FAIL=1           every invocation exits 1 with a canned stderr line
#   STUB_GH_CLONE_FROM=path  `repo clone` clones from this local repo instead of GitHub
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${STUB_GH_FAIL:-}" == "1" ]]; then
  echo "gh: canned failure (STUB_GH_FAIL=1)" >&2
  exit 1
fi

cmd="${1:-} ${2:-}"
case "$cmd" in
  "--version "*|"--version")
    echo "gh version 2.62.0 (stub)"
    ;;
  "auth status")
    echo "github.com"
    echo "  Logged in to github.com account SymJavi (keyring)"
    echo "  - Active account: true"
    ;;
  "auth token")
    # gh auth token --user <login>  ->  $3=--user  $4=<login>
    echo "gho_stub_token_for_${4:-unknown}"
    ;;
  "api graphql")
    cat "$here/graphql-inbox.json"
    ;;
  "pr checkout")
    # Runs with the fresh worktree as cwd; simulate by switching to a PR branch.
    git checkout -B "stub-pr-${3:?pr number}" --quiet
    ;;
  "repo clone")
    # gh repo clone <owner/name> <dir> — clone from the local fixture instead.
    git clone --quiet "${STUB_GH_CLONE_FROM:?set STUB_GH_CLONE_FROM}" "${4:?target dir}"
    ;;
  *)
    echo "stub gh: unhandled argv: $*" >&2
    exit 64
    ;;
esac
```

Then make it executable: `chmod +x tests/fixtures/stub-gh/gh`

- [ ] **Step 4: Write the canned GraphQL payload**

The shape mirrors what `gh api graphql` prints for the Task 3 query — three aliased searches. PR #42 appears under both `assigned` and `reviewRequested` on purpose: Task 3's dedupe test depends on it. `sympower/controller-app` matches the e2e fixture clone's origin remote (Task 14); `sympower/msa-resource-bff` is deliberately never cloned anywhere, so it exercises "Clone into scope…".

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
          "repository": { "nameWithOwner": "sympower/msa-resource-bff" }
        },
        {
          "__typename": "PullRequest",
          "title": "Fix auth retry loop",
          "number": 42,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/42",
          "updatedAt": "2026-08-20T08:05:00Z",
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

- [ ] **Step 5: Run the smoke test**

Run: `npx vitest run src/main/github/stubGh.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/stub-gh/gh tests/fixtures/stub-gh/graphql-inbox.json src/main/github/stubGh.test.ts
git commit -m "test: stub gh executable fixture with canned inbox payload"
```

---

### Task 3: Inbox GraphQL query and payload parsing

**Files:**
- Create: `src/main/github/parseInbox.ts`
- Test: `src/main/github/parseInbox.test.ts`

**Interfaces:**
- Consumes: `InboxItem`, `workItemKey` from `src/shared/github.ts` (Task 1); `tests/fixtures/stub-gh/graphql-inbox.json` (Task 2).
- Produces (used by Task 4):
  - `INBOX_QUERY: string` — the GraphQL document.
  - `searchStrings(accountLogin: string, org?: string): { assigned: string; authored: string; reviewRequested: string }`
  - `parseInboxPayload(payload: unknown): InboxItem[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/github/parseInbox.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './parseInbox';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

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
});

describe('parseInboxPayload', () => {
  const items = parseInboxPayload(canned);

  it('parses the canned payload into deduplicated items', () => {
    // 5 nodes in the fixture, but PR #42 appears under two roles.
    expect(items).toHaveLength(4);
  });

  it('dedupes with role precedence review-requested > assigned > author', () => {
    const pr42 = items.find((item) => item.workItem.number === 42);
    expect(pr42?.role).toBe('review-requested');
  });

  it('maps PullRequest nodes to pr work items with CI and review fields', () => {
    const pr51 = items.find((item) => item.workItem.number === 51);
    expect(pr51?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(pr51?.ciStatus).toBe('failing');
    expect(pr51?.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(pr51?.additions).toBe(210);
    expect(pr51?.deletions).toBe(88);
    expect(pr51?.state).toBe('open');
  });

  it('maps Issue nodes to issue work items without CI fields', () => {
    const issue87 = items.find((item) => item.workItem.number === 87);
    expect(issue87?.workItem.type).toBe('issue');
    expect(issue87?.role).toBe('assigned');
    expect(issue87?.ciStatus).toBeUndefined();
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('maps SUCCESS to passing and PENDING to pending', () => {
    const payload = {
      data: {
        assigned: { nodes: [] },
        authored: { nodes: [] },
        reviewRequested: {
          nodes: [
            {
              __typename: 'PullRequest',
              title: 'A',
              number: 1,
              state: 'OPEN',
              url: 'https://github.com/o/r/pull/1',
              updatedAt: '2026-08-20T00:00:00Z',
              repository: { nameWithOwner: 'o/r' },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
            },
          ],
        },
      },
    };
    expect(parseInboxPayload(payload)[0].ciStatus).toBe('pending');
  });

  it('skips malformed nodes rather than throwing', () => {
    const payload = { data: { assigned: { nodes: [{ __typename: 'Issue', title: 'no repo' }] } } };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  it('returns [] for a payload with no data at all', () => {
    expect(parseInboxPayload({})).toEqual([]);
    expect(parseInboxPayload(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/github/parseInbox.test.ts`
Expected: FAIL — cannot resolve `./parseInbox`.

- [ ] **Step 3: Write `src/main/github/parseInbox.ts`**

```ts
import type { InboxItem } from '../../shared/github';
import { workItemKey } from '../../shared/github';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Three aliased searches — assigned, authored, review-requested — in a single
 * request: GitHub's search syntax cannot OR those qualifiers in one string,
 * but one request keeps the spec's "one GraphQL search per workspace" budget.
 * `type: ISSUE` searches return both issues and PRs; `__typename` tells them
 * apart.
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
    repository { nameWithOwner }
  }
  ... on PullRequest {
    title number state url updatedAt
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

function toItem(node: SearchNode, role: InboxItem['role']): InboxItem | null {
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
    state: (node.state ?? 'OPEN').toLowerCase(),
    role,
    ciStatus: rollup ? CI_STATES[rollup] : undefined,
    reviewDecision: node.reviewDecision ?? undefined,
    updatedAt: node.updatedAt ?? '',
    url: node.url,
    additions: node.additions,
    deletions: node.deletions,
  };
}

/**
 * Flatten a gh graphql payload into deduplicated, newest-first inbox items.
 *
 * An item can match several searches; the first role below wins because the
 * reason you were asked (a requested review) outranks the reason you are
 * merely attached (assignee, author). Malformed nodes are skipped, never
 * thrown on — a half-broken payload still yields the readable remainder.
 */
export function parseInboxPayload(payload: unknown): InboxItem[] {
  const data =
    (payload as { data?: Record<string, { nodes?: SearchNode[] } | undefined> } | null)?.data ?? {};
  const roles: Array<[InboxItem['role'], string]> = [
    ['review-requested', 'reviewRequested'],
    ['assigned', 'assigned'],
    ['author', 'authored'],
  ];
  const byKey = new Map<string, InboxItem>();
  for (const [role, alias] of roles) {
    for (const node of data[alias]?.nodes ?? []) {
      const item = toItem(node, role);
      if (!item) continue;
      const key = workItemKey(item.workItem);
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/main/github/parseInbox.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/github/parseInbox.ts src/main/github/parseInbox.test.ts
git commit -m "feat: inbox GraphQL query and payload parsing"
```

---

### Task 4: `GitHubService` — cached in main, pushed to renderers, degrades on failure

**Files:**
- Create: `src/main/github/GitHubService.ts`
- Test: `src/main/github/GitHubService.test.ts`

**Interfaces:**
- Consumes: `INBOX_QUERY`, `searchStrings`, `parseInboxPayload` (Task 3); `InboxItem`, `InboxSnapshot`, `sameWorkItem` (Task 1); the stub `gh` (Task 2); `Workspace` v6 and `WorkItemRef` from Phase 0.
- Produces (used by Tasks 7 and 8):
  - `class GitHubService { constructor(deps: GitHubServiceDeps); start(): void; stop(): void; onWindowFocus(): void; getSnapshot(workspaceId: string): InboxSnapshot | null; refresh(workspaceId: string): Promise<void>; findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined }`
  - `interface GitHubServiceDeps { getWorkspace(workspaceId: string): Workspace | undefined; getGitHubWorkspaceIds(): string[]; token(accountLogin: string): Promise<string>; ghBinary(): Promise<string>; baseEnv(): NodeJS.ProcessEnv; broadcast(snapshot: InboxSnapshot): void }`
  - `INBOX_REFRESH_INTERVAL_MS = 180_000`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/github/GitHubService.test.ts
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxSnapshot } from '../../shared/github';
import type { Workspace } from '../../shared/workspace';
import { GitHubService, INBOX_REFRESH_INTERVAL_MS, type GitHubServiceDeps } from './GitHubService';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

// v6 shape from Phase 0's contract; cast keeps the fixture honest but short.
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [],
    groups: [],
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

function makeService(overrides: Partial<GitHubServiceDeps> = {}) {
  const broadcasts: InboxSnapshot[] = [];
  const workspace = makeWorkspace();
  const service = new GitHubService({
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getGitHubWorkspaceIds: () => [workspace.id],
    token: async () => 'gho_test_token',
    ghBinary: async () => STUB,
    baseEnv: () => ({ ...process.env }),
    broadcast: (snapshot) => broadcasts.push(snapshot),
    ...overrides,
  });
  return { service, broadcasts, workspace };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GitHubService.refresh', () => {
  it('fetches through gh, parses, caches, and broadcasts', async () => {
    const { service, broadcasts } = makeService();

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.items.length).toBe(4);
    expect(snapshot!.fetchedAt).toBeGreaterThan(0);
    expect(snapshot!.error).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].workspaceId).toBe('ws-1');
  });

  it('keeps the last good items and stamps the error when gh fails', async () => {
    let fail = false;
    const { service } = makeService({
      baseEnv: () => ({ ...process.env, ...(fail ? { STUB_GH_FAIL: '1' } : {}) }),
    });

    await service.refresh('ws-1');
    const good = service.getSnapshot('ws-1')!;

    fail = true;
    await service.refresh('ws-1');
    const degraded = service.getSnapshot('ws-1')!;

    expect(degraded.items).toEqual(good.items);
    expect(degraded.fetchedAt).toBe(good.fetchedAt);
    expect(degraded.error).toContain('canned failure');
  });

  it('degrades the same way when the token cannot be borrowed', async () => {
    const { service } = makeService({
      token: async () => {
        throw new Error('gh: no accounts logged in');
      },
    });

    await service.refresh('ws-1');

    const snapshot = service.getSnapshot('ws-1')!;
    expect(snapshot.items).toEqual([]);
    expect(snapshot.error).toContain('no accounts logged in');
  });

  it('does nothing for a workspace without a github binding', async () => {
    const { service, broadcasts } = makeService({
      getWorkspace: () => makeWorkspace({ github: undefined }),
    });

    await service.refresh('ws-1');

    expect(service.getSnapshot('ws-1')).toBeNull();
    expect(broadcasts).toHaveLength(0);
  });

  it('coalesces concurrent refreshes of one workspace', async () => {
    const { service, broadcasts } = makeService();

    await Promise.all([service.refresh('ws-1'), service.refresh('ws-1')]);

    expect(broadcasts).toHaveLength(1);
  });
});

describe('GitHubService.findItem', () => {
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

describe('GitHubService cadence', () => {
  it('polls every workspace on the 3-minute timer', () => {
    vi.useFakeTimers();
    const getGitHubWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getGitHubWorkspaceIds });

    service.start();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
    service.stop();
    vi.advanceTimersByTime(INBOX_REFRESH_INTERVAL_MS);
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
  });

  it('debounces window-focus refreshes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
    const getGitHubWorkspaceIds = vi.fn(() => [] as string[]);
    const { service } = makeService({ getGitHubWorkspaceIds });

    service.onWindowFocus();
    service.onWindowFocus();
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-20T09:01:00Z'));
    service.onWindowFocus();
    expect(getGitHubWorkspaceIds).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/github/GitHubService.test.ts`
Expected: FAIL — cannot resolve `./GitHubService`.

- [ ] **Step 3: Write `src/main/github/GitHubService.ts`**

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InboxItem, InboxSnapshot, WorkItemRef } from '../../shared/github';
import { sameWorkItem } from '../../shared/github';
import type { Workspace } from '../../shared/workspace';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './parseInbox';

const execFileAsync = promisify(execFile);

/** Spec cadence: a timer refresh every 3 minutes. */
export const INBOX_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
/** Focus events arrive in bursts (click-through between windows); refresh once. */
const FOCUS_REFRESH_MIN_GAP_MS = 30 * 1000;

export interface GitHubServiceDeps {
  getWorkspace(workspaceId: string): Workspace | undefined;
  /** Every workspace with a github binding — the set the timer and focus poll. */
  getGitHubWorkspaceIds(): string[];
  /** GhBroker.token — throws with gh's stderr; the message becomes the label. */
  token(accountLogin: string): Promise<string>;
  ghBinary(): Promise<string>;
  /** The ambient login env; GH_TOKEN is layered on top per call. */
  baseEnv(): NodeJS.ProcessEnv;
  /** Push one workspace's snapshot to every renderer. */
  broadcast(snapshot: InboxSnapshot): void;
}

function describeExecError(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
  if (stderr) return stderr;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The per-workspace GitHub Inbox: one fetcher, one cache, one rate budget.
 *
 * Renderers never fetch. Main refreshes on window focus, on a manual intent,
 * and on a timer; results land in an in-memory cache and go out on
 * github:inbox-changed. A failed refresh never discards the last good list —
 * it re-broadcasts it with `error` set, and the UI labels the staleness.
 */
export class GitHubService {
  private readonly snapshots = new Map<string, InboxSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastFocusRefresh = 0;

  constructor(private readonly deps: GitHubServiceDeps) {}

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
    await Promise.all(this.deps.getGitHubWorkspaceIds().map((id) => this.refresh(id)));
  }

  private async doRefresh(workspaceId: string): Promise<void> {
    const workspace = this.deps.getWorkspace(workspaceId);
    const github = workspace?.github;
    if (!github) {
      // Unbound (or unbound since last fetch): nothing to show, nothing stale.
      this.snapshots.delete(workspaceId);
      return;
    }

    const previous = this.snapshots.get(workspaceId);
    try {
      const [binary, token] = await Promise.all([
        this.deps.ghBinary(),
        this.deps.token(github.accountLogin),
      ]);
      const searches = searchStrings(github.accountLogin, github.org);
      const { stdout } = await execFileAsync(
        binary,
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
        {
          env: { ...this.deps.baseEnv(), GH_TOKEN: token } as { [key: string]: string },
          maxBuffer: 10 * 1024 * 1024,
        }
      );
      this.adopt({
        workspaceId,
        items: parseInboxPayload(JSON.parse(stdout)),
        fetchedAt: Date.now(),
      });
    } catch (error) {
      // Degrade, never dialog: keep the last good list and its age, label why.
      this.adopt({
        workspaceId,
        items: previous?.items ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: describeExecError(error),
      });
    }
  }

  private adopt(snapshot: InboxSnapshot): void {
    this.snapshots.set(snapshot.workspaceId, snapshot);
    this.deps.broadcast(snapshot);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/main/github/GitHubService.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/github/GitHubService.ts src/main/github/GitHubService.test.ts
git commit -m "feat: GitHubService fetches per-workspace inbox via gh, caches and degrades"
```

---

### Task 5: `WorktreeService` — remote normalization and `resolveRepo`

**Files:**
- Create: `src/main/WorktreeService.ts`
- Test: `src/main/WorktreeService.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `Scope` (v6, Phase 0); `WorkItemRef` (Phase 0).
- Produces (Task 6 extends the same class; Tasks 7–8 consume):
  - `normalizeRemote(url: string): string | null` — `owner/repo`, lowercased, from scp/https/ssh remote forms.
  - `worktreeDirName(workItem: WorkItemRef): string` — `<repo-basename>-<type>-<number>`.
  - `class WorktreeService { constructor(root?: string, ghBinary?: () => Promise<string>); resolveRepo(workspace: Workspace, repo: string): string | null; invalidate(): void }`
  - Default root: `process.env.CONSOLA_WORKTREES_DIR ?? path.join(os.homedir(), '.consola', 'worktrees')` (env override is the Playwright seam).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/WorktreeService.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Scope, Workspace } from '../shared/workspace';
import { WorktreeService, normalizeRemote, worktreeDirName } from './WorktreeService';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir: string, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

function makeScope(dir: string, isGitRepo: boolean): Scope {
  return { id: `scope-${path.basename(dir)}`, name: path.basename(dir), path: dir, isGitRepo, createdAt: Date.now() };
}

function makeWorkspace(scopes: Scope[]): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes,
    groups: [],
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
  } as Workspace;
}

describe('normalizeRemote', () => {
  it('parses scp-style ssh remotes', () => {
    expect(normalizeRemote('git@github.com:Sympower/Controller-App.git')).toBe(
      'sympower/controller-app'
    );
  });

  it('parses https remotes with and without .git', () => {
    expect(normalizeRemote('https://github.com/sympower/flex-portal.git')).toBe(
      'sympower/flex-portal'
    );
    expect(normalizeRemote('https://github.com/sympower/flex-portal')).toBe(
      'sympower/flex-portal'
    );
  });

  it('parses ssh:// remotes', () => {
    expect(normalizeRemote('ssh://git@github.com/sympower/flextools.git')).toBe(
      'sympower/flextools'
    );
  });

  it('returns null for remotes it cannot read', () => {
    expect(normalizeRemote('/some/local/path')).toBeNull();
    expect(normalizeRemote('')).toBeNull();
  });
});

describe('worktreeDirName', () => {
  it('is <repo-basename>-<type>-<number>', () => {
    expect(
      worktreeDirName({ provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 })
    ).toBe('controller-app-pr-51');
    expect(
      worktreeDirName({ provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 })
    ).toBe('msa-resource-bff-issue-87');
  });
});

describe('WorktreeService.resolveRepo', () => {
  let repoScope: string;
  let containerScope: string;
  let childClone: string;

  beforeAll(() => {
    repoScope = path.join(tmpDir('consola-wt-repo-'), 'controller-app');
    initRepo(repoScope, 'git@github.com:sympower/controller-app.git');

    containerScope = tmpDir('consola-wt-container-');
    childClone = path.join(containerScope, 'flex-portal');
    initRepo(childClone, 'https://github.com/sympower/flex-portal.git');
    // A non-repo child, to prove the scan skips it quietly.
    fs.mkdirSync(path.join(containerScope, 'notes'), { recursive: true });
  });

  it('matches a repo scope on its origin remote', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true)]);
    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBe(repoScope);
  });

  it('scans a container scope one level deep', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/flex-portal')).toBe(childClone);
  });

  it('returns null when no scope holds the repo', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true), makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/msa-resource-bff')).toBeNull();
  });

  it('caches remote lookups until invalidate()', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const dir = path.join(tmpDir('consola-wt-cache-'), 'renamed');
    initRepo(dir, 'git@github.com:sympower/old-name.git');
    const workspace = makeWorkspace([makeScope(dir, true)]);

    expect(service.resolveRepo(workspace, 'sympower/old-name')).toBe(dir);

    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'git@github.com:sympower/new-name.git']);
    // Stale until told otherwise — scope changes are what invalidate it.
    expect(service.resolveRepo(workspace, 'sympower/new-name')).toBeNull();

    service.invalidate();
    expect(service.resolveRepo(workspace, 'sympower/new-name')).toBe(dir);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: FAIL — cannot resolve `./WorktreeService`.

- [ ] **Step 3: Write `src/main/WorktreeService.ts` (resolve half)**

```ts
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { WorkItemRef } from '../shared/github';
import type { Workspace } from '../shared/workspace';

const execFileAsync = promisify(execFile);

/**
 * `owner/repo` (lowercased) from a git remote URL, or null.
 *
 * Lowercased on both sides of every comparison because GitHub treats repo
 * names case-insensitively while remembering the display casing — a clone made
 * from a differently-cased URL must still resolve.
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (!trimmed) return null;
  // scp-style: git@github.com:owner/repo
  const scp = trimmed.match(/^[^@\s/]+@[^:\s]+:(.+)$/);
  // url-style: https://github.com/owner/repo or ssh://git@github.com/owner/repo
  const web = trimmed.match(/^\w+:\/\/[^/]+\/(.+)$/);
  const repoPath = (scp?.[1] ?? web?.[1])?.replace(/^\/+/, '');
  if (!repoPath) return null;
  const parts = repoPath.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

/** Spec naming: `<repo-basename>-<type>-<number>`, e.g. controller-app-pr-51. */
export function worktreeDirName(workItem: WorkItemRef): string {
  const basename = workItem.repo.split('/').pop() ?? workItem.repo;
  return `${basename}-${workItem.type}-${workItem.number}`;
}

/**
 * Owns work-item worktrees under ~/.consola/worktrees/ and the mapping from
 * remote repos to local clones.
 *
 * The mapping scans the workspace's scopes: a repo scope matches on its origin
 * remote; a container scope scans its direct children. Remote lookups are
 * cached per directory and invalidated when scopes change (wired to
 * WorkspaceService.onChange) — a `git remote get-url` per directory per scan
 * would otherwise run on every Inbox paint.
 */
export class WorktreeService {
  /** Directory -> normalized origin remote (or null for non-repos). */
  private readonly remoteCache = new Map<string, string | null>();

  constructor(
    private readonly root: string = process.env.CONSOLA_WORKTREES_DIR ??
      path.join(os.homedir(), '.consola', 'worktrees'),
    private readonly ghBinary: () => Promise<string> = async () =>
      process.env.CONSOLA_GH_PATH ?? 'gh'
  ) {}

  public invalidate(): void {
    this.remoteCache.clear();
  }

  /** Local clone for a remote repo, found through the workspace's scopes. */
  public resolveRepo(workspace: Workspace, repo: string): string | null {
    const target = repo.toLowerCase();
    for (const scope of workspace.scopes) {
      if (this.originOf(scope.path) === target) return scope.path;
      if (!scope.isGitRepo) {
        for (const child of this.childDirs(scope.path)) {
          if (this.originOf(child) === target) return child;
        }
      }
    }
    return null;
  }

  private childDirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(dir, entry.name));
    } catch {
      // A scope pointing at a moved folder resolves nothing; the launch path
      // reports "not cloned", which offers the clone flow — strictly better
      // than throwing here.
      return [];
    }
  }

  private originOf(dir: string): string | null {
    const cached = this.remoteCache.get(dir);
    if (cached !== undefined) return cached;
    let origin: string | null = null;
    try {
      const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      origin = normalizeRemote(url);
    } catch {
      origin = null; // Not a repo, or no origin — either way, not a match.
    }
    this.remoteCache.set(dir, origin);
    return origin;
  }
}
```

(`execFileAsync` and `WorkItemRef` are imported now because Task 6 adds the async worktree methods to this same class; the unused-var lint pass, if any, happens at Task 6.)

Note for the implementer: if `execFileAsync` triggers a no-unused-vars error at this step, add it in Task 6 instead — the import lines above are listed complete so both tasks agree on them.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: PASS (resolve/normalize/name describes all green).

- [ ] **Step 5: Commit**

```bash
git add src/main/WorktreeService.ts src/main/WorktreeService.test.ts
git commit -m "feat: WorktreeService resolves remote repos through workspace scopes"
```

---

### Task 6: `WorktreeService` — `ensureWorktree` and `prune`

**Files:**
- Modify: `src/main/WorktreeService.ts` (add methods to the Task 5 class)
- Test: `src/main/WorktreeService.test.ts` (add describes)

**Interfaces:**
- Consumes: Task 5's class and helpers; stub `gh` (Task 2) for `pr checkout`.
- Produces (used by Tasks 7 and 8):
  - `ensureWorktree(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<string>` — idempotent; recreates a deleted worktree; PRs get `gh pr checkout <n>` inside the worktree, issues get branch `consola/issue-<n>`; rejects with git/gh stderr as the Error message.
  - `prune(worktreePath: string): Promise<void>` — rejects while the worktree holds uncommitted changes; otherwise `git worktree remove`.

- [ ] **Step 1: Add the failing tests**

Append to `src/main/WorktreeService.test.ts`:

```ts
const STUB_GH = path.resolve(__dirname, '../../tests/fixtures/stub-gh/gh');

function initCloneWithCommit(dir: string, origin: string): void {
  initRepo(dir, origin);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

function currentBranch(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

describe('WorktreeService.ensureWorktree', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;
  const issue87 = { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 87 } as const;

  function setup() {
    const clone = path.join(tmpDir('consola-wt-clone-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const root = tmpDir('consola-wt-worktrees-');
    const service = new WorktreeService(root, async () => STUB_GH);
    return { clone, root, service };
  }

  it('creates a PR worktree under the spec name and checks the PR out via gh', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(dir).toBe(path.join(root, 'controller-app-pr-51'));
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(currentBranch(dir)).toBe('stub-pr-51'); // the stub's checkout branch
  });

  it('is idempotent — a second call returns the same directory untouched', async () => {
    const { clone, service } = setup();

    const first = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.writeFileSync(path.join(first, 'wip.txt'), 'uncommitted');
    const second = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(first, 'wip.txt'), 'utf8')).toBe('uncommitted');
  });

  it('recreates a worktree whose directory was deleted', async () => {
    const { clone, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.rmSync(dir, { recursive: true, force: true });

    const again = await service.ensureWorktree(clone, pr51, { ...process.env });
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  });

  it('creates issue worktrees on a consola/issue-<n> branch, reusing it if present', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(dir).toBe(path.join(root, 'controller-app-issue-87'));
    expect(currentBranch(dir)).toBe('consola/issue-87');

    fs.rmSync(dir, { recursive: true, force: true });
    const again = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(currentBranch(again)).toBe('consola/issue-87');
  });

  it('rejects with git stderr when the clone cannot host a worktree', async () => {
    const empty = path.join(tmpDir('consola-wt-empty-'), 'empty');
    initRepo(empty, 'git@github.com:sympower/empty.git'); // no commits: worktree add fails
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);

    await expect(
      service.ensureWorktree(empty, pr51, { ...process.env })
    ).rejects.toThrow(/./); // the git message travels up verbatim
  });
});

describe('WorktreeService.prune', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;

  it('refuses while the worktree holds uncommitted changes', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');
    await expect(service.prune(dir)).rejects.toThrow(/uncommitted/);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes a clean worktree and unregisters it', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    await service.prune(dir);

    expect(fs.existsSync(dir)).toBe(false);
    const list = execFileSync('git', ['-C', clone, 'worktree', 'list'], { encoding: 'utf8' });
    expect(list).not.toContain('controller-app-pr-51');
  });
});
```

- [ ] **Step 2: Run to verify the new describes fail**

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: FAIL — `ensureWorktree` / `prune` are not functions; Task 5's describes still pass.

- [ ] **Step 3: Add the methods to the class**

Append inside `WorktreeService` (below `resolveRepo`):

```ts
  /**
   * The worktree for a work item, creating or recreating it as needed.
   *
   * Idempotent by design: resuming a session whose worktree was deleted lands
   * here again before the PTY spawns, and the checkout must simply happen
   * again. A linked worktree keeps a `.git` *file* pointing at the clone, so
   * its presence is the "already exists" signal.
   *
   * PRs: `git worktree add --detach` then `gh pr checkout <n>` inside it —
   * gh owns the branch naming and the fetch, with GH_TOKEN in `env`.
   * Issues: a `consola/issue-<n>` branch, created on first use, reused after.
   */
  public async ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string> {
    const dir = path.join(this.root, worktreeDirName(workItem));
    if (fs.existsSync(path.join(dir, '.git'))) return dir;

    await fs.promises.mkdir(this.root, { recursive: true });
    // A worktree whose directory was deleted stays registered and would make
    // `worktree add` refuse; prune drops stale registrations only.
    await this.run('git', clonePath, ['worktree', 'prune'], env);

    if (workItem.type === 'pr') {
      await this.run('git', clonePath, ['worktree', 'add', '--detach', dir], env);
      await this.run(await this.ghBinary(), dir, ['pr', 'checkout', String(workItem.number)], env);
    } else {
      const branch = `consola/issue-${workItem.number}`;
      const existing = await this.run('git', clonePath, ['branch', '--list', branch], env);
      await this.run(
        'git',
        clonePath,
        existing.trim()
          ? ['worktree', 'add', dir, branch]
          : ['worktree', 'add', '-b', branch, dir],
        env
      );
    }
    return dir;
  }

  /**
   * Remove a work-item worktree — offered, never automatic.
   *
   * Refuses while the worktree holds uncommitted changes: pruning is cleanup,
   * and cleanup must never be the thing that loses work.
   */
  public async prune(worktreePath: string): Promise<void> {
    const status = await this.run('git', worktreePath, ['status', '--porcelain'], process.env);
    if (status.trim()) {
      throw new Error(
        `Refusing to prune ${worktreePath}: it has uncommitted changes. Commit or discard them first.`
      );
    }
    const commonDir = (
      await this.run(
        'git',
        worktreePath,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        process.env
      )
    ).trim();
    const mainRoot = path.dirname(commonDir);
    await this.run('git', mainRoot, ['worktree', 'remove', worktreePath], process.env);
  }

  /** Run a subprocess; on failure surface stderr as the Error message. */
  private async run(
    binary: string,
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<string> {
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
```

- [ ] **Step 4: Run the whole file's tests**

Run: `npx vitest run src/main/WorktreeService.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/main/WorktreeService.ts src/main/WorktreeService.test.ts
git commit -m "feat: worktree creation, idempotent recreation, and guarded prune"
```

---

### Task 7: `launchWorkItem` — the one-click pipeline

**Files:**
- Create: `src/main/github/launchWorkItem.ts`
- Test: `src/main/github/launchWorkItem.test.ts`

**Interfaces:**
- Consumes: `sameWorkItem`, `InboxItem`, `WorkItemRef` (Task 1 / Phase 0); `WorkItemLaunchResult` (Task 1, from `src/shared/types.ts`); `Workspace`, `Session`, `NewSessionFields`, `Scope` v6 (Phase 0).
- Produces (used by Task 8):
  - `interface WorkItemLaunchDeps { getWorkspace(id: string): Workspace | undefined; createSession(workspaceId: string, fields: NewSessionFields): Session | undefined; resolveRepo(workspace: Workspace, repo: string): string | null; ensureWorktree(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<string>; composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>; findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined }`
  - `launchWorkItem(deps: WorkItemLaunchDeps, workspaceId: string, workItem: WorkItemRef): Promise<WorkItemLaunchResult>`
  - `buildSeedPrompt(workItem: WorkItemRef, item?: InboxItem): string`
  - `workItemSessionName(workItem: WorkItemRef, item?: InboxItem): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/github/launchWorkItem.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import {
  buildSeedPrompt,
  launchWorkItem,
  workItemSessionName,
  type WorkItemLaunchDeps,
} from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  state: 'open',
  role: 'review-requested',
  ciStatus: 'failing',
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

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
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
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
    composeEnv: async () => ({ GH_TOKEN: 'gho_test' }),
    findItem: () => item51,
    ...overrides,
  };
  return { deps, created };
}

describe('launchWorkItem', () => {
  it('re-attaches to an existing session for the same work item, touching nothing', async () => {
    const existing = {
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
      workItem: { ...pr51, repo: 'Sympower/Controller-App' }, // casing differs on purpose
      createdAt: 1,
      lastActiveAt: 1,
    } as unknown as Session;
    const workspace = makeWorkspace({ sessions: [existing] });
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: true, session: existing, reattached: true });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace, { resolveRepo: () => null });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace, {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  it('creates the record with the matched scope, worktree cwd, and work item', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reattached).toBe(false);
    expect(result.seedPrompt).toContain('#51');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'PR #51 - Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
  });

  it('errors plainly for a workspace without a github binding', async () => {
    const workspace = makeWorkspace({ github: undefined });
    const { deps } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51);

    expect(result.ok).toBe(false);
  });
});

describe('buildSeedPrompt', () => {
  it('describes the item and the worktree, and starts from gh view', () => {
    const prompt = buildSeedPrompt(pr51, item51);
    expect(prompt).toContain('pull request #51');
    expect(prompt).toContain('Extract billing client');
    expect(prompt).toContain('sympower/controller-app');
    expect(prompt).toContain('gh pr view 51');
    expect(prompt).toContain('worktree');
  });

  it('still reads sensibly without a cached inbox item', () => {
    const prompt = buildSeedPrompt({ ...pr51, type: 'issue', number: 87 });
    expect(prompt).toContain('issue #87');
    expect(prompt).toContain('gh issue view 87');
  });
});

describe('workItemSessionName', () => {
  it('uses the title when the inbox holds one, a plain label when not', () => {
    expect(workItemSessionName(pr51, item51)).toBe('PR #51 - Extract billing client');
    expect(workItemSessionName(pr51)).toBe('PR #51');
    expect(workItemSessionName({ ...pr51, type: 'issue', number: 87 })).toBe('Issue #87');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/github/launchWorkItem.test.ts`
Expected: FAIL — cannot resolve `./launchWorkItem`.

- [ ] **Step 3: Write `src/main/github/launchWorkItem.ts`**

```ts
import * as path from 'path';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import { sameWorkItem } from '../../shared/github';
import type { WorkItemLaunchResult } from '../../shared/types';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus GH_TOKEN for this account. Composed main-side only. */
  composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
}

/** Same shape as the renderer's generateSessionInstanceId — one id namespace. */
function generateInstanceId(workspaceId: string): string {
  const suffix = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  return `workspace-${workspaceId}-session-${suffix}`;
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
 * The prompt seeded into the fresh session.
 *
 * Delivered through the existing guarded queue (TerminalService.queuePrompt via
 * TerminalCreateOptions.initialPrompt), so it can never answer a trust gate or
 * permission menu. It tells the agent where it is and to read the item with gh
 * first — the token in its env makes that work as the workspace's account.
 */
export function buildSeedPrompt(workItem: WorkItemRef, item?: InboxItem): string {
  const noun = workItem.type === 'pr' ? 'pull request' : 'issue';
  const ghNoun = workItem.type === 'pr' ? 'pr' : 'issue';
  const title = item ? ` ("${item.title}")` : '';
  const task =
    workItem.type === 'pr'
      ? 'review the changes and summarise your findings before writing any review comments'
      : 'investigate it and propose a plan before changing anything';
  return (
    `This session is for ${noun} #${workItem.number}${title} in ${workItem.repo}. ` +
    `You are in a dedicated git worktree for it, so the user's own checkout stays untouched. ` +
    `Start with \`gh ${ghNoun} view ${workItem.number}\` to read it, then ${task}.`
  );
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
 * existing session rather than minting a rival.
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
  if (!workspace.github) {
    return { ok: false, reason: 'error', message: 'This workspace has no GitHub account bound.' };
  }

  const existing = workspace.sessions.find((session) =>
    sameWorkItem(session.workItem, workItem)
  );
  if (existing) return { ok: true, session: existing, reattached: true };

  const clonePath = deps.resolveRepo(workspace, workItem.repo);
  if (!clonePath) return { ok: false, reason: 'not-cloned' };

  let worktreePath: string;
  try {
    const env = await deps.composeEnv(workspace.github.accountLogin);
    worktreePath = await deps.ensureWorktree(clonePath, workItem, env);
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const item = deps.findItem(workspaceId, workItem);
  const session = deps.createSession(workspaceId, {
    name: workItemSessionName(workItem, item),
    workspaceId,
    instanceId: generateInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scopeIdForPath(workspace, clonePath),
    cwd: worktreePath,
    kind: 'interactive',
    workItem,
  });
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return { ok: true, session, seedPrompt: buildSeedPrompt(workItem, item), reattached: false };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/main/github/launchWorkItem.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Run the full unit suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS across the board.

- [ ] **Step 6: Commit**

```bash
git add src/main/github/launchWorkItem.ts src/main/github/launchWorkItem.test.ts
git commit -m "feat: work-item launch pipeline with re-attach and atomic ordering"
```

---

### Task 8: Main-process wiring — IPC handlers, preload, `githubBridge`

**Files:**
- Modify: `src/main/ipc-handlers.ts` (new module-level services + handlers in `setupIpcHandlers`, teardown in `cleanupIpcHandlers`)
- Modify: `src/preload/preload.ts` (inbox members on the `githubAPI` bridge object)
- Modify: `src/renderer/services/githubBridge.ts` (Phase 0 creates it for the probe; add inbox methods — if it does not exist, create it with the `getAPI()` null-guard pattern from `gitBridge.ts`)
- Test: `npm run typecheck` (wiring only — every piece behind it is unit-tested in Tasks 3–7; house precedent is that `ipc-handlers.ts` itself has no test file)

**Interfaces:**
- Consumes: `GitHubService` (Task 4), `WorktreeService` (Tasks 5–6), `launchWorkItem` (Task 7), `GhBroker` (Phase 0), `getLoginEnv` (`src/main/LoginEnvironment.ts`), channels + `GitHubInboxAPI` (Task 1), `WorkspaceService` (existing).
- Produces (used by Tasks 9, 12, 14):
  - IPC handlers for `GITHUB_GET_INBOX`, `GITHUB_REFRESH_INBOX`, `GITHUB_RESOLVE_REPOS`, `GITHUB_LAUNCH_WORK_ITEM`; broadcast on `GITHUB_INBOX_CHANGED`; focus + timer refresh live. (`GITHUB_CLONE_REPO` is Task 12.)
  - `window.githubAPI.getInbox/refreshInbox/resolveRepos/launchWorkItem/onInboxChanged` via preload.
  - `githubBridge.getInbox/refreshInbox/resolveRepos/launchWorkItem/onInboxChanged` renderer-side.

- [ ] **Step 1: Wire the services in `src/main/ipc-handlers.ts`**

Add imports at the top:

```ts
import { GhBroker } from './github/GhBroker';
import { GitHubService } from './github/GitHubService';
import { launchWorkItem } from './github/launchWorkItem';
import { WorktreeService } from './WorktreeService';
import { getLoginEnv } from './LoginEnvironment';
import type { InboxSnapshot, WorkItemRef } from '../shared/github';
```

(If Phase 0 already constructs a `GhBroker` instance in this file for its probe handler, reuse that instance instead of constructing a second one — its token cache should be shared. The code below assumes none exists yet.)

Add module-level state next to `terminalManager`:

```ts
// GitHub organs: one broker, one inbox fetcher, one worktree owner — all main-side.
let ghBroker: GhBroker | null = null;
let githubService: GitHubService | null = null;
let worktreeService: WorktreeService | null = null;
let onBrowserWindowFocus: (() => void) | null = null;
```

Inside `setupIpcHandlers()`, after the harness handlers and before the terminal section, add:

```ts
    const broker = new GhBroker();
    ghBroker = broker;

    // The gh binary, resolved once. CONSOLA_GH_PATH is the test seam: the
    // Playwright suite points it at the stub gh fixture so no network or
    // keyring is ever touched.
    let cachedGhBinary: string | null = null;
    const resolveGhBinary = async (): Promise<string> => {
        if (process.env.CONSOLA_GH_PATH) return process.env.CONSOLA_GH_PATH;
        if (!cachedGhBinary) {
            const probe = await broker.probe();
            cachedGhBinary = probe.available && probe.resolvedBinary ? probe.resolvedBinary : 'gh';
        }
        return cachedGhBinary;
    };

    // Login env plus this account's token — composed here and only here, so a
    // token never crosses IPC and never lands in a renderer-bound payload.
    const composeGhEnv = async (accountLogin: string): Promise<NodeJS.ProcessEnv> => ({
        ...getLoginEnv(),
        GH_TOKEN: await broker.token(accountLogin),
    });

    const worktrees = new WorktreeService(undefined, resolveGhBinary);
    worktreeService = worktrees;
    // The remote->path map is only as fresh as the scope list that feeds it.
    workspaces.onChange(() => worktrees.invalidate());

    const github = new GitHubService({
        getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
        getGitHubWorkspaceIds: () =>
            workspaces.getAll().filter((workspace) => workspace.github).map((workspace) => workspace.id),
        token: (login) => broker.token(login),
        ghBinary: resolveGhBinary,
        baseEnv: () => ({ ...getLoginEnv() }),
        broadcast: (snapshot: InboxSnapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (!window.isDestroyed()) {
                    window.webContents.send(IPC_CHANNELS.GITHUB_INBOX_CHANGED, snapshot);
                }
            }
        },
    });
    githubService = github;
    github.start();
    onBrowserWindowFocus = () => github.onWindowFocus();
    app.on('browser-window-focus', onBrowserWindowFocus);

    // Cached snapshot, or null. Null also kicks a background refresh, so the
    // first Inbox open populates itself through the push channel.
    ipcMain.handle(IPC_CHANNELS.GITHUB_GET_INBOX, (_event, workspaceId: string) => {
        const snapshot = github.getSnapshot(workspaceId);
        if (!snapshot) void github.refresh(workspaceId);
        return snapshot;
    });

    ipcMain.handle(IPC_CHANNELS.GITHUB_REFRESH_INBOX, (_event, workspaceId: string) =>
        github.refresh(workspaceId)
    );

    // Which of these remote repos have a local clone in this workspace's
    // scopes — the Inbox uses it to label buttons ("Review" vs "Clone into
    // scope..."), read-only and token-free.
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_RESOLVE_REPOS,
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
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM,
        (_event, workspaceId: string, workItem: WorkItemRef) =>
            launchWorkItem(
                {
                    getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
                    createSession: (id, fields) => workspaces.createSession(id, fields),
                    resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
                    ensureWorktree: (clonePath, item, env) =>
                        worktrees.ensureWorktree(clonePath, item, env),
                    composeEnv: composeGhEnv,
                    findItem: (id, ref) => github.findItem(id, ref),
                },
                workspaceId,
                workItem
            )
    );
```

Note: `workspaces.createSession` accepts the v6 `NewSessionFields` (with `scopeId`, `cwd`, `kind`, `workItem`) per Phase 0's contract — no change to `WorkspaceService` is needed here, and its `onChange` broadcast already pushes the new session to every window.

In `cleanupIpcHandlers()`, add before the terminal teardown:

```ts
    githubService?.stop();
    githubService = null;
    worktreeService = null;
    ghBroker = null;
    if (onBrowserWindowFocus) {
        app.removeListener('browser-window-focus', onBrowserWindowFocus);
        onBrowserWindowFocus = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_GET_INBOX);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_REFRESH_INBOX);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_RESOLVE_REPOS);
    ipcMain.removeHandler(IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM);
```

- [ ] **Step 2: Expose the API in `src/preload/preload.ts`**

Add to the imports: `InboxSnapshot` from `../shared/github`, `WorkItemLaunchResult` from `../shared/types`, and `WorkItemRef` from `../shared/github`.

Add the inbox members to the `githubAPI` object Phase 0 exposes (create the `contextBridge.exposeInMainWorld('githubAPI', {...})` block if Phase 0 did not):

```ts
    getInbox: (workspaceId: string): Promise<InboxSnapshot | null> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_GET_INBOX, workspaceId),

    refreshInbox: (workspaceId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_REFRESH_INBOX, workspaceId),

    resolveRepos: (workspaceId: string, repos: string[]): Promise<Record<string, string | null>> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_RESOLVE_REPOS, workspaceId, repos),

    launchWorkItem: (workspaceId: string, workItem: WorkItemRef): Promise<WorkItemLaunchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LAUNCH_WORK_ITEM, workspaceId, workItem),

    onInboxChanged: (callback: (snapshot: InboxSnapshot) => void) =>
        subscribe<InboxSnapshot>(IPC_CHANNELS.GITHUB_INBOX_CHANGED, callback),
```

- [ ] **Step 3: Add the bridge methods in `src/renderer/services/githubBridge.ts`**

Following the `gitBridge.ts` null-guard pattern (the whole file, if Phase 0 has not created it — otherwise append the methods and reuse its `getAPI`):

```ts
import type { InboxSnapshot, WorkItemRef } from '../../shared/github';
import type { WorkItemLaunchResult } from '../../shared/types';

/**
 * GitHub Bridge - isolates all window.githubAPI access to this single file.
 * Read-only against GitHub by construction: nothing here writes to GitHub.
 */
function getAPI() {
  if (typeof window !== 'undefined' && window.githubAPI) {
    return window.githubAPI;
  }
  return null;
}

export const githubBridge = {
  getInbox: async (workspaceId: string): Promise<InboxSnapshot | null> => {
    const api = getAPI();
    if (!api) return null;
    return api.getInbox(workspaceId);
  },

  refreshInbox: async (workspaceId: string): Promise<void> => {
    const api = getAPI();
    if (!api) return;
    await api.refreshInbox(workspaceId);
  },

  resolveRepos: async (
    workspaceId: string,
    repos: string[]
  ): Promise<Record<string, string | null>> => {
    const api = getAPI();
    if (!api) return {};
    return api.resolveRepos(workspaceId, repos);
  },

  launchWorkItem: async (
    workspaceId: string,
    workItem: WorkItemRef
  ): Promise<WorkItemLaunchResult | null> => {
    const api = getAPI();
    if (!api) return null;
    return api.launchWorkItem(workspaceId, workItem);
  },

  onInboxChanged: (callback: (snapshot: InboxSnapshot) => void): (() => void) => {
    const api = getAPI();
    if (!api) return () => {};
    return api.onInboxChanged(callback);
  },
};
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: clean; no behavior change reachable yet from the UI.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/services/githubBridge.ts
git commit -m "feat: wire inbox IPC handlers, preload API, and github bridge"
```

---

### Task 9: `inboxStore` — push-fed renderer state and the launch action

**Files:**
- Create: `src/renderer/stores/inboxStore.ts`
- Test: `src/renderer/stores/inboxStore.test.ts`

**Interfaces:**
- Consumes: `githubBridge` (Task 8), `InboxItem`, `InboxSnapshot`, `workItemKey` (Task 1), `useTerminalStore.setPendingPrompt` (existing), `activateSession` from `src/renderer/utils/sessionActions.ts` (existing).
- Produces (used by Tasks 10–13):
  - `useInboxStore` with: `snapshots: Record<string, InboxSnapshot>`, `resolvedRepos: Record<string, Record<string, string | null>>`, `launchErrors: Record<string, string>`, `launching: Record<string, boolean>`, `clonePrompt: { workspaceId: string; item: InboxItem } | null`, `load(workspaceId)`, `refresh(workspaceId)`, `adoptSnapshot(snapshot)`, `launch(workspaceId, item)`, `openClonePrompt(workspaceId, item)`, `dismissClonePrompt()`, `subscribeToEvents(): () => void`.
  - `launchKey(workspaceId: string, item: InboxItem): string` — the key for `launchErrors`/`launching`.
  - (Task 12 appends `cloneAndLaunch(workspaceId, item, destinationDir)`.)

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/stores/inboxStore.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/github';

vi.mock('../services/githubBridge', () => ({
  githubBridge: {
    getInbox: vi.fn(async () => null),
    refreshInbox: vi.fn(async () => undefined),
    resolveRepos: vi.fn(async () => ({})),
    launchWorkItem: vi.fn(),
    onInboxChanged: vi.fn(() => () => {}),
  },
}));

import { githubBridge } from '../services/githubBridge';
import { useNavigationStore } from './navigationStore';
import { useTerminalStore } from './terminalStore';
import { launchKey, useInboxStore } from './inboxStore';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  state: 'open',
  role: 'review-requested',
  ciStatus: 'failing',
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

const snapshot: InboxSnapshot = {
  workspaceId: 'ws-1',
  items: [item51],
  fetchedAt: Date.now(),
};

beforeEach(() => {
  useInboxStore.setState({
    snapshots: {},
    resolvedRepos: {},
    launchErrors: {},
    launching: {},
    clonePrompt: null,
  });
  vi.clearAllMocks();
});

describe('adoptSnapshot', () => {
  it('stores the snapshot by workspace and asks main which repos are cloned', async () => {
    vi.mocked(githubBridge.resolveRepos).mockResolvedValue({
      'sympower/controller-app': '/repos/controller-app',
    });

    useInboxStore.getState().adoptSnapshot(snapshot);
    await vi.waitFor(() => {
      expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
        'sympower/controller-app': '/repos/controller-app',
      });
    });

    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
    expect(githubBridge.resolveRepos).toHaveBeenCalledWith('ws-1', ['sympower/controller-app']);
  });
});

describe('launch', () => {
  it('seeds the prompt and activates the session on a fresh launch', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: false,
      seedPrompt: 'This session is for pull request #51...',
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBe(
      'This session is for pull request #51...'
    );
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('does not re-seed the prompt when re-attaching', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: true,
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBeUndefined();
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });

  it('records an error on the item, keyed, when the launch fails', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'fatal: not a valid ref',
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe(
      'fatal: not a valid ref'
    );
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51)]).toBeUndefined();
  });

  it('opens the clone prompt when the repo is not cloned', async () => {
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'not-cloned',
    });

    await useInboxStore.getState().launch('ws-1', item51);

    expect(useInboxStore.getState().clonePrompt).toEqual({ workspaceId: 'ws-1', item: item51 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: FAIL — cannot resolve `./inboxStore`.

- [ ] **Step 3: Write `src/renderer/stores/inboxStore.ts`**

```ts
import { create } from 'zustand';
import type { InboxItem, InboxSnapshot } from '../../shared/github';
import { workItemKey } from '../../shared/github';
import { githubBridge } from '../services/githubBridge';
import { activateSession } from '../utils/sessionActions';
import { useTerminalStore } from './terminalStore';

/** Key for per-item launch state: one workspace's view of one work item. */
export function launchKey(workspaceId: string, item: InboxItem): string {
  return `${workspaceId}:${workItemKey(item.workItem)}`;
}

interface InboxState {
  /** Per-workspace snapshots, fed by main's github:inbox-changed pushes. */
  snapshots: Record<string, InboxSnapshot>;
  /** Per-workspace map of remote repo -> local clone path (null = not cloned). */
  resolvedRepos: Record<string, Record<string, string | null>>;
  /** Launch failures surfaced on their Inbox item — never a dialog. */
  launchErrors: Record<string, string>;
  launching: Record<string, boolean>;
  /** The item whose repo needs cloning; renders the clone dialog when set. */
  clonePrompt: { workspaceId: string; item: InboxItem } | null;
  load: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  adoptSnapshot: (snapshot: InboxSnapshot) => void;
  launch: (workspaceId: string, item: InboxItem) => Promise<void>;
  openClonePrompt: (workspaceId: string, item: InboxItem) => void;
  dismissClonePrompt: () => void;
  /** Subscribe to main's pushes. Call once near the app root. */
  subscribeToEvents: () => () => void;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  snapshots: {},
  resolvedRepos: {},
  launchErrors: {},
  launching: {},
  clonePrompt: null,

  load: async (workspaceId) => {
    const snapshot = await githubBridge.getInbox(workspaceId);
    // null means main has no cache yet; it has kicked off a refresh and the
    // result will arrive on the push channel.
    if (snapshot) get().adoptSnapshot(snapshot);
  },

  refresh: async (workspaceId) => {
    await githubBridge.refreshInbox(workspaceId);
  },

  adoptSnapshot: (snapshot) => {
    set((state) => ({
      snapshots: { ...state.snapshots, [snapshot.workspaceId]: snapshot },
    }));
    // Repo resolution rides along so button labels are honest. Fire-and-forget:
    // until it lands, items assume "cloned" and the launch path corrects them.
    const repos = [...new Set(snapshot.items.map((item) => item.workItem.repo))];
    if (repos.length === 0) return;
    void githubBridge.resolveRepos(snapshot.workspaceId, repos).then((resolved) => {
      set((state) => ({
        resolvedRepos: { ...state.resolvedRepos, [snapshot.workspaceId]: resolved },
      }));
    });
  },

  launch: async (workspaceId, item) => {
    const key = launchKey(workspaceId, item);
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await githubBridge.launchWorkItem(workspaceId, item.workItem);
      if (!result) return;
      if (result.ok) {
        if (!result.reattached && result.seedPrompt) {
          // The prompt rides the existing pending-prompt path: the terminal
          // pane consumes it on mount and sends it as initialPrompt, where the
          // main-side guarded queue delivers it — never into a menu.
          useTerminalStore.getState().setPendingPrompt(result.session.instanceId, result.seedPrompt);
        }
        activateSession(workspaceId, result.session.id);
      } else if (result.reason === 'not-cloned') {
        set({ clonePrompt: { workspaceId, item } });
      } else {
        set((state) => ({ launchErrors: { ...state.launchErrors, [key]: result.message } }));
      }
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  openClonePrompt: (workspaceId, item) => set({ clonePrompt: { workspaceId, item } }),

  dismissClonePrompt: () => set({ clonePrompt: null }),

  subscribeToEvents: () =>
    githubBridge.onInboxChanged((snapshot) => get().adoptSnapshot(snapshot)),
}));
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/inboxStore.ts src/renderer/stores/inboxStore.test.ts
git commit -m "feat: push-fed inbox store with launch, errors, and clone prompt state"
```

---

### Task 10: Navigation and the pinned sidebar Inbox row

**Files:**
- Modify: `src/renderer/stores/navigationStore.ts` (`isInboxOpen` + `openInbox`)
- Modify: `src/renderer/utils/sessionActions.ts` (`activateSession` closes the inbox)
- Modify: `src/renderer/components/Sidebar/index.tsx` (pinned Inbox row, github-bound workspaces only)
- Modify: `src/renderer/components/Sidebar/styles.css` (row styles)
- Modify: `src/renderer/components/Layout/index.tsx` (subscribe the inbox store next to the terminal store subscription, line ~38)
- Test: `src/renderer/stores/navigationStore.test.ts` (add cases)

**Interfaces:**
- Consumes: `useInboxStore` (Task 9); existing `useNavigationStore`, `Sidebar`, `Layout`.
- Produces (used by Tasks 11–14): `useNavigationStore` gains `isInboxOpen: boolean` and `openInbox(): void`; `setActiveWorkspace`, `setActiveSession`, and `sessionActions.activateSession` all reset `isInboxOpen` to false; the sidebar renders the pinned Inbox row with the live item count for github-bound workspaces.
- Scope boundary: the `MainContent.tsx` routing edit belongs to **Task 11**, which creates `InboxView`. This task delivers navigation state and the sidebar row only — the row is clickable and flips state even before the view exists, so this task stands alone.

- [ ] **Step 1: Add the failing navigation tests**

Append to `src/renderer/stores/navigationStore.test.ts`:

```ts
describe('inbox navigation', () => {
  it('opens the inbox', () => {
    useNavigationStore.setState({ isInboxOpen: false });
    useNavigationStore.getState().openInbox();
    expect(useNavigationStore.getState().isInboxOpen).toBe(true);
  });

  it('closes the inbox when a session is activated', () => {
    useNavigationStore.setState({ isInboxOpen: true });
    useNavigationStore.getState().setActiveSession('session-1');
    expect(useNavigationStore.getState().isInboxOpen).toBe(false);
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
  });
});
```

(Use the same `describe`/import scaffolding already present in that file; `useNavigationStore` is already imported there.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/renderer/stores/navigationStore.test.ts`
Expected: FAIL — `openInbox is not a function`.

- [ ] **Step 3: Add the state to `navigationStore.ts`**

In the `NavigationState` interface add:

```ts
  /** The Inbox view is showing instead of a session. Per-window, not persisted. */
  isInboxOpen: boolean;
  openInbox: () => void;
```

In the store creator add the field and action, and fold `isInboxOpen: false` into both identity-changing actions:

```ts
      isInboxOpen: false,
      openInbox: () => set({ isInboxOpen: true }),
```

- In `setActiveWorkspace`, extend the existing `set({ activeWorkspaceId: id, activeSessionId: null })` to `set({ activeWorkspaceId: id, activeSessionId: null, isInboxOpen: false })`.
- In `setActiveSession`, extend its `set(...)` the same way: add `isInboxOpen: false` alongside `activeSessionId: id`.

`mergeNavigationState` needs no change — it only merges the two visibility preferences, and `isInboxOpen` is per-window identity-adjacent state that must start false.

- [ ] **Step 4: Close the inbox in `sessionActions.activateSession`**

`activateSession` bypasses the store action with a raw `setState`, so it must reset the flag itself:

```ts
export function activateSession(workspaceId: string, sessionId: string): void {
  useNavigationStore.setState({
    activeWorkspaceId: workspaceId,
    activeSessionId: sessionId,
    isInboxOpen: false,
  });
  windowBridge.setActiveSession(sessionId);
}
```

- [ ] **Step 5: Run the navigation tests**

Run: `npx vitest run src/renderer/stores/navigationStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Render the pinned row in `Sidebar/index.tsx`**

Add imports:

```tsx
import { useEffect } from 'react';
import { Inbox as InboxIcon, Plus, Settings } from 'lucide-react';
import { useInboxStore } from '../../stores/inboxStore';
```

Inside the component, after the `workspace` lookup:

```tsx
  const isInboxOpen = useNavigationStore((state) => state.isInboxOpen);
  const openInbox = useNavigationStore((state) => state.openInbox);
  const inboxCount = useInboxStore((state) =>
    workspace ? (state.snapshots[workspace.id]?.items.length ?? 0) : 0
  );

  // Prime the inbox for github-bound workspaces so the count is live even
  // before the Inbox view is ever opened. Main answers from cache or kicks a
  // background refresh whose result arrives on the push channel.
  const githubAccount = workspace?.github?.accountLogin;
  useEffect(() => {
    if (workspace && githubAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, githubAccount]);
```

(Hook-order note: the `if (isSidebarHidden) return null;` early return currently sits above where these hooks would land — place all hooks above it, exactly as `useNavigationStore` calls already are.)

Then render the row as the first child of `<aside className="sidebar">`, above the sessions section — Inbox before Groups (Phase 2) before Scopes, per the spec's sidebar order:

```tsx
      {workspace?.github && (
        <div className="sidebar-inbox">
          <button
            className={`sidebar-inbox-row ${isInboxOpen ? 'active' : ''}`}
            onClick={openInbox}
          >
            <InboxIcon size={14} />
            <span className="sidebar-inbox-name">Inbox</span>
            {inboxCount > 0 && <span className="sidebar-inbox-count">{inboxCount}</span>}
          </button>
        </div>
      )}
```

- [ ] **Step 7: Style the row in `Sidebar/styles.css`**

```css
/* Pinned Inbox row — only rendered for GitHub-bound workspaces */
.sidebar-inbox {
  padding: var(--space-2) var(--space-2) 0;
}

.sidebar-inbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: var(--sidebar-row-padding-y) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--sidebar-font-size);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sidebar-inbox-row:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.sidebar-inbox-row.active {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

.sidebar-inbox-name {
  flex: 1;
  text-align: left;
}

.sidebar-inbox-count {
  font-size: var(--sidebar-font-size-small);
  color: var(--color-text-tertiary);
}
```

- [ ] **Step 8: Subscribe the store in `Layout/index.tsx`**

Next to the existing terminal subscription effect (`useEffect(() => useTerminalStore.getState().subscribeToEvents(), []);`):

```tsx
  useEffect(() => useInboxStore.getState().subscribeToEvents(), []);
```

with `import { useInboxStore } from '../../stores/inboxStore';` added to that file's imports.

- [ ] **Step 9: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean. (The row toggles `isInboxOpen`; the view that reads it arrives in Task 11.)

- [ ] **Step 10: Commit**

```bash
git add src/renderer/stores/navigationStore.ts src/renderer/stores/navigationStore.test.ts \
  src/renderer/utils/sessionActions.ts src/renderer/components/Sidebar/index.tsx \
  src/renderer/components/Sidebar/styles.css src/renderer/components/Layout/index.tsx
git commit -m "feat: inbox navigation state and pinned sidebar row"
```

---

### Task 11: The Inbox view

**Files:**
- Create: `src/renderer/components/Inbox/inboxPresentation.ts` (pure helpers — the testable core)
- Create: `src/renderer/components/Inbox/index.tsx`
- Create: `src/renderer/components/Inbox/styles.css`
- Modify: `src/renderer/components/Layout/MainContent.tsx` (route the view)
- Test: `src/renderer/components/Inbox/inboxPresentation.test.ts`

**Interfaces:**
- Consumes: `useInboxStore`, `launchKey` (Task 9), `useNavigationStore.isInboxOpen` (Task 10), `InboxItem`, `sameWorkItem` (Task 1), `Workspace` type from `src/renderer/stores/workspaceStore.ts`.
- Produces:
  - `InboxView({ workspace }: { workspace: Workspace })` exported from `src/renderer/components/Inbox/index.tsx` — Task 12 mounts `CloneDialog` inside it; Task 14 drives it end-to-end.
  - Helpers (also reused by Task 13's strip): `formatAge(fetchedAt: number, now?: number): string`, `roleLabelFor(item: InboxItem): string`, `metaLineFor(item: InboxItem): string`, `actionFor(item: InboxItem, hasSession: boolean, cloned: boolean): { label: string; kind: 'launch' | 'open' | 'clone' }`, `dotClassFor(item: InboxItem): string`.

- [ ] **Step 1: Write the failing presentation tests**

```ts
// src/renderer/components/Inbox/inboxPresentation.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/github';
import { actionFor, dotClassFor, formatAge, metaLineFor, roleLabelFor } from './inboxPresentation';

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    state: 'open',
    role: 'review-requested',
    ciStatus: 'failing',
    reviewDecision: 'REVIEW_REQUIRED',
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    additions: 210,
    deletions: 88,
    ...overrides,
  };
}

describe('formatAge', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');
  it('labels fresh, minutes, hours, and never', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now');
    expect(formatAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(0, now)).toBe('never');
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
    expect(actionFor(makeItem({ role: 'author' }), false, true).label).toBe('Address review');
    expect(
      actionFor(
        makeItem({
          role: 'assigned',
          workItem: { provider: 'github', repo: 'o/r', type: 'issue', number: 87 },
        }),
        false,
        true
      ).label
    ).toBe('Start work');
  });
});

describe('metaLineFor and roleLabelFor', () => {
  it('joins repo, role, CI, review state, and diff stats', () => {
    expect(metaLineFor(makeItem())).toBe(
      'controller-app · review requested · CI failing · +210 −88'
    );
  });

  it('labels authored items as yours', () => {
    expect(roleLabelFor(makeItem({ role: 'author' }))).toBe('your PR');
    expect(
      roleLabelFor(
        makeItem({
          role: 'author',
          workItem: { provider: 'github', repo: 'o/r', type: 'issue', number: 1 },
        })
      )
    ).toBe('your issue');
  });

  it('mentions changes requested when GitHub says so', () => {
    expect(metaLineFor(makeItem({ reviewDecision: 'CHANGES_REQUESTED' }))).toContain(
      'changes requested'
    );
  });
});

describe('dotClassFor', () => {
  it('flags failing CI red, requested reviews attention, the rest idle', () => {
    expect(dotClassFor(makeItem())).toBe('inbox-dot--err');
    expect(dotClassFor(makeItem({ ciStatus: 'passing' }))).toBe('inbox-dot--att');
    expect(dotClassFor(makeItem({ ciStatus: 'passing', role: 'assigned' }))).toBe(
      'inbox-dot--idle'
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: FAIL — cannot resolve `./inboxPresentation`.

- [ ] **Step 3: Write `inboxPresentation.ts`**

```ts
import type { InboxItem } from '../../../shared/github';

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

export function roleLabelFor(item: InboxItem): string {
  if (item.role === 'author') return item.workItem.type === 'pr' ? 'your PR' : 'your issue';
  if (item.role === 'review-requested') return 'review requested';
  return 'assigned to you';
}

/** The one-line subtitle under an item: repo · role · CI · review · +a −d. */
export function metaLineFor(item: InboxItem): string {
  const parts: string[] = [
    item.workItem.repo.split('/').pop() ?? item.workItem.repo,
    roleLabelFor(item),
  ];
  if (item.ciStatus) parts.push(`CI ${item.ciStatus}`);
  if (item.reviewDecision === 'CHANGES_REQUESTED') parts.push('changes requested');
  if (item.reviewDecision === 'APPROVED') parts.push('approved');
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
 * Otherwise the label names the likely job, by role.
 */
export function actionFor(item: InboxItem, hasSession: boolean, cloned: boolean): InboxAction {
  if (hasSession) return { label: 'Open session', kind: 'open' };
  if (!cloned) return { label: 'Clone into scope...', kind: 'clone' };
  if (item.workItem.type === 'issue') return { label: 'Start work', kind: 'launch' };
  if (item.role === 'author') return { label: 'Address review', kind: 'launch' };
  return { label: 'Review', kind: 'launch' };
}

/** Status dot class: failing CI screams, requested reviews nudge, rest idle. */
export function dotClassFor(item: InboxItem): string {
  if (item.ciStatus === 'failing') return 'inbox-dot--err';
  if (item.role === 'review-requested') return 'inbox-dot--att';
  return 'inbox-dot--idle';
}
```

- [ ] **Step 4: Run the presentation tests**

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the view, `src/renderer/components/Inbox/index.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { InboxItem } from '../../../shared/github';
import { sameWorkItem } from '../../../shared/github';
import { launchKey, useInboxStore } from '../../stores/inboxStore';
import type { Workspace } from '../../stores/workspaceStore';
import { actionFor, dotClassFor, formatAge, metaLineFor } from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

/**
 * Morning triage (mockup scene 1). Remote-driven: items appear whether or not
 * the repo is cloned. Read-only against GitHub — the only verbs here create or
 * open local sessions; every GitHub write happens through the agent.
 */
export function InboxView({ workspace }: InboxViewProps) {
  const [tab, setTab] = useState<'pr' | 'issue'>('pr');

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);
  const launchErrors = useInboxStore((state) => state.launchErrors);
  const launching = useInboxStore((state) => state.launching);
  const launch = useInboxStore((state) => state.launch);
  const openClonePrompt = useInboxStore((state) => state.openClonePrompt);
  const refresh = useInboxStore((state) => state.refresh);

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
  }, [workspace.id]);

  const items = snapshot?.items ?? [];
  const prs = items.filter((item) => item.workItem.type === 'pr');
  const issues = items.filter((item) => item.workItem.type === 'issue');
  const shown = tab === 'pr' ? prs : issues;

  const github = workspace.github;
  if (!github) return null;

  const handleAction = (item: InboxItem) => {
    const hasSession = workspace.sessions.some((session) =>
      sameWorkItem(session.workItem, item.workItem)
    );
    const cloned = resolved?.[item.workItem.repo] !== null; // unknown counts as cloned
    if (actionFor(item, hasSession, cloned).kind === 'clone') {
      openClonePrompt(workspace.id, item);
    } else {
      void launch(workspace.id, item);
    }
  };

  return (
    <div className="inbox-view">
      <div className="inbox-header">
        <h1 className="inbox-title">Inbox</h1>
        <div className="inbox-tabs">
          <button
            className={`inbox-tab ${tab === 'pr' ? 'active' : ''}`}
            onClick={() => setTab('pr')}
          >
            PRs · {prs.length}
          </button>
          <button
            className={`inbox-tab ${tab === 'issue' ? 'active' : ''}`}
            onClick={() => setTab('issue')}
          >
            Issues · {issues.length}
          </button>
        </div>
        <div className="inbox-meta">
          <span className="inbox-meta-account">
            {github.accountLogin}
            {github.org ? ` · ${github.org}` : ''}
          </span>
          {snapshot?.error ? (
            // Degrade, never dialog: name the failure, show the data's age.
            <span className="inbox-meta-error" title={snapshot.error}>
              GitHub unreachable · showing data from {formatAge(snapshot.fetchedAt)}
            </span>
          ) : (
            <span className="inbox-meta-age">updated {formatAge(snapshot?.fetchedAt ?? 0)}</span>
          )}
          <button
            className="inbox-refresh"
            aria-label="Refresh inbox"
            onClick={() => void refresh(workspace.id)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="inbox-list">
        {shown.length === 0 && (
          <p className="inbox-empty">
            {snapshot ? 'Nothing here right now.' : 'Fetching from GitHub...'}
          </p>
        )}
        {shown.map((item) => {
          const hasSession = workspace.sessions.some((session) =>
            sameWorkItem(session.workItem, item.workItem)
          );
          const cloned = resolved?.[item.workItem.repo] !== null;
          const action = actionFor(item, hasSession, cloned);
          const key = launchKey(workspace.id, item);
          const error = launchErrors[key];
          return (
            <div className="inbox-item" key={key}>
              <span className={`inbox-dot ${dotClassFor(item)}`} />
              <div className="inbox-item-text">
                <span className="inbox-item-title">
                  #{item.workItem.number} {item.title}
                </span>
                <span className="inbox-item-meta">{metaLineFor(item)}</span>
                {error && <span className="inbox-item-error">{error}</span>}
              </div>
              <a
                className="inbox-item-link"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on GitHub"
              >
                <ExternalLink size={13} />
              </a>
              <button
                className={`inbox-item-action ${action.kind === 'clone' ? 'ghost' : ''}`}
                disabled={launching[key]}
                onClick={() => handleAction(item)}
              >
                {launching[key] ? 'Preparing...' : action.label}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write `src/renderer/components/Inbox/styles.css`**

```css
.inbox-view {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-4);
  background: var(--color-bg-primary);
}

.inbox-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: var(--space-4);
}

.inbox-title {
  font-size: 16px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  margin: 0;
}

.inbox-tabs {
  display: flex;
  gap: 4px;
}

.inbox-tab {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}

.inbox-tab.active {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.inbox-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.inbox-meta-error {
  color: var(--color-warning);
}

.inbox-refresh {
  display: flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
}

.inbox-refresh:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.inbox-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 720px;
}

.inbox-empty {
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.inbox-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
}

.inbox-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.inbox-dot--att { background: var(--color-warning); }
.inbox-dot--err { background: var(--color-error); }
.inbox-dot--idle { background: var(--color-text-disabled); }

.inbox-item-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.inbox-item-title {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inbox-item-meta {
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

.inbox-item-error {
  font-size: 11.5px;
  color: var(--color-error);
}

.inbox-item-link {
  display: flex;
  align-items: center;
  color: var(--color-text-tertiary);
}

.inbox-item-link:hover {
  color: var(--color-text-primary);
}

.inbox-item-action {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-accent);
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.inbox-item-action.ghost {
  border-color: var(--color-border-strong);
  color: var(--color-text-secondary);
}

.inbox-item-action:disabled {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 7: Route the view in `MainContent.tsx`**

```tsx
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { HomeView, ContentView, NewSessionView } from '../Views';
import { InboxView } from '../Inbox';

export function MainContent() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const isInboxOpen = useNavigationStore((state) => state.isInboxOpen);
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  // No workspace selected - show home/welcome
  if (!activeWorkspaceId) {
    return <HomeView />;
  }

  const workspace = getWorkspace(activeWorkspaceId);

  if (!workspace) {
    return <HomeView />;
  }

  // The Inbox takes the pane over; the active session keeps running behind it
  // ("terminals outlive their views") and returns on the next sidebar click.
  if (isInboxOpen && workspace.github) {
    return <InboxView workspace={workspace} />;
  }

  // Workspace selected, no session - show centered input
  if (!activeSessionId) {
    return <NewSessionView workspace={workspace} />;
  }

  // Session active - show conversation view
  return <ContentView workspaceId={activeWorkspaceId} sessionId={activeSessionId} />;
}
```

- [ ] **Step 8: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/Inbox/ src/renderer/components/Layout/MainContent.tsx
git commit -m "feat: Inbox view with tabs, degraded header states, and item actions"
```

---

### Task 12: The clone-into-scope flow

**Files:**
- Create: `src/main/github/cloneRepo.ts`
- Test: `src/main/github/cloneRepo.test.ts`
- Modify: `src/main/ipc-handlers.ts` (the `GITHUB_CLONE_REPO` handler, next to the Task 8 block; add its `removeHandler` to cleanup)
- Modify: `src/preload/preload.ts` (the `cloneRepo` member on `githubAPI`)
- Modify: `src/renderer/services/githubBridge.ts` (`cloneRepo` method)
- Modify: `src/renderer/stores/inboxStore.ts` + `src/renderer/stores/inboxStore.test.ts` (`cloneAndLaunch`)
- Create: `src/renderer/components/Inbox/CloneDialog.tsx`
- Modify: `src/renderer/components/Inbox/index.tsx` (mount the dialog)
- Modify: `src/renderer/components/Inbox/styles.css` (dialog styles)

**Interfaces:**
- Consumes: stub `gh` `repo clone` (Task 2), `composeGhEnv`/`resolveGhBinary` (Task 8, in-scope in `setupIpcHandlers`), `CloneRepoResult` (Task 1), `useInboxStore` (Task 9), `dialogBridge.selectFolder` (existing), Phase 0's scope-add on `WorkspaceService`.
- Produces:
  - `cloneWorkspaceRepo(deps: CloneRepoDeps, workspace: Workspace, repo: string, destinationDir: string): Promise<CloneRepoResult>` with `interface CloneRepoDeps { ghBinary(): Promise<string>; composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>; addScope(workspaceId: string, dirPath: string): void }`
  - `useInboxStore.cloneAndLaunch(workspaceId: string, item: InboxItem, destinationDir: string): Promise<void>`
  - `CloneDialog()` component rendered by `InboxView`.

**Contract note (recorded for the executor):** the spec says "`git clone` via subprocess with GH_TOKEN env", but bare `git clone` does not read `GH_TOKEN` — that would fail on any private repo unless `gh auth setup-git` happens to be configured. `gh repo clone <owner/name> <dir>` is the faithful implementation of the intent: a subprocess authenticated by `GH_TOKEN`, no credential ever stored by Consola, and it runs `git clone` underneath. The stub covers it (Task 2).

**Contract note 2:** `addScope` must be whatever scope-add method Phase 0 gave `WorkspaceService` (its scope CRUD deliverable). Verify the exact name and signature in `src/main/state/WorkspaceService.ts` at execution time; the behavior required here is exactly "append a scope record for this directory to this workspace" — which also fires `onChange`, which invalidates the worktree cache (Task 8 wiring).

- [ ] **Step 1: Write the failing main-side test**

```ts
// src/main/github/cloneRepo.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import { cloneWorkspaceRepo, type CloneRepoDeps } from './cloneRepo';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A local "origin" for the stub's `repo clone` to clone from. */
function makeSourceRepo(): string {
  const dir = path.join(tmpDir('consola-clone-src-'), 'msa-resource-bff');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function makeWorkspace(scopePaths: Array<{ path: string; isGitRepo: boolean }>): Workspace {
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
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
  } as Workspace;
}

function makeDeps(source: string, overrides: Partial<CloneRepoDeps> = {}) {
  const addScope = vi.fn();
  const deps: CloneRepoDeps = {
    ghBinary: async () => STUB,
    composeEnv: async () => ({ ...process.env, STUB_GH_CLONE_FROM: source, GH_TOKEN: 'gho_test' }),
    addScope,
    ...overrides,
  };
  return { deps, addScope };
}

describe('cloneWorkspaceRepo', () => {
  it('clones into the destination and leaves scopes alone when a scope covers it', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, addScope } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(container, 'msa-resource-bff'));
    expect(fs.existsSync(path.join(container, 'msa-resource-bff', '.git'))).toBe(true);
    expect(addScope).not.toHaveBeenCalled();
  });

  it('adds a scope for a destination no scope covers', async () => {
    const source = makeSourceRepo();
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps, addScope } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(true);
    expect(addScope).toHaveBeenCalledWith('ws-1', outside);
  });

  it('refuses when the target directory already exists', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    fs.mkdirSync(path.join(container, 'msa-resource-bff'));
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns gh stderr on a failed clone, creating nothing', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(source, {
      composeEnv: async () => ({ ...process.env, STUB_GH_FAIL: '1', GH_TOKEN: 'gho_test' }),
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('canned failure');
    expect(fs.existsSync(path.join(container, 'msa-resource-bff'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/github/cloneRepo.test.ts`
Expected: FAIL — cannot resolve `./cloneRepo`.

- [ ] **Step 3: Write `src/main/github/cloneRepo.ts`**

```ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { CloneRepoResult } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';

const execFileAsync = promisify(execFile);

export interface CloneRepoDeps {
  ghBinary(): Promise<string>;
  /** Login env plus GH_TOKEN for the workspace's account. Main-side only. */
  composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** WorkspaceService's scope-add (Phase 0 scope CRUD). Fires onChange. */
  addScope(workspaceId: string, dirPath: string): void;
}

/**
 * Clone an un-cloned inbox repo into a chosen directory.
 *
 * `gh repo clone` rather than bare `git clone`: gh authenticates from GH_TOKEN
 * in the subprocess env, so private repos clone as the workspace's account and
 * Consola still stores zero credentials. When the destination is not inside
 * any existing scope, it becomes one — otherwise resolveRepo would still
 * answer null and the launch could never continue.
 */
export async function cloneWorkspaceRepo(
  deps: CloneRepoDeps,
  workspace: Workspace,
  repo: string,
  destinationDir: string
): Promise<CloneRepoResult> {
  if (!workspace.github) {
    return { ok: false, error: 'This workspace has no GitHub account bound.' };
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
    const env = await deps.composeEnv(workspace.github.accountLogin);
    await execFileAsync(await deps.ghBinary(), ['repo', 'clone', repo, target], {
      env: env as { [key: string]: string },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || (error instanceof Error ? error.message : String(error)),
    };
  }

  const covered = workspace.scopes.some(
    (scope) => target === scope.path || target.startsWith(scope.path + path.sep)
  );
  if (!covered) deps.addScope(workspace.id, destinationDir);
  return { ok: true, path: target };
}
```

- [ ] **Step 4: Run the main-side test**

Run: `npx vitest run src/main/github/cloneRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire handler, preload, and bridge**

In `setupIpcHandlers` (next to the Task 8 github handlers), with `cloneWorkspaceRepo` imported from `./github/cloneRepo`:

```ts
    ipcMain.handle(
        IPC_CHANNELS.GITHUB_CLONE_REPO,
        async (_event, workspaceId: string, repo: string, destinationDir: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            if (!workspace) return { ok: false, error: `Unknown workspace: ${workspaceId}` };
            const result = await cloneWorkspaceRepo(
                {
                    ghBinary: resolveGhBinary,
                    composeEnv: composeGhEnv,
                    // Phase 0's scope CRUD on WorkspaceService — verify the exact
                    // method name there; behavior: append a scope for dirPath.
                    addScope: (id, dirPath) => workspaces.addScope(id, dirPath),
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

Add `ipcMain.removeHandler(IPC_CHANNELS.GITHUB_CLONE_REPO);` to `cleanupIpcHandlers`.

Preload, on `githubAPI` (add `CloneRepoResult` to the `../shared/types` import alongside Task 8's `WorkItemLaunchResult`):

```ts
    cloneRepo: (
        workspaceId: string,
        repo: string,
        destinationDir: string
    ): Promise<CloneRepoResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.GITHUB_CLONE_REPO, workspaceId, repo, destinationDir),
```

Bridge, in `githubBridge`:

```ts
  cloneRepo: async (
    workspaceId: string,
    repo: string,
    destinationDir: string
  ): Promise<CloneRepoResult | null> => {
    const api = getAPI();
    if (!api) return null;
    return api.cloneRepo(workspaceId, repo, destinationDir);
  },
```

- [ ] **Step 6: Add the failing store tests for `cloneAndLaunch`**

Append to `src/renderer/stores/inboxStore.test.ts` (add `cloneRepo: vi.fn()` to the `vi.mock` factory's bridge object):

```ts
describe('cloneAndLaunch', () => {
  it('clones, then continues the launch', async () => {
    vi.mocked(githubBridge.cloneRepo).mockResolvedValue({ ok: true, path: '/repos/x' });
    vi.mocked(githubBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      reattached: false,
      seedPrompt: 'seed',
      session: { id: 'session-2', instanceId: 'inst-2' } as never,
    });
    useInboxStore.setState({ clonePrompt: { workspaceId: 'ws-1', item: item51 } });

    await useInboxStore.getState().cloneAndLaunch('ws-1', item51, '/repos');

    expect(githubBridge.cloneRepo).toHaveBeenCalledWith('ws-1', 'sympower/controller-app', '/repos');
    expect(githubBridge.launchWorkItem).toHaveBeenCalled();
    expect(useInboxStore.getState().clonePrompt).toBeNull();
  });

  it('surfaces a clone failure on the item and does not launch', async () => {
    vi.mocked(githubBridge.cloneRepo).mockResolvedValue({ ok: false, error: 'denied' });

    await useInboxStore.getState().cloneAndLaunch('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51)]).toBe('denied');
    expect(githubBridge.launchWorkItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Implement `cloneAndLaunch` in `inboxStore.ts`**

Add to the interface: `cloneAndLaunch: (workspaceId: string, item: InboxItem, destinationDir: string) => Promise<void>;` and to the store:

```ts
  cloneAndLaunch: async (workspaceId, item, destinationDir) => {
    const key = launchKey(workspaceId, item);
    set({ clonePrompt: null });
    const result = await githubBridge.cloneRepo(workspaceId, item.workItem.repo, destinationDir);
    if (!result || !result.ok) {
      set((state) => ({
        launchErrors: { ...state.launchErrors, [key]: result?.error ?? 'Clone failed.' },
      }));
      return;
    }
    // The clone landed and (if needed) became a scope; the normal launch path
    // now resolves it and continues: worktree, record, spawn.
    await get().launch(workspaceId, item);
  },
```

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts` — Expected: PASS.

- [ ] **Step 8: Write `CloneDialog.tsx` and mount it**

```tsx
// src/renderer/components/Inbox/CloneDialog.tsx
import * as Dialog from '@radix-ui/react-dialog';
import { dialogBridge } from '../../services/dialogBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

/**
 * "Clone into scope..." — the one dialog in the inbox flow, and it is about
 * the local disk, not GitHub: where should this repo live? Container scopes
 * are offered first; an arbitrary folder becomes a new scope holding the
 * clone (main adds the scope record). The launch continues automatically.
 */
export function CloneDialog() {
  const clonePrompt = useInboxStore((state) => state.clonePrompt);
  const dismiss = useInboxStore((state) => state.dismissClonePrompt);
  const cloneAndLaunch = useInboxStore((state) => state.cloneAndLaunch);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === clonePrompt?.workspaceId)
  );

  if (!clonePrompt || !workspace) return null;
  const { item, workspaceId } = clonePrompt;
  const containers = workspace.scopes.filter((scope) => !scope.isGitRepo);

  const chooseFolder = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    void cloneAndLaunch(workspaceId, item, folder.path);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="clone-dialog-overlay" />
        <Dialog.Content className="clone-dialog">
          <Dialog.Title className="clone-dialog-title">Clone {item.workItem.repo}</Dialog.Title>
          <Dialog.Description className="clone-dialog-description">
            This repo is not cloned in any scope of {workspace.name}. Pick where the clone should
            live; the launch continues once it lands.
          </Dialog.Description>
          <div className="clone-dialog-options">
            {containers.map((scope) => (
              <button
                key={scope.id}
                className="clone-dialog-option"
                onClick={() => void cloneAndLaunch(workspaceId, item, scope.path)}
              >
                <span className="clone-dialog-option-name">{scope.name}</span>
                <span className="clone-dialog-option-path">{scope.path}</span>
              </button>
            ))}
            <button className="clone-dialog-option" onClick={() => void chooseFolder()}>
              <span className="clone-dialog-option-name">Choose a folder...</span>
              <span className="clone-dialog-option-path">Becomes a new scope holding the clone</span>
            </button>
          </div>
          <div className="clone-dialog-footer">
            <button className="clone-dialog-cancel" onClick={dismiss}>
              Cancel
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Mount it in `InboxView` — add `import { CloneDialog } from './CloneDialog';` and render `<CloneDialog />` as the last child of the `.inbox-view` div.

Dialog styles, appended to `src/renderer/components/Inbox/styles.css`:

```css
.clone-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}

.clone-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 420px;
  max-width: calc(100vw - 32px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.clone-dialog-title {
  font-size: 14px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  margin: 0 0 6px;
}

.clone-dialog-description {
  font-size: 12.5px;
  color: var(--color-text-secondary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.clone-dialog-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.clone-dialog-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 8px 10px;
  cursor: pointer;
}

.clone-dialog-option:hover {
  background: var(--color-bg-hover);
}

.clone-dialog-option-name {
  font-size: 13px;
  color: var(--color-text-primary);
}

.clone-dialog-option-path {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.clone-dialog-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.clone-dialog-cancel {
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
```

- [ ] **Step 9: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/main/github/cloneRepo.ts src/main/github/cloneRepo.test.ts src/main/ipc-handlers.ts \
  src/preload/preload.ts src/renderer/services/githubBridge.ts src/renderer/stores/inboxStore.ts \
  src/renderer/stores/inboxStore.test.ts src/renderer/components/Inbox/
git commit -m "feat: clone-into-scope flow that continues the work-item launch"
```

---

### Task 13: The work-item strip and the worktree cwd

**Files:**
- Create: `src/renderer/components/WorkItemStrip/index.tsx`
- Create: `src/renderer/components/WorkItemStrip/styles.css`
- Modify: `src/renderer/components/Views/ContentView.tsx` (cwd resolution + strip render)
- Modify: `src/main/window-manager.ts` (external links open in the OS browser)
- Test: `npm run typecheck` + the existing presentation tests (the strip's logic is Task 11's tested helpers plus Task 1's tested `workItemUrl`); Task 14 exercises it end-to-end

**Interfaces:**
- Consumes: `sameWorkItem`, `workItemUrl` (Task 1), `useInboxStore` (Task 9), `metaLineFor`, `dotClassFor` (Task 11), `Session` v6 (Phase 0).
- Produces: `WorkItemStrip({ workspaceId, session })`; `ContentView` computes `cwd = session.cwd ?? scope.path` and renders the strip above the terminal area when the active session has a `workItem`.

- [ ] **Step 1: Let external links leave the app**

The strip and the Inbox render plain `<a target="_blank">` links to github.com. Electron's default for `window.open` is a new Electron window — wrong for "Open on GitHub". In `src/main/window-manager.ts`, add `shell` to the electron import and, in `createWindow` right after the `new BrowserWindow({...})` call:

```ts
    // "Open on GitHub" and every other external link leaves the app: the OS
    // browser gets the URL and no second Electron window ever opens.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://') || url.startsWith('http://')) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
```

- [ ] **Step 2: Write `src/renderer/components/WorkItemStrip/index.tsx`**

```tsx
import { ExternalLink } from 'lucide-react';
import { sameWorkItem, workItemUrl } from '../../../shared/github';
import type { Session } from '../../../shared/workspace';
import { useInboxStore } from '../../stores/inboxStore';
import { dotClassFor, metaLineFor } from '../Inbox/inboxPresentation';
import './styles.css';

interface WorkItemStripProps {
  workspaceId: string;
  session: Session;
}

/**
 * The thin strip above a work-item session's terminal (mockup scene 3): live
 * PR/issue facts and where the session physically runs. It reads the same
 * cache as the Inbox — one fetcher, one rate-limit budget — and is read-only:
 * every GitHub write happens through the agent in the terminal below it.
 *
 * A merged/closed item drops out of the inbox; the strip then falls back to
 * the immutable workItem on the session record, because the session and its
 * transcript outlive the work item.
 */
export function WorkItemStrip({ workspaceId, session }: WorkItemStripProps) {
  const workItem = session.workItem;
  const item = useInboxStore((state) =>
    workItem
      ? state.snapshots[workspaceId]?.items.find((candidate) =>
          sameWorkItem(candidate.workItem, workItem)
        )
      : undefined
  );

  if (!workItem) return null;
  const label = workItem.type === 'pr' ? 'PR' : 'Issue';

  return (
    <div className="work-item-strip">
      <span className={`inbox-dot ${item ? dotClassFor(item) : 'inbox-dot--idle'}`} />
      <div className="work-item-strip-text">
        <span className="work-item-strip-title">
          #{workItem.number} {item?.title ?? `${label} in ${workItem.repo}`}
        </span>
        <span className="work-item-strip-meta">
          {item ? metaLineFor(item) : `${workItem.repo} · no longer in the inbox`}
        </span>
      </div>
      {session.cwd && (
        <span className="work-item-strip-pill">
          worktree · {workItem.type}-{workItem.number}
        </span>
      )}
      <a
        className="work-item-strip-link"
        href={item?.url ?? workItemUrl(workItem)}
        target="_blank"
        rel="noreferrer"
      >
        Open on GitHub <ExternalLink size={12} />
      </a>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/renderer/components/WorkItemStrip/styles.css`**

```css
.work-item-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 6px 10px;
  margin: 0 var(--space-3) var(--space-2);
  background: var(--color-bg-secondary);
}

/* The dot reuses .inbox-dot--* colors from the Inbox stylesheet; declare the
   base shape here too so the strip stands alone when the Inbox never mounted. */
.work-item-strip .inbox-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

.work-item-strip-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.work-item-strip-title {
  font-size: 12.5px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.work-item-strip-meta {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.work-item-strip-pill {
  border: 1px solid var(--color-border-strong);
  border-radius: 10px;
  font-size: 10px;
  color: var(--color-text-secondary);
  padding: 1px 8px;
  white-space: nowrap;
}

.work-item-strip-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.work-item-strip-link:hover {
  color: var(--color-text-primary);
}
```

Import note: the dot color classes (`.inbox-dot--err` etc.) live in `Inbox/styles.css`; `WorkItemStrip/index.tsx` imports `../Inbox/inboxPresentation` (logic) and both stylesheets end up in the bundle. If the strip renders before any Inbox ever mounted, Vite still bundles the Inbox CSS because `inboxPresentation` is imported from the Inbox directory — but CSS only loads via a CSS import, so ALSO add `import '../Inbox/styles.css';` to `WorkItemStrip/index.tsx` to make the dependency explicit rather than incidental.

- [ ] **Step 4: Wire cwd and the strip in `ContentView.tsx`**

Replace the cwd line (currently `const cwd = workspace?.path ?? '';` — Phase 0 may already have rewritten it in scope terms; either way the end state is):

```tsx
  // Where the session runs: its own cwd (worktree sessions) or its scope's
  // path. "Home vs runs-in": the sidebar files it under its scope either way.
  const scope = workspace?.scopes.find((candidate) => candidate.id === session?.scopeId);
  const cwd = session?.cwd ?? scope?.path ?? '';
```

Add the import `import { WorkItemStrip } from '../WorkItemStrip';` and render the strip between the header and the panel group — inside the outer `.workspace-view` div, immediately after the `.workspace-view-header` block:

```tsx
      {session.workItem && <WorkItemStrip workspaceId={workspaceId} session={session} />}
```

Everything else in `ContentView` (terminal props, git panel, explorer) already keys off `cwd`, so the worktree flows through `TerminalPanel`, `FileExplorer`, and git status untouched — the spawn itself is the existing terminal-create-on-mount path, satisfying "worktree first, record second, spawn third".

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/WorkItemStrip/ src/renderer/components/Views/ContentView.tsx src/main/window-manager.ts
git commit -m "feat: work-item strip above the terminal and worktree-aware session cwd"
```

---

### Task 14: Playwright E2E — the daily loop against the stub

**Files:**
- Modify: `tests/e2e/helpers/electron.ts` (accept extra env)
- Create: `tests/e2e/inbox.spec.ts`
- Test: `npm run test:e2e` (build first: `npm run build`)

**Interfaces:**
- Consumes: everything above; stub `gh` (Task 2); `CONSOLA_GH_PATH` and `CONSOLA_WORKTREES_DIR` seams (Tasks 5, 8); the ` Test` userData suffix from `src/main/index.ts` (`PROFILE_SUFFIX`).
- Produces: the spec's E2E proof — "bind a workspace to a stub account, Inbox renders, launch, worktree exists, session record correct, relaunch re-attaches".

**Contingency (recorded for the executor):** the launch path borrows the token through Phase 0's `GhBroker`, which resolves `gh` via the login-shell PATH. The spec prepends the stub directory to `PATH`, which login shells normally preserve; if the token step still misses the stub on some machine (symptom: launch error mentioning gh auth), teach `GhBroker`'s binary resolution the same `CONSOLA_GH_PATH` override used everywhere else in this phase — a one-line change to coordinate with Phase 0's file, not a redesign.

- [ ] **Step 1: Let `launchElectron` pass env through**

In `tests/e2e/helpers/electron.ts`, extend the options and the launch call:

```ts
export interface LaunchOptions {
  /** Profile directory. Defaults to a fresh temp dir, so runs cannot collide. */
  userDataDir?: string;
  /** Extra environment for the app process (stub gh, worktree root, ...). */
  env?: Record<string, string>;
}
```

and in `electron.launch({ ... })`:

```ts
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...(options.env ?? {}),
    },
```

- [ ] **Step 2: Write `tests/e2e/inbox.spec.ts`**

```ts
import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');

/** A local clone whose origin matches the stub payload's sympower/controller-app. */
function initClone(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'e2e@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola E2E']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  execFileSync('git', [
    '-C', dir, 'remote', 'add', 'origin',
    'https://github.com/sympower/controller-app.git',
  ]);
}

/**
 * Seed a github-bound v6 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test (PROFILE_SUFFIX), so
 * the file must land there. Shape per Phase 0's v6 contract — if Phase 0's
 * on-disk field names drifted, fix this seed against src/shared/workspace.ts.
 */
function seedWorkspaceState(userDataDir: string, repoDir: string): string {
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const workspaceId = 'ws-inbox-e2e';
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify(
      {
        version: 6,
        workspaces: [
          {
            id: workspaceId,
            name: 'Sympower',
            defaultHarnessId: 'default',
            scopes: [
              {
                id: 'scope-controller',
                name: 'controller-app',
                path: repoDir,
                isGitRepo: true,
                createdAt: now,
              },
            ],
            groups: [],
            github: { accountLogin: 'SymJavi', org: 'sympower' },
            sessions: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2
    )
  );
  return workspaceId;
}

interface SeededSession {
  workItem?: { provider: string; repo: string; type: string; number: number };
  cwd?: string;
  scopeId?: string;
}

function sessionsIn(stateFile: string): SeededSession[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed.workspaces?.[0]?.sessions ?? [];
  } catch {
    return []; // mid-write; the poll comes back
  }
}

test('inbox renders, launch cuts a worktree and a session, relaunch re-attaches', async () => {
  test.setTimeout(90_000);

  const userDataDir = createProfileDir();
  const repoDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-')), 'controller-app');
  initClone(repoDir);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-worktrees-'));
  seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');

  const { app, page } = await launchElectron({
    userDataDir,
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      CONSOLA_WORKTREES_DIR: worktreesDir,
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  // Hold the seeded workspace through the real switcher UI (windows.spec.ts
  // precedent: a raw IPC call would not update what the window renders).
  await page.getByRole('button', { name: /^Switch workspace/ }).click();
  await page.getByRole('menuitem', { name: /Sympower/ }).click();

  // The pinned Inbox row exists because the workspace is github-bound.
  const inboxRow = page.locator('.sidebar-inbox-row');
  await expect(inboxRow).toBeVisible({ timeout: 10_000 });
  await inboxRow.click();

  // Remote-driven list from the stub's canned GraphQL payload.
  await expect(
    page.locator('.inbox-item-title', { hasText: '#51 Extract billing client' })
  ).toBeVisible({ timeout: 15_000 });

  // The un-cloned repo's issue offers the clone path instead of failing.
  await page.locator('.inbox-tab', { hasText: 'Issues' }).click();
  await expect(
    page.locator('.inbox-item-action.ghost', { hasText: 'Clone into scope' })
  ).toBeVisible();
  await page.locator('.inbox-tab', { hasText: 'PRs' }).click();

  // One click: worktree first, record second, spawn third.
  const item51 = page.locator('.inbox-item', { hasText: 'Extract billing client' });
  await item51.getByRole('button', { name: 'Review' }).click();

  const worktree = path.join(worktreesDir, 'controller-app-pr-51');
  await expect
    .poll(() => fs.existsSync(path.join(worktree, '.git')), { timeout: 20_000 })
    .toBe(true);
  expect(
    execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  ).toBe('stub-pr-51'); // the stub's `gh pr checkout` branch

  await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(1);
  const [session] = sessionsIn(stateFile);
  expect(session.workItem).toMatchObject({
    provider: 'github',
    repo: 'sympower/controller-app',
    type: 'pr',
    number: 51,
  });
  expect(session.cwd).toBe(worktree);
  expect(session.scopeId).toBe('scope-controller');

  // Re-attach: the item now reads "Open session", and clicking it must not
  // mint a second session — one work item, one session, forever.
  await inboxRow.click();
  await expect(item51.getByRole('button', { name: 'Open session' })).toBeVisible({
    timeout: 10_000,
  });
  await item51.getByRole('button', { name: 'Open session' }).click();
  await page.waitForTimeout(1_500);
  expect(sessionsIn(stateFile)).toHaveLength(1);

  await app.close();
});
```

(The seeded session's terminal will try to spawn the real `claude` binary after the record lands; whether that spawn succeeds is irrelevant to every assertion above — the worktree and the record exist before any spawn, which is exactly the atomicity being proven.)

- [ ] **Step 3: Build and run the spec**

Run: `npm run build && npx playwright test tests/e2e/inbox.spec.ts`
Expected: PASS. If the launch errors with a gh-auth message, apply the contingency at the top of this task.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run test:e2e`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/electron.ts tests/e2e/inbox.spec.ts
git commit -m "test: e2e inbox daily loop against the stub gh"
```

---

## Design notes — resolved ambiguities (recorded so executors do not re-litigate)

1. **"One GraphQL search per workspace"** is implemented as one GraphQL *request* containing three aliased `search` fields (assigned / authored / review-requested) — GitHub's search syntax cannot OR those qualifiers into a single search string. One subprocess, one HTTP request, one rate-budget hit per refresh.
2. **Role precedence on dedupe:** review-requested > assigned > author. The reason you were asked outranks the reason you are attached.
3. **How the renderer knows a repo is un-cloned before clicking:** the contract's channel list is minimal, but the mockup shows "Clone into scope..." as the button's resting label. `GITHUB_RESOLVE_REPOS` (read-only, token-free) exists for exactly that; the launch path re-checks authoritatively and answers `not-cloned` regardless, so a stale label can never mis-launch.
4. **`git clone` vs `gh repo clone`:** the clone subprocess is `gh repo clone` because bare `git clone` ignores `GH_TOKEN` (see Task 12's contract note).
5. **Seed prompt transport:** main returns `seedPrompt` with the fresh session; the renderer parks it in `terminalStore.pendingPrompts` (the same slot `NewSessionView` uses); the pane mount sends it as `TerminalCreateOptions.initialPrompt`; `TerminalService`'s guarded queue delivers it. No new delivery path, no typing into menus. Re-attach launches carry no prompt.
6. **`prune` has no UI in this phase.** The spec offers pruning "when a work item is closed/merged", which needs item-lifecycle affordances that belong with later phases; the service method and its refusal rules ship (and are tested) now, so wiring a button later is UI-only.
7. **Inbox header degraded states:** `gh` missing, token expired, and offline all surface through `InboxSnapshot.error` (gh's own stderr), rendered as a labelled state beside the last fetch's age — one mechanism for all three failure modes, never a dialog, and the Inbox never raises OS notifications.
8. **Test seams:** `CONSOLA_GH_PATH` (gh binary override) and `CONSOLA_WORKTREES_DIR` (worktree root override) exist for the stubbed test rig demanded by the spec's Testing section. Production behavior with both unset is exactly the spec's: probe-resolved `gh`, `~/.consola/worktrees/`.

## Self-review

Performed against the spec and the interface contracts before hand-off:

- **Spec coverage:** GitHubService (Task 4: query/cadence/cache/push, Task 8: focus+timer+manual wiring), Inbox view (Tasks 9–11: remote-driven, "Open session" re-attach label, clone label, degraded header, read-only), WorktreeService (Tasks 5–6: resolve incl. container scan + cache invalidation on scope change, ensure incl. idempotence/recreate/naming, prune refusal), launch + re-attach (Task 7 + 8: atomic order, seeded prompt on the guarded queue, error surfaced on the item), session strip (Task 13: same cache, worktree pill, external link), un-cloned repo flow (Task 12), stub-gh testing + E2E (Tasks 2, 14). The Inbox never notifies (nothing in this plan touches Notification APIs) and no UI writes to GitHub.
- **Placeholder scan:** every step carries its code or its exact command; the two "verify at execution" points (Phase 0's `GhBroker` instance reuse, `WorkspaceService`'s scope-add name) are recorded contract seams with the required behavior spelled out, not deferred design.
- **Type consistency:** `InboxItem`/`InboxSnapshot` (Task 1) match the contract's fields exactly; `GitHubServiceDeps.ghBinary(): Promise<string>` is used identically in Tasks 4/8/12; `WorktreeService` constructor `(root?, ghBinary?)` matches Tasks 5/6/8/14; `WorkItemLaunchResult` shape is identical in Tasks 1/7/8/9; `launchKey` is defined once (Task 9) and reused in 11/12; `actionFor/metaLineFor/dotClassFor/formatAge` signatures match between Tasks 11 and 13; channel constants match between Tasks 1, 8, and 12.
