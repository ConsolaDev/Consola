---
date: 2026-08-27
topic: "Tracks (cross-system work relations), Connections, and declarative integration manifests (Jira first) for the local side of Consola Factories"
status: explored — design direction agreed in conversation, final confirmations pending; nothing implemented
builds_on: docs/north-star/consola-factories.md
artifact: https://claude.ai/code/artifact/2b05a5b5-ca41-4b15-94a4-4f7204e6860d (interactive version with mockups and diagrams)
tags: [research, tracks, integrations, jira, linear, slack, acli, mcp, inbox, manifests]
---

# Tracks, Connections, and Integration Manifests

This document records the 2026-08-27 exploration of the **local** half of Consola
Factories: how to see tickets (Jira first) next to the GitHub Inbox, start
sessions from them, relate every artefact of a piece of work (ticket ↔ session ↔
PR ↔ Slack thread ↔ cloud run) in one visible place, and let users add vendor
integrations without Consola hardcoding each one. It extends
`docs/north-star/consola-factories.md`; the invariants there apply throughout.

## The aim, in the user's words

Relate sessions to SDLC workflows — a Jira ticket that relates to a Claude Code
session that relates to a GitHub PR, with Slack conversations in the mix — and
have a visual way to track it inside the app, instead of the current mental
effort of remembering which session belongs to which ticket and which PR.
Integrations and feeds are the plumbing; **the relation is the product**.

Guiding principle (user-stated, adopted): **the session is the actor; Consola
only links things and hands the session the right context.** Consola stays
read-only against every vendor — writes to a ticket, a PR or Slack happen
inside the session through the vendor's CLI or MCP. (This generalises the
Inbox v2 rule "the UI is read-only against GitHub".)

---

## 1. Tracks: the first-class relation

Today the entire relation graph is `Session.workItem` (one session → one GitHub
item). The new primary entity:

- **`ItemRef`** generalises `WorkItemRef` to `{ provider, type, key }`:
  `github:pr:sympower/payments#4131`, `linear:issue:SYM-4127`,
  `jira:issue:PAY-88`, `slack:thread:C0123/1724…`. One shape for every
  connected system; `sameWorkItem`/`workItemKey` become trivial; one state
  migration (v8).
- **`Track`** = `{ id, anchor: ItemRef, items: [{ ref, role, attachedBy:
  'rule' | 'vendor' | 'person' | 'automation' }], scopeId?, createdAt }`.
  Sessions and Runs point at a Track (replacing the bare `Session.workItem`,
  which becomes "the item this session was started from" within the Track).
  Groups remain manual containers.
- **The anchor is the identity.** Track id = anchor key; the anchor is the
  ticket when there is one (else the PR, else the session). Two machines —
  local and cloud, or two people — computing "the Track for SYM-4127" agree
  without coordination. A cloud Run whose `trigger.ref` is that ticket lands
  on the same Track as the local session for it.
- **Stage is derived, never stored**: Triage · Spec · Implement · Review ·
  Verify · Ship, computed from attached items' states (ticket open + no
  session → Triage; session working or branch → Implement; PR open → Review;
  checks → Verify; merged + ticket done → Ship). Nothing can drift.
- **Re-anchoring rule**: a PR-anchored Track merges into the ticket's Track
  the moment a ticket link appears — the ticket always wins as anchor, items
  move over, sessions are redirected, `attachedBy: 'person'` links survive.

### How items find their Track (correlation)

| Edge | Rule | Declared in |
|---|---|---|
| Ticket ↔ PR / branch | Ticket key (`[A-Z]+-\d+`) in a PR's branch, title or body; or the vendor's own attachment (Linear's GitHub integration, Jira's dev panel, "Closes #45") | Tracker manifest `correlate.key_pattern` / `branch_pattern`; git manifest says which fields to scan |
| Session ↔ item | Existing link, set at launch or "Link session" | Built in (exists) |
| Session ↔ PR | Worktree branch = PR head ref | Built in (WorktreeService knows the branch; Inbox knows the head) |
| Run ↔ item | `Run.trigger.ref`; write actions attach the branch/PR they produce | Built in (Run record) |
| Slack thread ↔ Track | A ticket/PR link in the message; or the thread is where `ask-in-slack` was asked (attached at Run creation) | Slack manifest `correlate.links` |
| Anything ↔ anything | "Link…" / Unlink; person links never overridden by rules | Built in |

### Linking gestures (UI)

- **Start from an Inbox row** (any connection, not just GitHub) → session
  attaches to the row's Track, creating it if absent. Same gesture as today.
- **Start from a Track** → "Run action…", session gets the whole Track as
  context.
- **Link a hand-made session** → search all connections' cached feeds, or
  **paste any URL** — the manifest's `url_pattern` parses it into an ItemRef.
  Also in the command palette ("Link this session to…").
- **Triggered runs** attach automatically via `trigger.ref`.
- **Background correlation** on every poll (branch↔head, key scanning).
- **Agent-side (optional, follow-up)**: a small Consola MCP (conductor
  `consola_*` pattern) with `track_attach(url)` and `track_note(text)` so a
  session can link instantly and leave a summary for the next session on the
  Track. Deferred from the first slice; polling correlation covers the common
  case.

### What a session receives

1. **Seed header rendered from the Track**, not one item: anchor (key, title,
   URL), attached PRs, Slack threads, branch, one-line summaries of previous
   runs, plus per-provider "how to reach it" lines from each manifest
   (`gh pr view 4131`; `acli jira workitem view PAY-88 --json`; the Slack MCP).
2. **MCP servers / CLIs** of the workspace's Connections merged into
   `--mcp-config` / available on PATH.
3. **A place to work.** A ticket names no repo. Rule: the Track's PR's repo →
   the action's pinned `scope` → **ask once and remember on the Track**
   (`Track.scopeId`). The worktree branch carries the key
   (`pay-88-retry-backoff`, from the manifest's `branch_pattern`) — the single
   convention that makes the PR link itself later.
4. **Optional doorbells**: short `[track:attached:github:pr:#4131 ci=failing]`
   lines through the existing prompt FIFO (delivery guard untouched), off by
   default per action.

### What Tracks buy automations

- Triggers about the work, not one system's event:
  `track: stage.changed(review)`, `track: pr.merged`.
- Seed placeholders `{{track.ticket.url}} {{track.pr.url}} {{track.slack.url}}`.
- The Runs view, Inbox and sidebar gain a Tracks lens; sidebar sessions are
  labelled by anchor (`PAY-88 · Implement`).

---

## 2. Integrations: Connections + declarative manifests

### Reframe: four capabilities, one needs no code

| Capability | Meaning | Owner |
|---|---|---|
| **Act** | Comment, transition, create, link — inside a session | The agent, via the vendor's **CLI when one exists** (`gh`, `acli`), else its **MCP server** (Linear, Slack). Consola never implements a vendor write API |
| **Feed** | "What's mine / needs me" → Inbox | Consola, described per vendor by a manifest |
| **Correlate** | Fetched items snap onto Tracks | Manifest rules (key/branch/link patterns) |
| **Events** | Feed diffs → triggers (`issue.assigned`, `issue.transitioned(...)`, `review_requested`) | Uniform poll-diff-dedupe engine; manifest declares which transitions emit what. Same trigger vocabulary as cloud webhooks |

A **Connection** is the workspace record tying these together:
`{ provider, cli?/mcp?, credentialRef?, feed enabled, … }`. The Workspace
Settings "Provider" tab becomes "Connections".

### Extensibility options considered

| Option | Verdict |
|---|---|
| A. Code drivers per vendor (status quo `GitProviderDriver`) | Kept **only** for git mechanics (checkout/clone/remote-match) — code because git is code |
| B. **Declarative manifests** (YAML + JSONata mapping) | **Chosen** for feeds/correlation/events/UI shape; built-ins ship as the same YAML users write |
| C. Subprocess plugins (JSON-RPC over stdio, MCP-like) | Escape hatch, only when a real vendor exceeds the schema; not before |
| D. Consola as MCP client for feeds | Rejected as primary: tool outputs are prose-shaped, polling through MCP is heavy; MCP stays the *acting* path where no CLI exists |
| E. Agent-defined feeds (`claude -p --json-schema` + vendor MCP on a schedule) | Escape hatch for long-tail vendors; token cost per poll |

### Who maintains a manifest (answer to "is it only us?")

Four tiers, resolved by `id`, more specific wins:

1. **Built-in** — shipped in Consola (GitHub, Jira, Linear, Slack), updated
   with the app, visible as plain YAML (the template for the rest).
2. **Personal** — `~/.consola/integrations/*.yml`; override a built-in or add
   an unknown vendor.
3. **Org** — `<org>/.consola/integrations/*.yml`, distributed through the same
   channel as company automations: everyone who binds the org gets the
   company's Jira site, JQL views and branch convention with zero setup.
4. **Community** (later) — install by URL, pinned by content hash.

Every manifest has `schema_version`; Settings → Connections surfaces
validation errors per manifest. Consola-developer-only surface: the engine
(manifest schema, JSONata evaluator, git mechanics, credential resolvers).

### Credentials

Preference order per vendor:

1. **The vendor's CLI keyring** — Consola holds nothing (`gh`; now `acli`).
2. **Credential references**, resolved in main, never stored as values, never
   on IPC: `env:VAR`, `keychain:<service>/<account>` (macOS `security`),
   `op://vault/item/field` (1Password CLI), `safeStorage:<id>` as fallback.
3. MCP OAuth is the MCP server's business (acting path only).

---

## 3. The ticket workflow next to the GitHub one

Two mental models, deliberately kept distinct, tied together by Track chips:

- **GitHub view = reactive**: needs your review · your PRs · assigned ·
  involves you (shipped Inbox v2, unchanged).
- **Ticket view = proactive**: what I'm supposed to be doing and how far along
  each piece is.

### Inbox structure

- Header gains a **connection strip**: GitHub · Jira · Linear · Slack ·
  **Tracks** (the cross-vendor lens). Each connection's view keeps that
  vendor's own shape ("the mental model transfers").
- **Jira view**: tabs = Jira's own filters (*Assigned to me · Reported by me ·
  Watching*, JQL in the manifest); sections by **status category**
  (`new`/`indeterminate`/`done` — universal across Jira projects) with a
  `review|qa` status-name regex splitting "In review" from "In progress".
- **Every row carries its Track's downstream state as chips**: `● session
  working`, `PR #4131 · review requested`, `cloud triage commented`, `no
  session yet`. The same PR appears in the GitHub view with a `PAY-91` chip;
  both rows open the same Track pane.

### Starting a session from a ticket

1. Action: section default (To do → *Plan*, In progress → *Implement*, In
   review → *Address review*) as primary button; "Start with…" lists the rest
   incl. repo `factory.yml` actions with `applies_to: jira.issue`.
2. Scope: Track's PR repo → action's pinned scope → ask once, remember on the
   Track (scope-picker modal).
3. Worktree on a key-carrying branch (`pay-88-retry-backoff`).
4. Seed with ticket + Track + manifest instruction line (read via `acli`; put
   the key in the PR title; don't transition unless asked).
5. Sidebar label `PAY-88 · Implement`.

The PR then attaches with no extra work (branch = head, or key in title, next
poll), or manually via Link…/paste-URL.

---

## 4. Jira specifics: ACLI first (verified 2026-08-27)

Decision: prefer **`acli`, Atlassian's official CLI**, over the Atlassian MCP —
it makes Jira the same shape as GitHub (Consola coordinates a CLI, holds no
credential). Verified against developer.atlassian.com/cloud/acli:

- `acli jira workitem search --jql "…" --json --fields … --limit --paginate`
  (also `--csv`, `--count`, `--filter <id>`); default fields
  `issuetype,key,assignee,priority,status,summary`.
- `acli jira workitem view KEY-123 --json --fields …` (`*all`, `*navigable`,
  `-field` exclusion supported).
- Acting: `create`, `create-bulk`, `edit`, `transition`, `comment-create`,
  `comment-list`, `assign`, `link`, `attachment-*`, `clone`, `archive`.
- Auth: browser OAuth `acli jira auth login --web`; non-interactive (CI/cloud
  runner): `echo "$TOKEN" | acli jira auth login --site X --email Y --token`;
  `auth status`, `auth logout`, `auth switch --site/--email` (multiple stored
  accounts). Command groups also cover `jira board/sprint/project/filter/
  dashboard/field`, `admin`, and `rovodev`.

**Caveats recorded:**
- No `gh auth token` equivalent → Consola cannot borrow a per-account token
  and layer it per spawn; `auth switch` is global. Two Jira accounts on one
  machine ⇒ second account uses the REST fallback with a credential reference
  (preserves the "two accounts at once" rule).
- Each ACLI release is supported ~6 months → built-in manifest pins argv;
  probe checks version.
- On the cloud runner, the environment image installs `acli` and logs in
  non-interactively with the company bot token.

Fallback chain for the Jira feed: `cli` (acli) → `rest`
(`/rest/api/3/search` + JQL, Basic email+API token via credential ref; PAT
bearer on Data Center). Atlassian MCP (`https://mcp.atlassian.com/v1/sse`)
remains the acting alternative when `acli` is absent.

**Linear**: no official CLI → GraphQL feed with a credential reference, the
official Linear MCP for acting. **Slack**: an item type (thread permalink),
correlated by links / `ask-in-slack`; Slack MCP for acting; Socket Mode events
later.

### Sketch of the Jira manifest (full version in the artifact)

```yaml
schema_version: 1
id: jira
cli: { binary: acli, probe: [jira, auth, status], login_hint: "acli jira auth login --web" }
mcp: { url: https://mcp.atlassian.com/v1/sse }
item: { type: issue, key: "{{key}}", url_pattern: "https://{{site}}/browse/(?<key>[A-Z]+-\\d+)" }
views:
  assigned: { jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" }
  reported: { jql: "reporter = currentUser() AND statusCategory != Done" }
  watching: { jql: "watcher = currentUser() AND assignee != currentUser()" }
feed:                                   # first available source wins
  - cli: [jira, workitem, search, --jql, "{{view.jql}}", --fields, "key,summary,status,priority,assignee,reporter,updated", --json, --paginate]
    items: "$"                          # JSONata
    map: { title: summary, state: status.name, category: status.statusCategory.key, priority: priority.name, updatedAt: updated }
  - rest: { url: "https://{{site}}/rest/api/3/search", query: { jql: "{{view.jql}}" } }
    auth: { basic: { user: "{{email}}", token: "{{ref}}" } }
    items: issues
    map: { title: fields.summary, state: fields.status.name, category: fields.status.statusCategory.key, priority: fields.priority.name, updatedAt: fields.updated }
sections:                               # first match wins
  - { id: in-review,   when: "category = 'indeterminate' and $match(state, /review|qa/i)", stage: review }
  - { id: in-progress, when: "category = 'indeterminate'", stage: implement }
  - { id: to-do,       when: "category = 'new'", stage: triage }
events:
  issue.assigned:     { on: new-in-view, view: assigned }
  issue.transitioned: { on: section-changed }
correlate: { key_pattern: "\\b[A-Z][A-Z0-9]+-\\d+\\b", branch_pattern: "{{key | lower}}-{{slug}}" }
default_actions: { to-do: Plan, in-progress: Implement, in-review: Address review }
seed: |
  This session is for Jira issue {{key}} ("{{title}}", {{state}}). Start with
  `acli jira workitem view {{key}} --json`; act with `acli jira workitem comment-create` /
  `transition` / `edit`. You are on branch `{{branch}}`; put {{key}} in the PR title so it
  links back. Do not transition the ticket unless asked.
```

---

## 5. Proposed first local slice (pending confirmation)

`ItemRef` migration → Connections (CLI/MCP into sessions) → Jira manifest +
multi-connection Inbox (Jira view) → Track model + row chips + Track view →
the `review_requested → Review` personal trigger (from the north star's
personal-automations design) → personal recipes file + Export/Import profile.
Second manifest: Linear. Deferred: agent-side `track_attach`/`track_note` MCP,
Slack Socket Mode, community manifest registry, subprocess plugins.

## 6. Open confirmations (asked, not yet answered)

1. Track as the primary relation, anchored on the ticket, stage derived; the
   name "Track" itself.
2. Slack as an item type from the start.
3. Inbox = connection strip + per-vendor views + Tracks lens (vs one merged list).
4. Jira sections by status category + review regex; tabs = Jira's filters.
5. Scope rule (Track PR → action scope → ask-once-remember) + key-carrying
   branch convention.
6. Jira before Linear for the first local slice.
7. Re-anchoring rule (ticket always wins).
8. Agent-side Track MCP as follow-up, not first slice.

## Mockups and diagrams

The interactive artifact (link in the front matter) contains: the Track
relation diagram, the Track view mockup, the multi-connection Inbox with the
Jira view, the scope-picker modal, the GitHub-vs-Jira comparison, the manifest
tiers, and the full Jira manifest. If the artifact is ever lost, this document
is the recoverable source of record.
