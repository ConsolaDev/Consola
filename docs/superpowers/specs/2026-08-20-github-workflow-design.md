# GitHub Workflow: Accounts, Scopes, Work Items, Groups

**Date:** 2026-08-20
**Status:** Implemented — all four phases shipped to main (Model, Inbox, Fleet, Conductors; merged 2026-08-24)
**Mockups:** `.superpowers/brainstorm/87378-1787218296/content/` (full-flow.html is the walkthrough)
**Prior art:** `research/2026-08-18-agent-deck-conductor-listeners-actions.md`,
`docs/superpowers/specs/2026-08-19-workspace-windows-design.md`

## Problem

Consola manages sessions well but knows nothing about why they exist. The work
arrives on GitHub — PRs waiting on review, issues assigned — and today the loop
is: notice it in a browser, `gh auth switch` to the right account (which
silently switches every other terminal too), find or clone the repo, open a
session by hand, paste context in. Multiply by two accounts (work and personal)
and by Sympower's 38-repo microservice layout, where the right working folder is
sometimes one service and sometimes the whole parent directory.

The rewrite makes a workspace mean what it already means in practice — an
identity plus the places that identity works — and gives it three new organs: an
Inbox fed by that identity's GitHub account, scopes that say where sessions run,
and groups that say why several sessions belong together.

## Decisions

| Question | Decision |
|---|---|
| Workspace model | A workspace is an identity container: optional GitHub account + org, and a list of **scopes** (pinned folders). `Workspace.path` and `isGitRepo` die; each existing workspace migrates to a single scope. |
| Auth | `gh` CLI is the broker and is required for GitHub features. Consola stores **zero credentials**: it borrows a per-account token via `gh auth token --user <login>` at spawn/call time and injects `GH_TOKEN`. No global `gh auth switch`, ever. Absent `gh` degrades to today's behavior. |
| Scope vs session | Scope = a durable *place* (`{id, name, path, isGitRepo}`), few, nest by path. Session = a *conversation*, many. They diverge the moment worktrees exist: a review session's cwd is a worktree, its scope is the repo it belongs to. |
| Work item ↔ disk | Launching a PR/issue cuts a **git worktree** under `~/.consola/worktrees/`, isolated from the user's own branch. One session per work item, re-attached forever. |
| Batches | Rejected as an entity. A **group** is a plain container (`{id, name, parentGroupId?, conductorSessionId?}`); progress is derived by counting member session states. Fan-out is a creation gesture; orchestration is a conductor session scaffolded from templates. |
| GitHub writes | The UI is read-only against GitHub. All writes (comments, reviews, merges) happen through the agent running `gh` inside its session. Consola never needs its own permission model. |
| Providers | Everything GitHub-specific lives behind a `GitProviderDriver`, mirroring `HarnessDriver`. Nothing outside `src/main/github/` branches on a provider id. |
| Cloud | Out of scope, but two rules keep it cheap: session identity never encodes location, and nothing outside the main process assumes a session's files are local. Remote execution is Fleetwide's job, docking later as a `TerminalService` transport. |

## Domain model (state v6)

```ts
interface Workspace {
  id: string;
  name: string;
  defaultHarnessId: string;
  scopes: Scope[];                    // replaces path + isGitRepo
  groups: Group[];
  github?: {                          // absent = pure local workspace, today's behavior
    accountLogin: string;             // e.g. "SymJavi" — which gh keyring account
    org?: string;                     // scopes the Inbox query; absent = all repos for account
  };
  sessions: Session[];
  createdAt: number; updatedAt: number;
}

interface Scope {
  id: string;
  name: string;                       // defaults to folder basename
  path: string;                       // absolute; nesting/overlap between scopes is allowed
  isGitRepo: boolean;                 // cached at add time, refreshed on demand
  createdAt: number;
}

interface Group {
  id: string;
  name: string;
  parentGroupId?: string;             // nesting, as in the agent-deck tree
  conductorSessionId?: string;        // set only by the orchestration door
  createdAt: number;
  archivedAt?: number;                // done groups collapse out of the sidebar
}

interface Session {
  // existing: id, name, workspaceId, instanceId, claudeSessionId,
  //           hasStarted, harnessId, model?, createdAt, lastActiveAt
  scopeId: string;                    // where it belongs — its home in the sidebar
  cwd?: string;                       // where it runs, when ≠ scope.path (worktrees)
  groupId?: string;                   // why it exists alongside others; mutable
  kind: 'interactive' | 'conductor';
  workItem?: {                        // set by Inbox launches; immutable
    provider: 'github';
    repo: string;                     // "sympower/controller-app"
    type: 'pr' | 'issue';
    number: number;
  };
}
```

Immutability follows the harness/model precedent: `scopeId`, `cwd`, `kind` and
`workItem` are kept out of `allowedSessionUpdates` — fixed by omission, not
validation. `groupId` is allowed: dragging a session between groups is an
organizational act, not an identity change.

### Migration v5 → v6

Each workspace's `path`/`isGitRepo` becomes its single scope; every session gets
that scope's id, `kind: 'interactive'`, and no group. `groups: []`, no `github`
binding. A migrated workspace behaves byte-for-byte as before — the GitHub organs
only switch on when the user binds an account. The migration is exercised by its
own tests, same as v4 and v5.

## Auth: `gh` as broker

A new `GhBroker` (main process) wraps the `gh` binary:

- `probe()` — resolves the binary (login-shell PATH via `getLoginEnv`), reports
  version and the accounts in `gh auth status`. Feeds the workspace settings UI
  (account picker) and the "install gh" empty state.
- `token(accountLogin)` — `gh auth token --user <login>`, cached in memory for
  minutes (only to pick up account changes; the tokens themselves are
  long-lived), never persisted, never crossed over IPC.

Token injection happens at exactly two seams, both main-side:

1. **Subprocess calls** — every `gh api …` the GitHub service runs gets
   `GH_TOKEN` in its env.
2. **PTY spawn** — `TerminalService` composes the session env; when the
   session's workspace has a `github` binding, `GH_TOKEN` is layered on top of
   the driver env. The agent's `gh pr checkout`/`gh pr comment` then act as the
   workspace's account with no global switch. `TerminalCreateOptions` gains
   `workspaceId` so main can resolve the account itself; the renderer never
   sees a token.

Failure modes: `gh` missing → GitHub UI shows an install prompt, everything else
untouched. Token invalid/expired → Inbox header shows the `gh auth status`
error with a "re-login" hint (`gh auth login`, run by the user). Offline → the
last fetch is shown with its age; no error dialogs.

## GitHub service and the Inbox

`GitHubService` (main) fetches per GitHub-bound workspace, via
`gh api graphql` with the workspace account's token:

- **Query:** one GraphQL search per workspace covering PRs and issues that are
  assigned to, authored by, or review-requested from the account, scoped to the
  org when one is set. Fields: title, number, repo, state, CI rollup, review
  decision, updatedAt, URL.
- **Cadence:** refresh on window focus, on manual refresh, and on a timer
  (default 3 min). Results are cached in main and pushed on
  `github:inbox-changed`; renderers never fetch.
- **The Inbox is remote-driven.** Items appear whether or not the repo is
  cloned. An item whose session already exists renders "Open session"
  (re-attach); an item whose repo has no local clone renders "Clone into
  scope…".

The session work-item strip (scene 3 of the mockups) reads from the same cache —
one fetcher, one rate-limit budget.

## Worktrees

`WorktreeService` (main) owns the lifecycle under `~/.consola/worktrees/`:

- `create(repoPath, workItem)` → `git worktree add` +
  `gh pr checkout <n>` (PRs) or a new branch (issues). Directory name:
  `<repo-basename>-<type>-<number>`.
- `resolve(workspace, repo)` — maps a remote repo to a local clone by scanning
  the workspace's scopes: a repo scope matches on its `origin` remote; a
  container scope scans its child directories. The remote→path map is cached
  and invalidated when scopes change.
- `prune(session)` — offered (never automatic) when a work item is
  closed/merged; refuses while the worktree holds uncommitted changes.
- Resuming a session whose worktree was deleted recreates it — the checkout is
  idempotent — before the PTY spawns.

## Launch flows

**From the Inbox** (one click, no dialog): resolve repo → ensure worktree →
create the session record `{scopeId, cwd, workItem}` → launch with `GH_TOKEN`
and a seeded prompt describing the item. Every step reuses existing machinery:
the session record is ordinary, the prompt rides the guarded delivery queue
(never types into a confirmation menu), resume works because the worktree is
recreatable.

**The ＋ New menu** is the whole creation surface, in increasing order of
machinery:

| Door | Gesture | Produces |
|---|---|---|
| New session | pick a scope (the picker lists scopes, not a folder browser) | one session |
| New group | name it | an empty group; sessions drag in or create into it |
| Fan-out | pick a scope → select target repos within it → one prompt | N sessions in a fresh group, no conductor |
| Orchestration | name + kickoff prompt | a conductor directory scaffolded from shipped templates, a group, a conductor session at its head |

## Groups, conductors, attention

**Sidebar order: Inbox · Groups · Scopes** (the Inbox row exists only for
workspaces with a `github` binding). A grouped session renders under its
group with its scope as subtitle; an ungrouped session renders under its scope.
Groups show derived counts (`◐2 · 7 sessions`) computed from the terminal
status store — no stored progress state anywhere.

**A conductor is an ordinary session** with `kind: 'conductor'`. The
orchestration dialog asks which scope hosts its directory; the session's
`scopeId` is that scope and its `cwd` is the generated `conductor/<name>/`
inside it — the same home-vs-runs-in split worktree sessions use. The directory
holds `CLAUDE.md` (role, reading order), `POLICY.md` (auto vs escalate), and
`state.json` (survives compaction). The files are the product: everything
agent-deck makes users hand-author, Consola generates — and they stay editable
on disk, which is also the future Playbook seam (name + version the directory
and it becomes shareable, no rework).

**Attention has one signal at four altitudes:** session dot (exists today) →
group count (derived) → workspace-switcher dot on other windows (exists today)
→ OS notification when no Consola window is focused (new; click focuses the
right window and session). The Inbox never notifies — GitHub changes are
pull-refresh facts; only sessions needing the user ring the bell.

## What the main process must gain (the Layer-1 gap)

Fan-out and conductors require sessions that exist before any pane mounts:

- **Headless session start.** An entry point that creates the record *and*
  spawns the PTY without `terminal:create` arriving from a mounted pane.
  `TerminalManager` already runs headless `ScreenModel`s; the change is the
  entry point, not the machinery. Mounting later repaints from `snapshot()` —
  "terminals outlive their views" gains "…and can be born without one".
- **Prompt FIFO.** `TerminalService`'s single `pendingPrompt` overwrite slot
  becomes a queue drained one prompt per ready-composer transition. The
  delivery guard is kept byte-for-byte.
- **Status vocabulary.** Promote the existing signals to one emitted event —
  `working | ready | needs-attention | exited` — consumed by group counts and
  OS notifications.

## Error handling

- `gh` absent, token expired, offline: see Auth; always degrade to a labelled
  stale state, never a dialog.
- Repo not cloned: "Clone into scope…" flow; the clone lands inside a chosen
  container scope (or a new scope) and the launch continues.
- Worktree creation fails (dirty index, missing base, detached HEAD): surface
  the git error on the Inbox item; no session record is created — the
  operation is atomic in that order (worktree first, record second, spawn
  third).
- Conductor scaffold collision (directory exists): refuse and point at it.
- Deleting a scope with sessions: refuse while sessions reference it. Unlike
  harnesses there is no archive tier — a scope is only a pointer, so the rule
  is simply that the pointer outlives its referents.
- Deleting a group: sessions lose their `groupId` and fall back to their
  scope; the group archives rather than deletes if it has a conductor.

## Testing

- **Unit (vitest):** the v6 migration (the one failure that costs
  conversations); scope→repo resolution including container scans; token env
  composition (never in renderer-bound payloads); group progress derivation;
  prompt FIFO ordering under the delivery guard; worktree name/prune rules.
- **Stubbed `gh`:** a fake `gh` script on PATH returning canned JSON lets
  `GhBroker` and `GitHubService` be tested end-to-end without network or a real
  keyring, and lets Playwright E2E drive the Inbox deterministically.
- **E2E (Playwright):** bind a workspace to a stub account → Inbox renders →
  launch → worktree exists, session record correct → relaunch re-attaches.

## Phasing

Each phase is independently shippable and gets its own implementation plan;
writing-plans targets Phase 0 first.

| Phase | Contents | Proves |
|---|---|---|
| **0 — Model** | v6 migration, scopes replace `path`, scope CRUD + picker, `github` binding UI, `GhBroker` probe, `GH_TOKEN` into PTYs | The identity model; account switching pain gone even with zero new UI surfaces |
| **1 — Inbox** | `GitHubService`, Inbox view, `WorktreeService`, work-item launch + re-attach, session strip | The daily loop: triage → one-click session |
| **2 — Fleet** | Headless session start, prompt FIFO, status event, groups + sidebar, fan-out door, OS notifications | Many sessions with one attention stream |
| **3 — Conductors** | Orchestration door, scaffold templates, conductor spawn/observe plumbing | The Symbalance workflow inside Consola |

Deliberately deferred, each with its seam already in the design: Playbooks (the
conductor directory), other providers (`GitProviderDriver`), watchers/webhooks
(prompt FIFO + conductor inbox), Fleetwide remote execution (`TerminalService`
transport), org sharing (explicitly not Consola's business).
