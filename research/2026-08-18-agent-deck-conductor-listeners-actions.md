# Agent-Deck Concepts in Consola: Conductor, Listeners, and Custom Actions

**Date:** 2026-08-18
**Status:** Research / design exploration — nothing here is implemented
**Prior art:** `research/2026-02-17-platform-architecture-migration-analysis.md` sketched a
`TriggerEngine`/`SchedulerService`/`SlackConnector` as a *separate future monorepo*. This document
takes the opposite stance: these capabilities can grow *inside* Consola incrementally, because
agent-deck proves the whole category needs far less machinery than that sketch assumed.

---

## 1. What agent-deck actually is

[agent-deck](https://github.com/asheshgoplani/agent-deck) is a Go/tmux TUI that manages fleets of
agent CLI sessions (Claude Code, Codex, Gemini, custom tools). It is philosophically identical to
Consola on the core point: **the CLI owns the conversation; the tool owns the surrounding
workspace.** It wraps binaries in tmux panes the way Consola wraps them in node-pty + xterm.

The three concepts worth stealing, and the key insight behind each:

### 1.1 Conductor — orchestration is a session, not an engine

An agent-deck conductor is **not** an orchestration engine. It is an ordinary Claude session,
pinned in a named tmux pane, whose "intelligence" is five markdown/JSON files in a directory:

```
conductor/<name>/
├── CLAUDE.md      # startup instructions (scope, what agents it supervises, reading order)
├── POLICY.md      # auto-respond rules vs "escalate to human" rules — user-editable
├── LEARNINGS.md   # append-only institutional memory
├── state.json     # working memory that survives context compaction
└── task-log.md    # append-only audit trail
```

The host app provides only *plumbing*:

- `session send <name> "msg"` — deliver a message into a session's composer
- `session output <name>` — read what a session's screen shows
- status polling (running ● / waiting ◐ / idle ○ / error ✕) per child session
- a heartbeat timer (launchd/systemd) that pings `[HEARTBEAT]` on a schedule
- a **durable inbox** (`inboxes/<id>.jsonl`): a child that finishes while the conductor is busy
  commits its completion to disk; the conductor *pulls* (drains) at turn boundaries or on
  heartbeat. **Delivery is pull, not push** — nothing ever types into a busy session's pane.

That last point is exactly Consola's "Never Type Into a Confirmation Menu" invariant, generalized.

### 1.2 Watchers — the doorbell model

A watcher forwards external events (GitHub webhook, Slack message, ntfy push, generic HTTP POST)
into a conductor as a **short, structured trigger**, never the payload:

> **"Forward the bell, not the package."**
> ✅ `[github:pr_opened:asheshgoplani/agent-deck#740]`
> ❌ the full webhook JSON

Rules: ≤200 chars, `[source:type:identifier] optional hint` format, self-contained enough to
*ignore*. The conductor decides whether it cares and fetches live state itself (`gh pr view 740`).
This keeps a weeks-long conductor session from drowning its context in email bodies.

Mechanics that matter: SQLite-level dedupe (`INSERT OR IGNORE` on `(watcher, event_id)`), HMAC
verification on GitHub webhooks, per-watcher routing config (`clients.json`: event type → target
conductor), health accounting, and `--no-wait` sends so a wedged conductor never wedges a watcher.

Their Slack integration uses **Socket Mode** (outbound WebSocket) — no public HTTP endpoint
needed, which matters enormously for a desktop app (§4.3).

### 1.3 Groups — policy containers

Agent-deck groups carry *policy* (concurrency caps, working dir, per-group `CLAUDE_CONFIG_DIR`),
not just visual grouping. Consola's **harness** already covers the config-isolation half; what
Consola lacks is any grouping of sessions inside a workspace at all — `Workspace.sessions` is a
flat array (`workspaceStore.ts`), and the sidebar renders it flat.

---

## 2. What Consola already has (and doesn't)

From a full codebase pass (2026-08-18, branch `main` @ `4dc70c7`):

### Already in place — the building blocks

| Capability | Where | Notes |
|---|---|---|
| Programmatic prompt delivery with safety guard | `TerminalService.queuePrompt` / `deliverPendingPrompt` (`TerminalService.ts:117,352`) | Waits for idle + empty composer (`COMPOSER_READY_PATTERN`) + no `CONFIRMATION_MARKERS`. **This is agent-deck's `session send`, already built.** |
| Terminals outlive views | `TerminalManager` | Background sessions keep running when unmounted — a fleet can already exist |
| Emulated screen you can classify | `ScreenModel.visibleText()` / `snapshot()` | The substrate for status detection |
| Per-session config isolation | Harness model + `HarnessDriver` | ≈ agent-deck profiles/groups' `config_dir` overrides |
| Headless one-shot agent call | `ClaudeDriver.runHeadless` (`claude -p … --output-format json`) | Used for commit messages today; precedent for cheap triage calls |
| Single instance per profile | `src/main/index.ts:33` | Prerequisite for owning a local control socket |

### Gaps — what the three ideas would require

1. **Session creation is renderer-only.** Sessions are minted in `workspaceStore` (localStorage),
   and a PTY spawns only when the pane *mounts* (`useTerminal` → `terminalBridge.create`). A
   conductor or trigger cannot start a session today without the user clicking into it. This is
   the single biggest architectural gap.
2. **All persistence is renderer localStorage.** The main process persists nothing. Triggers,
   connections, dedupe state, and a session registry that main-process code can act on all need
   main-side storage (JSON in `userData`, or SQLite if dedupe/event logs grow).
3. **Status detection is coarse.** `isBusy` is a 500 ms output-silence debounce; `isComposerReady()`
   is private and never emitted over IPC. Nothing distinguishes "turn complete" from "waiting on a
   permission prompt" beyond four regexes. Agent-deck leans on Claude Code's own **hooks**
   (Stop/Notification) and transcript files for reliable turn boundaries — Consola reads
   transcripts already (`ClaudeSessionIndex`) but never watches them.
4. **Prompt queue is a single overwrite slot**, not FIFO (`queuePrompt` replaces `pendingPrompt`).
   Fine for one human, wrong for automation firing multiple prompts.
5. **No groups inside a workspace**, no `Session.kind`, no skill registry (the `skills` prop in
   `CommandHighlightContext` is cosmetic and never populated from disk).
6. **No notification surface.** An unattended session hitting a permission prompt is invisible
   unless its tab is open. (No `Notification`, no tray, no badges anywhere in `src/`.)

---

## 3. Proposed shape: four layers, strictly ordered

The dependency order is rigid — each layer is independently useful and shippable, and nothing
above works without the layer below. Crucially, **layers 1–3 need no LLM orchestration at all**;
the conductor is an optional cherry on top, exactly as in agent-deck.

```
Layer 4  Conductor        an ordinary session + control MCP server        (optional, last)
Layer 3  Connections &    Slack/GitHub/webhook adapters → trigger rules   (the "listeners" idea)
         Triggers
Layer 2  Actions          user-defined: prompt template + harness +       (the "custom actions" idea)
                          skill + target group, invokable from UI
Layer 1  Session          main-process session registry, headless start,  (foundation — pure refactor
         Orchestration    FIFO prompts, real status events, groups         + small additions)
```

### 3.1 Layer 1 — Session orchestration foundation

Everything else reduces to one sentence: *the main process must be able to create, start, prompt,
and observe a session without the renderer mounting a pane.*

- **SessionRegistry (main process).** Move the authoritative session/workspace record out of
  renderer localStorage into a main-process store (JSON file in `userData`, mirrored to the
  renderer over IPC; zustand stores become caches). This is a real migration but it also fixes a
  latent fragility: today, clearing renderer storage orphans every PTY and transcript.
  *Cheaper alternative if the migration feels too big for step one:* keep renderer ownership and
  add an IPC round-trip ("main asks renderer to create a session"). It works while a window
  exists — which is always true for a desktop app — but it makes main-process code depend on
  renderer availability and ordering. Worth doing only as a stopgap.
- **Headless start.** `TerminalManager.ensure` already spawns a `TerminalService` with a headless
  `ScreenModel` — nothing in it needs a view. The change is an entry point that isn't
  `TERMINAL_CREATE`-from-a-mounted-pane. When the user later clicks the session, the existing
  `snapshot()` replay path paints it. (This preserves "Terminals Outlive Their Views" — it just
  adds "…and can be born without one.")
- **Prompt FIFO.** Replace the single `pendingPrompt` slot with a queue, drained one prompt per
  ready-composer transition. Keep the delivery guard byte-for-byte — it is the safety invariant.
- **Status vocabulary.** Promote agent-deck's four states to a first-class emitted event:
  `working | ready | needs-attention | exited`, where `needs-attention` = confirmation marker or
  permission prompt detected. Concretely: make `isComposerReady()` public, emit a
  `terminal:status` event alongside the existing four channels, and track it in `terminalStore`
  for badges. Optionally harden turn detection later via Claude Code hooks (a `Stop` hook that
  POSTs to a local Consola socket, injected through harness `--settings` config) — screen
  classification is the v1, hooks are the upgrade.
- **Groups.** Add `groupId?: string` to `Session` and `groups: {id, name}[]` to `Workspace`
  (one localStorage/registry migration, v5→v6). Sidebar renders grouped sections under each
  workspace. No policy semantics yet — visual + targeting only. Policy (concurrency caps) can
  attach later if needed.
- **Attention surface.** OS notification + sidebar badge on `needs-attention` for any unmounted
  session. Without this, unattended automation is a trap: sessions silently stuck on permission
  prompts.

### 3.2 Layer 2 — Custom actions

An **action** is a user-defined, named recipe for starting (or continuing) a session. This is the
user's "review a PR with a given harness, run a specific skill, group it under Reviews" idea. It
is deliberately declarative — no code, no LLM required to *dispatch* it:

```ts
interface ActionDefinition {
  id: string;
  name: string;                    // "Review PR"
  icon?: string;
  workspaceId?: string;            // omit = ask / infer at invocation
  harnessId: string;               // which login/profile runs it
  groupName?: string;              // sessions created by this action land here
  promptTemplate: string;          // "/review-pr {{pr_url}}\nFocus on correctness."
  inputs: { key: string; label: string; required: boolean }[];  // template variables
  sessionNamePrefix?: string;      // "PR #{{pr_number}}" before Claude names it
  reuseSession?: 'never' | 'per-key';  // e.g. one session per PR, prompts appended
}
```

Design choices worth making explicit:

- **Skills ride inside the prompt.** `/skill-name args` typed into the composer is how a human
  invokes a skill; actions do the same via the Layer-1 prompt path. Consola needs no skill
  registry to *execute* this. A registry (scanning `~/.claude/skills`, plugin caches, honoring the
  harness's `configDir`) is purely an authoring nicety — autocomplete in the action editor — and
  can come later.
- **Invocation surfaces:** workspace context menu, command palette (`⌘K`), the `+` button
  split-menu, and — in Layer 3 — triggers. Manual invocation ships first; it makes actions
  useful and testable before any external system is wired up.
- **Storage:** actions are launch descriptions, like harnesses — same pattern (`actionsStore`,
  or the main-process registry if Layer 1 migrated storage). Like harnesses, they hold **no
  credentials** and archived-not-deleted semantics apply if triggers reference them.
- **Template hygiene:** values interpolated into `promptTemplate` come from trigger payloads or
  user input — treat them as untrusted text. The existing bracketed-paste delivery already
  prevents `\r`-injection submitting extra commands mid-prompt; keep it that way.

### 3.3 Layer 3 — Connections and triggers (the listeners)

Split the concept the way the user described it — *configure connections, link them to actions*:

- A **connection** is a configured, credentialed event source. One per external system instance:
  a Slack app (bot token + app token), a GitHub repo watch, a generic localhost webhook port.
  Lives in the main process; credentials in `safeStorage` (Electron's keychain wrapper) — never
  in a store that syncs to the renderer, mirroring the "harnesses never hold a credential" rule
  by keeping secrets out of harness-adjacent records entirely.
- A **trigger** is a rule: `connection + event filter → action + input mapping`.

```ts
interface TriggerRule {
  id: string;
  connectionId: string;
  filter: { type: string; match?: Record<string, string> };  // e.g. {type:'slack:mention', match:{channel:'C0123'}}
  actionId: string;
  inputMapping: Record<string, string>;   // action input key → JSONPath/template over event
  mode: 'auto' | 'confirm';               // confirm = notification with a "Run" button
}
```

Adapter realities for a **desktop** app (this is where Consola differs most from agent-deck,
which happily runs on servers):

| Source | Viable transport | Notes |
|---|---|---|
| Slack | **Socket Mode** (outbound WebSocket) | No public endpoint needed; works behind NAT; agent-deck uses exactly this. First adapter to build. |
| GitHub | Polling via `gh api` per repo, or an ntfy/relay topic | True webhooks need a public URL — punt on that; polling notifications/PRs every N min is honest and simple |
| Generic webhook | `http://localhost:<port>` listener | For local tools, scripts, CI runners on the same machine |
| Anything else | External script → localhost webhook | Agent-deck's own escape hatch ("custom external watchers") — Consola gets it for free via the webhook adapter |

Non-negotiables imported from agent-deck's design:

- **Doorbell discipline.** The event record a trigger hands to an action is short and structured
  (`[slack:mention:C0123:ts]` + extracted fields), never the raw payload. The spawned session
  fetches context itself if the prompt tells it to.
- **Dedupe before dispatch.** Persistent event log keyed `(connectionId, eventId)`; Slack
  reconnects and GitHub redeliveries must not double-fire an action. This alone justifies
  main-process persistence.
- **Offline honesty.** Consola is not a daemon. Socket Mode misses messages while the app is
  closed; polling adapters should sweep a backfill window on launch and the UI should show each
  connection's "listening since / last event" so silence is diagnosable. A menu-bar/tray presence
  ("Consola is listening") is worth considering so quitting the window doesn't silently kill
  every trigger.
- **`mode: 'confirm'` as the default.** A trigger firing an agent with write access to a repo is
  an outward-facing automation; opt into full auto per-rule, not globally.

### 3.4 Layer 4 — The conductor (optional, and only after 1–3)

With Layers 1–3, most of the user-visible value exists *without* an always-on LLM: Slack mention →
review session appears in the right group under the right harness. The conductor adds judgment —
triage, cross-session supervision, auto-answering workers, escalation — and agent-deck shows the
cheapest sound way to build it:

**A conductor is just a Consola session with two extras:**

1. **A control surface.** Instead of agent-deck's `agent-deck session send` CLI, Consola exposes a
   small **MCP server** (stdio binary or local socket, attached via the harness's `extraArgs` /
   `--mcp-config`) with tools like `list_sessions`, `session_status`, `create_session(workspace,
   harness, group, prompt)`, `send_prompt(session, text)`, `read_screen(session)`,
   `run_action(actionId, inputs)`. This is *more* Claude-native than tmux send-keys: the conductor
   reasons with typed tools instead of screen-scraping its siblings, and every mutation funnels
   through the same guarded Layer-1 paths a human uses. It also honors the driver abstraction —
   nothing branches on "claude" outside the driver.
2. **A standing brief.** A per-conductor directory Consola scaffolds (instructions/policy/
   learnings/state/log — agent-deck's five files translate directly), living inside the
   workspace or `userData`. `Session.kind: 'conductor'` marks it in the registry; the sidebar
   renders it distinctly.

Routing then gets a second target: a trigger can point at an **action** (deterministic, Layer 3)
or at a **conductor** (a doorbell line queued into its FIFO — pull-based, delivered only on
ready-composer, exactly like agent-deck's inbox drain). Heartbeat is trivial inside an Electron
app: a main-process interval that queues `[HEARTBEAT]` when the conductor has been idle > N min.

Honest costs to weigh before building this layer: an always-running Claude session burns tokens
continuously; permission policy for a session that *supervises other sessions* needs thought
(the control MCP's mutating tools are themselves permission-gated by Claude Code, which is the
right default); and weeks-long sessions need the compaction-survival trick (`state.json`) to stay
coherent. None of these block Layers 1–3.

---

## 4. What this is *not* (deliberate divergences from agent-deck)

- **No tmux, no CLI surface.** Consola's process model (PTY per session, single instance per
  profile) already covers what agent-deck gets from tmux. A `consola` CLI for scripting could
  come later via the same control socket the MCP server uses, but it is not on any critical path.
- **No cost dashboards, worktree forking, Docker sandboxes, MCP socket pooling.** All real
  agent-deck features, all out of scope for this exploration. Worktree-per-session is the one
  most likely to matter eventually (parallel sessions dirtying one working tree *will* bite once
  triggers spawn sessions automatically) — flag it as a known follow-up, not part of this design.
- **No Telegram/Discord/phone channels.** Consola *is* the control surface; remote channels only
  make sense once a conductor exists and the user is away from the machine. Slack in this design
  is an *event source* (Layer 3), not a control channel — a smaller, safer scope. Two-way Slack
  ("reply in a thread to steer the conductor") is a natural Layer-4+ extension via the same
  Socket Mode connection.

## 5. Risks and open questions

1. **Storage migration (Layer 1) is the load-bearing decision.** Main-process registry vs
   renderer-owned-with-IPC-callback. Recommendation: bite the bullet on the registry; every
   later layer leans on it, and the stopgap creates a dependency direction (main → renderer)
   that the codebase currently avoids on purpose.
2. **Permission prompts in unattended sessions.** Even with notifications, an action-spawned
   session may sit on a tool-approval prompt for hours. Options: per-action
   `--permission-mode`/allowlist extraArgs (user-configured, eyes-open), or accept "review
   sessions wait for a human" as v1 semantics. Do **not** default anything to skip-permissions.
3. **Screen-heuristic fragility.** `COMPOSER_READY_PATTERN` and `CONFIRMATION_MARKERS` track
   Claude Code's TUI strings. Automation multiplies the blast radius of a TUI redesign. The hooks
   upgrade path (§3.1) is the mitigation; a version-pinned marker test in E2E is the tripwire.
4. **Trigger→prompt injection.** External text (Slack messages!) flows into prompts of sessions
   that hold tool access. Template mapping should quote/fence extracted values, `mode:'confirm'`
   defaults, and prompt templates should instruct fetching context via tools rather than trusting
   the trigger text.
5. **Does the app need to become a daemon?** Tray mode, launch-at-login, and "window closed but
   listeners alive" are product decisions that Layer 3 forces. Punting = "triggers work while
   Consola is open," which is a legitimate v1.

## 6. Suggested sequencing

| Phase | Ships | User-visible outcome |
|---|---|---|
| 1 | Registry + headless start + FIFO + status events + groups + notifications | Sessions can be grouped; background sessions badge when they need you |
| 2 | Actions + editor UI + palette/menu invocation | "Review PR" one-click flows with the right harness, skill, and group |
| 3 | Connections (Slack Socket Mode first, localhost webhook second) + trigger rules + dedupe | A Slack mention spawns a grouped review session, with confirm-mode safety |
| 4 | Control MCP server + conductor session kind + scaffolded brief + heartbeat | An optional supervisor session that triages triggers and drives workers |

Each phase is independently valuable; stopping after any of them leaves a coherent product.
