---
date: 2026-08-27
topic: "Consola plugin system: functionality + UI contributions around session management — design, research findings, and POC starting point"
status: design agreed in conversation (Approach A, staged; Inbox unification adopted); POC is the next step; nothing implemented
builds_on: docs/north-star/consola-factories.md, research/2026-08-27-tracks-connections-integration-manifests.md
artifact: https://claude.ai/code/artifact/2b05a5b5-ca41-4b15-94a4-4f7204e6860d#plugins (mockups, code examples, comparison figures)
tags: [research, plugins, extension-host, contribution-points, cohesion, vscode, raycast, slack-apps, inbox]
---

# Consola Plugin System

Design record for a third-party plugin system: anyone can build **functionality
and UI** for Consola, revolving around **session management** (organisation,
automation, tracking), while the app stays cohesive. This is the tier *above*
what already exists: Claude Code plugins own the conversation layer (skills,
MCP, hooks); integration manifests own feeds/correlation; `factory.yml` owns
automations. This system owns the app layer — and, after the unification in
§5, it is the **registration mechanism for surfaces the app already has**, not
a place where separate plugin UI lives.

## 1. Goals and constraints

- Anyone can create a plugin: logic and UI usable inside the app.
- Plugins revolve around session management nouns (Session, Track, Run,
  Action, Connection, Group, Inbox item) — not arbitrary app remodelling.
- Strike cohesion vs flexibility deliberately; the user's instinct is Slack's
  app model (fixed slots + Block Kit), which this design adopts.
- Must not duplicate the harness layer (MCP/skills/hooks are Claude Code
  plugins' turf) nor compromise Consola's credential/PTY posture.

## 2. Research findings (2026-08-27, two web-research passes)

**VS Code** (reference implementation):
- Extensions run in an **extension host** — an Electron `utilityProcess` —
  talking to the sandboxed renderer over MessagePorts/async RPC. Workbench
  renders fine if the host dies; crashed host restarts with a toast.
- **38 declarative `contributes.*` points** (commands, menus, views,
  keybindings, configuration, themes…). Declarative = renderable without
  running plugin code → instant UI + lazy loading. Since 1.74 activation is
  **implicit** from contributions.
- The `vscode` API module is **injected** (not an npm dep); stable API never
  breaks; proposed APIs can't be published.
- **No DOM access**, ever. UI = data-driven (TreeView: plugin supplies data,
  workbench renders — why 60k extensions look native) + **webviews**
  (sandboxed iframes) as the escape hatch — their acknowledged cohesion
  failure ("use sparingly"; the Webview UI Toolkit was a retrofit apology).
- **No permission model** — extensions run with full user privileges; 1,200+
  malicious extensions / ~229M installs found (2024–26); mitigations are all
  marketplace-side (scanning, signing, kill list). Their biggest regret.

**Ecosystem pattern** — *data-shaped contributions rendered by host-owned
components get cohesion cheaply; free-form UI buys breadth at security and
native-feel cost*:
- **Raycast**: React + TS but **no DOM** — a custom reconciler renders a fixed
  kit (`List`, `Grid`, `Detail`, `Form`, `Action`) natively. Pixel styling is
  impossible ⇒ third-party = first-party. **AI Extensions** (2025): extension
  commands exposed as tools the AI calls — adopted below as `tools`.
- **Zed**: WASM/WASI-sandboxed, data-only (languages, themes, slash commands,
  MCP servers); deliberately no UI extensibility ("someday" for 3 years).
- **Obsidian**: full DOM, no permissions ⇒ ~7,000 plugins, 120M+ downloads,
  permanent security/consistency debate.
- **Claude Code plugins**: bundle commands/agents/skills/hooks/MCP/LSP;
  **marketplaces are git repos** pinned by SHA. Covers the conversation
  layer; cannot touch host-app UI.
- **Session managers have no plugin systems** (Conductor, Crystal,
  claude-squad, Vibe Kanban — whose top issues are plugin-shaped: Slack
  notifications, Jira import; agent-deck internalised the categories).
  Consola would be first.
- **Popular categories, ranked**: tracker integrations (→ our manifests),
  code-intel MCPs (→ harness layer), notifications, cost dashboards,
  workflow bundles (→ factory.yml), session organisers/boards. What's left
  for the app tier: UI around sessions/Tracks/Runs + logic sinks.

## 3. Approaches considered

- **A — Raycast/VS Code hybrid (chosen)**: plugin host (`utilityProcess`) +
  declarative contribution points + fixed component kit for panels; capability
  permissions from day one. Staged (Phase 1 without the kit).
- **B — Zed model**: data-only + external processes against a public control
  API. Safest, but no third-party panels ever — the category people want.
- **C — Obsidian/webview model**: rejected outright, with a Consola-specific
  reason beyond taste: the app holds live PTYs to credential-bearing CLIs and
  the prompt delivery guard is a safety invariant; arbitrary plugin code
  beside them means a plugin can type into sessions.

## 4. The design (Approach A, staged)

### 4.1 A plugin is a bundle

```
my-plugin/
  consola-plugin.json      # id, version, publisher, contributes, capabilities, main?
  integrations/*.yml       # optional: integration manifests (existing tier)
  actions/*.yml            # optional: action templates the user may adopt
  dist/main.js             # optional: code — only when data can't express it
  panels/                  # optional (Phase 2): kit-built panels
```

**The floor is pure data**: no `main` → nothing executes, no permissions
prompt, full cohesion by construction. Code is opt-in and pays its own cost.
Rule: **if data can express it, it must be a manifest; code only for what
data can't say.**

### 4.2 Process architecture

- One **plugin host**: an Electron `utilityProcess` spawned by main; all
  plugin code runs there — never in main (PTYs, token composition) nor the
  renderer (DOM). Async JSON-RPC only; Consola renders fully with the host
  dead; crash → toast + restart.
- **Implicit lazy activation** from contributions (VS Code 1.74 lesson):
  Consola renders declarative contributions without loading code; first
  invocation/event activates.
- The `consola` API module is injected by the host loader;
  `@consola/plugin-types` ships types only. Semver: stable API never breaks
  within a major; experimental APIs behind a flag, unpublishable.

### 4.3 Contribution points (Phase 1 unless noted)

| Point | Renders as |
|---|---|
| `views` | **The** item-view type (see §5): query/group/layout over connection items, shown in the Inbox strip. Declarable (manifest) or computed (code) |
| `commands` | Palette entries (+ keybindings) |
| `menus` | Context-menu items on session / Track / Run / Inbox item / scope |
| `badges` | Status chips on session, Track, Run and item rows — attach to the *record*, so they render everywhere it appears |
| `detailSections` | Titled section in item/Track/Run detail pane (data-driven blocks) |
| `statusBar` | Status-bar item |
| `settings` | Schema-declared settings section (Consola renders the form) |
| `notificationSinks` | Destinations for automation `notify`/`confirm` (Slack DM, ntfy, webhook…) |
| `tools` | Commands exposed as tools — callable from palette, automations (`run: plugin:<id>#<tool>`), and conductors (control MCP). The Raycast AI Extensions move |
| `integrations`, `actions` | Bundled data tiers (existing designs) |
| `panels` *(Phase 2)* | Non-item panes under the sidebar's Apps section, kit-built |
| `triggers` *(Phase 2)* | Plugin as event source into the factory vocabulary (`pagerduty: incident.triggered`) |

**Never contributable**: chat/terminal UI, PTY rendering, DOM/CSS, harness
internals, credential storage.

### 4.4 API and permissions

One authority layer in main (the conductor control server generalised —
capability-checked per call, records re-resolved per call), four consumers:
conductor MCP, plugin host, future `consola` CLI, plugin tools.

| Namespace | Capability | Notes |
|---|---|---|
| `items.query/observe` | `items:read` | normalized items across connections |
| `sessions.list/get/observe` | `sessions:read` | status = existing `terminal:status` vocabulary |
| `sessions.create` | `sessions:create` | via `SessionLauncher` only |
| `prompts.queue` | `prompts:send` | **only** the guarded FIFO; a raw-PTY API does not exist at any level |
| `screen.readText` | `screen:read` | loud consent (screens can show secrets) |
| `tracks.*` | `tracks:read/write` | attach via the validated link path |
| `runs.*` | `runs:read` | local + cloud |
| `actions.list/invoke` | `actions:invoke` | the sanctioned way to *do* things |
| `events.on` | `events:subscribe` | same trigger vocabulary as automations |
| `storage`, `secrets.ref` | — | per-plugin KV; secrets only as references resolved in main |
| `ui.*` | — | refresh own views, quickPick, notify (tied to declared contributions) |

**Honesty clause**: the host is Node, so plugin code can technically reach
fs/network. Two capability classes: **session powers** (`sessions:*`,
`prompts:send`, `screen:read`, `tracks:write`) enforced *hard* at the RPC
boundary in main; **ambient powers** (`network:<hosts>`, `fs`) declared for
transparency/consent, enforced by marketplace review + org allowlists in
Phase 1 and technically (locked-down workers / WASM) in Phase 3. Typing into
a live session is structurally impossible: no API exists, and plugin code
never runs beside the PTY.

### 4.5 Phase 2: the component kit

`@consola/plugin-kit`: React whose only exports are Consola-rendered
primitives — `List`, `Board`, `Timeline`, `Detail`, `Form`, `Chart`,
`Markdown`, `Action`. Plugin runs its React tree in the host; a reconciler
serialises the element tree over RPC; the renderer materialises it with real
Consola components and tokens; handlers round-trip by id. No style props
beyond semantic variants (`tone="warning"`) ⇒ cohesion is structural. Enables
`panels` and modal `Form`s. **No webviews at any tier.**

### 4.6 Distribution and trust

- Marketplaces = git repos with a listing file, plugins pinned by commit SHA
  (Claude Code's model). Channels: personal (`~/.consola/plugins/`), **org**
  (`<org>/.consola/plugins.json` — curated, auto-installed for org members),
  community marketplaces.
- Install = Slack-style scopes screen: capability list + an explicit
  **cannot** list ("type into sessions, read screens, access credentials").
  Data-only plugins skip consent.
- Org policy can allowlist/denylist ids and capabilities. Dev mode:
  `consola --dev-plugin <path>` with contribution hot-reload.

### 4.7 Slack mapping (the user's reference model)

slash command → palette command/tool · Block Kit message → detail section /
badge / view row · app DM → notification sink · modal → kit Form ·
App Home → Apps panel (non-item only) · OAuth scopes → capability consent ·
app directory → git-repo marketplaces.

## 5. The Inbox unification (critical correction, adopted)

The initial design had plugin "lenses" and an Apps-section Sprint Board —
duplicating the Inbox. Resolved:

- **One contribution type `view`** `{source connection(s), query, group-by,
  layout: list | board, row spec}`, three producers: the built-in GitHub view
  (first registered view — dogfooding via an internal **view registry**, no
  literal repackaging of built-ins), integration manifests (`views:` blocks),
  and plugins (computed views). **The Inbox renders all of them** — strip
  grouped by connection, plugin views tagged `APP`. Jira Suite's Sprint Board
  is a Jira view with `layout: board`, *inside the Inbox*.
- **Apps section = non-item panels only** (Cost, Time). Review rule: *if it
  renders work items, it must be a view.*
- **Plugins extend the factory, never compete**: `events.on` is for display;
  anything that starts work goes through `actions.invoke` or contributes
  `tools`/`triggers` into the automation engine (confirm-mode, budgets, Run
  records live there). No private trigger→session loops.
- Net statement: **one item surface (Inbox), one automation engine (factory),
  one detail pane (sections), one notification router (sinks); manifests,
  plugins and built-ins are three producers feeding those four consumers.**
- Cost acknowledged: Inbox v2's renderer must consume the view registry
  instead of hardcoded GitHub components — a real refactor, taken knowingly.

## 6. Code examples

Floor — pure data (`jira-suite`, runs no code):

```json
{ "id": "jira-suite", "version": "1.2.0", "publisher": "consola-community",
  "contributes": {
    "integrations": ["integrations/jira.yml"],
    "views": [{ "id": "sprint-board", "title": "Sprint {{sprint.name}}",
                "connection": "jira", "query": "sprint = active AND assignee = me",
                "groupBy": "section", "layout": "board" }],
    "actions": ["actions/plan.yml", "actions/implement.yml"] } }
```

Ceiling — code (`review-sla`):

```json
{ "id": "review-sla", "publisher": "javier", "main": "dist/main.js",
  "capabilities": ["items:read", "tracks:read"],
  "contributes": {
    "views":  [{ "id": "review-sla", "title": "Review SLA", "connection": "github" }],
    "badges": [{ "id": "waiting", "on": "item" }],
    "tools":  [{ "id": "oldest_waiting", "description": "The PR that has waited longest for my review" }] } }
```

```ts
import { items, tracks } from 'consola';

export function activate(ctx) {
  ctx.views.provide('review-sla', async () => {
    const prs = await items.query({ connection: 'github', section: 'needs-your-review' });
    return prs.map(pr => ({ ...pr, waitingDays: daysSince(pr.reviewRequestedAt) }))
              .sort((a, b) => b.waitingDays - a.waitingDays);
  });
  ctx.badges.provide('waiting', item =>
    item.waitingDays >= 2 ? { text: `waiting ${item.waitingDays}d`, tone: 'warning' } : null);
  ctx.tools.provide('oldest_waiting', async () => {
    const [top] = await ctx.views.items('review-sla');
    return { ref: top.workItem, waitingDays: top.waitingDays, track: await tracks.for(top.workItem) };
  });
}
```

Automation using plugin tool + sink (personal `factory.yml`):

```yaml
- name: morning-review-nudge
  on: { cron: "0 9 * * 1-5" }
  run: plugin:review-sla#oldest_waiting
  notify: plugin:slack-notifier#dm-me
  runner: local
```

## 7. Example plugins (surface mapping)

1. Jira Suite — manifest + board view + sprint tools (+`sprint.started` trigger, P2)
2. Review SLA — computed view + badge + tool (P1)
3. Cost Dashboard — Apps panel + status bar (P2 panel; P1 status bar)
4. Slack/Discord/ntfy Notifier — sink + settings (P1)
5. Tracks Kanban — Tracks view `layout: board`; drag = `actions.invoke` (P1/P2)
6. Standup Summary — command + tool (P1)
7. PagerDuty Triage — trigger source + action template (P2)
8. Session Hygiene — session badges + archive command (P1)
9. Time per Track — event observer + Timeline panel (P1 logic; P2 panel)
10. Review Checklist Gate — detail-pane Form section + `checklist_state` tool (P1 section w/ blocks; P2 Form)

## 8. User interaction

1. ⌘K → "Install plugin…" (org list / marketplaces) → consent screen (skipped
   for data-only).
2. Appears **in place**: new Inbox tab with `APP` tag; badges on the item
   rows everywhere they render.
3. Daily use = existing gestures (row → Track pane → actions).
4. Automations use its tools/sinks; 5. conductors call the same tools over
   the control MCP. One tool, three callers.

## 9. Staging

- **Phase 1** (strong-opinions v1, a real platform by itself): host +
  contribution registry + `views`/`commands`/`menus`/`badges`/
  `detailSections`/`statusBar`/`settings`/`notificationSinks`/`tools` + API
  core + capability consent + dev mode + git marketplaces.
- **Phase 2**: kit + `panels` + modal Forms + `triggers`. Go-criterion: the
  first real panel-shaped need (likely the Cost Dashboard).
- **Phase 3**: hard sandboxing of ambient powers (locked-down workers / WASM);
  community marketplace curation at scale.

## 10. Open decisions

- Phase 3 sandbox technology (worker + SES? isolated-vm? WASM?) — unresolved.
- `triggers` in Phase 1 vs 2 (currently 2).
- Kit component list (grow one component at a time as plugins hit walls).
- Built-ins literally packaged as plugins vs internal registry only
  (recommended: registry only — VS Code's built-ins-as-extensions ceremony
  isn't worth it for one team).

## 11. POC starting point (for the next session)

Goal: prove the loop **host ↔ main ↔ renderer** with real cohesion, in the
smallest slice that touches nothing unbuilt (no Tracks/ItemRef dependency):

1. `PluginHostService` in main: spawn a `utilityProcess`, JSON-RPC over
   MessagePort, restart on crash.
2. Manifest loader: `~/.consola/plugins/*/consola-plugin.json` + a
   `--dev-plugin <path>` flag; contribution registry in main, mirrored to the
   renderer over a new bridge (`pluginBridge`), rendered without loading code.
3. Two contribution points only: `commands` (palette) and `badges` on
   **session rows** (rows exist today in the sidebar).
4. API: `sessions.list/observe` read-only, capability-checked in main.
5. Fixture plugin **session-hygiene**: badge `idle 3d` on idle sessions +
   command "List idle sessions" (quickpick; no writes).
6. Non-goals: views/items (needs Tracks work), kit, permissions UI (log
   only), marketplaces, sandboxing.

Treat POC code as a spike: keep only after review against this document.
Invariants that must hold even in the POC: plugin code never in main or
renderer; no PTY-adjacent API; bridges pattern respected; delivery guard
untouched.

## Sources

VS Code: extension host, sandboxing blog (utilityProcess), contribution
points, activation events, webview guide + UI Toolkit blog, workspace trust,
runtime security, proposed APIs, publishing docs; koi.ai design-flaw letter;
229M-install malware reports; Eclipse blog on forks; Open VSX supply-chain
reports. Ecosystem: OpenHands skills docs + extensions repo; Zed "Life of a
Zed Extension"; Obsidian "future of plugins" + obsidianstats; Raycast "How
the Raycast API and extensions work" + AI Extensions docs; Claude Code plugin
docs; vibe-kanban issues #1110/#2159; agent-deck; terragon-oss; Conductor
docs. (Two research-agent reports, 2026-08-27.)
