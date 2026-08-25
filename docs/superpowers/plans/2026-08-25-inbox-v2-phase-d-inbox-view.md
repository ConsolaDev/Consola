# Inbox v2 Phase D — Inbox View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Inbox reads like GitHub's own PR inbox: one five-search fetch per workspace, GitHub's sections (plus "Issues assigned to you") with per-section collapse, five views as a tab strip, repository and Updated filters that persist per workspace, lean rows with a session hint, and the selected item's pane on the right — over the sessions, actions and linking that Phase C already built.

**Architecture:** Main's `InboxService` keeps fetching through `GitHubDriver.fetchInbox`; this phase widens `inboxQuery.ts` to five aliased searches whose parser merges roles per item and derives check counts from the status rollup, and the stub `gh` fixture grows to nine items across all five aliases. Everything else is renderer-side and pure-first: `src/shared/inboxViews.ts` (views over the cache), `Inbox/inboxFilters.ts` (client-side filters), a `settingsStore.inboxFilters` slice, `inboxPresentation.ts` (row labels), and five small components — `InboxHeader`, `InboxFilters`, `ViewTabs`, `InboxSectionGroup`, `InboxRow` — orchestrated by a rewritten `Inbox/index.tsx` that owns view, filter, selection and collapse state and mounts C's `InboxItemPane` in a right-hand slot. The Playwright spec is rewritten to the spec's full flow against a runtime-generated fixture.

**Tech Stack:** Electron 28 (main + preload + renderer), React 19, Zustand (`persist`), Radix `DropdownMenu` (`CheckboxItem`, `RadioGroup`/`RadioItem`, `ItemIndicator` — all exported by the installed `@radix-ui/react-dropdown-menu@2.1.16`), `lucide-react`, `gh` CLI as a subprocess, vitest (co-located, node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-inbox-actions-and-provider-seam-design.md` — sections "Inbox data" (fetch, sections, views, filters), "Inbox view (layout B)", "Error handling", "Testing" (unit bullets for the parser, `sectionFor` consumers and the view filters; the E2E flow). Mockups: `.superpowers/brainstorm/79317-1787637506/content/inbox-layout.html` option B and `inbox-views.html` option 2. Cross-phase names are fixed by the contracts file recorded at planning time (`scratchpad/blueprints/contracts.md`, "Phase D" rulings 1–7); where this plan says "verify at execution" it names the one B/A/C detail an executor must read off the tree before editing.

## Global Constraints

- **Phase order is B → A → C → D.** This plan starts from the tree after Phase C's final commit on `feat/inbox-v2`. Every name it consumes from those phases (`src/shared/workItems.ts`, `src/shared/inboxSections.ts`, `src/main/providers/**`, `inboxBridge`/`providerBridge`, `InboxItemPane`, `statusDots.css`, `sessionLabel`, `useWorkspaceSettings`) is fixed by the contracts — never invent a sibling, never recreate one.
- **Bridge pattern is binding**: renderer code never touches `window.*API`; everything goes through `src/renderer/services/*Bridge.ts` (`inboxBridge`, `providerBridge`, `workspaceBridge`). Every IPC channel name lives in `IPC_CHANNELS` in `src/shared/constants.ts`. This phase adds no channel and no bridge method.
- **One request per workspace.** The Inbox fetch stays a single `gh api graphql` subprocess per refresh, now carrying five aliased searches, each `first: 50`, all `is:open archived:false`, org-scoped by appending ` org:<org>` when the binding has an org. Alias → search qualifier → role, verbatim:
  - `direct` → `user-review-requested:<login> is:pr is:open archived:false` → `review-requested-direct`
  - `team` → `review-requested:<login> is:pr is:open archived:false` → `review-requested-team` (only when the item is not in `direct`)
  - `authored` → `author:<login> is:open archived:false` → `author`
  - `assigned` → `assignee:<login> is:open archived:false` → `assignee`
  - `involved` → `involves:<login> is:open archived:false` → `involved`
- **Fragment fields (verbatim).** Issue: `title number state url updatedAt repository { nameWithOwner } author { login } comments { totalCount }`. PullRequest: the same plus `isDraft reviewDecision additions deletions commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }`.
- **Sections come from B** — `sectionFor`, `sectionItemType`, `INBOX_SECTIONS`, `DEFAULT_COLLAPSED_SECTIONS` in `src/shared/inboxSections.ts`. Do not recreate them. Display order and labels, verbatim: `needs-your-review` "Needs your review" · `needs-team-review` "Needs your teams' review" · `your-drafts` "Your drafts" · `waiting` "Waiting for review or checks" · `needs-action` "Needs action" · `ready-to-merge` "Ready to merge" · `issues` "Issues assigned to you". Collapsed by default: `needs-team-review`, `your-drafts`, `ready-to-merge`. Collapsed state is component state keyed by workspace id, never persisted.
- **Views (verbatim labels, tab order):** `inbox` "Inbox" · `authored` "Authored by me" · `assigned` "Assigned to me" · `involved` "Involves me" · `review-requests` "Review requests". "Involves me" is every cached item. Flat views sort by `updatedAt` descending.
- **Filters (verbatim labels):** repositories — the trigger reads "Select repositories" when nothing is selected, and an empty selection means no filtering; Updated — `week` "Last week", `month` "Last month", `quarter` "Last 3 months", `any` "Any time", default `month`. Both apply client-side, before sectioning and before every count, and persist per workspace in `settingsStore.inboxFilters`. No extra fetch, no extra rate budget.
- **Status dots come from C** — `src/renderer/styles/statusDots.css` defines `.status-dot` and `.status-dot--working|--ready|--needs-attention|--done|--exited`. `.inbox-dot--*` is retired in this phase; nothing new may reference it.
- **`InboxItemPane` is C's.** Its props are exactly `{ workspace, item, onClose }` and it highlights the section default itself. This phase passes nothing else and never edits its behaviour; it only verifies two selectors on it.
- **Selectors this phase exposes (the e2e drives them):** `[data-testid="inbox-tab-{id}"]` buttons with `role="tab"` inside a `role="tablist"`, each holding `.inbox-view-tab-count`; `[data-testid="inbox-section-{id}"]` sections with `.inbox-section-toggle` and `.inbox-section-count`; `.inbox-row[data-work-item-key]` where the key is `workItemKey(item.workItem)`; `.inbox-repo-filter-trigger` (Radix `menuitemcheckbox` items, one per repo, labelled `owner/name`) and `.inbox-updated-filter-trigger` (`menuitemradio` items with the labels above); `.inbox-refresh` (`aria-label="Refresh inbox"`); `.inbox-settings-button` (`aria-label="Workspace settings"`); `.inbox-pane-slot`; and, on C's pane, `[data-action-id="<action id>"]` on every Start-a-session button and `.inbox-pane-session-row` on every listed session.
- **Degrade, never dialog:** a fetch or parse failure keeps the last good list and labels the staleness in the header beside the refresh button; the parser throws on an unrecognised top-level reply so a broken payload is never read as an empty inbox. The Inbox is read-only against the provider and never raises OS notifications.
- **Commands:** `npm test` (vitest, node environment, `src/**/*.test.ts` only — no jsdom, no testing-library; React components are covered by `npm run typecheck` + Playwright, pure helpers by vitest), `npx vitest run <path>`, `npm run typecheck` (main + preload + renderer tsconfigs), `npm run build`, then `npx playwright test tests/e2e/inbox.spec.ts` (the e2e launches `dist/main/main/index.js`, so build first). `tests/e2e/terminal.spec.ts` fails standalone on main — not a regression signal.
- **Commits:** conventional prefix (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`), a body that explains why, and the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. `npm test` and `npm run typecheck` stay green after every task.
- No emoji in code, comments or UI copy. Icons come from `lucide-react` only (all verified present in the installed version: `GitPullRequest`, `GitPullRequestDraft`, `CircleDot`, `Settings`, `RefreshCw`, `ChevronDown`, `ChevronRight`, `Check`, `X`, `MessageSquare`). Co-located `styles.css` using `var(--space-*)`, `var(--color-*)`, `var(--radius-*)` tokens; dropdowns use the shared `.dropdown-content/.dropdown-item/.dropdown-separator` classes from `Sidebar/styles.css`. Comments explain why, in the repo's voice.

---

### Task 1: Views — five lenses over one cache

**Files:**
- Create: `src/shared/inboxViews.ts`
- Test: `src/shared/inboxViews.test.ts`

**Interfaces:**
- Consumes: `InboxItem`, `InboxRole` from `src/shared/workItems.ts` (B); `INBOX_SECTIONS`, `sectionFor`, `InboxSection` from `src/shared/inboxSections.ts` (B).
- Produces:
  - `type InboxViewId = 'inbox' | 'authored' | 'assigned' | 'involved' | 'review-requests'`
  - `INBOX_VIEWS: ReadonlyArray<{ id: InboxViewId; label: string }>` (tab order)
  - `itemsForView(items: InboxItem[], view: InboxViewId): InboxItem[]` — a new, sorted array; never mutates its input
  - `interface SectionedItems { section: InboxSection; items: InboxItem[] }`
  - `groupBySection(items: InboxItem[]): SectionedItems[]` — all seven sections in `INBOX_SECTIONS` display order, empty ones included

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/inboxViews.test.ts
import { describe, expect, it } from 'vitest';
import { INBOX_SECTIONS } from './inboxSections';
import { INBOX_VIEWS, groupBySection, itemsForView } from './inboxViews';
import type { InboxItem, InboxRole } from './workItems';

/**
 * The item number doubles as its day of the month, so sorting by updatedAt
 * descending is the same as sorting by number descending -- which keeps
 * every ordering assertion below readable.
 */
function makeItem(number: number, roles: InboxRole[], overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number },
    title: `Item ${number}`,
    author: 'someone',
    roles,
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    commentCount: 0,
    updatedAt: `2026-08-${String(number).padStart(2, '0')}T00:00:00Z`,
    url: `https://github.com/sympower/flex-portal/pull/${number}`,
    ...overrides,
  };
}

const numbers = (items: InboxItem[]) => items.map((item) => item.workItem.number);

const direct = makeItem(1, ['review-requested-direct']);
const team = makeItem(2, ['review-requested-team']);
const authored = makeItem(3, ['author']);
const assignedIssue = makeItem(4, ['assignee'], {
  workItem: { provider: 'github', repo: 'sympower/flex-portal', type: 'issue', number: 4 },
});
const involvedOnly = makeItem(5, ['involved']);
// Deliberately unsorted: every view must sort for itself.
const all = [authored, involvedOnly, direct, assignedIssue, team];

describe('INBOX_VIEWS', () => {
  it("lists the five views in tab order with GitHub's labels", () => {
    expect(INBOX_VIEWS).toEqual([
      { id: 'inbox', label: 'Inbox' },
      { id: 'authored', label: 'Authored by me' },
      { id: 'assigned', label: 'Assigned to me' },
      { id: 'involved', label: 'Involves me' },
      { id: 'review-requests', label: 'Review requests' },
    ]);
  });
});

describe('itemsForView', () => {
  it('inbox: only items that land in a section', () => {
    expect(numbers(itemsForView(all, 'inbox'))).toEqual([4, 3, 2, 1]);
  });

  it('authored: the author role', () => {
    expect(numbers(itemsForView(all, 'authored'))).toEqual([3]);
  });

  it('assigned: the assignee role', () => {
    expect(numbers(itemsForView(all, 'assigned'))).toEqual([4]);
  });

  it('involved: every cached item, including one no section wants', () => {
    expect(numbers(itemsForView(all, 'involved'))).toEqual([5, 4, 3, 2, 1]);
    expect(numbers(itemsForView(all, 'inbox'))).not.toContain(5);
  });

  it('review-requests: direct and team requests alike', () => {
    expect(numbers(itemsForView(all, 'review-requests'))).toEqual([2, 1]);
  });

  it('sorts every view newest-updated first', () => {
    for (const { id } of INBOX_VIEWS) {
      const stamps = itemsForView(all, id).map((item) => item.updatedAt);
      expect(stamps).toEqual([...stamps].sort().reverse());
    }
  });

  it('never mutates the cache it reads', () => {
    const before = numbers(all);
    itemsForView(all, 'involved');
    expect(numbers(all)).toEqual(before);
  });
});

describe('groupBySection', () => {
  it('emits all seven sections in display order, empty ones included', () => {
    const groups = groupBySection(all);
    expect(groups.map((group) => group.section)).toEqual(INBOX_SECTIONS.map((section) => section.id));
    const itemsIn = (section: string) =>
      numbers(groups.find((group) => group.section === section)?.items ?? []);
    expect(itemsIn('needs-your-review')).toEqual([1]);
    expect(itemsIn('needs-team-review')).toEqual([2]);
    expect(itemsIn('waiting')).toEqual([3]);
    expect(itemsIn('issues')).toEqual([4]);
    expect(itemsIn('your-drafts')).toEqual([]);
    expect(itemsIn('needs-action')).toEqual([]);
    expect(itemsIn('ready-to-merge')).toEqual([]);
  });

  it('drops an item no section wants', () => {
    const everyGrouped = groupBySection(all).flatMap((group) => numbers(group.items));
    expect(everyGrouped).not.toContain(5);
  });

  it('sorts within a section newest first', () => {
    const later = makeItem(6, ['author']);
    const waiting = groupBySection([authored, later]).find((group) => group.section === 'waiting');
    expect(numbers(waiting?.items ?? [])).toEqual([6, 3]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/inboxViews.test.ts`
Expected: FAIL — `Cannot find module './inboxViews'`.

- [ ] **Step 3: Implement `src/shared/inboxViews.ts`**

```ts
// src/shared/inboxViews.ts
import { INBOX_SECTIONS, sectionFor, type InboxSection } from './inboxSections';
import type { InboxItem } from './workItems';

/**
 * GitHub's own navigation over one workspace's cache: Inbox is the sectioned
 * triage, the other four are flat lists. Five lenses, one fetch -- a view
 * never costs a request.
 */
export type InboxViewId = 'inbox' | 'authored' | 'assigned' | 'involved' | 'review-requests';

/** Tab order and labels, as on github.com. */
export const INBOX_VIEWS: ReadonlyArray<{ id: InboxViewId; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'authored', label: 'Authored by me' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'involved', label: 'Involves me' },
  { id: 'review-requests', label: 'Review requests' },
];

function byUpdatedDesc(a: InboxItem, b: InboxItem): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The items one view shows, newest first.
 *
 * "involved" is deliberately unfiltered: every item in the merged cache is
 * there because some search returned it, so "any role" means "everything" --
 * including an item no Inbox section wants, which is exactly the case the
 * spec calls out ("absent from the Inbox view but present in Involves me").
 */
export function itemsForView(items: InboxItem[], view: InboxViewId): InboxItem[] {
  switch (view) {
    case 'inbox':
      return items.filter((item) => sectionFor(item) !== null).sort(byUpdatedDesc);
    case 'authored':
      return items.filter((item) => item.roles.includes('author')).sort(byUpdatedDesc);
    case 'assigned':
      return items.filter((item) => item.roles.includes('assignee')).sort(byUpdatedDesc);
    case 'involved':
      return [...items].sort(byUpdatedDesc);
    case 'review-requests':
      return items
        .filter(
          (item) =>
            item.roles.includes('review-requested-direct') ||
            item.roles.includes('review-requested-team')
        )
        .sort(byUpdatedDesc);
  }
}

export interface SectionedItems {
  section: InboxSection;
  items: InboxItem[];
}

/**
 * The sectioned Inbox view: every section in INBOX_SECTIONS' display order,
 * empty ones included, so the list always shows the same seven headings with
 * their counts -- as GitHub does -- rather than a shape that shifts with the
 * data.
 */
export function groupBySection(items: InboxItem[]): SectionedItems[] {
  const buckets = new Map<InboxSection, InboxItem[]>();
  for (const { id } of INBOX_SECTIONS) buckets.set(id, []);
  for (const item of items) {
    const section = sectionFor(item);
    if (section) buckets.get(section)?.push(item);
  }
  return INBOX_SECTIONS.map(({ id }) => ({
    section: id,
    items: (buckets.get(id) ?? []).sort(byUpdatedDesc),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/inboxViews.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/inboxViews.ts src/shared/inboxViews.test.ts
git commit -m "feat(inbox): the five views as pure filters over the cache

GitHub's Inbox / Authored / Assigned / Involves / Review requests are
lenses over one fetched list, not five fetches. Involves me is every
cached item on purpose: an item no section wants still belongs there.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Fetch — five-alias query, role merge, check derivation, and the fixture that proves it

**Files:**
- Modify: `tests/fixtures/stub-gh/graphql-inbox.json` (rewrite: five aliases, nine items)
- Modify: `tests/fixtures/stub-gh/gh` (`GRAPHQL_INBOX_FIXTURE` and `STUB_GH_ARGV_LOG` knobs)
- Modify: `src/main/providers/github/stubGh.test.ts` (B moved it here from `src/main/github/`)
- Modify: `src/main/providers/github/inboxQuery.ts` (rewrite — B's three-alias version becomes five)
- Modify: `src/main/providers/github/inboxQuery.test.ts` (rewrite)

**Interfaces:**
- Consumes: `InboxItem`, `InboxRole`, `workItemKey` from `src/shared/workItems.ts` (B).
- Produces (all from `src/main/providers/github/inboxQuery.ts`):
  - `INBOX_QUERY: string`
  - `type InboxSearchAlias = 'direct' | 'team' | 'authored' | 'assigned' | 'involved'`
  - `type InboxSearchStrings = Record<InboxSearchAlias, string>`
  - `INBOX_SEARCH_ALIASES: ReadonlyArray<InboxSearchAlias>` — the merge order, `direct` first
  - `searchStrings(accountLogin: string, org?: string): InboxSearchStrings`
  - `parseInboxPayload(payload: unknown): InboxItem[]` — roles merged per item, newest first; throws on a malformed top level
- Also produces two stub-`gh` env knobs the driver test (Task 3) and the e2e (Task 14) rely on: `GRAPHQL_INBOX_FIXTURE=<path>` (what `api graphql` prints) and `STUB_GH_ARGV_LOG=<path>` (every invocation appends its argv, one `argv\t<arg>` line per argument, then one `env\tGH_TOKEN=<value>` line).

The fixture and the parser change together in one task because they are one contract: B's fixture-reading parser tests would go red the moment the aliases change, and the new parser reads nothing under B's alias names. Nine items, org `sympower`, account `SymJavi` — the table the e2e (Task 14) is built on:

| # | repo | item | aliases | roles after merge | section |
|---|---|---|---|---|---|
| 1 | controller-app | PR #51 | direct, team | `review-requested-direct` only | needs-your-review |
| 2 | flex-portal | PR #60 | team | `review-requested-team` | needs-team-review |
| 3 | flex-portal | PR #70 | authored, involved | `author`, `involved`; draft | your-drafts |
| 4 | flex-portal | PR #80 | authored | `author`; changes requested | needs-action |
| 5 | flex-portal | PR #90 | authored | `author`; approved, 4/4 checks | ready-to-merge |
| 6 | flex-portal | PR #100 | authored | `author`; review required, 2 pending checks | waiting |
| 7 | msa-resource-bff | Issue #12 | assigned, involved | `assignee`, `involved` | issues |
| 8 | other-repo | PR #200 | involved | `involved` | none |
| 9 | old-repo | Issue #300 | involved | `involved`; six months old | none |

- [ ] **Step 1: Rewrite `tests/fixtures/stub-gh/graphql-inbox.json`**

Replace the whole file with:

```json
{
  "data": {
    "direct": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "Extract billing client",
          "number": 51,
          "state": "OPEN",
          "url": "https://github.com/sympower/controller-app/pull/51",
          "updatedAt": "2026-08-22T07:55:00Z",
          "repository": { "nameWithOwner": "sympower/controller-app" },
          "author": { "login": "steve-sympower" },
          "comments": { "totalCount": 1 },
          "isDraft": false,
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 210,
          "deletions": 88,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "FAILURE",
                    "contexts": {
                      "totalCount": 3,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" },
                        { "__typename": "StatusContext", "state": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        }
      ]
    },
    "team": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "Extract billing client",
          "number": 51,
          "state": "OPEN",
          "url": "https://github.com/sympower/controller-app/pull/51",
          "updatedAt": "2026-08-22T07:55:00Z",
          "repository": { "nameWithOwner": "sympower/controller-app" },
          "author": { "login": "steve-sympower" },
          "comments": { "totalCount": 1 },
          "isDraft": false,
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 210,
          "deletions": 88,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "FAILURE",
                    "contexts": {
                      "totalCount": 3,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE" },
                        { "__typename": "StatusContext", "state": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        },
        {
          "__typename": "PullRequest",
          "title": "Migrate flex-portal to the shared auth client",
          "number": 60,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/60",
          "updatedAt": "2026-08-22T06:10:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "maria-sympower" },
          "comments": { "totalCount": 0 },
          "isDraft": false,
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 340,
          "deletions": 120,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "SUCCESS",
                    "contexts": {
                      "totalCount": 2,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        }
      ]
    },
    "authored": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "WIP: auto-scale the operating envelope axis",
          "number": 70,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/70",
          "updatedAt": "2026-08-21T18:00:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 0 },
          "isDraft": true,
          "reviewDecision": null,
          "additions": 40,
          "deletions": 8,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": null } }] }
        },
        {
          "__typename": "PullRequest",
          "title": "Explain the one year cap on custom revenue date ranges",
          "number": 80,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/80",
          "updatedAt": "2026-08-21T16:30:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 2 },
          "isDraft": false,
          "reviewDecision": "CHANGES_REQUESTED",
          "additions": 25,
          "deletions": 4,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "SUCCESS",
                    "contexts": {
                      "totalCount": 2,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        },
        {
          "__typename": "PullRequest",
          "title": "Add release notes generator",
          "number": 90,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/90",
          "updatedAt": "2026-08-21T12:00:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 1 },
          "isDraft": false,
          "reviewDecision": "APPROVED",
          "additions": 180,
          "deletions": 20,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "SUCCESS",
                    "contexts": {
                      "totalCount": 4,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" },
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        },
        {
          "__typename": "PullRequest",
          "title": "Filter ActivationScheduleUpdated by activationProvider",
          "number": 100,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/100",
          "updatedAt": "2026-08-21T09:45:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 0 },
          "isDraft": false,
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 60,
          "deletions": 12,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "PENDING",
                    "contexts": {
                      "totalCount": 2,
                      "nodes": [
                        { "__typename": "StatusContext", "state": "PENDING" },
                        { "__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": null }
                      ]
                    }
                  }
                }
              }
            ]
          }
        }
      ]
    },
    "assigned": {
      "nodes": [
        {
          "__typename": "Issue",
          "title": "Rate limit returns 500",
          "number": 12,
          "state": "OPEN",
          "url": "https://github.com/sympower/msa-resource-bff/issues/12",
          "updatedAt": "2026-08-20T07:12:00Z",
          "repository": { "nameWithOwner": "sympower/msa-resource-bff" },
          "author": { "login": "erkki-sympower" },
          "comments": { "totalCount": 3 }
        }
      ]
    },
    "involved": {
      "nodes": [
        {
          "__typename": "PullRequest",
          "title": "WIP: auto-scale the operating envelope axis",
          "number": 70,
          "state": "OPEN",
          "url": "https://github.com/sympower/flex-portal/pull/70",
          "updatedAt": "2026-08-21T18:00:00Z",
          "repository": { "nameWithOwner": "sympower/flex-portal" },
          "author": { "login": "SymJavi" },
          "comments": { "totalCount": 0 },
          "isDraft": true,
          "reviewDecision": null,
          "additions": 40,
          "deletions": 8,
          "commits": { "nodes": [{ "commit": { "statusCheckRollup": null } }] }
        },
        {
          "__typename": "Issue",
          "title": "Rate limit returns 500",
          "number": 12,
          "state": "OPEN",
          "url": "https://github.com/sympower/msa-resource-bff/issues/12",
          "updatedAt": "2026-08-20T07:12:00Z",
          "repository": { "nameWithOwner": "sympower/msa-resource-bff" },
          "author": { "login": "erkki-sympower" },
          "comments": { "totalCount": 3 }
        },
        {
          "__typename": "PullRequest",
          "title": "Bump shared tooling to node 22",
          "number": 200,
          "state": "OPEN",
          "url": "https://github.com/sympower/other-repo/pull/200",
          "updatedAt": "2026-08-23T10:00:00Z",
          "repository": { "nameWithOwner": "sympower/other-repo" },
          "author": { "login": "renovate[bot]" },
          "comments": { "totalCount": 0 },
          "isDraft": false,
          "reviewDecision": "REVIEW_REQUIRED",
          "additions": 3,
          "deletions": 3,
          "commits": {
            "nodes": [
              {
                "commit": {
                  "statusCheckRollup": {
                    "state": "SUCCESS",
                    "contexts": {
                      "totalCount": 1,
                      "nodes": [
                        { "__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS" }
                      ]
                    }
                  }
                }
              }
            ]
          }
        },
        {
          "__typename": "Issue",
          "title": "Legacy exporter drops trailing rows",
          "number": 300,
          "state": "OPEN",
          "url": "https://github.com/sympower/old-repo/issues/300",
          "updatedAt": "2026-02-01T09:00:00Z",
          "repository": { "nameWithOwner": "sympower/old-repo" },
          "author": { "login": "someone-else" },
          "comments": { "totalCount": 7 }
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Teach the stub `gh` the two knobs**

In `tests/fixtures/stub-gh/gh`, extend the header comment's env list and add the argv log right after the `STUB_GH_FAIL` block; change the `api graphql` case to honour the fixture override. Before:

```bash
# Env knobs:
#   STUB_GH_FAIL=1           every invocation exits 1 with a canned stderr line
#   STUB_GH_CLONE_FROM=path  `repo clone` clones from this local repo instead of GitHub
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${STUB_GH_FAIL:-}" == "1" ]]; then
  echo "gh: canned failure (STUB_GH_FAIL=1)" >&2
  exit 1
fi
```

After:

```bash
# Env knobs:
#   STUB_GH_FAIL=1                every invocation exits 1 with a canned stderr line
#   STUB_GH_CLONE_FROM=path       `repo clone` clones from this local repo instead of GitHub
#   GRAPHQL_INBOX_FIXTURE=path    `api graphql` prints this file instead of graphql-inbox.json
#   STUB_GH_ARGV_LOG=path         every invocation appends its argv (one line per argument)
#                                 and the GH_TOKEN it saw, so callers can assert what they sent
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${STUB_GH_FAIL:-}" == "1" ]]; then
  echo "gh: canned failure (STUB_GH_FAIL=1)" >&2
  exit 1
fi

if [[ -n "${STUB_GH_ARGV_LOG:-}" ]]; then
  {
    printf 'argv\t%s\n' "$@"
    printf 'env\tGH_TOKEN=%s\n' "${GH_TOKEN:-}"
  } >> "$STUB_GH_ARGV_LOG"
fi
```

and the `api graphql` case, before:

```bash
  "api graphql")
    cat "$here/graphql-inbox.json"
    ;;
```

after:

```bash
  "api graphql")
    # The static fixture keeps fixed dates for the parser tests; the e2e
    # points this at a payload it generates with live timestamps.
    cat "${GRAPHQL_INBOX_FIXTURE:-$here/graphql-inbox.json}"
    ;;
```

- [ ] **Step 3: Update the stub's own test for the new aliases and knobs**

In `src/main/providers/github/stubGh.test.ts` (verify at execution: B moved the file here byte-identical from `src/main/github/stubGh.test.ts`; if it still sits at the old path, edit it there), add the `fs`/`os` imports and replace the `api graphql` case. Before:

```ts
import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
```

After:

```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
```

Before:

```ts
  it('answers api graphql with the canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(payload.data.reviewRequested.nodes.length).toBeGreaterThan(0);
  });
```

After:

```ts
  it('answers api graphql with the five-alias canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(Object.keys(payload.data)).toEqual(['direct', 'team', 'authored', 'assigned', 'involved']);
    expect(payload.data.direct.nodes.length).toBeGreaterThan(0);
  });

  it('prints GRAPHQL_INBOX_FIXTURE instead of the canned payload when set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-gh-'));
    const fixture = path.join(dir, 'inbox.json');
    fs.writeFileSync(fixture, JSON.stringify({ data: { direct: { nodes: [] } } }));
    try {
      const payload = JSON.parse(
        runStub(['api', 'graphql'], { GRAPHQL_INBOX_FIXTURE: fixture })
      );
      expect(payload).toEqual({ data: { direct: { nodes: [] } } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs argv and the token it was handed when STUB_GH_ARGV_LOG is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-gh-'));
    const log = path.join(dir, 'argv.log');
    try {
      runStub(['auth', 'token', '--user', 'SymJavi'], {
        STUB_GH_ARGV_LOG: log,
        GH_TOKEN: 'gho_seen_by_stub',
      });
      const lines = fs.readFileSync(log, 'utf8').split('\n');
      expect(lines).toEqual(
        expect.arrayContaining([
          'argv\tauth',
          'argv\ttoken',
          'argv\t--user',
          'argv\tSymJavi',
          'env\tGH_TOKEN=gho_seen_by_stub',
        ])
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
```

Run: `npx vitest run src/main/providers/github/stubGh.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: Write the failing parser test**

Replace `src/main/providers/github/inboxQuery.test.ts` wholesale:

```ts
// src/main/providers/github/inboxQuery.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import { INBOX_QUERY, INBOX_SEARCH_ALIASES, parseInboxPayload, searchStrings } from './inboxQuery';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

/** One PullRequest node carrying every field the fragment asks for. */
function prNode(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    title: `PR ${number}`,
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt: '2026-08-20T00:00:00Z',
    repository: { nameWithOwner: 'o/r' },
    author: { login: 'someone' },
    comments: { totalCount: 0 },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 1,
    deletions: 1,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  };
}

/** A `commits` field whose rollup carries the given state and contexts. */
function rollup(state: string, contexts?: { totalCount: number; nodes: unknown[] }) {
  return {
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state, ...(contexts ? { contexts } : {}) } } }],
    },
  };
}

const checkRun = (status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  status,
  conclusion,
});
const statusContext = (state: string) => ({ __typename: 'StatusContext', state });

/** A payload with nodes under the named aliases and every other alias empty. */
function payloadWith(nodesByAlias: Partial<Record<string, unknown[]>>): unknown {
  const data: Record<string, { nodes: unknown[] }> = {};
  for (const alias of INBOX_SEARCH_ALIASES) data[alias] = { nodes: nodesByAlias[alias] ?? [] };
  return { data };
}

const only = (payload: unknown): InboxItem => {
  const items = parseInboxPayload(payload);
  expect(items).toHaveLength(1);
  return items[0];
};

describe('searchStrings', () => {
  it('builds the five qualifiers, org-scoped', () => {
    expect(searchStrings('SymJavi', 'sympower')).toEqual({
      direct: 'user-review-requested:SymJavi is:pr is:open archived:false org:sympower',
      team: 'review-requested:SymJavi is:pr is:open archived:false org:sympower',
      authored: 'author:SymJavi is:open archived:false org:sympower',
      assigned: 'assignee:SymJavi is:open archived:false org:sympower',
      involved: 'involves:SymJavi is:open archived:false org:sympower',
    });
  });

  it('omits the org qualifier when the workspace has none -- all repos for the account', () => {
    expect(searchStrings('SymJavi').involved).toBe('involves:SymJavi is:open archived:false');
  });
});

describe('INBOX_QUERY', () => {
  it('declares one variable and one aliased search per alias, first: 50 each', () => {
    for (const alias of INBOX_SEARCH_ALIASES) {
      expect(INBOX_QUERY).toContain(`$${alias}: String!`);
      expect(INBOX_QUERY).toContain(`${alias}: search(query: $${alias}, type: ISSUE, first: 50)`);
    }
  });

  it('asks for the fields check counts, authorship and comment counts derive from', () => {
    expect(INBOX_QUERY).toContain('contexts(first: 100)');
    expect(INBOX_QUERY).toContain('... on CheckRun { status conclusion }');
    expect(INBOX_QUERY).toContain('... on StatusContext { state }');
    expect(INBOX_QUERY).toContain('comments { totalCount }');
    expect(INBOX_QUERY).toContain('author { login }');
    expect(INBOX_QUERY).toContain('isDraft');
  });
});

describe('parseInboxPayload over the canned fixture', () => {
  const items = parseInboxPayload(canned);
  const byNumber = (number: number) => items.find((item) => item.workItem.number === number);

  it('yields nine distinct items from eleven nodes', () => {
    expect(items).toHaveLength(9);
  });

  it('keeps a directly requested review out of the team role', () => {
    expect(byNumber(51)?.roles).toEqual(['review-requested-direct']);
  });

  it('marks a team-only request as such', () => {
    expect(byNumber(60)?.roles).toEqual(['review-requested-team']);
  });

  it('merges every role an item was returned under', () => {
    expect(byNumber(70)?.roles).toEqual(['author', 'involved']);
    expect(byNumber(12)?.roles).toEqual(['assignee', 'involved']);
  });

  it('keeps items only the involves search returned', () => {
    expect(byNumber(200)?.roles).toEqual(['involved']);
    expect(byNumber(300)?.roles).toEqual(['involved']);
  });

  it('reads author, draft flag, comment count and diff size', () => {
    expect(byNumber(70)?.author).toBe('SymJavi');
    expect(byNumber(70)?.isDraft).toBe(true);
    expect(byNumber(51)?.isDraft).toBe(false);
    expect(byNumber(12)?.commentCount).toBe(3);
    expect(byNumber(51)?.additions).toBe(210);
    expect(byNumber(51)?.deletions).toBe(88);
  });

  it('normalises the review decision', () => {
    expect(byNumber(90)?.reviewDecision).toBe('approved');
    expect(byNumber(80)?.reviewDecision).toBe('changes-requested');
    expect(byNumber(51)?.reviewDecision).toBe('review-required');
    expect(byNumber(70)?.reviewDecision).toBe('none');
    expect(byNumber(12)?.reviewDecision).toBe('none');
  });

  it('derives check counts and the CI verdict from the rollup', () => {
    expect(byNumber(51)?.checks).toEqual({ passed: 2, failed: 1, pending: 0, total: 3 });
    expect(byNumber(51)?.ciStatus).toBe('failing');
    expect(byNumber(90)?.checks).toEqual({ passed: 4, failed: 0, pending: 0, total: 4 });
    expect(byNumber(90)?.ciStatus).toBe('passing');
    expect(byNumber(100)?.checks).toEqual({ passed: 0, failed: 0, pending: 2, total: 2 });
    expect(byNumber(100)?.ciStatus).toBe('pending');
  });

  it('leaves checks and ciStatus undefined when there is no rollup', () => {
    expect(byNumber(70)?.checks).toBeUndefined();
    expect(byNumber(70)?.ciStatus).toBeUndefined();
    expect(byNumber(12)?.checks).toBeUndefined();
    expect(byNumber(12)?.ciStatus).toBeUndefined();
  });

  it('maps Issue nodes to issue work items and PullRequest nodes to pr', () => {
    expect(byNumber(12)?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/msa-resource-bff',
      type: 'issue',
      number: 12,
    });
    expect(byNumber(51)?.workItem.type).toBe('pr');
    expect(byNumber(51)?.state).toBe('open');
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

describe('parseInboxPayload derivation rules', () => {
  it('classifies completed CheckRuns by conclusion', () => {
    const node = prNode(
      1,
      rollup('FAILURE', {
        totalCount: 8,
        nodes: [
          checkRun('COMPLETED', 'SUCCESS'),
          checkRun('COMPLETED', 'NEUTRAL'),
          checkRun('COMPLETED', 'SKIPPED'),
          checkRun('COMPLETED', 'FAILURE'),
          checkRun('COMPLETED', 'CANCELLED'),
          checkRun('COMPLETED', 'TIMED_OUT'),
          checkRun('COMPLETED', 'ACTION_REQUIRED'),
          checkRun('COMPLETED', 'STARTUP_FAILURE'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 3,
      failed: 5,
      pending: 0,
      total: 8,
    });
  });

  it('treats an unfinished or stale CheckRun as pending', () => {
    const node = prNode(
      1,
      rollup('PENDING', {
        totalCount: 3,
        nodes: [
          checkRun('IN_PROGRESS', null),
          checkRun('QUEUED', null),
          checkRun('COMPLETED', 'STALE'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 0,
      failed: 0,
      pending: 3,
      total: 3,
    });
  });

  it('classifies StatusContexts by state', () => {
    const node = prNode(
      1,
      rollup('FAILURE', {
        totalCount: 5,
        nodes: [
          statusContext('SUCCESS'),
          statusContext('ERROR'),
          statusContext('FAILURE'),
          statusContext('PENDING'),
          statusContext('EXPECTED'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 1,
      failed: 2,
      pending: 2,
      total: 5,
    });
  });

  it('counts an unrecognised context type in the total only', () => {
    const node = prNode(
      1,
      rollup('SUCCESS', {
        totalCount: 2,
        nodes: [{ __typename: 'Mystery' }, checkRun('COMPLETED', 'SUCCESS')],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 1,
      failed: 0,
      pending: 0,
      total: 2,
    });
  });

  it('maps the rollup state to ciStatus', () => {
    const verdict = (state: string) =>
      only(payloadWith({ authored: [prNode(1, rollup(state))] })).ciStatus;
    expect(verdict('SUCCESS')).toBe('passing');
    expect(verdict('FAILURE')).toBe('failing');
    expect(verdict('ERROR')).toBe('failing');
    expect(verdict('PENDING')).toBe('pending');
    expect(verdict('EXPECTED')).toBe('pending');
    expect(verdict('SOMETHING_NEW')).toBeUndefined();
  });

  it('reports no checks when the rollup carries no contexts -- never a zeroed object', () => {
    const item = only(payloadWith({ authored: [prNode(1, rollup('SUCCESS'))] }));
    expect(item.ciStatus).toBe('passing');
    expect(item.checks).toBeUndefined();
  });

  it('reads a null or unfamiliar reviewDecision as none', () => {
    expect(only(payloadWith({ authored: [prNode(1, { reviewDecision: null })] })).reviewDecision).toBe(
      'none'
    );
    expect(
      only(payloadWith({ authored: [prNode(1, { reviewDecision: 'SOMETHING_NEW' })] })).reviewDecision
    ).toBe('none');
  });

  it('defaults a missing author and comment count', () => {
    const item = only(payloadWith({ authored: [prNode(1, { author: null, comments: undefined })] }));
    expect(item.author).toBe('');
    expect(item.commentCount).toBe(0);
  });

  it('gives each role to an item several searches returned', () => {
    const item = only(payloadWith({ authored: [prNode(1)], assigned: [prNode(1)] }));
    expect(item.roles).toEqual(['author', 'assignee']);
  });

  it('suppresses the team role when the item was requested directly, whatever the payload order', () => {
    const payload = { data: { team: { nodes: [prNode(1)] }, direct: { nodes: [prNode(1)] } } };
    expect(only(payload).roles).toEqual(['review-requested-direct']);
  });

  it('never records a role twice', () => {
    expect(only(payloadWith({ authored: [prNode(1), prNode(1)] })).roles).toEqual(['author']);
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
    expect(() => parseInboxPayload('not an object')).toThrow();
    expect(() => parseInboxPayload(42)).toThrow();
    expect(() => parseInboxPayload(true)).toThrow();
    expect(() => parseInboxPayload([])).toThrow();
  });

  it('throws when payload.data is null', () => {
    expect(() => parseInboxPayload({ data: null })).toThrow('GitHub API returned no data');
  });

  it('throws when errors exist without data, carrying the message', () => {
    expect(() => parseInboxPayload({ errors: [{ message: 'API rate limit exceeded' }] })).toThrow(
      'API rate limit exceeded'
    );
  });

  it('tolerates errors alongside usable data', () => {
    expect(parseInboxPayload({ ...(payloadWith({}) as object), errors: [{ message: 'warning' }] })).toEqual(
      []
    );
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/github/inboxQuery.test.ts`
Expected: FAIL — `INBOX_SEARCH_ALIASES` is not exported, `searchStrings` still answers B's three keys, and the canned-fixture block finds zero items under B's alias names.

- [ ] **Step 6: Rewrite `src/main/providers/github/inboxQuery.ts`**

Replace the whole file:

```ts
// src/main/providers/github/inboxQuery.ts
import type { InboxItem, InboxRole } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Five aliased searches in a single request: GitHub's search syntax cannot
 * OR those qualifiers into one string, and one request keeps the spec's
 * "one request per workspace" budget. `type: ISSUE` searches return both
 * issues and PRs; `__typename` tells them apart. The rollup's contexts ride
 * along so check counts can be derived without a second call per PR.
 */
export const INBOX_QUERY = `
query($direct: String!, $team: String!, $authored: String!, $assigned: String!, $involved: String!) {
  direct: search(query: $direct, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  team: search(query: $team, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  authored: search(query: $authored, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  assigned: search(query: $assigned, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  involved: search(query: $involved, type: ISSUE, first: 50) { nodes { ...inboxFields } }
}
fragment inboxFields on SearchResultItem {
  __typename
  ... on Issue {
    title number state url updatedAt
    repository { nameWithOwner }
    author { login }
    comments { totalCount }
  }
  ... on PullRequest {
    title number state url updatedAt
    repository { nameWithOwner }
    author { login }
    comments { totalCount }
    isDraft reviewDecision additions deletions
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            state
            contexts(first: 100) {
              totalCount
              nodes {
                __typename
                ... on CheckRun { status conclusion }
                ... on StatusContext { state }
              }
            }
          }
        }
      }
    }
  }
}`;

export type InboxSearchAlias = 'direct' | 'team' | 'authored' | 'assigned' | 'involved';
export type InboxSearchStrings = Record<InboxSearchAlias, string>;

/**
 * Merge order, fixed. `direct` before `team` is what lets a team request be
 * dropped when the same PR was requested of you directly -- whatever order
 * the aliases come back in, and whatever order the driver sent them.
 */
export const INBOX_SEARCH_ALIASES: ReadonlyArray<InboxSearchAlias> = [
  'direct',
  'team',
  'authored',
  'assigned',
  'involved',
];

const ALIAS_ROLE: Record<InboxSearchAlias, InboxRole> = {
  direct: 'review-requested-direct',
  team: 'review-requested-team',
  authored: 'author',
  assigned: 'assignee',
  involved: 'involved',
};

/** The search strings for one workspace's account, org-scoped when org is set. */
export function searchStrings(accountLogin: string, org?: string): InboxSearchStrings {
  const scope = org ? ` org:${org}` : '';
  const common = `is:open archived:false${scope}`;
  return {
    direct: `user-review-requested:${accountLogin} is:pr ${common}`,
    team: `review-requested:${accountLogin} is:pr ${common}`,
    authored: `author:${accountLogin} ${common}`,
    assigned: `assignee:${accountLogin} ${common}`,
    involved: `involves:${accountLogin} ${common}`,
  };
}

interface ContextNode {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

interface Rollup {
  state?: string | null;
  contexts?: { totalCount?: number; nodes?: ContextNode[] } | null;
}

interface SearchNode {
  __typename?: string;
  title?: string;
  number?: number;
  state?: string;
  url?: string;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  author?: { login?: string } | null;
  comments?: { totalCount?: number } | null;
  isDraft?: boolean;
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: Rollup | null } }> };
}

const CI_STATES: Record<string, NonNullable<InboxItem['ciStatus']>> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

const REVIEW_DECISIONS: Record<string, InboxItem['reviewDecision']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

type CheckVerdict = 'passed' | 'failed' | 'pending';

/**
 * One context's verdict, or null for a type this parser does not know --
 * which still counts toward `total` (through totalCount) but decides
 * nothing, so an unfamiliar check can never read as a failure.
 */
function classifyContext(node: ContextNode): CheckVerdict | null {
  if (node.__typename === 'CheckRun') {
    if (node.status !== 'COMPLETED') return 'pending';
    if (node.conclusion && PASSED_CONCLUSIONS.has(node.conclusion)) return 'passed';
    if (node.conclusion && FAILED_CONCLUSIONS.has(node.conclusion)) return 'failed';
    // STALE, null, anything newer: GitHub has not settled it either.
    return 'pending';
  }
  if (node.__typename === 'StatusContext') {
    if (node.state === 'SUCCESS') return 'passed';
    if (node.state === 'ERROR' || node.state === 'FAILURE') return 'failed';
    return 'pending';
  }
  return null;
}

/** Check counts, or undefined when there is nothing to count -- never a zeroed object. */
function checksOf(rollup: Rollup | null | undefined): InboxItem['checks'] {
  const contexts = rollup?.contexts;
  if (!contexts) return undefined;
  const checks = {
    passed: 0,
    failed: 0,
    pending: 0,
    total: contexts.totalCount ?? contexts.nodes?.length ?? 0,
  };
  for (const node of contexts.nodes ?? []) {
    const verdict = classifyContext(node);
    if (verdict) checks[verdict] += 1;
  }
  return checks;
}

type ItemFacts = Omit<InboxItem, 'roles'>;

/** Everything about one node except why it was returned -- roles are merged by the caller. */
function toItem(node: SearchNode): ItemFacts | null {
  const repo = node.repository?.nameWithOwner;
  if (!repo || typeof node.number !== 'number' || !node.title || !node.url) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const rollupState = rollup?.state;
  return {
    workItem: {
      provider: 'github',
      repo,
      type: node.__typename === 'PullRequest' ? 'pr' : 'issue',
      number: node.number,
    },
    title: node.title,
    author: node.author?.login ?? '',
    isDraft: node.isDraft === true,
    state: (node.state ?? 'OPEN').toLowerCase(),
    reviewDecision: (node.reviewDecision && REVIEW_DECISIONS[node.reviewDecision]) || 'none',
    ciStatus: rollupState ? CI_STATES[rollupState] : undefined,
    checks: checksOf(rollup),
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
 * An item that several searches returned becomes one item carrying every
 * role, with one exception: a team review request is dropped when the same
 * PR was requested of you directly, because GitHub's own inbox files it
 * under "Needs your review" and nowhere else. Malformed nodes are skipped,
 * never thrown on -- a half-broken payload still yields the readable
 * remainder.
 *
 * Throws when the top-level payload is malformed (not an object, data is
 * null, or errors exist without usable data), so the caller can label the
 * failure in the UI rather than silently treating it as empty.
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
      const firstError = (payloadObj.errors[0] as { message?: string })?.message;
      throw new Error(firstError || 'Unknown GitHub API error');
    }
  }

  const data =
    (payloadObj as { data?: Partial<Record<InboxSearchAlias, { nodes?: SearchNode[] }>> }).data ??
    {};
  const byKey = new Map<string, InboxItem>();
  for (const alias of INBOX_SEARCH_ALIASES) {
    const role = ALIAS_ROLE[alias];
    for (const node of data[alias]?.nodes ?? []) {
      const facts = toItem(node);
      if (!facts) continue;
      const key = workItemKey(facts.workItem);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...facts, roles: [role] });
        continue;
      }
      if (role === 'review-requested-team' && existing.roles.includes('review-requested-direct')) {
        continue;
      }
      if (!existing.roles.includes(role)) existing.roles.push(role);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
```

- [ ] **Step 7: Run the parser test, then every test that reads the fixture**

Run: `npx vitest run src/main/providers/github/inboxQuery.test.ts`
Expected: PASS (29 tests).

Run: `npx vitest run src/main/providers`
Expected: PASS. Verify at execution: B's `GitHubDriver.test.ts` has a `fetchInbox` case against the real stub; if it pins the item count (B's fixture had 4), change that one number to 9 here — Task 3 rewrites that case in full anyway. `InboxService.test.ts` runs against a stub driver and is unaffected.

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/stub-gh/graphql-inbox.json tests/fixtures/stub-gh/gh src/main/providers/github/stubGh.test.ts src/main/providers/github/inboxQuery.ts src/main/providers/github/inboxQuery.test.ts
git commit -m "feat(inbox): five aliased searches, merged roles, derived check counts

One request still, but it now asks GitHub the five questions its own
inbox is built from -- direct and team review requests, authored,
assigned, involved -- and the parser keeps every role an item came
back under instead of picking one. Check counts come from the rollup's
contexts so the row can read 3/5 without a second call per PR. The
stub fixture grows to nine items across all five aliases, and the stub
learns two knobs the driver test and the e2e need.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Driver argv — `fetchInbox` sends all five searches

**Files:**
- Modify: `src/main/providers/github/GitHubDriver.ts` (the `fetchInbox` argument list)
- Modify: `src/main/providers/github/GitHubDriver.test.ts` (replace B's `fetchInbox` case)

**Interfaces:**
- Consumes: `INBOX_QUERY`, `INBOX_SEARCH_ALIASES`, `searchStrings`, `parseInboxPayload` (Task 2); `GitHubDriver` constructor `(getEnv?: () => NodeJS.ProcessEnv, tokenTtlMs?: number)` and its `CONSOLA_GH_PATH` live `process.env` lookup (B); `ProviderBinding` from `src/shared/providers.ts` (B); the stub's `STUB_GH_ARGV_LOG` and `GRAPHQL_INBOX_FIXTURE` knobs (Task 2).
- Produces: `GitHubDriver.fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]>` — signature unchanged; argv becomes `api graphql -f query=… -f direct=… -f team=… -f authored=… -f assigned=… -f involved=…`.

- [ ] **Step 1: Write the failing test**

In `src/main/providers/github/GitHubDriver.test.ts`, delete B's `fetchInbox` case (verify at execution: it is the `it(...)` that calls `driver.fetchInbox` against the stub and asserts on the canned payload) and append this block. Add `import * as fs from 'fs';` and `import * as os from 'os';` at the top if B's file lacks them; `path`, `describe`/`it`/`expect`/`beforeEach`/`afterEach` and `GitHubDriver` are already imported there.

```ts
import { INBOX_SEARCH_ALIASES, searchStrings } from './inboxQuery';

describe('GitHubDriver.fetchInbox', () => {
  const stubGh = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');
  const binding = { accountLogin: 'SymJavi', org: 'sympower' };
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-fetch-inbox-'));
    // The driver resolves CONSOLA_GH_PATH from process.env on every call, the
    // same seam WorktreeService's tests and the Playwright rig use.
    process.env.CONSOLA_GH_PATH = stubGh;
  });

  afterEach(() => {
    delete process.env.CONSOLA_GH_PATH;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('sends one gh api graphql call carrying the query and all five searches, with the token env', async () => {
    const log = path.join(scratch, 'argv.log');
    const driver = new GitHubDriver(() => ({ ...process.env }));

    const items = await driver.fetchInbox(binding, {
      ...process.env,
      GH_TOKEN: 'gho_test_token',
      STUB_GH_ARGV_LOG: log,
    });

    expect(items).toHaveLength(9);
    const lines = fs.readFileSync(log, 'utf8').split('\n');
    const argv = lines
      .filter((line) => line.startsWith('argv\t'))
      .map((line) => line.slice('argv\t'.length));
    expect(argv.slice(0, 2)).toEqual(['api', 'graphql']);
    // One -f for the query, one per alias -- and nothing under B's old names.
    expect(argv.filter((arg) => arg === '-f')).toHaveLength(6);
    const searches = searchStrings('SymJavi', 'sympower');
    for (const alias of INBOX_SEARCH_ALIASES) {
      expect(argv).toContain(`${alias}=${searches[alias]}`);
    }
    expect(argv.some((arg) => arg.startsWith('query=') && arg.includes('$involved: String!'))).toBe(
      true
    );
    expect(argv.some((arg) => arg.startsWith('reviewRequested='))).toBe(false);
    expect(lines).toContain('env\tGH_TOKEN=gho_test_token');
  });

  it('propagates a parser rejection instead of answering with an empty inbox', async () => {
    const broken = path.join(scratch, 'broken.json');
    fs.writeFileSync(broken, JSON.stringify({ data: null }));
    const driver = new GitHubDriver(() => ({ ...process.env }));

    await expect(
      driver.fetchInbox(binding, { ...process.env, GRAPHQL_INBOX_FIXTURE: broken })
    ).rejects.toThrow('GitHub API returned no data');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/github/GitHubDriver.test.ts`
Expected: FAIL — the argv log holds `assigned=`, `authored=`, `reviewRequested=` (three `-f` flags besides the query), so the per-alias `toContain` for `direct`/`team`/`involved` and the count of `-f` fail. (The parser-rejection case passes already: B's driver calls `parseInboxPayload`, which Task 2 left throwing.)

- [ ] **Step 3: Send the five searches**

In `src/main/providers/github/GitHubDriver.ts`, the `fetchInbox` method reads as below after the change. Verify at execution: keep B's name for the binary-resolving helper (shown here as `requireBinary()`), B's `execFileAsync` import, and B's error handling exactly as they are — the only change is that the hand-written argument array becomes a loop over `INBOX_SEARCH_ALIASES`, and `INBOX_SEARCH_ALIASES` joins the existing `./inboxQuery` import.

```ts
import { INBOX_QUERY, INBOX_SEARCH_ALIASES, parseInboxPayload, searchStrings } from './inboxQuery';
```

```ts
  /**
   * One request per workspace: five aliased searches ride in a single
   * `gh api graphql` call. The parser throws on an unrecognised reply and
   * that rejection is the caller's to degrade -- an empty inbox would read
   * as "nothing to do".
   */
  public async fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]> {
    const binary = await this.requireBinary();
    const searches = searchStrings(binding.accountLogin, binding.org);
    const args = ['api', 'graphql', '-f', `query=${INBOX_QUERY}`];
    for (const alias of INBOX_SEARCH_ALIASES) {
      args.push('-f', `${alias}=${searches[alias]}`);
    }
    const { stdout } = await execFileAsync(binary, args, {
      env: env as { [key: string]: string },
      // Five searches of fifty items, each PR carrying up to a hundred
      // check contexts: comfortably under this, never under the 1 MB default.
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseInboxPayload(JSON.parse(stdout));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/providers/github/GitHubDriver.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/github/GitHubDriver.ts src/main/providers/github/GitHubDriver.test.ts
git commit -m "feat(inbox): GitHubDriver sends the five aliased searches

The flag list is derived from INBOX_SEARCH_ALIASES so the query, the
parser and the argv cannot drift apart. The test reads what the stub
gh actually received, token env included, instead of trusting a mock.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Status rollup — `worstStatus` shared by items and workspaces

**Files:**
- Modify: `src/renderer/utils/sessionStatus.ts`
- Modify: `src/renderer/utils/sessionStatus.test.ts`

**Interfaces:**
- Consumes: `SessionStatus`, `sessionStatusFor`, the private `RANK` table (existing).
- Produces: `worstStatus(statuses: SessionStatus[]): SessionStatus` — `'ready'` for an empty list, otherwise the highest-ranked status. `workspaceStatusFor` is refactored onto it with unchanged behaviour.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/utils/sessionStatus.test.ts`, and add `worstStatus` to the import from `./sessionStatus`:

```ts
import {
  anyOtherWorkspaceNeedsAttention,
  sessionStatusFor,
  workspaceStatusFor,
  worstStatus,
} from './sessionStatus';
```

```ts
describe('worstStatus', () => {
  it('is ready for nothing at all -- an item with no sessions shows no dot', () => {
    expect(worstStatus([])).toBe('ready');
  });

  it('passes a lone status through', () => {
    expect(worstStatus(['working'])).toBe('working');
    expect(worstStatus(['done'])).toBe('done');
  });

  it('picks the most urgent status, in the same order the workspace rollup uses', () => {
    expect(worstStatus(['ready', 'working'])).toBe('working');
    expect(worstStatus(['working', 'done'])).toBe('done');
    expect(worstStatus(['done', 'needs-attention', 'working'])).toBe('needs-attention');
    expect(worstStatus(['needs-attention', 'exited', 'ready'])).toBe('exited');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/utils/sessionStatus.test.ts`
Expected: FAIL — `worstStatus` is not exported.

- [ ] **Step 3: Extract the rollup**

In `src/renderer/utils/sessionStatus.ts`, replace `workspaceStatusFor` with `worstStatus` plus a thin `workspaceStatusFor`. Before:

```ts
/** The most urgent status among a workspace's sessions. */
export function workspaceStatusFor(
  workspace: Workspace,
  terminals: Record<string, TerminalState>
): SessionStatus {
  let worst: SessionStatus = 'ready';

  for (const session of workspace.sessions) {
    const status = sessionStatusFor(terminals[session.instanceId]);
    if (RANK[status] > RANK[worst]) {
      worst = status;
    }
  }

  return worst;
}
```

After:

```ts
/**
 * The most urgent status in a set. Extracted so the Inbox row's "N sessions"
 * dot and the workspace switcher's dot share one rule -- two rollups that
 * disagreed about whether done outranks working would be a bug nobody
 * could name.
 */
export function worstStatus(statuses: SessionStatus[]): SessionStatus {
  let worst: SessionStatus = 'ready';
  for (const status of statuses) {
    if (RANK[status] > RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

/** The most urgent status among a workspace's sessions. */
export function workspaceStatusFor(
  workspace: Workspace,
  terminals: Record<string, TerminalState>
): SessionStatus {
  return worstStatus(
    workspace.sessions.map((session) => sessionStatusFor(terminals[session.instanceId]))
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/utils/sessionStatus.test.ts`
Expected: PASS — the new block and every existing `workspaceStatusFor` case.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/utils/sessionStatus.ts src/renderer/utils/sessionStatus.test.ts
git commit -m "refactor(status): extract worstStatus from the workspace rollup

The Inbox row is about to roll up the sessions linked to one item; one
ranking rule, shared, rather than a second copy of the loop.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Presentation helpers — what a row and the header read

**Files:**
- Modify: `src/renderer/components/Inbox/inboxPresentation.ts` (rewrite)
- Modify: `src/renderer/components/Inbox/inboxPresentation.test.ts` (rewrite)
- Modify: `src/renderer/components/WorkItemStrip/index.tsx` (drop `dotClassFor` and the `../Inbox/styles.css` cross-import)
- Modify: `src/renderer/components/WorkItemStrip/styles.css` (drop the `.inbox-dot` rule)

**Interfaces:**
- Consumes: `InboxItem`, `workItemKey` from `src/shared/workItems.ts`; `Session` from `src/shared/workspace.ts`; `TerminalState` from `src/renderer/stores/terminalStore.ts`; `sessionStatusFor`, `worstStatus`, `SessionStatus` (Task 4).
- Produces (all from `inboxPresentation.ts`):
  - `formatAge(fetchedAt: number, now?: number): string` — unchanged header staleness label
  - `relativeTime(iso: string, now?: number): string` — compact row age: `now`, `5m`, `2h`, `3d`, `2w`, `4mo`, `1y`; `''` for an unparseable stamp
  - `reviewStateLabel(item: InboxItem): string | null` — `Approved` / `Changes requested` / `Awaiting approval` / `null` for `none`
  - `interface ChecksLabel { text: string; tone: 'ok' | 'warn' | 'bad' }`
  - `checksLabel(checks: InboxItem['checks']): ChecksLabel | null` — text is `passed/total`; `bad` when anything failed, `warn` when anything is pending, else `ok`; `null` when absent or `total` is 0
  - `hasAccentBar(item: InboxItem): boolean` — the direct-review-request bar
  - `isRepoCloned(resolved: Record<string, string | null> | undefined, repo: string): boolean` — unknown map or unknown repo reads as cloned (optimistic, the launch path corrects it); `null` reads as not cloned
  - `roleLabelFor(item: InboxItem): string` and `metaLineFor(item: InboxItem): string` — kept for `WorkItemStrip`, now reading `roles`
  - `groupSessionsByWorkItem(sessions: Session[]): Map<string, Session[]>` — keyed by `workItemKey`; unlinked sessions are skipped
  - `worstStatusForItem(linked: Session[], terminals: Record<string, TerminalState>): SessionStatus`
- Deleted: `dotClassFor` (its `.inbox-dot--*` classes are retired). `actionFor` was already deleted by C.

- [ ] **Step 1: Write the failing test**

Replace `src/renderer/components/Inbox/inboxPresentation.test.ts` wholesale:

```ts
// src/renderer/components/Inbox/inboxPresentation.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import { createSessionRecord, type Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import {
  checksLabel,
  formatAge,
  groupSessionsByWorkItem,
  hasAccentBar,
  isRepoCloned,
  metaLineFor,
  relativeTime,
  reviewStateLabel,
  roleLabelFor,
  worstStatusForItem,
} from './inboxPresentation';

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    author: 'steve-sympower',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    checks: { passed: 2, failed: 1, pending: 0, total: 3 },
    commentCount: 1,
    additions: 210,
    deletions: 88,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    ...overrides,
  };
}

function makeSession(instanceId: string, workItem?: Session['workItem']): Session {
  return createSessionRecord({
    name: instanceId,
    workspaceId: 'ws-1',
    instanceId,
    harnessId: 'default',
    scopeId: 'scope-1',
    workItem,
  });
}

const IDLE: TerminalState = {
  isBusy: false,
  isAwaitingConfirmation: false,
  hasExited: false,
  completedWhileAway: false,
  status: 'ready',
};

const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;
const issue12 = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 12 } as const;

describe('formatAge', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');

  it('labels fresh, minutes, hours, days, and never', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now');
    expect(formatAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatAge(0, now)).toBe('never');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('is compact at every boundary', () => {
    expect(relativeTime(ago(30_000), now)).toBe('now');
    expect(relativeTime(ago(MINUTE), now)).toBe('1m');
    expect(relativeTime(ago(59 * MINUTE), now)).toBe('59m');
    expect(relativeTime(ago(HOUR), now)).toBe('1h');
    expect(relativeTime(ago(23 * HOUR), now)).toBe('23h');
    expect(relativeTime(ago(DAY), now)).toBe('1d');
    expect(relativeTime(ago(6 * DAY), now)).toBe('6d');
    expect(relativeTime(ago(7 * DAY), now)).toBe('1w');
    expect(relativeTime(ago(29 * DAY), now)).toBe('4w');
    expect(relativeTime(ago(30 * DAY), now)).toBe('1mo');
    expect(relativeTime(ago(364 * DAY), now)).toBe('12mo');
    expect(relativeTime(ago(365 * DAY), now)).toBe('1y');
  });

  it('treats a stamp from the future as now, and an unparseable one as blank', () => {
    expect(relativeTime(ago(-HOUR), now)).toBe('now');
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('reviewStateLabel', () => {
  it('names the three decisions and stays quiet for none', () => {
    expect(reviewStateLabel(makeItem({ reviewDecision: 'approved' }))).toBe('Approved');
    expect(reviewStateLabel(makeItem({ reviewDecision: 'changes-requested' }))).toBe(
      'Changes requested'
    );
    expect(reviewStateLabel(makeItem({ reviewDecision: 'review-required' }))).toBe(
      'Awaiting approval'
    );
    expect(reviewStateLabel(makeItem({ reviewDecision: 'none' }))).toBeNull();
  });
});

describe('checksLabel', () => {
  it('is null with no checks, or none to count', () => {
    expect(checksLabel(undefined)).toBeNull();
    expect(checksLabel({ passed: 0, failed: 0, pending: 0, total: 0 })).toBeNull();
  });

  it('reads passed over total, toned by the worst thing in the set', () => {
    expect(checksLabel({ passed: 4, failed: 0, pending: 0, total: 4 })).toEqual({
      text: '4/4',
      tone: 'ok',
    });
    expect(checksLabel({ passed: 3, failed: 0, pending: 2, total: 5 })).toEqual({
      text: '3/5',
      tone: 'warn',
    });
    expect(checksLabel({ passed: 2, failed: 1, pending: 0, total: 3 })).toEqual({
      text: '2/3',
      tone: 'bad',
    });
    expect(checksLabel({ passed: 1, failed: 1, pending: 1, total: 3 })).toEqual({
      text: '1/3',
      tone: 'bad',
    });
  });
});

describe('hasAccentBar', () => {
  it('marks direct review requests only, as GitHub does', () => {
    expect(hasAccentBar(makeItem())).toBe(true);
    expect(hasAccentBar(makeItem({ roles: ['review-requested-team'] }))).toBe(false);
    expect(hasAccentBar(makeItem({ roles: ['author', 'review-requested-direct'] }))).toBe(true);
  });
});

describe('isRepoCloned', () => {
  it('assumes cloned until main has answered, and for repos main was not asked about', () => {
    expect(isRepoCloned(undefined, 'sympower/controller-app')).toBe(true);
    expect(isRepoCloned({}, 'sympower/controller-app')).toBe(true);
  });

  it('reads a null answer as not cloned and a path as cloned', () => {
    expect(isRepoCloned({ 'sympower/controller-app': null }, 'sympower/controller-app')).toBe(false);
    expect(
      isRepoCloned({ 'sympower/controller-app': '/repos/controller-app' }, 'sympower/controller-app')
    ).toBe(true);
  });
});

describe('roleLabelFor and metaLineFor', () => {
  it('names the strongest role', () => {
    expect(roleLabelFor(makeItem())).toBe('review requested');
    expect(roleLabelFor(makeItem({ roles: ['review-requested-team'] }))).toBe('team review requested');
    expect(roleLabelFor(makeItem({ roles: ['author'] }))).toBe('your PR');
    expect(
      roleLabelFor(makeItem({ roles: ['author'], workItem: { ...issue12 } }))
    ).toBe('your issue');
    expect(roleLabelFor(makeItem({ roles: ['assignee'] }))).toBe('assigned to you');
    expect(roleLabelFor(makeItem({ roles: ['involved'] }))).toBe('involves you');
  });

  it('joins repo, role, CI, review state, and diff stats', () => {
    expect(metaLineFor(makeItem())).toBe(
      'controller-app · review requested · CI failing · awaiting approval · +210 −88'
    );
  });

  it('omits what an issue does not have', () => {
    expect(
      metaLineFor(
        makeItem({
          workItem: { ...issue12 },
          roles: ['assignee'],
          reviewDecision: 'none',
          ciStatus: undefined,
          checks: undefined,
          additions: undefined,
          deletions: undefined,
        })
      )
    ).toBe('msa-resource-bff · assigned to you');
  });
});

describe('groupSessionsByWorkItem', () => {
  it('buckets linked sessions by item and skips unlinked ones', () => {
    const a = makeSession('a', { ...pr51 });
    const b = makeSession('b', { ...pr51, repo: 'Sympower/Controller-App' });
    const c = makeSession('c', { ...issue12 });
    const plain = makeSession('plain');

    const grouped = groupSessionsByWorkItem([a, plain, b, c]);

    expect([...grouped.keys()]).toEqual([
      'github:sympower/controller-app:pr:51',
      'github:sympower/msa-resource-bff:issue:12',
    ]);
    expect(grouped.get('github:sympower/controller-app:pr:51')).toEqual([a, b]);
    expect(grouped.get('github:sympower/msa-resource-bff:issue:12')).toEqual([c]);
  });
});

describe('worstStatusForItem', () => {
  it('rolls the linked sessions up with the shared ranking', () => {
    const a = makeSession('a', { ...pr51 });
    const b = makeSession('b', { ...pr51 });
    const terminals = {
      a: { ...IDLE, isBusy: true },
      b: { ...IDLE, isAwaitingConfirmation: true },
    };
    expect(worstStatusForItem([a, b], terminals)).toBe('needs-attention');
    expect(worstStatusForItem([a], terminals)).toBe('working');
    expect(worstStatusForItem([], terminals)).toBe('ready');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: FAIL — `relativeTime`, `reviewStateLabel`, `checksLabel`, `hasAccentBar`, `isRepoCloned`, `groupSessionsByWorkItem`, `worstStatusForItem` are not exported.

- [ ] **Step 3: Rewrite `src/renderer/components/Inbox/inboxPresentation.ts`**

```ts
// src/renderer/components/Inbox/inboxPresentation.ts
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { sessionStatusFor, worstStatus, type SessionStatus } from '../../utils/sessionStatus';

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
 * Compact age for a row -- "5h", "2w" -- because the row is lean on purpose
 * and "Updated 5 hours ago" is the pane's job. Weeks and months are the
 * calendar-free kind (7 and 30 days); a row does not need better.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** GitHub's wording for the review decision; nothing for a PR nobody has to decide on. */
export function reviewStateLabel(item: InboxItem): string | null {
  switch (item.reviewDecision) {
    case 'approved':
      return 'Approved';
    case 'changes-requested':
      return 'Changes requested';
    case 'review-required':
      return 'Awaiting approval';
    default:
      return null;
  }
}

export interface ChecksLabel {
  text: string;
  tone: 'ok' | 'warn' | 'bad';
}

/**
 * "3/5" toned by the worst thing in the set: one failure is red however
 * many passed, one pending check is amber, all green is green.
 */
export function checksLabel(checks: InboxItem['checks']): ChecksLabel | null {
  if (!checks || checks.total === 0) return null;
  const tone: ChecksLabel['tone'] = checks.failed > 0 ? 'bad' : checks.pending > 0 ? 'warn' : 'ok';
  return { text: `${checks.passed}/${checks.total}`, tone };
}

/** The left accent bar marks reviews asked of you personally, as on github.com. */
export function hasAccentBar(item: InboxItem): boolean {
  return item.roles.includes('review-requested-direct');
}

/**
 * Whether the repo has a local clone, given main's answer so far. Unknown
 * reads as cloned: the resolution is fire-and-forget after each snapshot,
 * and the launch path re-checks authoritatively, so an optimistic row can
 * never mis-launch -- while a pessimistic one would grey every row for the
 * first half-second of every refresh.
 */
export function isRepoCloned(
  resolved: Record<string, string | null> | undefined,
  repo: string
): boolean {
  if (!resolved) return true;
  return resolved[repo] !== null;
}

/** The strongest reason an item is in the inbox, for the strip's meta line. */
export function roleLabelFor(item: InboxItem): string {
  if (item.roles.includes('review-requested-direct')) return 'review requested';
  if (item.roles.includes('review-requested-team')) return 'team review requested';
  if (item.roles.includes('author')) return item.workItem.type === 'pr' ? 'your PR' : 'your issue';
  if (item.roles.includes('assignee')) return 'assigned to you';
  return 'involves you';
}

/** The one-line subtitle the strip shows: repo · role · CI · review · +a −d. */
export function metaLineFor(item: InboxItem): string {
  const parts: string[] = [
    item.workItem.repo.split('/').pop() ?? item.workItem.repo,
    roleLabelFor(item),
  ];
  if (item.ciStatus) parts.push(`CI ${item.ciStatus}`);
  const review = reviewStateLabel(item);
  if (review) parts.push(review.toLowerCase());
  if (item.additions !== undefined || item.deletions !== undefined) {
    parts.push(`+${item.additions ?? 0} −${item.deletions ?? 0}`);
  }
  return parts.join(' · ');
}

/**
 * A workspace's sessions bucketed by the item they are linked to, keyed by
 * workItemKey so repo casing never splits one item in two. Computed once
 * per render of the list rather than once per row.
 */
export function groupSessionsByWorkItem(sessions: Session[]): Map<string, Session[]> {
  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.workItem) continue;
    const key = workItemKey(session.workItem);
    const bucket = grouped.get(key) ?? [];
    bucket.push(session);
    grouped.set(key, bucket);
  }
  return grouped;
}

/** The one dot a row shows for its sessions: the most urgent of them. */
export function worstStatusForItem(
  linked: Session[],
  terminals: Record<string, TerminalState>
): SessionStatus {
  return worstStatus(linked.map((session) => sessionStatusFor(terminals[session.instanceId])));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Retire the strip's `.inbox-dot` and its cross-import**

`dotClassFor` is gone, so its one consumer changes with it. In `src/renderer/components/WorkItemStrip/index.tsx` (verify at execution: C reshaped this file with the action pill and the sibling menu — apply these three edits to whatever it now contains): delete the line `import '../Inbox/styles.css';`; change the presentation import to drop `dotClassFor` —

```ts
import { metaLineFor } from '../Inbox/inboxPresentation';
```

— and delete the leading dot element:

```tsx
      <span className={`inbox-dot ${item ? dotClassFor(item) : 'inbox-dot--idle'}`} />
```

The strip's text already carries the same facts ("CI failing", "changes requested"), and the sibling menu C added shows session status with `.status-dot`; a second, GitHub-state dot beside it was noise.

In `src/renderer/components/WorkItemStrip/styles.css`, delete this rule and its comment:

```css
/* The dot reuses .inbox-dot--* colors from the Inbox stylesheet; declare the
   base shape here too so the strip stands alone when the Inbox never mounted. */
.work-item-strip .inbox-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
```

Then confirm nothing else reaches for a deleted export:

Run: `grep -rn "dotClassFor\|actionFor\|inbox-dot" src/renderer`
Expected: only the `.inbox-dot` rules still inside `Inbox/styles.css` (Task 13 removes them) — no `.tsx` or `.ts` hits.

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Inbox/inboxPresentation.ts src/renderer/components/Inbox/inboxPresentation.test.ts src/renderer/components/WorkItemStrip/index.tsx src/renderer/components/WorkItemStrip/styles.css
git commit -m "feat(inbox): presentation helpers for GitHub-shaped rows

Compact ages, review-state and check labels, the direct-request accent,
the cloned-or-not read, and the per-item session rollup -- all pure, so
the row and section components that follow carry no logic of their own.
The strip drops its GitHub-state dot with dotClassFor; its text says the
same thing and the sibling menu already shows session status.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Pure filters — repositories and Updated

**Files:**
- Create: `src/renderer/components/Inbox/inboxFilters.ts`
- Test: `src/renderer/components/Inbox/inboxFilters.test.ts`

**Interfaces:**
- Consumes: `InboxItem` from `src/shared/workItems.ts`.
- Produces:
  - `type InboxUpdatedFilter = 'week' | 'month' | 'quarter' | 'any'`
  - `INBOX_UPDATED_FILTERS: ReadonlyArray<InboxUpdatedFilter>` (menu order)
  - `UPDATED_FILTER_LABELS: Record<InboxUpdatedFilter, string>`
  - `isInboxUpdatedFilter(value: unknown): value is InboxUpdatedFilter`
  - `interface InboxFilterState { repos: string[]; updated: InboxUpdatedFilter }`
  - `DEFAULT_INBOX_FILTER: InboxFilterState` — `{ repos: [], updated: 'month' }`, frozen
  - `filterByUpdated(items: InboxItem[], updated: InboxUpdatedFilter, now?: number): InboxItem[]`
  - `filterByRepos(items: InboxItem[], repos: string[]): InboxItem[]` — empty selection passes everything through
  - `reposInSnapshot(items: InboxItem[]): string[]` — deduped, sorted

This file is the single source of the filter vocabulary; Task 7's store imports from it rather than redeclaring the union.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/components/Inbox/inboxFilters.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import {
  DEFAULT_INBOX_FILTER,
  INBOX_UPDATED_FILTERS,
  UPDATED_FILTER_LABELS,
  filterByRepos,
  filterByUpdated,
  isInboxUpdatedFilter,
  reposInSnapshot,
} from './inboxFilters';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-08-25T12:00:00Z');

function makeItem(number: number, repo: string, ageDays: number): InboxItem {
  return {
    workItem: { provider: 'github', repo, type: 'pr', number },
    title: `Item ${number}`,
    author: 'someone',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'none',
    commentCount: 0,
    updatedAt: new Date(now - ageDays * DAY).toISOString(),
    url: `https://github.com/${repo}/pull/${number}`,
  };
}

const numbers = (items: InboxItem[]) => items.map((item) => item.workItem.number);

const fresh = makeItem(1, 'sympower/flex-portal', 1);
const sixDays = makeItem(2, 'sympower/controller-app', 6);
const eightDays = makeItem(3, 'sympower/flex-portal', 8);
const twentyNineDays = makeItem(4, 'sympower/msa-resource-bff', 29);
const thirtyOneDays = makeItem(5, 'sympower/flex-portal', 31);
const eightyNineDays = makeItem(6, 'sympower/controller-app', 89);
const ninetyOneDays = makeItem(7, 'sympower/old-repo', 91);
const all = [fresh, sixDays, eightDays, twentyNineDays, thirtyOneDays, eightyNineDays, ninetyOneDays];

describe('the Updated vocabulary', () => {
  it("lists the four ranges in menu order with GitHub's labels, month the default", () => {
    expect(INBOX_UPDATED_FILTERS).toEqual(['week', 'month', 'quarter', 'any']);
    expect(UPDATED_FILTER_LABELS).toEqual({
      week: 'Last week',
      month: 'Last month',
      quarter: 'Last 3 months',
      any: 'Any time',
    });
    expect(DEFAULT_INBOX_FILTER).toEqual({ repos: [], updated: 'month' });
    expect(Object.isFrozen(DEFAULT_INBOX_FILTER)).toBe(true);
  });

  it('recognises its own members and nothing else', () => {
    expect(isInboxUpdatedFilter('week')).toBe(true);
    expect(isInboxUpdatedFilter('any')).toBe(true);
    expect(isInboxUpdatedFilter('decade')).toBe(false);
    expect(isInboxUpdatedFilter(undefined)).toBe(false);
    expect(isInboxUpdatedFilter(7)).toBe(false);
  });
});

describe('filterByUpdated', () => {
  it('keeps the last 7, 30 or 90 days, inclusive of the boundary day', () => {
    expect(numbers(filterByUpdated(all, 'week', now))).toEqual([1, 2]);
    expect(numbers(filterByUpdated(all, 'month', now))).toEqual([1, 2, 3, 4]);
    expect(numbers(filterByUpdated(all, 'quarter', now))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps everything for any, including an item with no usable stamp', () => {
    const undated = makeItem(8, 'sympower/flex-portal', 0);
    undated.updatedAt = '';
    expect(numbers(filterByUpdated([...all, undated], 'any', now))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drops an item whose stamp cannot be parsed from a bounded range', () => {
    const undated = makeItem(8, 'sympower/flex-portal', 0);
    undated.updatedAt = 'not a date';
    expect(numbers(filterByUpdated([undated], 'month', now))).toEqual([]);
  });
});

describe('filterByRepos', () => {
  it('passes everything through when nothing is selected -- never "show nothing"', () => {
    expect(filterByRepos(all, [])).toEqual(all);
  });

  it('keeps only the selected repos, case-insensitively', () => {
    expect(numbers(filterByRepos(all, ['Sympower/Controller-App']))).toEqual([2, 6]);
    expect(numbers(filterByRepos(all, ['sympower/controller-app', 'sympower/old-repo']))).toEqual([
      2, 6, 7,
    ]);
  });

  it('yields nothing for a repo the snapshot does not have', () => {
    expect(filterByRepos(all, ['sympower/nowhere'])).toEqual([]);
  });
});

describe('reposInSnapshot', () => {
  it('dedupes and sorts the repos present', () => {
    expect(reposInSnapshot(all)).toEqual([
      'sympower/controller-app',
      'sympower/flex-portal',
      'sympower/msa-resource-bff',
      'sympower/old-repo',
    ]);
    expect(reposInSnapshot([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/Inbox/inboxFilters.test.ts`
Expected: FAIL — `Cannot find module './inboxFilters'`.

- [ ] **Step 3: Implement `src/renderer/components/Inbox/inboxFilters.ts`**

```ts
// src/renderer/components/Inbox/inboxFilters.ts
import type { InboxItem } from '../../../shared/workItems';

/**
 * GitHub's header filters, applied client-side over the cached snapshot.
 * Neither costs a request: the fetch is one query per workspace whatever
 * the filter says, and narrowing happens before sectioning and counting.
 */
export type InboxUpdatedFilter = 'week' | 'month' | 'quarter' | 'any';

/** Menu order. */
export const INBOX_UPDATED_FILTERS: ReadonlyArray<InboxUpdatedFilter> = [
  'week',
  'month',
  'quarter',
  'any',
];

export const UPDATED_FILTER_LABELS: Record<InboxUpdatedFilter, string> = {
  week: 'Last week',
  month: 'Last month',
  quarter: 'Last 3 months',
  any: 'Any time',
};

export function isInboxUpdatedFilter(value: unknown): value is InboxUpdatedFilter {
  return typeof value === 'string' && (INBOX_UPDATED_FILTERS as readonly string[]).includes(value);
}

export interface InboxFilterState {
  /** Selected `owner/name` repos; empty means no repo filter at all. */
  repos: string[];
  updated: InboxUpdatedFilter;
}

/**
 * Frozen because the store hands this very object out for every workspace
 * that has nothing saved -- one caller mutating it would filter every
 * other workspace.
 */
export const DEFAULT_INBOX_FILTER: InboxFilterState = Object.freeze({
  repos: [],
  updated: 'month',
}) as InboxFilterState;

const DAY_MS = 24 * 60 * 60 * 1000;

const UPDATED_WINDOW_MS: Record<Exclude<InboxUpdatedFilter, 'any'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 90 * DAY_MS,
};

/** Items updated inside the window; an unparseable stamp fails a bounded range. */
export function filterByUpdated(
  items: InboxItem[],
  updated: InboxUpdatedFilter,
  now: number = Date.now()
): InboxItem[] {
  if (updated === 'any') return items;
  const cutoff = now - UPDATED_WINDOW_MS[updated];
  return items.filter((item) => Date.parse(item.updatedAt) >= cutoff);
}

/** Items in the selected repos; an empty selection is no filter, never "show nothing". */
export function filterByRepos(items: InboxItem[], repos: string[]): InboxItem[] {
  if (repos.length === 0) return items;
  const wanted = new Set(repos.map((repo) => repo.toLowerCase()));
  return items.filter((item) => wanted.has(item.workItem.repo.toLowerCase()));
}

/** The repos present in a snapshot, deduped and sorted -- what the repo menu offers. */
export function reposInSnapshot(items: InboxItem[]): string[] {
  return [...new Set(items.map((item) => item.workItem.repo))].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/Inbox/inboxFilters.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Inbox/inboxFilters.ts src/renderer/components/Inbox/inboxFilters.test.ts
git commit -m "feat(inbox): repository and Updated filters as pure functions

Applied over the cache before sectioning and counting, so a filter never
costs a request. An empty repo selection means no filter: a menu that
could show nothing by default would read as a broken fetch.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Settings store — persisted per-workspace inbox filters

**Files:**
- Modify: `src/renderer/stores/settingsStore.ts`
- Create: `src/renderer/stores/settingsStore.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_INBOX_FILTER`, `isInboxUpdatedFilter`, `InboxFilterState`, `InboxUpdatedFilter` (Task 6).
- Produces (on `SettingsState`): `inboxFilters: Record<string, InboxFilterState>` keyed by workspace id; `setInboxRepoFilter(workspaceId: string, repos: string[]): void`; `setInboxUpdatedFilter(workspaceId: string, updated: InboxUpdatedFilter): void`; `inboxFilterFor(workspaceId: string): InboxFilterState` (the stored entry, else the frozen default). Module export `sanitizeInboxFilters(raw: unknown): Record<string, InboxFilterState>`, run on every hydrate.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/stores/settingsStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INBOX_FILTER } from '../components/Inbox/inboxFilters';
import { sanitizeInboxFilters, useSettingsStore } from './settingsStore';

describe('sanitizeInboxFilters', () => {
  it('answers an empty map for anything that is not a plain object', () => {
    expect(sanitizeInboxFilters(undefined)).toEqual({});
    expect(sanitizeInboxFilters(null)).toEqual({});
    expect(sanitizeInboxFilters('filters')).toEqual({});
    expect(sanitizeInboxFilters(42)).toEqual({});
    expect(sanitizeInboxFilters([])).toEqual({});
  });

  it('keeps a well-formed entry as is', () => {
    expect(
      sanitizeInboxFilters({ 'ws-1': { repos: ['sympower/flex-portal'], updated: 'week' } })
    ).toEqual({ 'ws-1': { repos: ['sympower/flex-portal'], updated: 'week' } });
  });

  it('fills a partial entry in with the defaults', () => {
    expect(sanitizeInboxFilters({ 'ws-1': {} })).toEqual({
      'ws-1': { repos: [], updated: 'month' },
    });
  });

  it('drops non-string repos and an Updated value it does not know', () => {
    expect(
      sanitizeInboxFilters({ 'ws-1': { repos: ['a/b', 3, null, 'c/d'], updated: 'decade' } })
    ).toEqual({ 'ws-1': { repos: ['a/b', 'c/d'], updated: 'month' } });
  });

  it('skips entries that are not objects', () => {
    expect(sanitizeInboxFilters({ 'ws-1': 'nope', 'ws-2': null })).toEqual({});
  });
});

describe('inbox filter actions', () => {
  beforeEach(() => {
    useSettingsStore.setState({ inboxFilters: {} });
  });

  it('answers the shared default for a workspace with nothing saved', () => {
    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toBe(DEFAULT_INBOX_FILTER);
  });

  it('keeps workspaces apart', () => {
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['sympower/flex-portal']);
    useSettingsStore.getState().setInboxUpdatedFilter('ws-2', 'any');

    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toEqual({
      repos: ['sympower/flex-portal'],
      updated: 'month',
    });
    expect(useSettingsStore.getState().inboxFilterFor('ws-2')).toEqual({ repos: [], updated: 'any' });
  });

  it('replaces the repo list wholesale and leaves Updated alone', () => {
    useSettingsStore.getState().setInboxUpdatedFilter('ws-1', 'quarter');
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['a/b', 'c/d']);
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['c/d']);

    expect(useSettingsStore.getState().inboxFilterFor('ws-1')).toEqual({
      repos: ['c/d'],
      updated: 'quarter',
    });
  });

  it('never hands out a mutated default', () => {
    useSettingsStore.getState().setInboxRepoFilter('ws-1', ['a/b']);
    expect(DEFAULT_INBOX_FILTER.repos).toEqual([]);
    expect(useSettingsStore.getState().inboxFilterFor('ws-2')).toBe(DEFAULT_INBOX_FILTER);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/stores/settingsStore.test.ts`
Expected: FAIL — `sanitizeInboxFilters` is not exported and `inboxFilterFor` is not a function. (The store module itself loads fine in node: `createJSONStorage(() => localStorage)` catches the missing global, exactly as `navigationStore.test.ts` relies on.)

- [ ] **Step 3: Add the slice**

In `src/renderer/stores/settingsStore.ts`, add the import after the zustand imports:

```ts
import {
  DEFAULT_INBOX_FILTER,
  isInboxUpdatedFilter,
  type InboxFilterState,
  type InboxUpdatedFilter,
} from '../components/Inbox/inboxFilters';
```

Extend `SettingsState` — before:

```ts
interface SettingsState {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  terminalFontSize: number;
  setTheme: (theme: ThemeMode) => void;
  /** Step to the next theme: light -> dark -> system -> light. */
  cycleTheme: () => void;
  setTerminalFontSize: (size: number) => void;
  _setResolvedTheme: (theme: 'light' | 'dark') => void;
}
```

after:

```ts
interface SettingsState {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  terminalFontSize: number;
  /** The Inbox's repository and Updated filters, per workspace id. */
  inboxFilters: Record<string, InboxFilterState>;
  setTheme: (theme: ThemeMode) => void;
  /** Step to the next theme: light -> dark -> system -> light. */
  cycleTheme: () => void;
  setTerminalFontSize: (size: number) => void;
  setInboxRepoFilter: (workspaceId: string, repos: string[]) => void;
  setInboxUpdatedFilter: (workspaceId: string, updated: InboxUpdatedFilter) => void;
  /** The saved filters, or the shared frozen default when nothing is saved. */
  inboxFilterFor: (workspaceId: string) => InboxFilterState;
  _setResolvedTheme: (theme: 'light' | 'dark') => void;
}

/**
 * Fold a persisted `inboxFilters` blob into a shape the Inbox can trust.
 *
 * Mirrors navigationStore's mergeNavigationState: zustand's default merge
 * would spread whatever an older build or a hand-edited profile wrote
 * straight into state, and the Inbox filters every list through this.
 * Exported so the one place a stale profile can break the view is
 * testable on its own.
 */
export function sanitizeInboxFilters(raw: unknown): Record<string, InboxFilterState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, InboxFilterState> = {};
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Partial<InboxFilterState>;
    result[workspaceId] = {
      repos: Array.isArray(candidate.repos)
        ? candidate.repos.filter((repo): repo is string => typeof repo === 'string')
        : [],
      updated: isInboxUpdatedFilter(candidate.updated)
        ? candidate.updated
        : DEFAULT_INBOX_FILTER.updated,
    };
  }
  return result;
}
```

Then the store body. Before:

```ts
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
      setTheme: (theme) => set({ theme }),
```

after:

```ts
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
      inboxFilters: {},
      setTheme: (theme) => set({ theme }),
```

Before:

```ts
      setTerminalFontSize: (size) => set({ terminalFontSize: clampTerminalFontSize(size) }),
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
```

after:

```ts
      setTerminalFontSize: (size) => set({ terminalFontSize: clampTerminalFontSize(size) }),
      setInboxRepoFilter: (workspaceId, repos) =>
        set((state) => ({
          inboxFilters: {
            ...state.inboxFilters,
            [workspaceId]: { ...state.inboxFilterFor(workspaceId), repos },
          },
        })),
      setInboxUpdatedFilter: (workspaceId, updated) =>
        set((state) => ({
          inboxFilters: {
            ...state.inboxFilters,
            [workspaceId]: { ...state.inboxFilterFor(workspaceId), updated },
          },
        })),
      // The default is one frozen object, returned by reference: selectors
      // comparing by identity stay stable, and nothing can mutate it.
      inboxFilterFor: (workspaceId) => get().inboxFilters[workspaceId] ?? DEFAULT_INBOX_FILTER,
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
```

And the persist options. Before:

```ts
      partialize: (state) => ({
        theme: state.theme,
        terminalFontSize: state.terminalFontSize,
      }),
      // A persisted size from an older build (or a hand-edited value) still has
      // to land inside the bounds the terminal can actually lay out.
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          terminalFontSize: clampTerminalFontSize(
            saved?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
          ),
        };
      },
```

after:

```ts
      partialize: (state) => ({
        theme: state.theme,
        terminalFontSize: state.terminalFontSize,
        inboxFilters: state.inboxFilters,
      }),
      // A persisted size from an older build (or a hand-edited value) still has
      // to land inside the bounds the terminal can actually lay out, and a
      // persisted filter blob has to be a shape the Inbox can filter with.
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          terminalFontSize: clampTerminalFontSize(
            saved?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
          ),
          inboxFilters: sanitizeInboxFilters(saved?.inboxFilters),
        };
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/stores/settingsStore.test.ts`
Expected: PASS (9 tests).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/settingsStore.ts src/renderer/stores/settingsStore.test.ts
git commit -m "feat(settings): persist the Inbox filters per workspace

The repo and Updated filters survive relaunch like every other
preference, sanitized on hydrate the way navigation preferences are, so
a stale or hand-edited profile cannot hand the Inbox a filter it cannot
apply.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Filter menus — `RepoFilterMenu` and `UpdatedFilterMenu`

**Files:**
- Create: `src/renderer/components/Inbox/InboxFilters.tsx`

**Interfaces:**
- Consumes: `INBOX_UPDATED_FILTERS`, `UPDATED_FILTER_LABELS`, `InboxUpdatedFilter` (Task 6); Radix `DropdownMenu` (`CheckboxItem`, `RadioGroup`, `RadioItem`, `ItemIndicator`); `Check`, `ChevronDown` from `lucide-react`.
- Produces:
  - `RepoFilterMenu({ repos: string[]; selected: string[]; onChange: (repos: string[]) => void })` — trigger `.inbox-filter-trigger.inbox-repo-filter-trigger`, one `menuitemcheckbox` per repo labelled `owner/name`; the menu stays open across toggles; "Clear selection" when anything is selected
  - `UpdatedFilterMenu({ value: InboxUpdatedFilter; onChange: (value: InboxUpdatedFilter) => void })` — trigger `.inbox-filter-trigger.inbox-updated-filter-trigger` reading `Updated: <label>`, one `menuitemradio` per range

Both menus stop their `Escape` from reaching the Inbox: Radix marks the event `defaultPrevented` when it dismisses a layer, and the Inbox's own listener (Task 12) ignores such events — so no extra wiring is needed here beyond letting Radix handle the key.

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/components/Inbox/InboxFilters.tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import {
  INBOX_UPDATED_FILTERS,
  UPDATED_FILTER_LABELS,
  type InboxUpdatedFilter,
} from './inboxFilters';

interface RepoFilterMenuProps {
  /** Every repo in the snapshot, sorted -- the only things worth offering. */
  repos: string[];
  selected: string[];
  onChange: (repos: string[]) => void;
}

/**
 * GitHub's "Select repositories": a multi-select over what the snapshot
 * actually holds. Toggling keeps the menu open (Radix closes on select by
 * default, which makes picking three repos three trips), and an empty
 * selection reads as "all" rather than "none".
 */
export function RepoFilterMenu({ repos, selected, onChange }: RepoFilterMenuProps) {
  const label =
    selected.length === 0
      ? 'Select repositories'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} repositories`;

  const toggle = (repo: string, checked: boolean) => {
    onChange(checked ? [...selected, repo] : selected.filter((candidate) => candidate !== repo));
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={`inbox-filter-trigger inbox-repo-filter-trigger ${
            selected.length > 0 ? 'active' : ''
          }`}
          disabled={repos.length === 0}
          title={repos.length === 0 ? 'No repositories in the inbox yet' : undefined}
        >
          <span className="inbox-filter-trigger-label">{label}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content inbox-filter-menu"
          sideOffset={6}
          align="start"
        >
          {repos.map((repo) => (
            <DropdownMenu.CheckboxItem
              key={repo}
              className="dropdown-item inbox-filter-item"
              checked={selected.includes(repo)}
              onCheckedChange={(checked) => toggle(repo, checked === true)}
              // Keep the menu open: a multi-select that closes on every tick
              // is a single-select with extra steps.
              onSelect={(event) => event.preventDefault()}
            >
              <span className="inbox-filter-item-indicator" aria-hidden="true">
                <DropdownMenu.ItemIndicator>
                  <Check size={12} />
                </DropdownMenu.ItemIndicator>
              </span>
              <span>{repo}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          {selected.length > 0 && (
            <>
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item className="dropdown-item" onSelect={() => onChange([])}>
                <span className="inbox-filter-item-indicator" aria-hidden="true" />
                <span>Clear selection</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface UpdatedFilterMenuProps {
  value: InboxUpdatedFilter;
  onChange: (value: InboxUpdatedFilter) => void;
}

/** GitHub's "Updated" range: one of four windows, single-select, closes on pick. */
export function UpdatedFilterMenu({ value, onChange }: UpdatedFilterMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="inbox-filter-trigger inbox-updated-filter-trigger">
          <span className="inbox-filter-trigger-label">Updated: {UPDATED_FILTER_LABELS[value]}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content inbox-filter-menu"
          sideOffset={6}
          align="start"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as InboxUpdatedFilter)}
          >
            {INBOX_UPDATED_FILTERS.map((range) => (
              <DropdownMenu.RadioItem
                key={range}
                className="dropdown-item inbox-filter-item"
                value={range}
              >
                <span className="inbox-filter-item-indicator" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>
                    <Check size={12} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span>{UPDATED_FILTER_LABELS[range]}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. The `onValueChange` cast is safe: every `RadioItem` value is one of `INBOX_UPDATED_FILTERS`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Inbox/InboxFilters.tsx
git commit -m "feat(inbox): repository and Updated filter menus

Radix checkbox items for the multi-select (kept open across toggles),
radio items for the range. Labels come from the pure filter module so
the menu and the persisted value cannot disagree.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: View tabs — the five lenses as a tab strip

**Files:**
- Create: `src/renderer/components/Inbox/ViewTabs.tsx`

**Interfaces:**
- Consumes: `INBOX_VIEWS`, `InboxViewId` (Task 1).
- Produces: `ViewTabs({ active: InboxViewId; counts: Record<InboxViewId, number>; onSelect: (view: InboxViewId) => void })` — a `role="tablist"` of `role="tab"` buttons, each `data-testid="inbox-tab-{id}"`, `aria-selected`, holding `.inbox-view-tab-count`.

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/components/Inbox/ViewTabs.tsx
import { INBOX_VIEWS, type InboxViewId } from '../../../shared/inboxViews';

interface ViewTabsProps {
  active: InboxViewId;
  /** Post-filter counts -- the number a tab shows is the number it will list. */
  counts: Record<InboxViewId, number>;
  onSelect: (view: InboxViewId) => void;
}

/**
 * GitHub's left navigation, folded into a tab strip (mockup inbox-views
 * option 2) so Consola's sidebar stays Inbox · Groups · Scopes. Counts are
 * live for every tab, not just the active one: the strip is also the
 * at-a-glance answer to "is anything waiting under the other views".
 */
export function ViewTabs({ active, counts, onSelect }: ViewTabsProps) {
  return (
    <div className="inbox-view-tabs" role="tablist" aria-label="Inbox views">
      {INBOX_VIEWS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          className={`inbox-view-tab ${active === id ? 'active' : ''}`}
          data-testid={`inbox-tab-${id}`}
          onClick={() => onSelect(id)}
        >
          <span>{label}</span>
          <span className="inbox-view-tab-count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Inbox/ViewTabs.tsx
git commit -m "feat(inbox): view tab strip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Row and section group — lean rows, collapsible sections

**Files:**
- Create: `src/renderer/components/Inbox/InboxRow.tsx`
- Create: `src/renderer/components/Inbox/InboxSectionGroup.tsx`

**Interfaces:**
- Consumes: `InboxItem`, `workItemKey` (`src/shared/workItems.ts`); `InboxSection` (`src/shared/inboxSections.ts`); `Session` (`src/shared/workspace.ts`); `TerminalState` (`terminalStore`); `relativeTime`, `reviewStateLabel`, `checksLabel`, `hasAccentBar`, `isRepoCloned`, `worstStatusForItem` (Task 5); `.status-dot--*` from `src/renderer/styles/statusDots.css` (C); `GitPullRequest`, `GitPullRequestDraft`, `CircleDot`, `Check`, `X`, `MessageSquare`, `ChevronDown`, `ChevronRight` from `lucide-react`.
- Produces:
  - `InboxRow({ item: InboxItem; sessions: Session[]; terminals: Record<string, TerminalState>; cloned: boolean; selected: boolean; onSelect: (item: InboxItem) => void })` — `.inbox-row[data-work-item-key]`, `role="button"`, keyboard-activatable
  - `InboxSectionGroup({ section: InboxSection; label: string; items: InboxItem[]; collapsed: boolean; onToggle: () => void; sessionsByItem: Map<string, Session[]>; terminals: Record<string, TerminalState>; resolvedRepos: Record<string, string | null> | undefined; selectedKey: string | null; onSelectItem: (item: InboxItem) => void })` — `[data-testid="inbox-section-{id}"]` with `.inbox-section-toggle` (`aria-expanded`) and `.inbox-section-count`

- [ ] **Step 1: Write `InboxRow.tsx`**

```tsx
// src/renderer/components/Inbox/InboxRow.tsx
import { Check, CircleDot, GitPullRequest, GitPullRequestDraft, MessageSquare, X } from 'lucide-react';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import {
  checksLabel,
  hasAccentBar,
  relativeTime,
  reviewStateLabel,
  worstStatusForItem,
} from './inboxPresentation';
import '../../styles/statusDots.css';

interface InboxRowProps {
  item: InboxItem;
  /** This workspace's sessions linked to this item. */
  sessions: Session[];
  terminals: Record<string, TerminalState>;
  cloned: boolean;
  selected: boolean;
  onSelect: (item: InboxItem) => void;
}

/**
 * One item, as lean as GitHub's own row (mockup inbox-layout option B):
 * type icon, title, `repo#n · author · age`, a one-dot hint of its sessions,
 * then review state, checks and comment count. No verbs -- selecting the
 * row opens the pane, and the pane is where sessions and actions live.
 */
export function InboxRow({ item, sessions, terminals, cloned, selected, onSelect }: InboxRowProps) {
  const key = workItemKey(item.workItem);
  const review = reviewStateLabel(item);
  const checks = checksLabel(item.checks);
  const repoName = item.workItem.repo.split('/').pop() ?? item.workItem.repo;
  const sessionStatus = sessions.length > 0 ? worstStatusForItem(sessions, terminals) : null;
  const meta = [`${repoName}#${item.workItem.number}`, item.author, relativeTime(item.updatedAt)]
    .filter(Boolean)
    .join(' · ');

  const icon =
    item.workItem.type === 'issue' ? (
      <CircleDot size={14} className="inbox-row-icon inbox-row-icon--issue" aria-hidden="true" />
    ) : item.isDraft ? (
      <GitPullRequestDraft size={14} className="inbox-row-icon inbox-row-icon--draft" aria-hidden="true" />
    ) : (
      <GitPullRequest size={14} className="inbox-row-icon" aria-hidden="true" />
    );

  // A div with role="button" rather than a <button>: the row will host
  // interactive children later (the pane's affordances migrating into rows
  // is the obvious next step), and a button may not contain a button. The
  // key handler restores the Enter/Space activation a real button gets free.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(item);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={[
        'inbox-row',
        selected ? 'selected' : '',
        hasAccentBar(item) ? 'inbox-row--accent' : '',
        cloned ? '' : 'inbox-row--uncloned',
      ]
        .filter(Boolean)
        .join(' ')}
      data-work-item-key={key}
      title={cloned ? undefined : 'No local clone of this repository in the workspace'}
      onClick={() => onSelect(item)}
      onKeyDown={handleKeyDown}
    >
      {icon}
      <div className="inbox-row-text">
        <span className="inbox-row-title">{item.title}</span>
        <span className="inbox-row-meta">
          <span className="inbox-row-meta-facts">{meta}</span>
          {sessionStatus && (
            <span className="inbox-row-sessions">
              <span className="inbox-row-meta-sep">·</span>
              <span className={`status-dot status-dot--${sessionStatus}`} aria-hidden="true" />
              {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
            </span>
          )}
        </span>
      </div>
      <div className="inbox-row-status">
        {review && (
          <span className={`inbox-row-review inbox-row-review--${item.reviewDecision}`}>{review}</span>
        )}
        {checks && (
          <span
            className={`inbox-row-checks inbox-row-checks--${checks.tone}`}
            title={`${item.checks?.passed ?? 0} passed, ${item.checks?.failed ?? 0} failed, ${
              item.checks?.pending ?? 0
            } pending`}
          >
            {checks.tone === 'bad' ? <X size={11} aria-hidden="true" /> : <Check size={11} aria-hidden="true" />}
            {checks.text}
          </span>
        )}
        {item.commentCount > 0 && (
          <span className="inbox-row-comments" title={`${item.commentCount} comments`}>
            <MessageSquare size={11} aria-hidden="true" />
            {item.commentCount}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `InboxSectionGroup.tsx`**

```tsx
// src/renderer/components/Inbox/InboxSectionGroup.tsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { InboxSection } from '../../../shared/inboxSections';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { InboxRow } from './InboxRow';
import { isRepoCloned } from './inboxPresentation';

interface InboxSectionGroupProps {
  section: InboxSection;
  label: string;
  items: InboxItem[];
  collapsed: boolean;
  onToggle: () => void;
  /** Keyed by workItemKey; computed once by the view, shared by every section. */
  sessionsByItem: Map<string, Session[]>;
  terminals: Record<string, TerminalState>;
  resolvedRepos: Record<string, string | null> | undefined;
  selectedKey: string | null;
  onSelectItem: (item: InboxItem) => void;
}

/**
 * One of GitHub's sections: a heading with a count that stays visible
 * while collapsed -- the count is the triage signal, the rows are the
 * detail -- and the rows beneath it when expanded.
 */
export function InboxSectionGroup({
  section,
  label,
  items,
  collapsed,
  onToggle,
  sessionsByItem,
  terminals,
  resolvedRepos,
  selectedKey,
  onSelectItem,
}: InboxSectionGroupProps) {
  return (
    <section
      className={`inbox-section ${collapsed ? 'collapsed' : ''}`}
      data-testid={`inbox-section-${section}`}
    >
      <button className="inbox-section-toggle" aria-expanded={!collapsed} onClick={onToggle}>
        {collapsed ? (
          <ChevronRight size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
        <span className="inbox-section-label">{label}</span>
        <span className="inbox-section-count">{items.length}</span>
      </button>
      {!collapsed && items.length > 0 && (
        <div className="inbox-list">
          {items.map((item) => {
            const key = workItemKey(item.workItem);
            return (
              <InboxRow
                key={key}
                item={item}
                sessions={sessionsByItem.get(key) ?? []}
                terminals={terminals}
                cloned={isRepoCloned(resolvedRepos, item.workItem.repo)}
                selected={selectedKey === key}
                onSelect={onSelectItem}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If it reports that `../../styles/statusDots.css` cannot be found, C placed the file elsewhere — verify at execution against C's `InboxItemPane.tsx` import and use the same path; the class names are the contract, not the path.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Inbox/InboxRow.tsx src/renderer/components/Inbox/InboxSectionGroup.tsx
git commit -m "feat(inbox): lean rows and collapsible section groups

Rows carry what GitHub's do plus a one-dot session hint; every verb
moved to the pane in Phase C. Section counts stay visible while
collapsed because the count is the triage signal.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Header — title, filters, account, staleness, refresh, settings

**Files:**
- Create: `src/renderer/components/Inbox/InboxHeader.tsx`

**Interfaces:**
- Consumes: `Workspace` (`src/renderer/stores/workspaceStore`); `InboxSnapshot` (`src/shared/workItems.ts`); `PROVIDER_META` (`src/shared/providers.ts`, B); `InboxFilterState`, `InboxUpdatedFilter` (Task 6); `RepoFilterMenu`, `UpdatedFilterMenu` (Task 8); `formatAge` (Task 5); `useWorkspaceSettings()` from `src/renderer/contexts/WorkspaceSettingsContext.tsx` (A) — `{ openWorkspaceSettings(workspaceId?: string): void }`; `RefreshCw`, `Settings` from `lucide-react`.
- Produces: `InboxHeader({ workspace: Workspace; provider: NonNullable<Workspace['provider']>; snapshot: InboxSnapshot | undefined; repos: string[]; filter: InboxFilterState; onReposChange: (repos: string[]) => void; onUpdatedChange: (updated: InboxUpdatedFilter) => void; onRefresh: () => void })` — `.inbox-header` with `.inbox-refresh` (`aria-label="Refresh inbox"`) and `.inbox-refresh.inbox-settings-button` (`aria-label="Workspace settings"`).

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/components/Inbox/InboxHeader.tsx
import { RefreshCw, Settings } from 'lucide-react';
import { PROVIDER_META } from '../../../shared/providers';
import type { InboxSnapshot } from '../../../shared/workItems';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import type { Workspace } from '../../stores/workspaceStore';
import { RepoFilterMenu, UpdatedFilterMenu } from './InboxFilters';
import type { InboxFilterState, InboxUpdatedFilter } from './inboxFilters';
import { formatAge } from './inboxPresentation';

interface InboxHeaderProps {
  workspace: Workspace;
  /** The binding, already known to exist -- the view renders nothing without one. */
  provider: NonNullable<Workspace['provider']>;
  snapshot: InboxSnapshot | undefined;
  /** Repos present in the snapshot, for the repo menu. */
  repos: string[];
  filter: InboxFilterState;
  onReposChange: (repos: string[]) => void;
  onUpdatedChange: (updated: InboxUpdatedFilter) => void;
  onRefresh: () => void;
}

/**
 * GitHub's inbox header, plus what Consola owns: whose account this is,
 * how old the data is (labelled, never a dialog, when the provider could
 * not be reached), a manual refresh, and the door to Workspace Settings
 * where the actions this inbox launches are edited.
 */
export function InboxHeader({
  workspace,
  provider,
  snapshot,
  repos,
  filter,
  onReposChange,
  onUpdatedChange,
  onRefresh,
}: InboxHeaderProps) {
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const providerName = PROVIDER_META[provider.id].displayName;

  return (
    <header className="inbox-header">
      <h1 className="inbox-title">Inbox</h1>
      <div className="inbox-filters">
        <RepoFilterMenu repos={repos} selected={filter.repos} onChange={onReposChange} />
        <UpdatedFilterMenu value={filter.updated} onChange={onUpdatedChange} />
      </div>
      <div className="inbox-meta">
        <span className="inbox-meta-account">
          {provider.accountLogin}
          {provider.org ? ` · ${provider.org}` : ''}
        </span>
        {snapshot?.error ? (
          // Degrade, never dialog: name the failure, show the data's age.
          <span className="inbox-meta-error" title={snapshot.error}>
            {providerName} unreachable · showing data from {formatAge(snapshot.fetchedAt)}
          </span>
        ) : (
          <span className="inbox-meta-age">updated {formatAge(snapshot?.fetchedAt ?? 0)}</span>
        )}
        <button className="inbox-refresh" aria-label="Refresh inbox" onClick={onRefresh}>
          <RefreshCw size={13} />
        </button>
        <button
          className="inbox-refresh inbox-settings-button"
          aria-label="Workspace settings"
          onClick={() => openWorkspaceSettings(workspace.id)}
        >
          <Settings size={13} />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Inbox/InboxHeader.tsx
git commit -m "feat(inbox): header with filters, account, staleness and settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Orchestrator — `Inbox/index.tsx` rewrite, sidebar count, pane selectors

**Files:**
- Modify: `src/renderer/components/Inbox/index.tsx` (rewrite)
- Modify: `src/renderer/components/Sidebar/index.tsx` (the Inbox count)
- Verify: `src/renderer/components/Inbox/InboxItemPane.tsx` (C) exposes `[data-action-id]` and `.inbox-pane-session-row`; `src/renderer/components/Inbox/CloneDialog.tsx` (C) stops `Escape` propagation

**Interfaces:**
- Consumes: `INBOX_VIEWS`, `InboxViewId`, `itemsForView`, `groupBySection` (Task 1); `INBOX_SECTIONS`, `DEFAULT_COLLAPSED_SECTIONS`, `InboxSection` (B); `workItemKey`, `InboxItem` (B); `useInboxStore` (`snapshots`, `resolvedRepos`, `refresh`, `load`) and `CloneDialog` (C's shapes); `useTerminalStore`; `useSettingsStore` (Task 7); `filterByRepos`, `filterByUpdated`, `reposInSnapshot`, `DEFAULT_INBOX_FILTER` (Task 6); `groupSessionsByWorkItem`, `isRepoCloned` (Task 5); `InboxHeader` (Task 11), `ViewTabs` (Task 9), `InboxSectionGroup`, `InboxRow` (Task 10); `InboxItemPane` (C) with props `{ workspace, item, onClose }`; `PROVIDER_META` (B).
- Produces: `InboxView({ workspace: Workspace })` — unchanged export and props, so `MainContent.tsx` needs no edit. Owns: view (`'inbox'` on mount), selection (`selectedKey`, toggled by a row click, cleared by `Escape` or the pane's `onClose`, and dropping out on its own when the item leaves the snapshot), per-workspace collapsed sections (component state keyed by workspace id, seeded from `DEFAULT_COLLAPSED_SECTIONS`), the stale-repo clamp effect, and the `.inbox-body/.inbox-main/.inbox-pane-slot` layout.
- Sidebar: the Inbox badge becomes `itemsForView(items, 'inbox').length` — the sectioned count, which is the number of things waiting for triage.

- [ ] **Step 1: Rewrite `src/renderer/components/Inbox/index.tsx`**

Replace the whole file (C's version — flat rows, selection, pane — is superseded; every piece of it that survives is re-expressed below):

```tsx
// src/renderer/components/Inbox/index.tsx
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_COLLAPSED_SECTIONS,
  INBOX_SECTIONS,
  type InboxSection,
} from '../../../shared/inboxSections';
import { INBOX_VIEWS, groupBySection, itemsForView, type InboxViewId } from '../../../shared/inboxViews';
import { PROVIDER_META } from '../../../shared/providers';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import type { Workspace } from '../../stores/workspaceStore';
import { CloneDialog } from './CloneDialog';
import { InboxHeader } from './InboxHeader';
import { InboxItemPane } from './InboxItemPane';
import { InboxRow } from './InboxRow';
import { InboxSectionGroup } from './InboxSectionGroup';
import { ViewTabs } from './ViewTabs';
import { filterByRepos, filterByUpdated, reposInSnapshot } from './inboxFilters';
import { groupSessionsByWorkItem, isRepoCloned } from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

const NO_ITEMS: InboxItem[] = [];

const SECTION_LABELS = Object.fromEntries(
  INBOX_SECTIONS.map(({ id, label }) => [id, label])
) as Record<InboxSection, string>;

/**
 * GitHub's PR inbox, in Consola (mockup inbox-layout option B, inbox-views
 * option 2): header, the five views as tabs, then sections or a flat list
 * on the left and the selected item's pane on the right. Remote-driven and
 * read-only against the provider -- the only verbs live in the pane, and
 * every one of them creates or opens a local session.
 *
 * State that is this view's alone: which view, which item is selected,
 * and which sections are folded (per workspace, never persisted). Filters
 * live in the settings store because they survive relaunch.
 */
export function InboxView({ workspace }: InboxViewProps) {
  const [view, setView] = useState<InboxViewId>('inbox');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Keyed by workspace id: MainContent keeps this component mounted across
  // a workspace switch, and one workspace's folded sections are not another's.
  const [collapsedByWorkspace, setCollapsedByWorkspace] = useState<
    Record<string, ReadonlySet<InboxSection>>
  >({});

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const resolvedRepos = useInboxStore((state) => state.resolvedRepos[workspace.id]);
  const refresh = useInboxStore((state) => state.refresh);
  const terminals = useTerminalStore((state) => state.terminals);
  const filter = useSettingsStore((state) => state.inboxFilterFor(workspace.id));
  const setInboxRepoFilter = useSettingsStore((state) => state.setInboxRepoFilter);
  const setInboxUpdatedFilter = useSettingsStore((state) => state.setInboxUpdatedFilter);

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
  }, [workspace.id]);

  const items = snapshot?.items ?? NO_ITEMS;
  const repos = useMemo(() => reposInSnapshot(items), [items]);

  // A persisted repo selection can name repos that have since left the
  // inbox (merged, archived, org changed). Clamp it once a snapshot has
  // something to clamp against, so the menu never shows a tick for a repo
  // it does not list and the filter never silently hides everything.
  useEffect(() => {
    if (items.length === 0) return;
    const present = new Set(repos);
    const kept = filter.repos.filter((repo) => present.has(repo));
    if (kept.length !== filter.repos.length) setInboxRepoFilter(workspace.id, kept);
  }, [workspace.id, items, repos, filter.repos, setInboxRepoFilter]);

  const filtered = useMemo(
    () => filterByRepos(filterByUpdated(items, filter.updated), filter.repos),
    [items, filter.updated, filter.repos]
  );
  const counts = useMemo(() => {
    const result = {} as Record<InboxViewId, number>;
    for (const { id } of INBOX_VIEWS) result[id] = itemsForView(filtered, id).length;
    return result;
  }, [filtered]);
  const shown = useMemo(() => itemsForView(filtered, view), [filtered, view]);
  const sections = useMemo(() => groupBySection(shown), [shown]);
  const sessionsByItem = useMemo(
    () => groupSessionsByWorkItem(workspace.sessions),
    [workspace.sessions]
  );

  // Selection is a key, not an item: the snapshot behind it refreshes every
  // few minutes, and the pane must show the fresh facts. An item that left
  // the snapshot simply has no pane any more.
  const selected = selectedKey
    ? items.find((item) => workItemKey(item.workItem) === selectedKey)
    : undefined;

  // Escape closes the pane. Radix marks an Escape it consumed (a menu, a
  // nested dialog) as defaultPrevented from its capture-phase listener, so
  // this window-level listener sees it and stands down -- closing the clone
  // dialog must not also close the pane behind it.
  useEffect(() => {
    if (!selectedKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelectedKey(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKey]);

  const collapsed = collapsedByWorkspace[workspace.id] ?? DEFAULT_COLLAPSED_SECTIONS;
  const toggleSection = (section: InboxSection) => {
    setCollapsedByWorkspace((previous) => {
      const current = previous[workspace.id] ?? DEFAULT_COLLAPSED_SECTIONS;
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return { ...previous, [workspace.id]: next };
    });
  };

  const selectItem = (item: InboxItem) => {
    const key = workItemKey(item.workItem);
    setSelectedKey((current) => (current === key ? null : key));
  };

  const provider = workspace.provider;
  if (!provider) return null;
  const providerName = PROVIDER_META[provider.id].displayName;

  return (
    <div className="inbox-view">
      <InboxHeader
        workspace={workspace}
        provider={provider}
        snapshot={snapshot}
        repos={repos}
        filter={filter}
        onReposChange={(next) => setInboxRepoFilter(workspace.id, next)}
        onUpdatedChange={(next) => setInboxUpdatedFilter(workspace.id, next)}
        onRefresh={() => void refresh(workspace.id)}
      />
      <ViewTabs active={view} counts={counts} onSelect={setView} />
      <div className={`inbox-body ${selected ? 'inbox-body--pane-open' : ''}`}>
        <div className="inbox-main">
          {!snapshot && <p className="inbox-empty">Fetching from {providerName}...</p>}
          {snapshot &&
            view === 'inbox' &&
            sections.map(({ section, items: sectionItems }) => (
              <InboxSectionGroup
                key={section}
                section={section}
                label={SECTION_LABELS[section]}
                items={sectionItems}
                collapsed={collapsed.has(section)}
                onToggle={() => toggleSection(section)}
                sessionsByItem={sessionsByItem}
                terminals={terminals}
                resolvedRepos={resolvedRepos}
                selectedKey={selectedKey}
                onSelectItem={selectItem}
              />
            ))}
          {snapshot && view !== 'inbox' && shown.length === 0 && (
            <p className="inbox-empty">Nothing here right now.</p>
          )}
          {snapshot && view !== 'inbox' && shown.length > 0 && (
            <div className="inbox-list">
              {shown.map((item) => {
                const key = workItemKey(item.workItem);
                return (
                  <InboxRow
                    key={key}
                    item={item}
                    sessions={sessionsByItem.get(key) ?? []}
                    terminals={terminals}
                    cloned={isRepoCloned(resolvedRepos, item.workItem.repo)}
                    selected={selectedKey === key}
                    onSelect={selectItem}
                  />
                );
              })}
            </div>
          )}
        </div>
        {selected && (
          <aside className="inbox-pane-slot">
            <InboxItemPane
              workspace={workspace}
              item={selected}
              onClose={() => setSelectedKey(null)}
            />
          </aside>
        )}
      </div>
      <CloneDialog />
    </div>
  );
}
```

- [ ] **Step 2: Point the sidebar badge at the sectioned count**

In `src/renderer/components/Sidebar/index.tsx`, add the import:

```ts
import { itemsForView } from '../../../shared/inboxViews';
```

and change the count selector. Before (verify at execution: B renamed `workspace.github` to `workspace.provider` around this selector; the selector body itself is as it was):

```ts
  const inboxCount = useInboxStore((state) =>
    workspace ? (state.snapshots[workspace.id]?.items.length ?? 0) : 0
  );
```

After:

```ts
  // The sectioned count, not the raw cache: the cache now holds everything
  // the "involves" search returned, and the badge is for things waiting on
  // a triage decision. Unfiltered on purpose -- the sidebar has no filter
  // context, and a badge that shrank with a repo selection would lie.
  const inboxCount = useInboxStore((state) =>
    workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0
  );
```

- [ ] **Step 3: Verify the two pane selectors and the dialog guard**

The e2e drives two selectors on C's pane and relies on C's `Escape` guard. Verify at execution, and add whichever is missing (attributes only — no behaviour change to C's components):

- In `src/renderer/components/Inbox/InboxItemPane.tsx`, every "Start a session" button rendered from `workspace.actions` carries `data-action-id={action.id}` (the "Custom prompt…" button carries none), and every row in the Sessions list carries `className` containing `inbox-pane-session-row`.
- In `src/renderer/components/Inbox/CloneDialog.tsx`, `Dialog.Content` has `onEscapeKeyDown={(event) => event.stopPropagation()}` (contracts ruling C.12). With this task's `defaultPrevented` check the guard is belt-and-braces, but it stays: it documents the rule for the next nested dialog.

Run: `grep -n 'data-action-id\|inbox-pane-session-row' src/renderer/components/Inbox/InboxItemPane.tsx && grep -n 'onEscapeKeyDown' src/renderer/components/Inbox/CloneDialog.tsx`
Expected: at least one hit per pattern.

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: green. `grep -rn "inbox-item\b\|inbox-tab\b\|inbox-dot" src/renderer --include='*.tsx'` reports no hits — the old row, tab and dot classes have no consumers left.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Inbox/index.tsx src/renderer/components/Sidebar/index.tsx src/renderer/components/Inbox/InboxItemPane.tsx src/renderer/components/Inbox/CloneDialog.tsx
git commit -m "feat(inbox): layout B -- sections, view tabs, filters, pane slot

The view owns what is its own: which lens, which item is selected,
which sections are folded per workspace. Filters come from the settings
store, sessions are grouped once per render, and Escape stands down
whenever Radix already consumed it. The sidebar badge counts sectioned
items, since the cache now holds everything the involves search returns.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Styles — header, tabs, sections, rows, two-column body

**Files:**
- Modify: `src/renderer/components/Inbox/styles.css`

**Interfaces:**
- Consumes: the class names Tasks 8–12 render; tokens from `src/renderer/styles/themes/tokens.css` and the theme files; `.dropdown-content/.dropdown-item/.dropdown-separator` from `Sidebar/styles.css`; `.status-dot--*` from `statusDots.css` (C).
- Produces: the rules below. Retires `.inbox-item*`, `.inbox-tab*`, `.inbox-dot*`, `.inbox-list`'s old gap layout.

- [ ] **Step 1: Replace the list rules, keep the pane's and the dialog's**

In `src/renderer/components/Inbox/styles.css`, delete every rule from the top of the file through `.inbox-item-action:disabled { ... }` — that is `.inbox-view`, `.inbox-header`, `.inbox-title`, `.inbox-tabs`, `.inbox-tab`, `.inbox-tab.active`, `.inbox-meta`, `.inbox-meta-error`, `.inbox-refresh`, `.inbox-refresh:hover`, `.inbox-list`, `.inbox-empty`, `.inbox-item`, `.inbox-dot`, the three `.inbox-dot--*` rules, `.inbox-item-text`, `.inbox-item-title`, `.inbox-item-meta`, `.inbox-item-error`, `.inbox-item-link`, `.inbox-item-link:hover`, `.inbox-item-action`, `.inbox-item-action.ghost`, `.inbox-item-action:disabled`. Verify at execution: C appended pane rules (`.inbox-pane*`) and may have touched `.inbox-item`; leave every `.inbox-pane*` rule and the whole `.clone-dialog*` block exactly as C left them. Put this block where the deleted rules were:

```css
/* The Inbox: header, view tabs, then a two-column body -- the sectioned or
   flat list on the left, the selected item's pane on the right. Rows are
   GitHub-lean on purpose (mockup inbox-layout option B); everything Consola
   adds to an item lives in the pane. */
.inbox-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-primary);
}

.inbox-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) 0;
}

.inbox-title {
  font-size: 16px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  margin: 0;
}

.inbox-filters {
  display: flex;
  gap: var(--space-2);
  margin-left: var(--space-2);
}

.inbox-filter-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}

.inbox-filter-trigger:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.inbox-filter-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}

.inbox-filter-trigger.active {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.inbox-filter-menu {
  min-width: 220px;
}

/* A fixed-width slot so ticked and unticked rows line up. */
.inbox-filter-item-indicator {
  display: inline-flex;
  justify-content: center;
  width: 14px;
  flex: none;
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

/* View tabs (mockup inbox-views option 2). */
.inbox-view-tabs {
  display: flex;
  gap: 2px;
  padding: 0 var(--space-4);
  margin-top: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.inbox-view-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12.5px;
  padding: 4px 10px 6px;
  cursor: pointer;
  white-space: nowrap;
}

.inbox-view-tab:hover {
  color: var(--color-text-primary);
}

.inbox-view-tab.active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-accent);
  font-weight: var(--font-weight-medium);
}

.inbox-view-tab-count {
  font-size: 11px;
  color: var(--color-text-tertiary);
}

/* Two columns. The pane is fixed width so the list does not reflow when it
   opens; the list scrolls on its own so the header and tabs stay put. */
.inbox-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.inbox-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-4);
}

.inbox-pane-slot {
  width: 320px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.inbox-empty {
  color: var(--color-text-tertiary);
  font-size: 13px;
}

/* Sections. */
.inbox-section {
  margin-bottom: var(--space-3);
}

.inbox-section-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 12.5px;
  font-weight: var(--font-weight-semibold);
  padding: 4px 0;
  cursor: pointer;
  text-align: left;
}

.inbox-section.collapsed .inbox-section-toggle {
  color: var(--color-text-secondary);
}

.inbox-section-count {
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  padding: 0 7px;
}

/* Rows. */
.inbox-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  margin-top: 4px;
}

.inbox-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
}

.inbox-row:last-child {
  border-bottom: none;
}

.inbox-row:hover {
  background: var(--color-bg-hover);
}

.inbox-row.selected {
  background: var(--color-bg-selected);
}

.inbox-row:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

/* GitHub's left bar for reviews asked of you personally. */
.inbox-row--accent::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--color-warning);
}

/* No local clone: still listed, visibly out of reach until cloned. */
.inbox-row--uncloned {
  opacity: 0.55;
}

.inbox-row-icon {
  flex: none;
  margin-top: 1px;
  color: var(--color-success);
}

.inbox-row-icon--issue {
  color: var(--color-accent);
}

.inbox-row-icon--draft {
  color: var(--color-text-tertiary);
}

.inbox-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.inbox-row-title {
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inbox-row-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
}

.inbox-row-meta-facts {
  overflow: hidden;
  text-overflow: ellipsis;
}

.inbox-row-sessions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.inbox-row-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  margin-top: 2px;
  font-size: 11.5px;
  white-space: nowrap;
}

.inbox-row-review--approved {
  color: var(--color-success);
}

.inbox-row-review--changes-requested {
  color: var(--color-error);
}

.inbox-row-review--review-required {
  color: var(--color-warning);
}

.inbox-row-checks {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.inbox-row-checks--ok {
  color: var(--color-success);
}

.inbox-row-checks--warn {
  color: var(--color-warning);
}

.inbox-row-checks--bad {
  color: var(--color-error);
}

.inbox-row-comments {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--color-text-tertiary);
}
```

- [ ] **Step 2: Check nothing still names a retired class**

Run: `grep -rn "inbox-dot\|inbox-item\b\|inbox-item-\|inbox-tab\b\|inbox-tabs" src/renderer`
Expected: no hits.

Run: `npm run build`
Expected: builds clean; the renderer bundle includes the new stylesheet.

- [ ] **Step 3: Look at it**

Run: `npm run dev`, open a bound workspace's Inbox. Check, against the mockup: the header row (title, two filter pills, account, age, refresh, gear); the tab strip with counts; sections with chevrons and count pills, the three default-collapsed ones folded; rows with the accent bar on direct requests, the type icon, `repo#n · author · age`, the session dot and count where sessions exist, review state, checks and comments on the right; clicking a row opens the pane in a fixed-width right column and the list does not reflow; `Escape` closes it; a repo with no clone is greyed; the Updated menu closes on pick, the repo menu stays open across ticks. Both themes.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Inbox/styles.css
git commit -m "feat(inbox): styles for layout B

Header, tab strip, collapsible sections, lean rows with GitHub's accent
bar, and the two-column body with a fixed-width pane slot. The old
row, tab and inbox-dot rules go; session dots are C's status-dot.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Playwright E2E — the spec's full flow against the stub

**Files:**
- Modify: `tests/e2e/inbox.spec.ts` (rewrite)
- Test: `npm run build && npx playwright test tests/e2e/inbox.spec.ts`

**Interfaces:**
- Consumes: everything above; the stub `gh` with `GRAPHQL_INBOX_FIXTURE` (Task 2 — `getLoginEnv()` spreads `process.env` under the login shell's, so a variable set on the Electron process reaches the `gh` subprocess); `CONSOLA_GH_PATH` and `CONSOLA_WORKTREES_DIR` (existing seams); the ` Test` userData suffix from `src/main/index.ts`; state v7 (B); the workspace switcher's "Workspace settings…" item and the modal titled by the workspace with its `Actions` nav (A); the pane's `[data-action-id]`/`.inbox-pane-session-row`, the sidebar's "Link to work item…" menu item and `LinkSessionDialog`, `sessionLabel` (`PR #51 · Review`, `⑂ <name>`), and the "Start anyway" concurrency confirm (C).
- Produces: the spec's E2E proof — bind → sections render with the right counts → switch views and filters → start an action → the pane lists the session → start a second action on the same item → both sessions share `cwd` → link a hand-made session from the sidebar → the pane lists three → open Workspace Settings from the top-bar menu, rename an action, see the new name in the pane while the launched session keeps its old label. A's gear-button assertion is folded in.

Two design points, recorded so the executor does not re-derive them:

- **Fixture freshness.** The static `graphql-inbox.json` keeps fixed dates for the parser tests. This spec builds the same nine items in JS with `updatedAt` relative to `Date.now()`, writes them to a temp file, and passes the path as `GRAPHQL_INBOX_FIXTURE`. Otherwise the default "Last month" filter would hide the whole inbox a month after the fixture was written.
- **The concurrency confirm is conditional.** Whether the second launch meets "Another session is working on this — Start anyway" depends on what the first session's terminal is doing on the machine running the suite (a real `claude` may be busy; an absent one has exited). `startAction` answers the confirm only if it appears.

- [ ] **Step 1: Rewrite `tests/e2e/inbox.spec.ts` — fixture, seed, helpers**

Replace the whole file; this step is the top half, Step 2 is the test body that follows it in the same file.

```ts
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');
const PR51_KEY = 'github:sympower/controller-app:pr:51';
const SECTIONS = [
  'needs-your-review',
  'needs-team-review',
  'your-drafts',
  'waiting',
  'needs-action',
  'ready-to-merge',
  'issues',
];

/** A local clone whose origin matches the fixture's sympower/controller-app. */
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

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const checkRun = (conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  status,
  conclusion,
});
const statusContext = (state: string) => ({ __typename: 'StatusContext', state });

/** A `commits` field whose rollup carries `state` and the given contexts; null means no rollup. */
function rollup(state: string | null, contexts: unknown[]) {
  if (state === null) return { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
  return {
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state,
              contexts: { totalCount: contexts.length, nodes: contexts },
            },
          },
        },
      ],
    },
  };
}

function pr(
  repo: string,
  number: number,
  title: string,
  author: string,
  ageDays: number,
  extra: Record<string, unknown> = {}
) {
  return {
    __typename: 'PullRequest',
    title,
    number,
    state: 'OPEN',
    url: `https://github.com/sympower/${repo}/pull/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sympower/${repo}` },
    author: { login: author },
    comments: { totalCount: 0 },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 10,
    deletions: 2,
    ...rollup('SUCCESS', [checkRun('SUCCESS')]),
    ...extra,
  };
}

function issue(repo: string, number: number, title: string, author: string, ageDays: number, comments: number) {
  return {
    __typename: 'Issue',
    title,
    number,
    state: 'OPEN',
    url: `https://github.com/sympower/${repo}/issues/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sympower/${repo}` },
    author: { login: author },
    comments: { totalCount: comments },
  };
}

/**
 * The nine-item, five-alias payload of tests/fixtures/stub-gh/graphql-inbox.json
 * with live timestamps: eight items inside the default "Last month" window,
 * one (issue #300) well outside it, one (PR #200) that no section wants.
 */
function buildInboxFixture(): unknown {
  const pr51 = pr('controller-app', 51, 'Extract billing client', 'steve-sympower', 3, {
    comments: { totalCount: 1 },
    additions: 210,
    deletions: 88,
    ...rollup('FAILURE', [checkRun('SUCCESS'), checkRun('FAILURE'), statusContext('SUCCESS')]),
  });
  const pr60 = pr('flex-portal', 60, 'Migrate flex-portal to the shared auth client', 'maria-sympower', 3);
  const pr70 = pr('flex-portal', 70, 'WIP: auto-scale the operating envelope axis', 'SymJavi', 3, {
    isDraft: true,
    reviewDecision: null,
    ...rollup(null, []),
  });
  const pr80 = pr('flex-portal', 80, 'Explain the one year cap on custom revenue date ranges', 'SymJavi', 3, {
    reviewDecision: 'CHANGES_REQUESTED',
    comments: { totalCount: 2 },
  });
  const pr90 = pr('flex-portal', 90, 'Add release notes generator', 'SymJavi', 3, {
    reviewDecision: 'APPROVED',
    ...rollup('SUCCESS', [checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS')]),
  });
  const pr100 = pr('flex-portal', 100, 'Filter ActivationScheduleUpdated by activationProvider', 'SymJavi', 3, {
    ...rollup('PENDING', [statusContext('PENDING'), checkRun(null, 'IN_PROGRESS')]),
  });
  const issue12 = issue('msa-resource-bff', 12, 'Rate limit returns 500', 'erkki-sympower', 3, 3);
  const pr200 = pr('other-repo', 200, 'Bump shared tooling to node 22', 'renovate[bot]', 1);
  const issue300 = issue('old-repo', 300, 'Legacy exporter drops trailing rows', 'someone-else', 200, 7);
  return {
    data: {
      direct: { nodes: [pr51] },
      team: { nodes: [pr51, pr60] },
      authored: { nodes: [pr70, pr80, pr90, pr100] },
      assigned: { nodes: [issue12] },
      involved: { nodes: [pr70, issue12, pr200, issue300] },
    },
  };
}

/** The spec's five default actions, with readable ids so the test can name them. */
const DEFAULT_ACTIONS = [
  {
    id: 'review',
    name: 'Review',
    appliesTo: ['pr'],
    prompt: 'Review the changes and summarise your findings before writing any review comments.',
  },
  {
    id: 'address-review',
    name: 'Address review',
    appliesTo: ['pr'],
    prompt:
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
  },
  {
    id: 'fix-ci',
    name: 'Fix CI',
    appliesTo: ['pr'],
    prompt: 'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
  },
  {
    id: 'implement',
    name: 'Implement',
    appliesTo: ['issue'],
    prompt: 'Investigate it and propose a plan before changing anything.',
  },
  {
    id: 'triage',
    name: 'Triage',
    appliesTo: ['issue'],
    prompt: 'Reproduce, label the severity, and comment your findings. Do not change code.',
  },
];

const SECTION_DEFAULTS = {
  'needs-your-review': 'review',
  'needs-team-review': 'review',
  'needs-action': 'address-review',
  waiting: 'fix-ci',
  issues: 'implement',
};

/**
 * Seed a provider-bound v7 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test (PROFILE_SUFFIX), so
 * the file must land there. Shape per B's v7 contract -- if the on-disk field
 * names drifted, fix this seed against src/shared/workspace.ts.
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
        version: 7,
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
            provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
            actions: DEFAULT_ACTIONS,
            sectionDefaults: SECTION_DEFAULTS,
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
  id?: string;
  name?: string;
  workItem?: { provider: string; repo: string; type: string; number: number };
  workItemAction?: string;
  cwd?: string;
  scopeId?: string;
  kind?: string;
}

interface SeededAction {
  id: string;
  name: string;
}

function readState(stateFile: string): { sessions: SeededSession[]; actions: SeededAction[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      sessions: parsed.workspaces?.[0]?.sessions ?? [],
      actions: parsed.workspaces?.[0]?.actions ?? [],
    };
  } catch {
    return { sessions: [], actions: [] }; // mid-write; the poll comes back
  }
}

const sessionsIn = (stateFile: string) => readState(stateFile).sessions;
const sessionsOn51 = (stateFile: string) =>
  sessionsIn(stateFile).filter((session) => session.workItem?.number === 51);

/** Open the Inbox from the sidebar, select PR #51's row, and hand back the pane. */
async function openPaneFor51(page: Page): Promise<Locator> {
  await page.locator('.sidebar-inbox-row').click();
  const row = page.locator(`[data-work-item-key="${PR51_KEY}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const pane = page.locator('.inbox-pane-slot');
  await expect(pane).toBeVisible();
  return pane;
}

/**
 * Click a pane action and, if the pane asks first because another session on
 * the item is busy, say "Start anyway". Whether it asks depends on what the
 * earlier session's terminal is doing on this machine, so both answers are
 * correct here; the assertion that matters is the record that follows.
 */
async function startAction(pane: Locator, actionId: string): Promise<void> {
  await pane.locator(`[data-action-id="${actionId}"]`).click();
  const confirm = pane.getByRole('button', { name: /Start anyway/ });
  const asked = await confirm.waitFor({ state: 'visible', timeout: 1_500 }).then(
    () => true,
    () => false
  );
  if (asked) await confirm.click();
}
```

- [ ] **Step 2: The test body — sections, views, filters, two launches, a link, a rename**

Continue the same file:

```ts
test('sections, views and filters render; actions, links and renames flow through the pane', async () => {
  test.setTimeout(240_000);

  const userDataDir = createProfileDir();
  const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-'));
  const repoDir = path.join(cloneRoot, 'controller-app');
  initClone(repoDir);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-worktrees-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-fixture-'));
  const fixturePath = path.join(fixtureDir, 'graphql-inbox.json');
  fs.writeFileSync(fixturePath, JSON.stringify(buildInboxFixture(), null, 2));
  seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');

  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({
      userDataDir,
      env: {
        CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
        CONSOLA_WORKTREES_DIR: worktreesDir,
        GRAPHQL_INBOX_FIXTURE: fixturePath,
        PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    app = launched.app;
    const { page } = launched;

    // "Bind" is a seeded bound workspace, held through the real switcher UI
    // (windows.spec.ts precedent: a raw IPC call would not update what the
    // window renders).
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /Sympower/ }).click();

    const inboxRow = page.locator('.sidebar-inbox-row');
    await expect(inboxRow).toBeVisible({ timeout: 10_000 });
    await inboxRow.click();

    // --- Sections, with the default "Last month" filter: seven sectioned
    // items, one per section; PR #200 has no section, issue #300 is too old.
    const tabCount = (id: string) => page.locator(`[data-testid="inbox-tab-${id}"] .inbox-view-tab-count`);
    await expect(tabCount('inbox')).toHaveText('7', { timeout: 15_000 });
    for (const section of SECTIONS) {
      await expect(
        page.locator(`[data-testid="inbox-section-${section}"] .inbox-section-count`)
      ).toHaveText('1');
    }
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
    await expect(page.locator('[data-work-item-key="github:sympower/other-repo:pr:200"]')).toHaveCount(0);
    // The sidebar badge is the sectioned count too.
    await expect(page.locator('.sidebar-inbox-count')).toHaveText('7');

    // Collapsed by default: the team-review section shows its count, not its row.
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toHaveCount(0);
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toBeVisible();
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toHaveCount(0);

    // The gear opens Workspace Settings for this workspace (Phase A's door).
    await page.locator('.inbox-settings-button').click();
    const settingsFromGear = page.getByRole('dialog', { name: 'Sympower' });
    await expect(settingsFromGear).toBeVisible();
    await settingsFromGear.getByRole('button', { name: 'Close' }).click();
    await expect(settingsFromGear).toBeHidden();

    // --- Views: Involves me is everything in the window, sections or not.
    await page.locator('[data-testid="inbox-tab-involved"]').click();
    await expect(tabCount('involved')).toHaveText('8');
    await expect(page.locator('[data-work-item-key="github:sympower/other-repo:pr:200"]')).toBeVisible();
    await expect(page.locator('[data-work-item-key="github:sympower/old-repo:issue:300"]')).toHaveCount(0);

    // --- Updated filter: "Any time" lets the six-month-old issue through.
    await page.locator('.inbox-updated-filter-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Any time' }).click();
    await expect(page.locator('.inbox-updated-filter-trigger')).toContainText('Any time');
    await expect(tabCount('involved')).toHaveText('9');
    await expect(page.locator('[data-work-item-key="github:sympower/old-repo:issue:300"]')).toBeVisible();
    // The old issue has no section, so the Inbox tab is unchanged by it.
    await page.locator('[data-testid="inbox-tab-inbox"]').click();
    await expect(tabCount('inbox')).toHaveText('7');

    // --- Repository filter: one repo ticked leaves one row; unticking restores
    // the four rows the expanded sections show (three sections stay folded).
    await page.locator('.inbox-repo-filter-trigger').click();
    const controllerApp = page.getByRole('menuitemcheckbox', { name: 'sympower/controller-app' });
    await controllerApp.click();
    await expect(page.locator('.inbox-row')).toHaveCount(1);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
    await expect(tabCount('inbox')).toHaveText('1');
    // The menu stayed open across the tick; untick and dismiss it.
    await controllerApp.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox-row')).toHaveCount(4);
    await expect(tabCount('inbox')).toHaveText('7');

    // --- Start "Review" from the pane: worktree first, record second, spawn third.
    const row51 = page.locator(`[data-work-item-key="${PR51_KEY}"]`);
    await row51.click();
    const pane = page.locator('.inbox-pane-slot');
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-action-id="review"]')).toBeVisible();
    await expect(pane.locator('.inbox-pane-session-row')).toHaveCount(0);
    await startAction(pane, 'review');

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
    const [first] = sessionsIn(stateFile);
    expect(first.workItem).toMatchObject({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(first.workItemAction).toBe('Review');
    expect(first.cwd).toBe(worktree);
    expect(first.scopeId).toBe('scope-controller');
    expect(first.kind).toBe('interactive');

    // The launch activated the session and closed the Inbox; back in, the
    // pane lists the one session and the row hints at it.
    const paneAfterFirst = await openPaneFor51(page);
    await expect(paneAfterFirst.locator('.inbox-pane-session-row')).toHaveCount(1);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"] .inbox-row-sessions`)).toContainText(
      '1 session'
    );

    // --- A second action on the same item mints a second session in the
    // same worktree -- one worktree per item, shared.
    await startAction(paneAfterFirst, 'fix-ci');
    await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(2);
    const [a, b] = sessionsIn(stateFile);
    expect(a.id).not.toBe(b.id);
    expect(a.cwd).toBe(worktree);
    expect(b.cwd).toBe(worktree);
    expect(sessionsIn(stateFile).map((session) => session.workItemAction).sort()).toEqual([
      'Fix CI',
      'Review',
    ]);

    const paneAfterSecond = await openPaneFor51(page);
    await expect(paneAfterSecond.locator('.inbox-pane-session-row')).toHaveCount(2);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"] .inbox-row-sessions`)).toContainText(
      '2 sessions'
    );

    // --- Link a hand-made session from the sidebar. The `+` on the scope row
    // creates "New Session" and activates it; its row's menu offers the link.
    await page.getByRole('button', { name: 'New session in controller-app' }).click();
    const plainRow = page.locator('.session-nav-item', { hasText: 'New Session' });
    await expect(plainRow).toBeVisible({ timeout: 10_000 });
    await plainRow.hover();
    await plainRow.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Link to work item…' }).click();
    const linkDialog = page.getByRole('dialog');
    await expect(linkDialog).toBeVisible();
    // verify at execution: LinkSessionDialog's activation gesture per C's plan --
    // Enter on the highlighted row of the SearchableList, or a confirm button.
    await linkDialog.getByRole('textbox').fill('Extract billing client');
    await linkDialog.getByRole('textbox').press('Enter');
    await expect.poll(() => sessionsOn51(stateFile).length, { timeout: 15_000 }).toBe(3);
    const linked = sessionsOn51(stateFile).find((session) => session.workItemAction === undefined);
    expect(linked?.name).toBe('New Session');
    expect(linked?.cwd).toBeUndefined(); // linking never moves a session
    await expect(linkDialog).toBeHidden({ timeout: 10_000 });

    const paneAfterLink = await openPaneFor51(page);
    await expect(paneAfterLink.locator('.inbox-pane-session-row')).toHaveCount(3);
    await expect(paneAfterLink.locator('.inbox-pane-session-row', { hasText: 'New Session' })).toHaveCount(1);
```

Continue the same test body:

```ts
    // --- Rename an action in Workspace Settings (top-bar menu door). The
    // pane's button follows the record; the launched session keeps the name
    // it was started under, because workItemAction is a snapshot.
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    const settings = page.getByRole('dialog', { name: 'Sympower' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Actions' }).click();
    // verify at execution: ActionsPanel's name field and commit gesture per C's
    // plan -- an always-rendered input per action (value attribute follows the
    // controlled value) committed on Enter/blur, as InlineRename does.
    const reviewName = settings.locator('input[value="Review"]');
    await expect(reviewName).toBeVisible();
    await reviewName.fill('Deep review');
    await reviewName.press('Enter');
    await expect
      .poll(() => readState(stateFile).actions.find((action) => action.id === 'review')?.name, {
        timeout: 10_000,
      })
      .toBe('Deep review');
    await settings.getByRole('button', { name: 'Close' }).click();
    await expect(settings).toBeHidden();

    const paneAfterRename = await openPaneFor51(page);
    await expect(paneAfterRename.locator('[data-action-id="review"]')).toContainText('Deep review');
    await expect(paneAfterRename.locator('[data-action-id="review"]')).not.toContainText(/^Review$/);
    // The contrast: the live list says Deep review, the first session still says Review.
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Review' })
    ).toHaveCount(1);
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Fix CI' })
    ).toHaveCount(1);
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'Deep review' })
    ).toHaveCount(0);
    expect(sessionsOn51(stateFile).map((session) => session.workItemAction).sort()).toEqual([
      'Fix CI',
      'Review',
      undefined,
    ]);

    // Escape closes the pane and nothing else.
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox-pane-slot')).toHaveCount(0);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
  } finally {
    // Guaranteed even if an assertion above throws: a mid-test failure must
    // not leave a real Electron process running for the rest of the worker,
    // nor leave its profile/clone/worktree/fixture directories behind in the
    // OS temp dir forever.
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(cloneRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
```

(The launched sessions' terminals will try to spawn the real harness binary after each record lands; whether that spawn succeeds is irrelevant to every assertion above — worktree and record exist before any spawn, and `startAction` tolerates either answer to the concurrency confirm.)

- [ ] **Step 3: Build and run the spec**

Run: `npm run build && npx playwright test tests/e2e/inbox.spec.ts`
Expected: `1 passed`. If it stops at one of the three `verify at execution` points (the link dialog's activation gesture, the Actions panel's name field, or the pane's two selectors), read the component C shipped and adjust the one locator or gesture — the assertion that follows each is the contract, not the gesture.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npx playwright test tests/e2e/inbox.spec.ts tests/e2e/workspace-settings.spec.ts tests/e2e/sidebar.spec.ts`
Expected: all green (`tests/e2e/terminal.spec.ts` is excluded by design; it fails standalone on main).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/inbox.spec.ts
git commit -m "test(e2e): the Inbox v2 flow end to end against the stub gh

Sections with their counts, the five views, both filters, two actions
on one item sharing a worktree, a hand-made session linked from the
sidebar, and an action renamed in Workspace Settings showing up in the
pane while the launched session keeps its snapshot label. The fixture
is generated at run time with live timestamps so the default Last
month filter behaves the same on any day.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design notes — resolved ambiguities (recorded so executors do not re-litigate)

1. **Fixture and parser change in one task (Task 2).** B's parser tests read the canned fixture under B's three alias names; the new parser reads only the five new ones. Splitting them would leave `npm test` red between tasks, which the standing requirement forbids. The task is large but atomic.
2. **`STUB_GH_ARGV_LOG` is a deliberate addition** beyond the one-line `GRAPHQL_INBOX_FIXTURE` override the contracts name. Without it the driver's argv can only be asserted by mocking `child_process`, which would prove nothing about the subprocess boundary. The knob is opt-in and inert in production paths. If B's `GitHubDriver.test.ts` already carries an argv-capture mechanism of its own, Task 3's test reuses that mechanism instead — the assertions stay.
3. **`WorkItemStrip`'s cleanup lives in Task 5, not Task 4.** Ruling D.1 keeps "`worstStatus` + the strip import cleanup" together; here the strip edit moves one task later because it deletes `dotClassFor`'s last consumer, and deleting an export in the same commit as its consumer is the only way to keep typecheck green.
4. **Escape handling is `defaultPrevented`-gated, not `stopPropagation`-chained.** Radix's dismissable layer calls `preventDefault()` on an Escape it consumes from a capture-phase document listener; the Inbox's window listener checks that flag. C's `stopPropagation` guard on `CloneDialog` stays as documentation of the rule, and no menu or dialog in this phase needs its own.
5. **Counts follow the filters; the sidebar badge does not.** Tab and section counts are computed after `filterByUpdated`/`filterByRepos` so a tab never promises more rows than it lists. The sidebar badge is `itemsForView(items, 'inbox').length` over the raw cache because the sidebar has no filter context.
6. **`metaLineFor`/`roleLabelFor` survive** (reading `roles`) because the strip still shows the meta line; only `dotClassFor` and the `.inbox-dot--*` classes retire.
7. **The static fixture keeps fixed dates; the e2e generates its own.** The parser tests want determinism; the Updated filter wants recency. One shape, two timestamp policies.
8. **Repo menu items are labelled `owner/name`, rows show `name#n`.** An unscoped binding can span owners, so the menu is unambiguous; the row follows the mockup's brevity.
9. **"Involves me" = every cached item.** Every item exists because some search returned it; the spec's "any role" is satisfied by the cache itself, and the no-section item the spec calls out lands exactly there.
10. **`checks.total` comes from `totalCount`,** so a PR with more than a hundred contexts reads `passed/total` honestly even though only the first hundred are classified — an accepted approximation the parser comment records.

## Self-review

Performed against the spec's "Inbox data", "Inbox view (layout B)", "Error handling" and the E2E flow, and against the contracts' Phase D rulings, before hand-off:

- **Spec coverage.** Fetch — five aliases, `first: 50`, `is:open archived:false`, org scoping, the extended fragment, role merge with team-suppressed-by-direct, check-count derivation (Tasks 2–3). Sections — consumed from B, grouped in display order with per-section, per-workspace collapse seeded from `DEFAULT_COLLAPSED_SECTIONS` (Tasks 1, 10, 12). Views — five tabs with counts, flat views newest first, Involves me as the whole cache (Tasks 1, 9, 12). Filters — repos multi-select and Updated with the spec's labels and `month` default, client-side before sectioning, persisted per workspace, stale selections clamped (Tasks 6–8, 12). Layout B — header (title, filters, account/org, staleness, refresh, settings door), tab strip, lean rows with type icon, `repo#n · author · age`, worst-status dot and session count, review state, checks, comments, the direct-request accent bar, greyed uncloned rows; row click toggles the pane, `Escape` closes it, C's pane in `.inbox-pane-slot` with props `{ workspace, item, onClose }` only (Tasks 10–13). Error handling — the header's labelled staleness, the parser's throw on a malformed top level, the driver propagating it (Tasks 2, 3, 11). Testing — the unit bullets for the parser (role merging, check derivation), the view filters, and the E2E flow step for step including the action-rename contrast (Tasks 1, 2, 14).
- **Contracts rulings 1–7.** No `sectionFor`/`INBOX_SECTIONS`/`DEFAULT_COLLAPSED_SECTIONS` or `statusDots.css` created here (1); pane props untouched (2); `inboxViews.ts` exports exactly `InboxViewId`, `INBOX_VIEWS`, `itemsForView`, `groupBySection` (3); five-alias query, merge, checks, `reviewDecision` normalisation, fixture override, nine-item fixture, runtime relative-date fixture (4); `settingsStore.inboxFilters` with `sanitizeInboxFilters`, pure helpers in `inboxFilters.ts` (5); the named components, test ids and classes, two-column body, sidebar count (6); the e2e rewritten with every selector the ruling lists (7).
- **Placeholder scan.** Every step carries its code or its exact command. The "verify at execution" points are all reads of B/A/C's output the tree will answer: B's binary-resolver name inside `fetchInbox`, B's `fetchInbox` test to replace, the post-B form of the sidebar selector, C's strip JSX around the deleted dot, C's pane selectors and dialog guard, C's `statusDots.css` path, the link dialog's activation gesture, and the Actions panel's name field. Each names the required behaviour so the executor adjusts a locator, never a design.
- **Name consistency.** `InboxSearchAlias`/`INBOX_SEARCH_ALIASES`/`searchStrings`/`parseInboxPayload` are identical in Tasks 2, 3 and 14's fixture shape; `InboxUpdatedFilter`/`InboxFilterState`/`DEFAULT_INBOX_FILTER`/`UPDATED_FILTER_LABELS` are defined once (Task 6) and imported by Tasks 7, 8, 11, 12; `worstStatus` (Task 4) feeds `worstStatusForItem` (Task 5) which feeds `InboxRow` (Task 10); `itemsForView`/`groupBySection` (Task 1) are used identically in Tasks 12 and the sidebar; every `data-testid`, class and `aria-label` the e2e (Task 14) drives is produced by Tasks 8–12 or named by the contracts for C's pane; `workItemKey` values in the e2e (`github:sympower/controller-app:pr:51`) match B's lower-cased key format.
