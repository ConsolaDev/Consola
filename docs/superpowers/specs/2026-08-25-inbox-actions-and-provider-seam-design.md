# Inbox v2: GitHub-shaped triage, configurable actions, many sessions per item, and the provider seam

**Date:** 2026-08-25
**Status:** Designed, not yet implemented
**Mockups:** `.superpowers/brainstorm/79317-1787637506/content/` — `inbox-layout.html` (layout B chosen),
`inbox-views.html` (tab strip chosen), `actions-and-linking.html`, `workspace-settings.html` (modal chosen)
**Builds on:** `docs/superpowers/specs/2026-08-20-github-workflow-design.md` (shipped 2026-08-24)

## Problem

The shipped Inbox is a flat two-tab list (PRs / Issues) with one hardcoded verb per
row. Three things are wrong with it, in the order they hurt:

1. **The action is baked in.** `buildSeedPrompt()` decides that a PR means "review
   and summarise" and an issue means "investigate and plan". Fix CI, address a
   review, run a security pass — none of it is expressible without editing code.
2. **One item, one session, forever.** A PR that needs a review today and a CI fix
   tomorrow gets one session for both, and a session started by hand cannot be
   tied to the item it is actually about. The relation is only visible from the
   Inbox row and the strip above one terminal.
3. **The seam the last design promised does not exist.** `WorkItemRef.provider` is
   the literal `'github'`, the IPC channels are `github:*`, the binding is
   `Workspace.github`, and the fetch, parse, checkout and clone are all `gh`-shaped.
   Adding GitLab would touch every one of them.

Separately, the Inbox itself should read like GitHub's own PR inbox — the
sections and views people already triage in — rather than a Consola-invented
list, so that the mental model transfers.

And one thing the brainstorm surfaced: workspace-scoped settings live inside the
global Settings modal, which is where the new Actions editor would have landed.
That confuses "this app" with "this workspace"; the workspace gets its own modal.

## Decisions

| Question | Decision |
|---|---|
| Inbox layout | GitHub's sections verbatim plus "Issues assigned to you"; lean rows; a right-hand **detail pane** for the selected item (sessions, actions, link). Layout B in the mockups. |
| GitHub's views | Inbox · Authored by me · Assigned to me · Involves me · Review requests, as a **tab strip** in the Inbox header. Five lenses over one cache. Custom views: out of scope. |
| Session ↔ item | A **mutable relation** stored on the session: link a hand-made session after the fact, unlink, and several sessions per item. Visible from both ends (Inbox pane and row hint; sidebar label and terminal strip). |
| Disk | **One worktree per work item, shared** by all its sessions. Starting a second session while another is working shows an inline warning, not a block. Linking never moves a session. |
| Actions | Records on the workspace: `{ name, appliesTo, prompt }`. Consola prepends a fixed context header; the body is the editable part and may be a bare slash command. Edited in Workspace Settings. Per-section defaults decide which action the pane highlights. |
| Providers | A `GitProviderDriver` seam mirroring `HarnessDriver`, with GitHub as the only driver. Nothing outside `src/main/providers/` branches on a provider id. No GitLab driver in this iteration; a stub driver in tests proves the seam. |
| Workspace settings | A second, dedicated modal titled by the workspace (General · Scopes · Provider · Actions · Groups · Danger zone). The global modal keeps Appearance · Harnesses · Shortcuts. |
| GitHub writes | Unchanged: the UI is read-only against GitHub; every write happens through the agent's `gh` inside a session. |

## Domain model (state v7)

```ts
// src/shared/providers.ts — alongside PROVIDER_META (display name, CLI name, login hint)
type GitProviderId = 'github';           // a union, like HarnessDriverId

interface Workspace {
  // …id, name, defaultHarnessId, scopes, groups, sessions, createdAt, updatedAt
  provider?: {                           // replaces `github`
    id: GitProviderId;
    accountLogin: string;
    org?: string;
  };
  actions: WorkItemAction[];             // ordered; [] for unbound workspaces
  sectionDefaults: Partial<Record<InboxSection, string>>;   // section -> action id
}

interface WorkItemAction {
  id: string;
  name: string;                          // "Review", "Fix CI"
  appliesTo: ('pr' | 'issue')[];         // non-empty
  prompt: string;                        // body only; non-empty
}

interface WorkItemRef {
  provider: GitProviderId;
  repo: string;                          // "owner/name"
  type: 'pr' | 'issue';
  number: number;
}

interface Session {
  // …unchanged fields
  workItem?: WorkItemRef;                // now MUTABLE: link / unlink after the fact
  workItemAction?: string;               // the action's NAME at launch; absent for linked sessions
}
```

**Immutability.** `scopeId`, `cwd`, `kind`, `harnessId` and `model` stay off
`allowedSessionUpdates`. `workItem` joins `groupId` on the list with presence
semantics: `'workItem' in updates` and `undefined` means unlink. Main validates
the ref on the way in (known provider id, `owner/name`, `pr | issue`, integer
number) and refuses to link a `conductor` session.

**Why a name snapshot, not an action id.** `workItemAction` is a label for the
sidebar and the strip — "this session was started as *Review*". Renaming or
deleting the action later must not rewrite what past sessions were.

**Why the link stays on the session.** One item can have many sessions but one
session belongs to at most one item, so the relation is a nullable field, not a
join table. `sameWorkItem`/`workItemKey` keep working unchanged.

**Sidebar label** is derived from the record, not from `name`: `PR #4118 · Review`
for a launched session, `⑂ <name>` for a linked one. `name` remains renameable
and is shown as the row's subtitle/tooltip. The CLI-summary poll no longer
decides what a work-item row reads.

**Prompt template placeholders:** `{{number}} {{repo}} {{title}} {{url}} {{type}}`
(`type` renders as "pull request" / "issue"). The rendered body must be non-empty.

**Default actions** (seeded when a provider is bound, and by the migration):

| name | appliesTo | body |
|---|---|---|
| Review | pr | Review the changes and summarise your findings before writing any review comments. |
| Address review | pr | Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread. |
| Fix CI | pr | Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push. |
| Implement | issue | Investigate it and propose a plan before changing anything. |
| Triage | issue | Reproduce, label the severity, and comment your findings. Do not change code. |

Default `sectionDefaults`: needs-your-review → Review, needs-team-review → Review,
needs-action → Address review, waiting → Fix CI, issues → Implement. Drafts and
ready-to-merge have no default.

**Editing channel:** `workspace:set-actions` replaces `actions` + `sectionDefaults`
in one validated write (unique ids, non-empty `appliesTo` and `prompt`, every
default points at an existing action of a matching type). No per-action CRUD.

### Migration v6 → v7

- `github` → `provider: { id: 'github', accountLogin, org }`.
- Bound workspaces receive the default `actions` and `sectionDefaults`; unbound
  ones receive `actions: []`, `sectionDefaults: {}`.
- Every existing session with a `workItem` gets `workItemAction` by item type:
  PR → "Review", issue → "Implement". The role it was launched under is not
  persisted (the inbox cache is in memory only), so the migration cannot do
  better than the type — and today's hardcoded prompt was exactly that split.
- Local-only workspaces come out byte-for-byte identical apart from the two new
  empty fields. Covered by its own tests, like v4–v6.

## The provider seam

```ts
// src/main/providers/GitProviderDriver.ts
interface GitProviderDriver {
  readonly id: GitProviderId;
  /** Env var carrying the borrowed token into subprocesses and PTYs ('GH_TOKEN'). */
  readonly tokenEnvVar: string;
  /** Binary present? Who is signed in? Feeds the binding panel. */
  probe(): Promise<ProviderProbeResult>;
  /** Borrow a token for one account; cached briefly in memory, never persisted. */
  token(accountLogin: string): Promise<string>;
  /** One request, provider-neutral items. Must throw on an unrecognised reply. */
  fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]>;
  /** Check a work item out inside an existing detached worktree. */
  checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<void>;
  cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void>;
  /** Whether a git remote URL names `repo` on this provider. */
  matchesRemote(remoteUrl: string, repo: string): boolean;
  workItemUrl(ref: WorkItemRef): string;
  /** The fixed context header prepended to every action body. */
  seedHeader(ref: WorkItemRef, item?: InboxItem): string;
}
```

**What moves where.**

| Today | After |
|---|---|
| `src/main/github/GhBroker.ts` | `src/main/providers/github/GitHubDriver.ts` (`probe`, `token`) |
| `src/main/github/parseInbox.ts` | `src/main/providers/github/inboxQuery.ts` (query + parser, used by `fetchInbox`) |
| `src/main/github/cloneRepo.ts` | driver `cloneRepo` + provider-neutral `cloneWorkspaceRepo` in `src/main/providers/cloneRepo.ts` |
| `src/main/github/GitHubService.ts` | `src/main/providers/InboxService.ts` — same cache/timer/focus/broadcast, `driver.fetchInbox` instead of `gh api graphql` |
| `src/main/github/launchWorkItem.ts` | `src/main/providers/launchWorkItem.ts` — resolves the driver from `workspace.provider.id` |
| `WorktreeService` PR path: `gh pr checkout` | `driver.checkout(dir, ref, env)`; every git mechanic (add, prune, common-dir check, issue branch) stays |
| `normalizeRemote` host-agnostic | `driver.matchesRemote` (GitHub: host is `github.com`, `owner/name` case-insensitive) |
| `src/main/drivers/index.ts` registry pattern | `src/main/providers/index.ts`: `getProviderDriver(id)` |

**Wire and bridge renames**, so the seam is visible from the renderer:

| Today | After |
|---|---|
| `github:get-inbox`, `github:refresh-inbox`, `github:inbox-changed` | `inbox:get`, `inbox:refresh`, `inbox:changed` |
| `github:probe`, `github:resolve-repos`, `github:launch-work-item`, `github:clone-repo` | `provider:probe`, `provider:resolve-repos`, `provider:launch-work-item`, `provider:clone-repo` |
| `workspace:set-github-binding` | `workspace:set-provider-binding` |
| `githubBridge` | `inboxBridge` + `providerBridge` |
| `GitHubBindingPanel` | `ProviderBindingPanel`; display name, CLI name and login hint come from `PROVIDER_META` in `src/shared/providers.ts` |
| `src/shared/github.ts` | `src/shared/workItems.ts` (`WorkItemRef`, `InboxItem`, `InboxSnapshot`, `sameWorkItem`, `workItemKey`) |

**Kept.** The token never crosses IPC. `TerminalService` layers `driver.tokenEnvVar`
onto the PTY env of bound workspaces exactly as it layers `GH_TOKEN` today.
`HarnessDriver` is untouched.

**`InboxItem`** (provider-neutral):

```ts
type InboxRole = 'review-requested-direct' | 'review-requested-team' | 'author' | 'assignee' | 'involved';

interface InboxItem {
  workItem: WorkItemRef;
  title: string;
  author: string;
  roles: InboxRole[];                    // replaces the single `role`
  isDraft: boolean;
  state: string;
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none';
  ciStatus?: 'pending' | 'passing' | 'failing';
  checks?: { passed: number; failed: number; pending: number; total: number };
  commentCount: number;
  additions?: number;
  deletions?: number;
  updatedAt: string;                     // ISO
  url: string;
}
```

## Inbox data

**Fetch.** One GraphQL request per workspace, five aliased searches, `first: 50`
each, all `is:open archived:false`, org-scoped when the binding has an org:

| alias | qualifier | role |
|---|---|---|
| `direct` | `user-review-requested:<login> is:pr` | `review-requested-direct` |
| `team` | `review-requested:<login> is:pr` | `review-requested-team`, only when the item is not in `direct` |
| `authored` | `author:<login>` | `author` |
| `assigned` | `assignee:<login>` | `assignee` |
| `involved` | `involves:<login>` | `involved` |

The fragment adds `isDraft`, `author { login }`, `comments { totalCount }` and
`statusCheckRollup { state contexts(first: 100) { totalCount nodes { … } } }` so
check counts are derivable. The parser merges an item that appears in several
searches into one `InboxItem` carrying all its roles. Cadence (focus, timer,
manual), cache, broadcast and "degrade, never dialog" are unchanged.

**Sections** — `sectionFor(item)` in `src/shared/inboxSections.ts`, pure, first
match wins, in this order:

| `InboxSection` | rule |
|---|---|
| `needs-your-review` | PR · `review-requested-direct` |
| `needs-team-review` | PR · `review-requested-team` |
| `your-drafts` | PR · `author` · `isDraft` |
| `needs-action` | PR · `author` · `changes-requested` **or** `ciStatus = failing` |
| `ready-to-merge` | PR · `author` · `approved` · checks passing or none |
| `waiting` | PR · `author` · anything else |
| `issues` | issue · `assignee` |

An item matching no row is absent from the Inbox view but present in "Involves
me". The section order in the view is GitHub's (as in the screenshots) with
Issues last. Collapsed/expanded state is per section per workspace, renderer
local state.

**Views** — five pure filters over the same cache, shown as a tab strip with
counts: Inbox (sectioned) · Authored by me (`author`) · Assigned to me
(`assignee`) · Involves me (any role) · Review requests (direct or team). Flat
views sort by `updatedAt` descending.

**Filters** — applied client-side before sectioning: *Select repositories*
(multi-select over the repos present in the snapshot) and *Updated* (last week /
month / 3 months / any; default month). Both persist per workspace in the
renderer settings store. No extra fetch, no extra rate budget.

## Behaviour

### Starting a session from an action

`provider:launch-work-item` with `{ workspaceId, ref, action: { id } | { customPrompt } }`:

1. resolve the repo through the workspace's scopes (unchanged) — `not-cloned`
   offers the clone flow;
2. ensure the item's **shared** worktree (`WorktreeService.ensureWorktree`,
   already idempotent and keyed by item);
3. create the session record `{ scopeId, cwd, workItem, workItemAction }`;
4. return `{ session, seedPrompt }` where `seedPrompt = driver.seedHeader(ref, item) + '\n\n' + renderedBody`.

Always a **new** session — re-attach is an explicit "Open" on a listed session.
Same atomic order as today (worktree, record, spawn), same guarded prompt
delivery (never into a confirmation menu). The launch coalescer is keyed by
**item + action** (custom prompts by item + body hash): a double-click on one
button still mints one session, while two different actions started back to
back on the same item each get their own.

**Concurrency warning** is renderer-side, because only the renderer knows
terminal status: if any session on the item is `working` or `needs-attention`,
the pane's action button becomes an inline "Another session is working on this
— Start anyway" confirm. Never a dialog, never a block.

### Linking

`workspace:update-session` with `{ workItem: ref }`; unlink with `{ workItem: undefined }`.
One `LinkSessionDialog` component serves two doors with the list flipped:

- from the Inbox pane, "Link existing session…" lists the workspace's sessions
  (already-linked greyed, conductors hidden), searchable;
- from the sidebar context menu, "Link to work item…" lists inbox items,
  searchable; a linked session's menu offers "Unlink".

Linking never moves the session and never sends a prompt. Unlinking a session
that runs in an item's worktree leaves it there.

### Inbox view (layout B)

Header: title, *Select repositories*, *Updated*, account/org, staleness label,
refresh, ⚙ (opens Workspace Settings). Tab strip of the five views. Then
sections or a flat list.

Row: type icon · title · `repo#n · author · updated · [worst-status dot] N sessions`
· review state · `✓ 3/5` checks · comment count. A left accent bar marks direct
review requests, as GitHub does.

Selecting a row opens the pane; selecting it again or `Esc` closes it. The pane
shows: title, `repo#n · author · Open on GitHub`; GitHub facts (review decision,
checks, diff size); **Sessions** (each with status dot, action label, age, cwd
hint, "Open"), then "Link existing session…"; **Start a session** — every
action whose `appliesTo` matches the item type, the section default
highlighted, plus "Custom prompt…" (an ad-hoc body, not stored). A repo with no
local clone greys the row and makes "Clone into scope…" the pane's only enabled
action.

### Workspace Settings modal

A second Radix dialog, `WorkspaceSettingsModal`, titled by the workspace, with a
left nav: **General** (`ManifestHeader` + `HarnessPanel`) · **Scopes** · **Provider**
(`ProviderBindingPanel`, labelled by the bound provider, e.g. "GitHub") ·
**Actions** (new `ActionsPanel`) · **Groups** · **Danger zone**. The six
existing panels move unchanged. Keyed by workspace id so switching workspaces
discards drafts.

`ActionsPanel`: ordered list (drag to reorder), inline edit (name, applies-to
chips, the fixed header shown greyed above the editable body), add, delete,
"Restore defaults", and the per-section default pickers. Saves through
`workspace:set-actions`.

Entry points: the top-bar workspace menu ("Workspace settings…"), the command
palette, the Inbox header ⚙. The global Settings modal keeps Appearance ·
Harnesses · Shortcuts and, for this release, shows a one-line pointer where the
Workspace tab was. `⌘,` keeps opening the global modal.

### Sidebar and strip

Sidebar: work-item rows render the derived label; the context menu gains
"Link to work item…" / "Unlink". Strip above the terminal: gains the action pill
and a "N sessions on this PR ▾" menu that activates a sibling session; the
fallback when the item has left the inbox is unchanged.

## Error handling

- `gh` absent, token expired, offline, malformed payload: unchanged — labelled
  staleness, never a dialog; a driver must throw on an unrecognised reply.
- Unknown action id, empty rendered body, unbound workspace, invalid ref:
  returned as `{ ok: false, reason: 'error', message }` and shown on the item /
  in the pane.
- Worktree creation failures: unchanged (no record created; error on the item).
- Deleting an action referenced by a section default clears that default.
  Deleting an action never touches sessions (they hold a name snapshot).
- `workspace:set-actions` validation failure rejects the whole write; the panel
  shows the message inline.
- Linking a conductor session, or an already-linked session to a second item:
  refused main-side with a message.

## Testing

**Unit (vitest)**

- v6 → v7 migration: binding rename; actions seeded only for bound workspaces;
  `workItemAction` backfill; local-only workspaces unchanged but for the two
  empty fields.
- `allowedSessionUpdates`: `workItem` presence semantics; `scopeId`, `cwd`,
  `kind` still dropped.
- `sectionFor` and the view filters: one fixture per row of the section table,
  the "no section but in Involves me" case, first-match precedence.
- Parser role merging across the five aliases; check-count derivation.
- Prompt rendering: header + body, every placeholder, empty-body refusal, a
  slash-command body passes through untouched.
- `InboxService` and `launchWorkItem` against a **stub driver**: the proof that
  nothing outside `src/main/providers/` branches on `'github'`.
- GitHub driver: `fetchInbox` over the existing fake `gh` with the five-alias
  payload; `checkout` and `cloneRepo` argv and env (`GH_TOKEN` present).
- `WorktreeService`: a second launch on the same item returns the same
  directory without a checkout; `assertBelongsToClone` unchanged.
- `workspace:set-actions` validation: duplicate ids, empty `appliesTo`, empty
  prompt, dangling default, type-mismatched default.

**E2E (Playwright, stub `gh`)**

Bind → sections render with the right counts → switch views and filters →
start an action → the pane lists the session → start a second action on the
same item → both sessions share `cwd` → link a hand-made session from the
sidebar → the pane lists three → open Workspace Settings from the top-bar menu,
rename an action, see the new name in the pane.

## Phasing

| Phase | Contents | Depends on |
|---|---|---|
| **A — Workspace Settings modal** | `WorkspaceSettingsModal` + nav, panels moved, global modal loses the tab, entry points | nothing |
| **B — Seam + model** | `GitProviderDriver`, GitHub driver, `InboxService`, `WorktreeService` delegation, renames (files, channels, bridges, shared types), v7 migration, `workspace:set-actions` + validation | nothing (parallel with A) |
| **C — Actions, sessions, linking** | `ActionsPanel`, launch payload + prompt rendering, mutable `workItem`, `LinkSessionDialog` (both doors), sidebar labels and menu, strip additions | A, B |
| **D — Inbox view** | five-search fetch and parser, `sectionFor`, views, filters, layout B rows and pane | B (pane needs C to show actions) |

Each phase is independently shippable and gets its own implementation plan.

## Deliberately out of scope

Custom/saved views; a GitLab (or any second) driver; GitHub writes from the UI;
per-action harness or model overrides; one-worktree-per-session; watchers or
webhooks. Each has its seam: views are filters over the cache, a driver is a
registry entry, an action is a record that can grow fields.
