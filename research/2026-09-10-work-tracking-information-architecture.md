---
date: 2026-09-10
status: proposal for review; no production behavior changed
builds_on:
  - research/2026-08-27-tracks-connections-integration-manifests.md
  - research/2026-08-27-plugin-system-design.md
  - docs/north-star/consola-factories.md
mockup: mockups/work-tracking/index.html
---

# Give the work a home beyond the Inbox

**Recommendation: add Work beside Inbox.** Work is the durable collection of Tracks; Inbox is the queue of changes and requests needing attention. Both open the same Track detail. Keep existing sessions accessible under Groups and Scopes, with a compact Track context panel when working in a terminal. Provider browsing lives under Work → Sources; connection setup stays in workspace settings.

The key distinction is lifetime: a notification can be handled in seconds, while the work it refers to may last weeks. Clearing an Inbox entry must never make its work disappear. Likewise, an active piece of work must remain easy to find even when none of its providers has a new update.

This is a design evaluation and staged proposal, not a user-tested conclusion or a replacement implementation spec. [Open the interactive mockups](mockups/work-tracking/index.html). They compare four navigation models and demonstrate the recommended Work, Inbox, Track detail, session context, and Sources screens with fictional data. No external services are called.

## What the original research gets right

- **The relationship is the product.** “Which ticket belongs to this session and PR?” is a better organizing question than “Which integration should I open?” Track should be a durable work record, with a clear outcome, relevant evidence, execution history, and next step.
- **Multiple entry points, shared context.** Starting from a ticket, PR, conversation, or hand-made session should converge on the same record. Search and paste-URL linking are essential.
- **Keep vendor facts recognizable.** Preserve native statuses, identifiers, links, and provider-specific actions. A GitHub review decision and a Jira ticket status should not become indistinguishable generic badges.
- **Reuse views and detail components.** Built-ins and plugins should contribute through consistent host-owned surfaces. This prevents each integration from creating a different app inside Consola.
- **Separate reading from acting.** Keep provider writes inside explicitly launched sessions/actions, as the existing product direction requires. Editing a local title, linking evidence, or acknowledging an Inbox signal is a Consola operation.
- **Keep local work useful offline.** A Track must retain its identity, saved links, notes, and session access when a connection expires.

The main gap is that the research spends more detail on integration plumbing than on recovering context, deciding what to do next, and finishing a piece of work.

## Why putting everything in Inbox is weak

The [Tracks exploration](2026-08-27-tracks-connections-integration-manifests.md#3-the-ticket-workflow-next-to-the-github-one) proposes a provider strip plus a Tracks lens. The subsequent [plugin design, section 5](2026-08-27-plugin-system-design.md#5-the-inbox-unification-critical-correction-adopted) makes this universal: every work-item view must render inside Inbox.

That preserves implementation consistency, but confuses three user intentions:

| Intention | Natural destination | What a row represents |
|---|---|---|
| What needs my attention? | Inbox | A request/change, with a reason to act |
| What am I trying to finish? | Work | A persistent unit of work |
| What exists in Jira or GitHub? | Work → Sources | A provider item, possibly not tracked |

A sprint board, an assigned backlog, and a Slack mention differ in expected lifetime, sorting, empty state, and dismissal semantics. Putting them into an Inbox makes “empty” ambiguous. A provider-first strip also requires the user to remember where something originated, recreating the fragmentation the product is meant to remove.

**One data model and view system does not require one navigation destination.** A row for a Track in Work and an attention row linked to that Track in Inbox are projections with different purposes, not duplicate records.

External patterns support this distinction, without proving it will work for Consola: Linear explicitly separates its notification [Inbox](https://linear.app/docs/inbox) from [My Issues](https://linear.app/docs/my-issues), a persistent view of relevant issues. GitHub Projects provides multiple table, board, and roadmap views over underlying work items, illustrating reuse of records across different views. [GitHub Projects documentation](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)

## Alternatives

| Model | Strength | Main cost | When it makes sense |
|---|---|---|---|
| A. Everything in Inbox | Smallest navigation change; familiar provider views | Mixes triage and ongoing work; tab growth; unclear clearing behavior | Short-term bridge for mostly GitHub review work |
| B. One Work hub, with Attention / Active / Sources inside | Coherent noun; compact sidebar; shared browsing context | Attention is less visible and competes with persistent views | Strong runner-up if users prefer one destination |
| **C. Inbox + Work** | Clear attention versus commitment; work survives triage; direct navigation | One extra destination; must explain why a Track appears in both | **Recommended for multi-day work across services** |
| D. Work-centric sidebar tree | Tickets and their sessions stay together during execution | Many Tracks crowd the sidebar; competes with Groups/Scopes; awkward shared artifacts | Optional future sidebar grouping for heavy session users |

Keep a relationship graph as an optional inspection tool, not the default navigation. It answers “how are these connected?” but is poor at showing the next actionable item in a busy workday. A board is another optional Work layout; there is no need to launch with both board and graph.

The mockup's comparison selector renders all four structures using the same example. It is meant to compare where work lives, not imply four implementations should ship.

## Recommended navigation and screen contract

```text
Workspace
├─ Inbox                 Attention / Snoozed / Handled
├─ Work                  Active / Waiting / Finished / Sources
│  └─ Track              Overview / Activity / Links
├─ Groups                Existing manual session containers
├─ Scopes                Existing repository/environment session access
└─ Workspace settings    Connections, actions, harnesses…
```

Default Work view: a compact list, one row per Track. Each row shows a readable outcome/title, preferred ticket key if present, **one specific next step**, essential provider/execution facts, and recency. Avoid a wall of every linked item's chip. Only Inbox receives an attention-count badge. Work counts belong in its own view. Remember the last destination per window; do not force Inbox to open every morning.

### Inbox: reasons to look, not a second backlog

Signals include review requested, a session waiting for input, a failed check relevant to your work, and a direct mention. Group signals for the same Track into one row, exposing the individual reasons inside. Untracked items can appear without creating a Track; the user can handle a one-off review or choose “Track this work.”

Opening a row marks it read but does not handle it. “Handled” acknowledges the current signal versions locally; “Snooze” delays those signals. Neither changes remote status, stops a session, or finishes a Track. A newer relevant event can resurface the row; polling the same failure cannot. A handled signal remains in Track activity. Persistent blockers stay visible in Work even when their notification is handled.

### Work: commitments and continuity

Active contains work explicitly tracked or started here, including local work without a ticket. Waiting is a filter over work with a recorded blocker or next actor; it does not infer “waiting” from every idle terminal. Finished is local shelving, distinct from provider completion. Sources lets users browse assigned Jira issues, authored GitHub PRs, or other provider views without committing to all of them.

Do not turn every fetched item into a Track. Create one on “Track this work,” on starting a session from an item, or on an explicit automation policy. Provider fetch size should not determine the size of the user's work list.

### Track: a durable work brief

The detail page should answer these in order:

1. **What outcome are we pursuing?** Title and short outcome/acceptance note. A ticket can supply the default; user-written text has a visible author and timestamp.
2. **What needs to happen next?** A concrete step and actor, supported by linked evidence: “Address rounding feedback in PR #4131,” not just “Review.” Suggestions are labelled; they do not silently replace a person's note.
3. **What is true now?** Native ticket/PR/check/session facts with freshness. Several states can coexist.
4. **Where do I continue?** Resume a specific session, or start an action with an explicit repository/environment and a reviewable context selection.
5. **What led here?** Decisions, handoffs, consequential provider events, and results of sessions/runs. Full transcripts and raw events remain expandable.

Overview includes a small set of relevant links grouped by purpose: definition (tickets/specs), implementation (branches/PRs), discussion (threads), execution (sessions/runs), evidence (checks/deployments). Links has the full set, roles, origin, and correction controls. Activity orders meaningful events; it is not the default replacement for the work brief.

Open a compact preview from lists, with “Open work” for the full page. Use a canonical Track route and preserve the originating list's filters, selection, and scroll on Back. A session's Track chip opens the same detail in a context rail without hiding the terminal. At narrower widths use a dismissible overlay or full detail page, not three compressed columns.

## Model assumptions to revise before implementation

| Research assumption | Failure case | Proposed correction |
|---|---|---|
| Track ID equals its ticket anchor | Work starts in a session; ticket changes; one outcome spans two tickets | Stable opaque Track ID; optional preferred/display item; change the display anchor without changing identity |
| Ticket always wins and triggers merging | A PR mentions an epic and a bug, or implements two independently tracked requests | Represent typed relationships; suggest a merge only for duplicate work, show affected links/sessions, preserve redirects and allow undo |
| `{provider,type,key}` identifies an item | `PAY-88` exists on two Jira sites; GitHub Enterprise and public GitHub share repo names | Canonical item identity includes provider instance/tenant and immutable remote ID when available; keep key/URL aliases and access connection separate |
| One stage is derived, so nothing can drift | One PR merged, another open; stale Jira status; QA running while implementation continues | Show independent lifecycle/execution/blocker facts with freshness; any rollup is a labelled interpretation, never the authority |
| Branch match or key mention means same work | Common branch names; incidental ticket mentions; a shared Slack thread | Scope branch matches to repository/fork and worktree; classify evidence; ambiguous correlations become suggestions |
| A Track has one scope | Frontend and API changes span repos, or several checkouts | Track can reference multiple scopes; each session/run has a concrete execution scope, with a remembered default when unambiguous |
| Feed disappearance means an event/state transition | Item leaves a search filter; pagination fails; permissions change | Cache fetched items independently from feed membership; disappearance means unknown visibility, never completion |
| Every context link belongs in every prompt | A broad discussion contains unrelated work or a long transcript | Build a bounded, source-labelled handoff; include relevant links and chosen summaries, fetch details on demand |

**Identity across machines is still a real requirement.** A UUID alone does not deduplicate independent creation. Initially promise workspace-local identity only. Later, a shared authority can atomically resolve or create a Track for an explicit primary-item binding, using scoped canonical item identities and retained aliases. Offline duplicate creation must reconcile as a suggested duplicate, not an automatic graph merge. Do not claim the original deterministic-ID guarantee survives this change for free.

Allow an artifact to relate to multiple Tracks: a shared PR or conversation should not force two outcomes into one. Store relation role (`implements`, `discusses`, `defines`, `blocks`, `reference`), provenance, evidence and disposition (`confirmed`, `suggested`, `rejected`). A session can retain one primary Track for launch/context while carrying references to other work. Track-to-Track dependencies are different from artifact membership. Linear's separate related, blocked, and duplicate relations are a useful precedent for keeping these meanings distinct. [Linear issue relations](https://linear.app/docs/issue-relations)

Explicit attachment and artifacts produced by a session can link immediately. Provider-declared relations retain their actual meaning; a generic “related” link does not imply ownership. Rejecting a suggestion records a suppression so the next poll does not recreate it. Unlinking a confirmed auto-link offers the same suppression. Every automatic link must be explainable.

Keep provider lifecycle as the source of truth. “Finished in Consola” is local organization, with a mismatch notice if a required ticket/PR is still open; it must not claim “shipped.” A deployment is not established merely by a merged PR. A verified new reopening/blocker on finished work should raise an attention signal; do not silently change the user's shelving choice. Ticketless Tracks remain valid and can be shelved manually.

## Integration and plugin consequences

Keep the existing single view registry idea, but make placement a host decision based on declared purpose and row entity. For example, `purpose: attention | collection | source`, `entity: signal | track | item`, plus query/layout. Attention contributions go to Inbox, collections to Work, provider views to Sources. The same renderer primitives, item cache, relation service, and Track detail serve all three. Plugins cannot invent competing Track stores or arbitrary top-level navigation.

This specifically proposes revising the plugin document's **“all item views live inside Inbox”** rule. It preserves consistent host rendering and shared actions. It does not require the plugin host, JSONata evaluator, community registry, or automation system to exist before validating Tracks.

Treat the August vendor/API findings as implementation hypotheses requiring a separate capability check before building adapters; this evaluation validates navigation precedents, not every CLI command. In particular, “MCP outputs are prose-shaped” is too broad a basis for rejecting it universally: MCP defines optional structured tool output. Feed suitability still depends on the actual server's querying, paging, authorization, and polling behavior. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)

A first integration should normalize identity, fetch-by-reference, display facts, freshness, and feed membership behind a small adapter contract. Add declarative manifests once at least two actual providers reveal which differences the schema must represent. Accept a generic URL attachment before supporting that provider's whole feed. Unsupported links remain useful as labelled references, with “Not synced” rather than fabricated metadata.

Credentials and sharing follow existing workspace boundaries. Do not silently join personal and company work because a URL matches. A newly attached Slack thread does not automatically become shareable context for a cloud run; selected context must respect the destination's access. This is a necessary cross-service handoff rule, not a new general permissions flow for viewing local Tracks.

## Build order and review gates

| Slice | Deliverable | Evidence needed before expanding |
|---|---|---|
| 0. Validate this prototype | Walk through Inbox, Work, detail, terminal context, and Sources | User can locate quiet work, explain Handled versus Finished, and resume the correct session |
| 1. Manual vertical slice | Stable Track store, Work list/detail, GitHub refs, generic URLs, session attach/resume, local outcome/next-step note | One real task connects a ticket URL, two sessions and a PR; no integration framework prerequisite |
| 2. Reliable linking and attention | Item cache, provenance/suppression, scoped correlation, durable signal acknowledgements; Inbox links to Track | Incorrect suggestion stays rejected; handling a signal leaves work accessible; stale providers never imply completion |
| 3. Second real provider | Jira read adapter and Sources view, connection health, ticket-to-session launch | One complete Jira → session → GitHub PR workflow; account/tenant identities remain distinct |
| 4. Continuity across executions | Bounded context preview, decision/handoff notes, multi-repo selection, Run attachments | A fresh session can continue without reconstructing the work from all source services |
| 5. Generalization | Manifest/view schema, saved views, optional boards, shared identity reconciliation | Repeated provider use cases justify the abstractions; board semantics do not introduce silent vendor writes |

At migration time inspect the then-current state version; do not assume the research's proposed v8 is still available. Preserve `Session.workItem` as launch provenance during transition. Idempotently group existing linked sessions by canonical item **within a workspace**, create one Track for each group, and retain legacy navigation until the new route works. Existing unlinked sessions need no forced Track. Replace the Inbox-only navigation flag with an explicit per-window destination while keeping terminal lifetime independent from whichever view is visible.

Likely implementation touchpoints, verified in the current checkout: `src/shared/workItems.ts` (GitHub-shaped reference), `src/renderer/components/Inbox/InboxItemPane.tsx` (single-item detail/session actions), `src/renderer/components/Sidebar/index.tsx` (Inbox + Groups + Scopes), `src/renderer/stores/navigationStore.ts` (`isInboxOpen`), and main-process persistence/launch authority. This proposal adds documentation and isolated mockups only; existing working-tree application changes are unrelated.

## How to assess the design with real work

Use the same real task in the recommended split and the one-Work-hub alternative; vary which is shown first. Test first-click destination, successful completion, wrong-session starts, and recovery from Back, rather than asking only which screenshot looks better.

- An assigned Jira ticket has no session. Find it, begin tracking, select its repository, and start planning.
- A GitHub review request appears for tracked work. Handle the notification, then find the unfinished work again.
- A quiet Track has no new events for three days. Find the last decision and resume the right session.
- One outcome spans an API PR and a web PR. Explain what is still unfinished after one merges.
- A Slack thread mentions two unrelated tickets. Reject the wrong suggestion and refresh.
- Jira is disconnected. Distinguish last-known facts from current local session status.
- A ticketless investigation becomes a bug ticket. Attach it without losing notes or changing the Track's identity.

Success hypotheses: people can explain where attention versus ongoing work lives without coaching; locate the next step and relevant evidence within roughly 30 seconds; and resume with fewer provider tabs and less manual prompt reconstruction. These are proposed validation targets, not measured results.

If users consistently hunt between Inbox and Work, choose alternative B (one Work hub with Attention as its first view). The durable Track, signal semantics, and shared detail remain the same; only navigation placement changes. That makes the first implementation useful even if this information-architecture recommendation changes after use.
