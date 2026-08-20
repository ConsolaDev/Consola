# GitHub Workflow Phase 3 — Conductors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestration door: a dialog that scaffolds a conductor directory from shipped templates, creates a group, and launches a conductor session whose MCP tools let it spawn, prompt, and observe worker sessions inside its own group — and only there.

**Architecture:** A conductor is an ordinary session (`kind: 'conductor'`) whose intelligence is three generated files on disk; Consola provides only plumbing. The plumbing is a per-conductor MCP endpoint: the `claude` CLI (via a per-session `--mcp-config` file) spawns a 20-line stdio shim that pipes JSON-RPC over a private Unix socket into the Electron main process, where `ConductorControlServer` holds the actual tool logic next to `SessionLauncher` and `TerminalManager`. Every tool call is authenticated by which conductor's socket it arrived on; scope of authority is that conductor's group, enforced server-side, never trusted from arguments.

**Tech Stack:** Electron 28 (main = CommonJS, Node 18), `@modelcontextprotocol/sdk` (new dependency), `zod`, node `net` Unix sockets, React 19 + Radix Dialog, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-github-workflow-design.md` (this phase: "Phase 3 — Conductors" in the Phasing table; sections "Groups, conductors, attention" and "Launch flows"). Prior art: `research/2026-08-18-agent-deck-conductor-listeners-actions.md` §1.1 (a conductor is a session plus files), §1.2 ("forward the bell, not the package"), §3.4 (the control-MCP shape).

## Global Constraints

- **Bridge pattern:** renderer code never touches `window.*API` directly; always via `src/renderer/services/*Bridge.ts` (CLAUDE.md).
- **IPC channel names** live only in `src/shared/constants.ts`.
- **Never type into a confirmation menu:** all prompt delivery goes through `TerminalService.queuePrompt`'s guarded FIFO (Phase 2). No code in this phase writes to a PTY directly.
- **A conductor is an ordinary session:** no special-casing in `TerminalService`/`ipc-handlers`/renderer beyond (a) kind-gated MCP registration and (b) the 🧠 glyph.
- **Main owns records:** all mutations go through `WorkspaceService`; renderers send intents.
- **No secrets outward:** the per-conductor token appears only in the generated config file (mode 0600) and the shim's env — never in MCP tool results, never in renderer-bound payloads.
- **Nothing branches on a driver id outside `src/main/drivers/`:** the `--mcp-config` flag lives in `ClaudeDriver`; everything else passes an opaque `mcpConfigPath`.
- **A session's harness is fixed for its lifetime**; workers spawned by a conductor inherit the conductor's `harnessId`.
- Main process compiles with `tsconfig.main.json` (`module: commonjs`, no bundler) — dependencies must be requirable from CJS.
- Tests: vitest, co-located `src/**/*.test.ts`, run with `npm test`; types with `npm run typecheck`.
- **CLI flag verification:** `--mcp-config <configs...>` ("Load MCP servers from JSON files or strings (space-separated)") verified against `claude --help` of claude 2.1.237 on 2026-08-20. Task 3 re-verifies at execution time. `--strict-mcp-config` is deliberately NOT passed — it would strip the user's own MCP servers from the conductor.

## Interface contracts consumed (delivered by Phases 0–2, possibly landing in parallel)

Consume as given; do not re-implement:

- **Phase 0 (v6 model, `src/shared/workspace.ts` / `WorkspaceService`):**
  `Group { id; name; parentGroupId?; conductorSessionId?; createdAt; archivedAt? }`,
  `Scope { id; name; path; isGitRepo }`,
  `Session` gains `scopeId: string; cwd?: string; groupId?: string; kind: 'interactive' | 'conductor'; workItem?`,
  `WorkspaceService.createGroup(workspaceId, fields: { name; parentGroupId?; conductorSessionId? }): Group`.
- **Phase 2:** `src/main/SessionLauncher.ts` with `launchSession(workspaceId: string, fields: NewSessionFields & { initialPrompt?: string }): Promise<Session>` (creates the record and spawns the PTY headlessly); `TerminalService.queuePrompt(prompt)` is a guarded FIFO; `terminal:status` event with `'working' | 'ready' | 'needs-attention' | 'exited'`; the ＋ New menu with a **disabled "Orchestration…" item**; the Groups sidebar + group progress view; the needs-attention OS notification pipeline.

Where a Phase 0/2 name differs from the above when you get there (e.g. the exact `NewSessionFields` pick, or a promoted status query on `TerminalManager`), **adapt the single wiring call site — never the tested module APIs defined in this plan.** Tasks note each such seam explicitly.

## File structure

```
src/main/conductor/
├── templates/
│   ├── CLAUDE.md.tmpl              # role, authority, reading order, tools   (new)
│   ├── POLICY.md.tmpl              # auto-act vs escalate, conservative      (new)
│   └── state.json.tmpl             # seeded working memory                   (new)
├── ConductorScaffold.ts            # scaffold() + template rendering         (new)
├── ConductorScaffold.test.ts                                                 (new)
├── ConductorControlServer.ts       # endpoints, tools, boundaries            (new)
├── ConductorControlServer.test.ts  # unit: every boundary                    (new)
├── ConductorControlServer.integration.test.ts  # fake MCP client             (new)
├── conductorShim.ts                # stdio<->socket pipe run by `claude`     (new)
├── createConductor.ts              # scaffold -> group -> launch ordering    (new)
├── createConductor.test.ts                                                   (new)
└── mcpSdk.test.ts                  # CJS interop smoke test                  (new)
scripts/copy-conductor-templates.cjs                                          (new)
src/renderer/services/conductorBridge.ts                                      (new)
src/renderer/components/Dialogs/OrchestrationDialog.tsx                       (new)
src/renderer/components/Views/ConductorCard.tsx                               (new)
Modified: package.json, electron-builder.yml, src/shared/constants.ts,
src/shared/types.ts, src/main/drivers/HarnessDriver.ts, ClaudeDriver.ts (+ new
ClaudeDriver.test.ts), src/main/TerminalService.ts, src/main/SessionLauncher.ts
(Phase 2 file), src/main/state/WorkspaceService.ts (+ test),
src/main/ipc-handlers.ts, src/preload/preload.ts, Dialogs/styles.css, the
Phase 2 New-menu and group-view components, Sidebar/SessionNavItem.tsx.
```

---

### Task 1: Conductor templates and ConductorScaffold

The three shipped templates and the `scaffold()` that renders them onto disk. Templates carry a `.tmpl` suffix on purpose: a literal `CLAUDE.md` under `src/` would be picked up by Claude Code as directory-scoped instructions while working on Consola itself.

**Files:**
- Create: `src/main/conductor/templates/CLAUDE.md.tmpl`
- Create: `src/main/conductor/templates/POLICY.md.tmpl`
- Create: `src/main/conductor/templates/state.json.tmpl`
- Create: `src/main/conductor/ConductorScaffold.ts`
- Create: `scripts/copy-conductor-templates.cjs`
- Modify: `package.json` (the `build:main` script line)
- Test: `src/main/conductor/ConductorScaffold.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `scaffold(scopePath: string, name: string, kickoff: string, workspaceName: string): Promise<string>` (returns the created directory; throws on collision or bad name), `renderTemplate(source: string, values: Record<string, string>): string`, `CONDUCTOR_NAME_PATTERN: RegExp`. Note: the phase contract named a 3-argument `scaffold`; the templates' `{{workspaceName}}` placeholder requires the 4th parameter — a backwards-compatible extension, flagged in the plan summary.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/conductor/ConductorScaffold.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONDUCTOR_NAME_PATTERN, renderTemplate, scaffold } from './ConductorScaffold';

let scopeDir: string;

beforeEach(() => {
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-scaffold-'));
});

afterEach(() => {
  fs.rmSync(scopeDir, { recursive: true, force: true });
});

describe('renderTemplate', () => {
  it('substitutes every known placeholder', () => {
    expect(renderTemplate('a {{name}} b {{kickoff}}', { name: 'x', kickoff: 'y' })).toBe('a x b y');
  });

  it('leaves unknown placeholders visible rather than blanking them', () => {
    expect(renderTemplate('{{mystery}}', { name: 'x' })).toBe('{{mystery}}');
  });
});

describe('scaffold', () => {
  it('creates the conductor directory with all three files rendered', async () => {
    const dir = await scaffold(scopeDir, 'symbalance-api', 'Ship the API.', 'Sympower');

    expect(dir).toBe(path.join(scopeDir, 'conductor', 'symbalance-api'));

    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('symbalance-api');
    expect(claude).toContain('Ship the API.');
    expect(claude).toContain('Sympower');
    expect(claude).not.toContain('{{');

    const policy = fs.readFileSync(path.join(dir, 'POLICY.md'), 'utf8');
    expect(policy).toContain('Escalate');
    expect(policy).not.toContain('{{');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(state).toEqual({ version: 1, tasks: [], workers: {}, notes: '' });
  });

  it('names the consola_* tools in CLAUDE.md so the conductor knows its hands', async () => {
    const dir = await scaffold(scopeDir, 'tools-check', 'k', 'ws');
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    for (const tool of [
      'consola_spawn_session',
      'consola_send_prompt',
      'consola_session_status',
      'consola_group_status',
    ]) {
      expect(claude).toContain(tool);
    }
  });

  it('refuses when the directory already exists, naming the path', async () => {
    await scaffold(scopeDir, 'dup', 'k', 'ws');
    await expect(scaffold(scopeDir, 'dup', 'k', 'ws')).rejects.toThrow(
      path.join(scopeDir, 'conductor', 'dup')
    );
  });

  it('rejects names that would escape the conductor directory', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', '']) {
      await expect(scaffold(scopeDir, bad, 'k', 'ws')).rejects.toThrow(/Invalid conductor name/);
    }
    expect(CONDUCTOR_NAME_PATTERN.test('ok-name.v2_x')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/conductor/ConductorScaffold.test.ts`
Expected: FAIL — cannot resolve `./ConductorScaffold`.

- [ ] **Step 3: Write the three template files**

`src/main/conductor/templates/CLAUDE.md.tmpl` — exactly this content:

```markdown
# Conductor: {{name}}

You are the conductor of the **{{name}}** group in the **{{workspaceName}}**
workspace, running inside Consola. You coordinate worker sessions; you do not
do the implementation work yourself.

## Scope of authority

Your authority is exactly your own group. The `consola_*` tools enforce this:
you can spawn sessions only into your group, and only inside this workspace's
scopes. Anything beyond that boundary — and anything POLICY.md reserves for a
human — you escalate.

## Reading order (at every startup and after every compaction)

1. This file — your role and tools.
2. `POLICY.md` — what you may do autonomously vs. what you escalate.
3. `state.json` — your working memory. It survives context compaction; trust
   it over your own recollection.

## Your tools

- `consola_spawn_session { name, scopePath?, cwd?, prompt }` — start a worker
  session in your group. `scopePath` must be one of this workspace's scopes;
  omit it to use your own scope. `cwd`, when given, must be inside that scope.
  Returns `{ sessionId, instanceId }`.
- `consola_send_prompt { sessionId, prompt }` — queue a prompt to a worker in
  your group. Delivery waits for the worker's composer to be free and empty;
  it is never typed into a menu, so it may take a while to land.
- `consola_session_status { sessionId }` — one worker's state:
  `working | ready | needs-attention | exited`. `needs-attention` means it is
  waiting on the human, not on you.
- `consola_group_status {}` — every session in your group, one line each.

## Working discipline

- **Forward the bell, not the package.** Prompts to workers are short and
  structured — `[task:<id>] <one-line instruction>` — never long documents.
  Point workers at files and let them read for themselves.
- **Poll, don't hover.** Check `consola_group_status` at your turn
  boundaries. Do not spam idle workers with check-in prompts.
- **Write `state.json` after every meaningful change** — task assigned,
  worker finished, decision made. It is your memory across compactions.
- **Escalate by stopping.** When POLICY.md says escalate, write a short
  summary of what happened, what needs deciding, and what you recommend —
  then stop and wait. Consola surfaces your session as needing attention;
  the human comes to you. No other channel is needed.

## Kickoff

{{kickoff}}
```

`src/main/conductor/templates/POLICY.md.tmpl` — exactly this content:

```markdown
# Policy: {{name}}

The split between what the conductor does on its own authority and what waits
for a human. This file belongs to you, the user — edit it freely; the
conductor re-reads it at every startup ({{workspaceName}} workspace).

## Act autonomously

- Read code, run builds and tests, and inspect diffs anywhere in this
  workspace's scopes.
- Spawn worker sessions in your own group and send them follow-up prompts.
- Split work into tasks, sequence them, and record progress in `state.json`.
- Draft summaries and review comments for the human to act on.

## Escalate to the human — always

- Anything destructive: deleting branches, resetting history, dropping data,
  removing files beyond a worker's own task.
- Merging anything, anywhere.
- Force-pushes.
- Cross-repo API changes — any change to a contract another repository
  depends on.
- Credentials, tokens, accounts, or permissions of any kind.
- Anything this file does not explicitly allow. When unsure, escalate.

## How to escalate

Write a short summary — what happened, what needs deciding, what you
recommend — then stop and wait. Do not proceed on an assumption.
```

`src/main/conductor/templates/state.json.tmpl` — exactly this content (no placeholders; it is seeded literally):

```json
{
  "version": 1,
  "tasks": [],
  "workers": {},
  "notes": ""
}
```

- [ ] **Step 4: Write ConductorScaffold.ts**

```ts
// src/main/conductor/ConductorScaffold.ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generates a conductor's brief on disk: CLAUDE.md, POLICY.md, state.json.
 *
 * The files are the product — everything agent-deck makes users hand-author,
 * Consola writes from shipped templates, and they stay editable on disk. The
 * directory is also the future Playbook seam: name and version it later and
 * it becomes shareable with no rework.
 */

/** Directory names a conductor may have. Rejects path traversal outright. */
export const CONDUCTOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const TEMPLATE_FILES: ReadonlyArray<{ template: string; output: string }> = [
    { template: 'CLAUDE.md.tmpl', output: 'CLAUDE.md' },
    { template: 'POLICY.md.tmpl', output: 'POLICY.md' },
    { template: 'state.json.tmpl', output: 'state.json' },
];

/**
 * Where the shipped templates live.
 *
 * The compiled build reads the copy `scripts/copy-conductor-templates.cjs`
 * places beside it in dist. Vitest (running from src) and a dev watch build
 * that has not run the copy step fall back to the source location.
 */
function templatesDir(): string {
    const candidates = [
        path.join(__dirname, 'templates'),
        path.join(__dirname, '../../../../src/main/conductor/templates'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Conductor templates not found. Looked in: ${candidates.join(', ')}`);
}

/** Replace {{key}} placeholders. Unknown keys stay visible, not blanked. */
export function renderTemplate(source: string, values: Record<string, string>): string {
    return source.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
    );
}

/**
 * Create `<scopePath>/conductor/<name>/` from the shipped templates.
 *
 * Refuses an existing directory rather than overwriting: the files are
 * user-editable state from the moment they land, and a name collision is a
 * fact the user has to resolve, not something to paper over.
 *
 * @returns the absolute path of the created directory.
 */
export async function scaffold(
    scopePath: string,
    name: string,
    kickoff: string,
    workspaceName: string
): Promise<string> {
    if (!CONDUCTOR_NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid conductor name "${name}": use letters, digits, dots, dashes and underscores.`
        );
    }

    const dir = path.join(scopePath, 'conductor', name);
    if (fs.existsSync(dir)) {
        throw new Error(`Conductor directory already exists: ${dir}`);
    }

    const source = templatesDir();
    const values = { name, kickoff, workspaceName };

    await fs.promises.mkdir(dir, { recursive: true });
    for (const { template, output } of TEMPLATE_FILES) {
        const raw = await fs.promises.readFile(path.join(source, template), 'utf8');
        await fs.promises.writeFile(path.join(dir, output), renderTemplate(raw, values), 'utf8');
    }
    return dir;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/conductor/ConductorScaffold.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Add the dist copy step**

Create `scripts/copy-conductor-templates.cjs`:

```js
#!/usr/bin/env node
/**
 * Copy conductor template files into dist, where tsc will not.
 *
 * tsc emits only TypeScript output; the .tmpl files must still ship, because
 * the packaged app (electron-builder `files: dist/**`) reads them at runtime.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../src/main/conductor/templates');
const dest = path.join(__dirname, '../dist/main/main/conductor/templates');

fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
}
console.log(`Copied ${fs.readdirSync(src).length} conductor templates to ${dest}`);
```

In `package.json`, change the `build:main` script line from:

```json
"build:main": "tsc -p tsconfig.main.json",
```

to:

```json
"build:main": "tsc -p tsconfig.main.json && node scripts/copy-conductor-templates.cjs",
```

(`dev:main` stays watch-only tsc; the loader's source-path fallback covers dev.)

- [ ] **Step 7: Verify the copy step**

Run: `npm run build:main && ls dist/main/main/conductor/templates`
Expected: the three `.tmpl` files listed.

- [ ] **Step 8: Commit**

```bash
git add src/main/conductor/templates src/main/conductor/ConductorScaffold.ts src/main/conductor/ConductorScaffold.test.ts scripts/copy-conductor-templates.cjs package.json
git commit -m "feat: conductor scaffold with shipped templates"
```

---

### Task 2: MCP SDK dependency with a CJS interop smoke test

The main process is CommonJS (`tsconfig.main.json`, `module: commonjs`, classic resolution). `@modelcontextprotocol/sdk@1.30.0` supports this: its `exports` map serves `dist/cjs/*` to `require`, and its `typesVersions` maps subpath imports to `dist/esm/*.d.ts` for classic TypeScript resolution. This task proves that before 500 lines are built on it.

**Files:**
- Modify: `package.json` (dependencies, via npm install)
- Test: `src/main/conductor/mcpSdk.test.ts`

**Interfaces:**
- Produces: the dependency `@modelcontextprotocol/sdk` (import paths `.../server/mcp.js`, `.../server/stdio.js`, `.../client/index.js`, `.../inMemory.js`, `.../shared/stdio.js`) and `zod`, used by Tasks 4–6.

- [ ] **Step 1: Install the dependencies**

```bash
npm install @modelcontextprotocol/sdk@^1.30.0 zod@^3.25.1
```

Note: `npm install` triggers the node-pty native rebuild (postinstall); that is expected and takes a minute. The SDK requires Node >= 18; Electron 28 embeds Node 18.18 — satisfied. The SDK's own zod range is `^3.25 || ^4.0`, so `zod@^3.25.1` dedupes to a single copy.

- [ ] **Step 2: Write the smoke test**

```ts
// src/main/conductor/mcpSdk.test.ts
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

/**
 * Proves the MCP SDK works under this repo's CommonJS main build before
 * ConductorControlServer is built on it: subpath imports resolve, a server
 * registers a zod-typed tool, and a client can call it end to end.
 */
describe('MCP SDK interop', () => {
  it('serves a tool call over a linked in-memory transport', async () => {
    const server = new McpServer({ name: 'smoke', version: '0.0.0' });
    server.registerTool(
      'echo',
      { description: 'echo back', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text' as const, text }] })
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'smoke-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'echo', arguments: { text: 'ping' } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('ping');

    await client.close();
  });
});
```

- [ ] **Step 3: Run the test and the typecheck**

Run: `npx vitest run src/main/conductor/mcpSdk.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean. If typecheck cannot resolve the subpath imports, stop and re-check the installed SDK version's `typesVersions` (`npm ls @modelcontextprotocol/sdk`; it must be >= 1.30.0) rather than changing `tsconfig.main.json`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/conductor/mcpSdk.test.ts
git commit -m "feat: add MCP SDK dependency with CJS interop smoke test"
```

---

### Task 3: The driver seam — `mcpConfigPath` through to argv

The one CLI-specific fact (`--mcp-config`) stays inside `ClaudeDriver`. Everything above it passes an opaque path. The flag rides `buildSessionArgs`, so it is present on first spawn, on resume, and on the retry-as-fresh path — a relaunched conductor keeps its tools.

**Files:**
- Modify: `src/main/drivers/HarnessDriver.ts` (the `SessionLaunch` interface)
- Modify: `src/main/drivers/ClaudeDriver.ts` (`buildSessionArgs`)
- Modify: `src/main/TerminalService.ts` (`TerminalServiceOptions` + the `buildSessionArgs` call in `initClaude`)
- Test: `src/main/drivers/ClaudeDriver.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SessionLaunch.mcpConfigPath?: string`; `TerminalServiceOptions.mcpConfigPath?: string`. **Deliberately NOT added to `TerminalCreateOptions` in `src/shared/types.ts`** — the renderer never sees or sends this path; main injects it (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/drivers/ClaudeDriver.test.ts
import { describe, expect, it } from 'vitest';
import { ClaudeDriver } from './ClaudeDriver';
import type { HarnessConfig } from './HarnessDriver';

const driver = new ClaudeDriver();
const config: HarnessConfig = { extraArgs: ['--verbose'] };

describe('buildSessionArgs MCP registration', () => {
  it('appends --mcp-config before the harness extra args when a path is set', () => {
    const args = driver.buildSessionArgs(config, {
      sessionId: 'abc',
      resume: false,
      mcpConfigPath: '/tmp/conductor.json',
    });
    expect(args).toEqual([
      '--session-id', 'abc',
      '--mcp-config', '/tmp/conductor.json',
      '--verbose',
    ]);
  });

  it('omits the flag entirely when no path is given', () => {
    const args = driver.buildSessionArgs(config, { sessionId: 'abc', resume: true });
    expect(args).toEqual(['--resume', 'abc', '--verbose']);
  });

  it('keeps the flag on resume, so a relaunched conductor keeps its tools', () => {
    const args = driver.buildSessionArgs(config, {
      sessionId: 'abc',
      resume: true,
      mcpConfigPath: '/tmp/c.json',
    });
    expect(args).toEqual(['--resume', 'abc', '--mcp-config', '/tmp/c.json', '--verbose']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/drivers/ClaudeDriver.test.ts`
Expected: FAIL — `mcpConfigPath` not in type `SessionLaunch` (typecheck error) or args missing the flag.

- [ ] **Step 3: Re-verify the CLI flag, then implement**

Run: `claude --help 2>&1 | grep -A2 'mcp-config'`
Expected: `--mcp-config <configs...>  Load MCP servers from JSON files or strings (space-separated)`. If the flag is absent or renamed, STOP and flag it — do not guess.

In `src/main/drivers/HarnessDriver.ts`, add to the `SessionLaunch` interface (after `model?`):

```ts
    /**
     * MCP config file to register with the CLI, when the session carries one.
     *
     * Set only for conductor sessions. A driver whose CLI cannot load MCP
     * servers from a config file must throw when this is set — silently
     * ignoring it would launch a conductor with no hands.
     */
    mcpConfigPath?: string;
```

In `src/main/drivers/ClaudeDriver.ts`, change `buildSessionArgs`'s return to:

```ts
        const mcp = launch.mcpConfigPath ? ['--mcp-config', launch.mcpConfigPath] : [];
        // The harness's own extra args come last so a hand-written `--model`
        // there still wins: Claude takes the last occurrence of a flag.
        return [...base, ...model, ...mcp, ...config.extraArgs];
```

In `src/main/TerminalService.ts`, add to `TerminalServiceOptions` (after `model?: string;`):

```ts
    /**
     * MCP config file registered with the CLI on every launch of this
     * session. Set by main for conductor sessions only; opaque here — which
     * flag it becomes is the driver's business.
     */
    mcpConfigPath?: string;
```

and in `initClaude`, extend the `buildSessionArgs` call:

```ts
        const args = this.driver.buildSessionArgs(this.harness, {
            sessionId: this.options.claudeSessionId,
            resume,
            model: this.options.model,
            mcpConfigPath: this.options.mcpConfigPath,
        });
```

- [ ] **Step 4: Run the test and typecheck to verify they pass**

Run: `npx vitest run src/main/drivers/ClaudeDriver.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/drivers/HarnessDriver.ts src/main/drivers/ClaudeDriver.ts src/main/drivers/ClaudeDriver.test.ts src/main/TerminalService.ts
git commit -m "feat: thread an opaque mcpConfigPath through the driver seam"
```

---

### Task 4: ConductorControlServer — endpoints, registration, config generation

The per-conductor endpoint: a private Unix socket plus a generated `--mcp-config` file pointing the `claude` CLI at the shim (Task 6). Registration is kind-gated here — `register` refuses anything that is not a conductor — and idempotent, because both the headless launch (Phase 2's `SessionLauncher`) and the pane-mount path (`TERMINAL_CREATE`) call it.

**Files:**
- Create: `src/main/conductor/ConductorControlServer.ts`
- Test: `src/main/conductor/ConductorControlServer.test.ts`

**Interfaces:**
- Consumes: Phase 0 v6 types (`Workspace`, `Session`, `NewSessionFields`, `generateId` from `src/shared/workspace.ts`); MCP SDK (Task 2).
- Produces (used by Tasks 5, 6, 8):
  - `type ConductorSessionStatus = 'working' | 'ready' | 'needs-attention' | 'exited'`
  - `interface ConductorControlDeps { getWorkspaces(): Workspace[]; launchSession(workspaceId: string, fields: NewSessionFields & { initialPrompt?: string }): Promise<Session>; queuePrompt(instanceId: string, prompt: string): boolean; getStatus(instanceId: string): ConductorSessionStatus; shimEntryPath(): string; configDir(): string; }`
  - `class ConductorControlServer { constructor(deps: ConductorControlDeps); register(session: Session): Promise<string>; unregister(sessionId: string): void; dispose(): void; }`
  - `mcpConfigForSession(session: Session, control: { register(session: Session): Promise<string> }): Promise<string | undefined>` — the kind gate, one implementation, used by both launch paths.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/conductor/ConductorControlServer.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session, Workspace } from '../../shared/workspace';
import {
  ConductorControlServer,
  mcpConfigForSession,
  type ConductorControlDeps,
} from './ConductorControlServer';

let configDir: string;
let control: ConductorControlServer;
let deps: ConductorControlDeps;

/** v6 session fixture. Cast tolerates fields v6 adds beyond this plan's use. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cond-1',
    name: 'conductor',
    workspaceId: 'ws-1',
    instanceId: 'inst-cond',
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-1',
    groupId: 'grp-1',
    kind: 'conductor',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  } as Session;
}

export function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-1', name: 'app', path: '/repos/app', isGitRepo: true, createdAt: 0 },
      { id: 'scope-2', name: 'parent', path: '/repos/parent', isGitRepo: false, createdAt: 0 },
    ],
    groups: [{ id: 'grp-1', name: 'symbalance-api', createdAt: 0 }],
    sessions: [makeSession()],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Workspace;
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-'));
  deps = {
    getWorkspaces: vi.fn(() => [makeWorkspace()]),
    launchSession: vi.fn(),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
    shimEntryPath: () => '/fake/dist/conductorShim.js',
    configDir: () => configDir,
  };
  control = new ConductorControlServer(deps);
});

afterEach(() => {
  control.dispose();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('register', () => {
  it('refuses a non-conductor session', async () => {
    await expect(control.register(makeSession({ kind: 'interactive' }))).rejects.toThrow(
      /not a conductor/
    );
  });

  it('writes a per-session mcp config wiring the shim to a private socket', async () => {
    const configPath = await control.register(makeSession());

    expect(configPath).toBe(path.join(configDir, 'cond-1.json'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = config.mcpServers.consola;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(['/fake/dist/conductorShim.js']);
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(entry.env.CONSOLA_CONDUCTOR_SOCKET).toBeTruthy();
    expect(entry.env.CONSOLA_CONDUCTOR_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    // The socket actually listens.
    expect(fs.existsSync(entry.env.CONSOLA_CONDUCTOR_SOCKET)).toBe(true);
  });

  it('is idempotent: a second register returns the same config path', async () => {
    const first = await control.register(makeSession());
    const second = await control.register(makeSession());
    expect(second).toBe(first);
  });

  it('keeps the config file private to the user', async () => {
    const configPath = await control.register(makeSession());
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe('unregister', () => {
  it('removes the config file and the socket', async () => {
    const configPath = await control.register(makeSession());
    const socketPath = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env
      .CONSOLA_CONDUCTOR_SOCKET;

    control.unregister('cond-1');

    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('tolerates an unknown session id', () => {
    expect(() => control.unregister('never-registered')).not.toThrow();
  });
});

describe('mcpConfigForSession', () => {
  it("hands a conductor its config path and an interactive session nothing", async () => {
    await expect(mcpConfigForSession(makeSession(), control)).resolves.toMatch(/cond-1\.json$/);
    await expect(
      mcpConfigForSession(makeSession({ id: 'i-1', kind: 'interactive' }), control)
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/conductor/ConductorControlServer.test.ts`
Expected: FAIL — cannot resolve `./ConductorControlServer`.

- [ ] **Step 3: Write the registration half of ConductorControlServer.ts**

```ts
// src/main/conductor/ConductorControlServer.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
    generateId,
    type NewSessionFields,
    type Session,
    type Workspace,
} from '../../shared/workspace';

/**
 * The control surface a conductor session drives Consola with.
 *
 * One endpoint per conductor: a private Unix socket plus a generated
 * `--mcp-config` file that has the CLI spawn `conductorShim.ts`, a dumb pipe
 * between its stdio and our socket. The tool logic runs here, in the main
 * process, next to the session records and terminals it acts on.
 *
 * Security boundary: a tool call is authenticated by which conductor's socket
 * it arrived on — the socket path and handshake token exist only in that
 * conductor's config file. Scope of authority is that conductor's group,
 * resolved fresh from the records on every call, never trusted from
 * arguments. Tokens never appear in tool results.
 */

export type ConductorSessionStatus = 'working' | 'ready' | 'needs-attention' | 'exited';

export interface ConductorControlDeps {
    getWorkspaces(): Workspace[];
    launchSession(
        workspaceId: string,
        fields: NewSessionFields & { initialPrompt?: string }
    ): Promise<Session>;
    /** Enqueue on the session's guarded FIFO. False when no live terminal. */
    queuePrompt(instanceId: string, prompt: string): boolean;
    getStatus(instanceId: string): ConductorSessionStatus;
    /** Absolute path to the compiled stdio shim the CLI will spawn. */
    shimEntryPath(): string;
    /** Directory for per-session MCP config files. Created on demand. */
    configDir(): string;
}

interface Endpoint {
    socketPath: string;
    token: string;
    configPath: string;
    server: net.Server;
}

/** Longest a client may stall mid-handshake before the line is cut. */
const HANDSHAKE_LIMIT_BYTES = 4096;

export class ConductorControlServer {
    private readonly endpoints = new Map<string, Endpoint>();

    constructor(private readonly deps: ConductorControlDeps) {}

    /**
     * Ensure this conductor has a live endpoint; returns its config path.
     *
     * Idempotent because both launch paths call it: the headless spawn at
     * creation, and TERMINAL_CREATE when a pane mounts after an app restart.
     * The config references this run's socket, so it is rewritten per run.
     */
    public async register(session: Session): Promise<string> {
        if (session.kind !== 'conductor') {
            throw new Error(
                `Session ${session.id} is not a conductor; refusing to register control tools.`
            );
        }

        const existing = this.endpoints.get(session.id);
        if (existing) return existing.configPath;

        const token = crypto.randomBytes(16).toString('hex');
        const socketPath = newSocketPath();
        const server = net.createServer((socket) => this.handleConnection(session.id, socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => resolve());
        });

        const configPath = path.join(this.deps.configDir(), `${session.id}.json`);
        const config = {
            mcpServers: {
                consola: {
                    type: 'stdio',
                    command: process.execPath,
                    args: [this.deps.shimEntryPath()],
                    env: {
                        // Turns the Electron binary into plain Node for the
                        // shim — no system Node install is assumed.
                        ELECTRON_RUN_AS_NODE: '1',
                        CONSOLA_CONDUCTOR_SOCKET: socketPath,
                        CONSOLA_CONDUCTOR_TOKEN: token,
                    },
                },
            },
        };
        await fs.promises.mkdir(this.deps.configDir(), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), {
            mode: 0o600,
        });

        this.endpoints.set(session.id, { socketPath, token, configPath, server });
        return configPath;
    }

    /** Close a conductor's endpoint and remove its socket and config file. */
    public unregister(sessionId: string): void {
        const endpoint = this.endpoints.get(sessionId);
        if (!endpoint) return;
        this.endpoints.delete(sessionId);
        endpoint.server.close();
        for (const doomed of [endpoint.socketPath, endpoint.configPath]) {
            try {
                fs.unlinkSync(doomed);
            } catch {
                // Already gone, or a Windows named pipe with no file to unlink.
            }
        }
    }

    public dispose(): void {
        for (const sessionId of [...this.endpoints.keys()]) {
            this.unregister(sessionId);
        }
    }

    /**
     * First line on a new connection is a handshake `{"token": "..."}\n`;
     * everything after is JSON-RPC handed to a fresh MCP server instance.
     * A wrong token gets a closed socket and nothing else.
     */
    private handleConnection(conductorSessionId: string, socket: net.Socket): void {
        const endpoint = this.endpoints.get(conductorSessionId);
        if (!endpoint) {
            socket.destroy();
            return;
        }

        let buffer = '';
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const newline = buffer.indexOf('\n');
            if (newline === -1) {
                if (buffer.length > HANDSHAKE_LIMIT_BYTES) socket.destroy();
                return;
            }
            socket.off('data', onData);

            let authenticated = false;
            try {
                authenticated = JSON.parse(buffer.slice(0, newline)).token === endpoint.token;
            } catch {
                // Not even JSON: treated the same as a wrong token.
            }
            if (!authenticated) {
                socket.destroy();
                return;
            }

            // Bytes that arrived glued to the handshake belong to the
            // JSON-RPC stream; push them back for the transport to read.
            const rest = buffer.slice(newline + 1);
            if (rest.length > 0) socket.unshift(Buffer.from(rest, 'utf8'));

            const transport = new StdioServerTransport(socket, socket);
            void this.buildServerFor(conductorSessionId).connect(transport);
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    }

    /**
     * The MCP surface for one conductor. Implemented in Task 6; the stub
     * keeps Task 4 compiling and failing honestly if reached.
     */
    public buildServerFor(conductorSessionId: string): McpServer {
        void conductorSessionId;
        throw new Error('buildServerFor is implemented in Task 6.');
    }
}

/**
 * A fresh, unguessable rendezvous path. Random per registration, so a stale
 * file from a crash can never collide, and knowing one run's path buys
 * nothing in the next.
 */
function newSocketPath(): string {
    const suffix = crypto.randomBytes(8).toString('hex');
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\consola-conductor-${suffix}`
        : path.join(os.tmpdir(), `consola-conductor-${suffix}.sock`);
}

/**
 * The kind gate both launch paths share: conductors get a config path,
 * everything else gets nothing. One implementation, so "interactive sessions
 * never carry MCP registration" is a single tested fact.
 */
export async function mcpConfigForSession(
    session: Session,
    control: { register(session: Session): Promise<string> }
): Promise<string | undefined> {
    return session.kind === 'conductor' ? control.register(session) : undefined;
}
```

(`McpServer`, `z`, `generateId`, `NewSessionFields` are imported now and used from Task 5/6 onward; if the linter objects to unused imports at this step, leave them — the next task consumes them.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/conductor/ConductorControlServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/conductor/ConductorControlServer.ts src/main/conductor/ConductorControlServer.test.ts
git commit -m "feat: per-conductor MCP endpoints with kind-gated registration"
```

---

### Task 5: Tool handlers and the group boundary

The four tools as plain methods, unit-testable without any transport. Identity (`conductorSessionId`) comes from the endpoint the call arrived on, never from arguments; the group and workspace are re-resolved from the live records on every call, so a conductor whose group changed acts on current truth.

**Files:**
- Modify: `src/main/conductor/ConductorControlServer.ts` (add the handler methods)
- Test: `src/main/conductor/ConductorControlServer.test.ts` (extend)

**Interfaces:**
- Consumes: `ConductorControlDeps` (Task 4), v6 records.
- Produces (used by Task 6's MCP wiring):
  - `handleSpawnSession(conductorSessionId: string, args: { name: string; scopePath?: string; cwd?: string; prompt: string }): Promise<{ sessionId: string; instanceId: string }>`
  - `handleSendPrompt(conductorSessionId: string, args: { sessionId: string; prompt: string }): { queued: true }`
  - `handleSessionStatus(conductorSessionId: string, args: { sessionId: string }): { status: ConductorSessionStatus; name: string }`
  - `handleGroupStatus(conductorSessionId: string): Array<{ sessionId: string; name: string; status: ConductorSessionStatus }>`

- [ ] **Step 1: Write the failing tests (append to ConductorControlServer.test.ts)**

```ts
describe('tool handlers enforce the group boundary', () => {
  const worker = () =>
    makeSession({ id: 'w-1', name: 'adapter · implement', instanceId: 'inst-w1', kind: 'interactive' });
  const foreign = () =>
    makeSession({ id: 'f-1', name: 'other', instanceId: 'inst-f1', kind: 'interactive', groupId: 'grp-OTHER' });

  beforeEach(() => {
    deps.getWorkspaces = vi.fn(() => [
      makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
    ]);
    control = new ConductorControlServer(deps);
  });

  describe('handleSpawnSession', () => {
    it('rejects a scopePath that is not one of the workspace scopes', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/somewhere/else',
          prompt: 'go',
        })
      ).rejects.toThrow(/not one of this workspace's scopes/);
      expect(deps.launchSession).not.toHaveBeenCalled();
    });

    it("forces the conductor's own group and kind interactive, whatever the args", async () => {
      deps.launchSession = vi.fn(async (_wsId, fields) =>
        makeSession({ id: 'new-1', instanceId: 'inst-new', ...fields } as Partial<Session>)
      );
      control = new ConductorControlServer(deps);

      const result = await control.handleSpawnSession('cond-1', {
        name: 'worker',
        scopePath: '/repos/parent',
        prompt: '[task:1] implement the adapter',
      });

      expect(result.sessionId).toBe('new-1');
      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.groupId).toBe('grp-1');          // the conductor's group, not an argument
      expect(fields.kind).toBe('interactive');
      expect(fields.scopeId).toBe('scope-2');        // resolved from scopePath
      expect(fields.harnessId).toBe('default');      // inherited from the conductor
      expect(fields.initialPrompt).toBe('[task:1] implement the adapter');
    });

    it("defaults to the conductor's own scope when scopePath is omitted", async () => {
      deps.launchSession = vi.fn(async () => makeSession({ id: 'new-2', instanceId: 'i2' }));
      control = new ConductorControlServer(deps);

      await control.handleSpawnSession('cond-1', { name: 'w', prompt: 'go' });

      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.scopeId).toBe('scope-1');
    });

    it('rejects a cwd outside the resolved scope', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/repos/app',
          cwd: '/repos/parent/other',
          prompt: 'go',
        })
      ).rejects.toThrow(/cwd must be inside/);
    });

    it('rejects a caller that is not a conductor — a worker id cannot drive the tools', async () => {
      await expect(
        control.handleSpawnSession('w-1', { name: 'x', prompt: 'go' })
      ).rejects.toThrow(/not a conductor/);
    });
  });

  describe('handleSendPrompt', () => {
    it('enqueues on a group member through the guarded FIFO', () => {
      const result = control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'continue' });
      expect(result).toEqual({ queued: true });
      expect(deps.queuePrompt).toHaveBeenCalledWith('inst-w1', 'continue');
    });

    it('rejects a session outside the group', () => {
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'f-1', prompt: 'hi' })
      ).toThrow(/not in your group/);
      expect(deps.queuePrompt).not.toHaveBeenCalled();
    });

    it('reports a dead terminal instead of silently dropping the prompt', () => {
      deps.queuePrompt = vi.fn(() => false);
      control = new ConductorControlServer(deps);
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'hi' })
      ).toThrow(/no live terminal/);
    });
  });

  describe('handleSessionStatus', () => {
    it('answers with the terse status and name for a group member', () => {
      deps.getStatus = vi.fn(() => 'needs-attention' as const);
      control = new ConductorControlServer(deps);
      expect(control.handleSessionStatus('cond-1', { sessionId: 'w-1' })).toEqual({
        status: 'needs-attention',
        name: 'adapter · implement',
      });
    });

    it('rejects a session outside the group', () => {
      expect(() => control.handleSessionStatus('cond-1', { sessionId: 'f-1' })).toThrow(
        /not in your group/
      );
    });
  });

  describe('handleGroupStatus', () => {
    it('lists every group member with its status — the bell, not the package', () => {
      const rows = control.handleGroupStatus('cond-1');
      expect(rows).toEqual([
        { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
        { sessionId: 'w-1', name: 'adapter · implement', status: 'ready' },
      ]);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/conductor/ConductorControlServer.test.ts`
Expected: FAIL — the `handle*` methods do not exist.

- [ ] **Step 3: Implement the handlers (add to the ConductorControlServer class)**

```ts
    /**
     * Who is calling, resolved fresh from the records on every tool call.
     *
     * The id comes from the endpoint the request arrived on, so this cannot
     * be spoofed by arguments; re-resolving means a deleted conductor or a
     * changed group takes effect immediately.
     */
    private resolveConductor(conductorSessionId: string): {
        workspace: Workspace;
        conductor: Session;
        groupId: string;
    } {
        for (const workspace of this.deps.getWorkspaces()) {
            const conductor = workspace.sessions.find((s) => s.id === conductorSessionId);
            if (!conductor) continue;
            if (conductor.kind !== 'conductor') {
                throw new Error('Calling session is not a conductor.');
            }
            if (!conductor.groupId) {
                throw new Error('Conductor has no group; nothing to act on.');
            }
            return { workspace, conductor, groupId: conductor.groupId };
        }
        throw new Error('Conductor session no longer exists.');
    }

    private groupMembers(workspace: Workspace, groupId: string): Session[] {
        return workspace.sessions.filter((s) => s.groupId === groupId);
    }

    public async handleSpawnSession(
        conductorSessionId: string,
        args: { name: string; scopePath?: string; cwd?: string; prompt: string }
    ): Promise<{ sessionId: string; instanceId: string }> {
        const { workspace, conductor, groupId } = this.resolveConductor(conductorSessionId);

        const scope = args.scopePath
            ? workspace.scopes.find((s) => path.resolve(s.path) === path.resolve(args.scopePath!))
            : workspace.scopes.find((s) => s.id === conductor.scopeId);
        if (!scope) {
            throw new Error(
                `scopePath is not one of this workspace's scopes: ${args.scopePath ?? '(conductor scope missing)'}`
            );
        }

        if (args.cwd) {
            const relative = path.relative(path.resolve(scope.path), path.resolve(args.cwd));
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`cwd must be inside the scope ${scope.path}`);
            }
        }

        // groupId and kind come from the calling conductor's record, never
        // from arguments: a conductor cannot spawn outside its own group, and
        // cannot mint further conductors. Workers inherit its harness so the
        // whole group runs as one login.
        const spawned = await this.deps.launchSession(workspace.id, {
            name: args.name,
            workspaceId: workspace.id,
            instanceId: generateId(),
            harnessId: conductor.harnessId,
            scopeId: scope.id,
            cwd: args.cwd,
            groupId,
            kind: 'interactive',
            initialPrompt: args.prompt,
        } as NewSessionFields & { initialPrompt?: string });

        return { sessionId: spawned.id, instanceId: spawned.instanceId };
    }

    public handleSendPrompt(
        conductorSessionId: string,
        args: { sessionId: string; prompt: string }
    ): { queued: true } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);

        if (!this.deps.queuePrompt(target.instanceId, args.prompt)) {
            throw new Error(`Session ${args.sessionId} has no live terminal; prompt not delivered.`);
        }
        return { queued: true };
    }

    public handleSessionStatus(
        conductorSessionId: string,
        args: { sessionId: string }
    ): { status: ConductorSessionStatus; name: string } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);
        return { status: this.deps.getStatus(target.instanceId), name: target.name };
    }

    public handleGroupStatus(
        conductorSessionId: string
    ): Array<{ sessionId: string; name: string; status: ConductorSessionStatus }> {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        return this.groupMembers(workspace, groupId).map((member) => ({
            sessionId: member.id,
            name: member.name,
            status: this.deps.getStatus(member.instanceId),
        }));
    }
```

Seam note: if Phase 0's `NewSessionFields` turns out to be an exact `Pick` that rejects a field used above (e.g. it generates `instanceId` itself), adjust only the object literal in `handleSpawnSession` and its test assertions — the tool's contract (`{ sessionId, instanceId }` out, group/kind enforced) must not change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/conductor/ConductorControlServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/conductor/ConductorControlServer.ts src/main/conductor/ConductorControlServer.test.ts
git commit -m "feat: conductor tools with server-side group boundary"
```

---

### Task 6: The MCP surface, the stdio shim, and the integration test

Wire the handlers into an `McpServer` per conductor, ship the shim `claude` spawns, and prove the whole pipe with a fake conductor client: MCP over the real socket, handshake included, with `launchSession` mocked.

**Files:**
- Modify: `src/main/conductor/ConductorControlServer.ts` (replace the `buildServerFor` stub)
- Create: `src/main/conductor/conductorShim.ts`
- Modify: `electron-builder.yml` (asarUnpack the shim)
- Test: `src/main/conductor/ConductorControlServer.integration.test.ts`

**Interfaces:**
- Consumes: handlers (Task 5), endpoints (Task 4), MCP SDK (Task 2).
- Produces: the four registered MCP tools `consola_spawn_session`, `consola_send_prompt`, `consola_session_status`, `consola_group_status`; `conductorShim.js` at `dist/main/main/conductor/conductorShim.js` (referenced by Task 8's `shimEntryPath`).

- [ ] **Step 1: Write the failing integration test**

```ts
// src/main/conductor/ConductorControlServer.integration.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ConductorControlServer, type ConductorControlDeps } from './ConductorControlServer';
import { makeSession, makeWorkspace } from './ConductorControlServer.test';

/** A fake conductor: the MCP SDK client over a raw socket, like the shim pipes. */
class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readBuffer = new ReadBuffer();

  constructor(private readonly socket: net.Socket) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk) => {
      this.readBuffer.append(chunk);
      for (;;) {
        const message = this.readBuffer.readMessage();
        if (!message) break;
        this.onmessage?.(message);
      }
    });
    this.socket.on('error', (error) => this.onerror?.(error));
    this.socket.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

const TOOL_NAMES = [
  'consola_group_status',
  'consola_send_prompt',
  'consola_session_status',
  'consola_spawn_session',
];

let configDir: string;
let control: ConductorControlServer;
let deps: ConductorControlDeps;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-int-'));
  deps = {
    getWorkspaces: vi.fn(() => [
      makeWorkspace({
        sessions: [
          makeSession(),
          makeSession({ id: 'w-1', name: 'worker', instanceId: 'inst-w1', kind: 'interactive' }),
        ],
      }),
    ]),
    launchSession: vi.fn(async () =>
      makeSession({ id: 'spawned-1', instanceId: 'inst-spawned', kind: 'interactive' })
    ),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
    shimEntryPath: () => '/fake/shim.js',
    configDir: () => configDir,
  };
  control = new ConductorControlServer(deps);
});

afterEach(() => {
  control.dispose();
  fs.rmSync(configDir, { recursive: true, force: true });
});

function firstText(result: { content?: unknown }): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe('MCP surface (in-memory)', () => {
  it('exposes exactly the four consola tools', async () => {
    const server = control.buildServerFor('cond-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    await client.close();
  });

  it('answers group status tersely and spawns through the mocked launcher', async () => {
    const server = control.buildServerFor('cond-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const status = await client.callTool({ name: 'consola_group_status', arguments: {} });
    expect(JSON.parse(firstText(status))).toEqual([
      { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
      { sessionId: 'w-1', name: 'worker', status: 'ready' },
    ]);

    const spawned = await client.callTool({
      name: 'consola_spawn_session',
      arguments: { name: 'adapter', prompt: '[task:1] implement' },
    });
    expect(JSON.parse(firstText(spawned))).toEqual({
      sessionId: 'spawned-1',
      instanceId: 'inst-spawned',
    });
    expect(deps.launchSession).toHaveBeenCalledTimes(1);

    const rejected = await client.callTool({
      name: 'consola_send_prompt',
      arguments: { sessionId: 'not-in-group', prompt: 'hi' },
    });
    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toMatch(/not in your group/);

    await client.close();
  });
});

describe('the socket endpoint', () => {
  async function endpointEnv(): Promise<{ socketPath: string; token: string }> {
    const configPath = await control.register(makeSession());
    const env = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env;
    return { socketPath: env.CONSOLA_CONDUCTOR_SOCKET, token: env.CONSOLA_CONDUCTOR_TOKEN };
  }

  it('drops a connection with a wrong token before any MCP traffic', async () => {
    const { socketPath } = await endpointEnv();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(JSON.stringify({ token: 'wrong' }) + '\n');
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.destroyed).toBe(true);
  });

  it('serves a full MCP session after a correct handshake', async () => {
    const { socketPath, token } = await endpointEnv();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(JSON.stringify({ token }) + '\n');

    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await client.connect(new SocketClientTransport(socket));

    const result = await client.callTool({
      name: 'consola_session_status',
      arguments: { sessionId: 'w-1' },
    });
    expect(JSON.parse(firstText(result))).toEqual({ status: 'ready', name: 'worker' });

    await client.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/conductor/ConductorControlServer.integration.test.ts`
Expected: FAIL — `buildServerFor is implemented in Task 6.`

- [ ] **Step 3: Implement buildServerFor (replace the Task 4 stub)**

```ts
    /**
     * The MCP surface for one conductor. A fresh instance per connection —
     * identity is baked in from the endpoint, never read from arguments.
     * Results are single-line JSON of small structured objects: the bell,
     * not the package.
     */
    public buildServerFor(conductorSessionId: string): McpServer {
        const server = new McpServer({ name: 'consola', version: '1.0.0' });

        server.registerTool(
            'consola_spawn_session',
            {
                description:
                    'Start a worker session in your group. scopePath must be one of the ' +
                    "workspace's scopes (omit for your own scope); cwd must be inside it. " +
                    'Returns { sessionId, instanceId }.',
                inputSchema: {
                    name: z.string().min(1),
                    scopePath: z.string().optional(),
                    cwd: z.string().optional(),
                    prompt: z.string().min(1),
                },
            },
            (args) => this.asResult(() => this.handleSpawnSession(conductorSessionId, args))
        );

        server.registerTool(
            'consola_send_prompt',
            {
                description:
                    'Queue a prompt on a session in your group. Delivery waits for an ' +
                    'empty composer and never types into a menu.',
                inputSchema: {
                    sessionId: z.string().min(1),
                    prompt: z.string().min(1),
                },
            },
            (args) => this.asResult(() => this.handleSendPrompt(conductorSessionId, args))
        );

        server.registerTool(
            'consola_session_status',
            {
                description:
                    "One group member's state: working | ready | needs-attention | exited.",
                inputSchema: { sessionId: z.string().min(1) },
            },
            (args) => this.asResult(() => this.handleSessionStatus(conductorSessionId, args))
        );

        server.registerTool(
            'consola_group_status',
            {
                description: 'Every session in your group: [{ sessionId, name, status }].',
                inputSchema: {},
            },
            () => this.asResult(() => this.handleGroupStatus(conductorSessionId))
        );

        return server;
    }

    /** Uniform tool envelope: JSON on success, the bare message on failure. */
    private async asResult(run: () => unknown | Promise<unknown>) {
        try {
            const value = await run();
            return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
        } catch (error) {
            return {
                isError: true,
                content: [
                    {
                        type: 'text' as const,
                        text: error instanceof Error ? error.message : String(error),
                    },
                ],
            };
        }
    }
```

- [ ] **Step 4: Write the shim**

```ts
// src/main/conductor/conductorShim.ts
/**
 * The process `claude` spawns for the `consola` MCP server: a dumb pipe
 * between its stdio and the Consola main process's per-conductor socket.
 *
 * Runs under `ELECTRON_RUN_AS_NODE=1`, so this is plain Node — no Electron
 * APIs, no imports beyond `net`. All intelligence lives in
 * ConductorControlServer on the other end of the socket; keeping this dumb
 * means the security boundary has exactly one implementation.
 */
import * as net from 'net';

const socketPath = process.env.CONSOLA_CONDUCTOR_SOCKET;
const token = process.env.CONSOLA_CONDUCTOR_TOKEN;

if (!socketPath || !token) {
    process.stderr.write('consola conductor shim: missing CONSOLA_CONDUCTOR_SOCKET or _TOKEN\n');
    process.exit(1);
}

const socket = net.connect(socketPath);

socket.once('connect', () => {
    // Handshake first; everything after is the CLI's own JSON-RPC.
    socket.write(JSON.stringify({ token }) + '\n');
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
});

socket.on('close', () => process.exit(0));
socket.on('error', (error) => {
    process.stderr.write(`consola conductor shim: ${error.message}\n`);
    process.exit(1);
});
process.stdin.on('end', () => process.exit(0));
```

- [ ] **Step 5: Unpack the shim from asar**

In `electron-builder.yml`, extend `asarUnpack` (a child process cannot be handed a script inside the asar archive as reliably as one on disk):

```yaml
# node-pty loads pty.node and execs spawn-helper by path. Neither works from
# inside an asar archive, so every session terminal would fail to spawn.
# The conductor shim is spawned by the *claude* CLI, an outside process, so
# it too must exist as a real file on disk.
asarUnpack:
  - '**/node_modules/node-pty/**'
  - dist/main/main/conductor/conductorShim.js
```

- [ ] **Step 6: Run all conductor tests to verify they pass**

Run: `npx vitest run src/main/conductor && npm run typecheck`
Expected: PASS (scaffold, unit, integration, smoke), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/conductor/ConductorControlServer.ts src/main/conductor/ConductorControlServer.integration.test.ts src/main/conductor/conductorShim.ts electron-builder.yml
git commit -m "feat: conductor MCP surface, stdio shim, and socket integration test"
```

---

### Task 7: `createConductor` ordering and `WorkspaceService.updateGroup`

The orchestration flow's spine, as a dependency-injected function so ordering and the failure path are plain unit tests: **scaffold first** (fails fast on collision, before any record exists), **group second**, **session third**; a launch failure leaves the scaffold on disk (it is user-editable state, not garbage) and archives the group with the error surfaced.

**Files:**
- Modify: `src/main/state/WorkspaceService.ts` (add `updateGroup`)
- Test: `src/main/state/WorkspaceService.test.ts` (extend)
- Create: `src/main/conductor/createConductor.ts`
- Test: `src/main/conductor/createConductor.test.ts`

**Interfaces:**
- Consumes: Phase 0's `WorkspaceService.createGroup` and v6 `Group`; `scaffold` (Task 1); Phase 2's `launchSession` shape.
- Produces:
  - `WorkspaceService.updateGroup(workspaceId: string, groupId: string, updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>): void` — **check first whether Phase 0/2 already shipped an equivalent group-update method; if so, use that and skip the WorkspaceService half of this task, adapting the deps wiring in Task 8.**
  - `interface ConductorCreateRequest { workspaceId: string; scopeId: string; name: string; kickoff: string }` (defined in `src/shared/types.ts` in Task 8; local to the test here)
  - `createConductor(deps: CreateConductorDeps, request: ConductorCreateRequest): Promise<Group>`
  - `interface CreateConductorDeps { getWorkspace(id: string): Workspace | undefined; scaffold(scopePath: string, name: string, kickoff: string, workspaceName: string): Promise<string>; createGroup(workspaceId: string, fields: { name: string; parentGroupId?: string; conductorSessionId?: string }): Group; updateGroup(workspaceId: string, groupId: string, updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>): void; launchSession(workspaceId: string, fields: NewSessionFields & { initialPrompt?: string }): Promise<Session>; }`

- [ ] **Step 1: Write the failing WorkspaceService test (append to WorkspaceService.test.ts)**

```ts
  it('updates a group in place, leaving its siblings untouched', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'symbalance-api' });
    const other = service.createGroup(workspace.id, { name: 'untouched' });

    service.updateGroup(workspace.id, group.id, { conductorSessionId: 'cond-1' });

    const groups = build().getAll()[0].groups;
    expect(groups.find((g) => g.id === group.id)?.conductorSessionId).toBe('cond-1');
    expect(groups.find((g) => g.id === other.id)?.conductorSessionId).toBeUndefined();
  });

  it('archives a group via updateGroup', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'doomed' });

    service.updateGroup(workspace.id, group.id, { archivedAt: 123 });

    expect(build().getAll()[0].groups.find((g) => g.id === group.id)?.archivedAt).toBe(123);
  });
```

(If Phase 0's `createWorkspace` signature changed to scopes, adapt the fixture calls to that file's existing test helpers — the assertions stand.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/state/WorkspaceService.test.ts`
Expected: FAIL — `updateGroup` does not exist. (If it already exists from Phase 0/2, verify these behaviors are covered there and skip Step 3.)

- [ ] **Step 3: Implement updateGroup (add to WorkspaceService, after createGroup)**

```ts
  public updateGroup(
    workspaceId: string,
    groupId: string,
    updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>
  ): void {
    this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              groups: workspace.groups.map((group) =>
                group.id === groupId ? { ...group, ...updates } : group
              ),
              updatedAt: Date.now(),
            }
          : workspace
      )
    );
  }
```

(Import `Group` from `../../shared/workspace` alongside the existing type imports.)

- [ ] **Step 4: Write the failing createConductor test**

```ts
// src/main/conductor/createConductor.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../../shared/workspace';
import { createConductor, type CreateConductorDeps } from './createConductor';
import { makeSession, makeWorkspace } from './ConductorControlServer.test';

const request = {
  workspaceId: 'ws-1',
  scopeId: 'scope-1',
  name: 'symbalance-api',
  kickoff: 'Deliver the API.',
};

let calls: string[];
let deps: CreateConductorDeps;
const group = (): Group => ({ id: 'grp-new', name: 'symbalance-api', createdAt: 1 });

beforeEach(() => {
  calls = [];
  deps = {
    getWorkspace: vi.fn(() => makeWorkspace()),
    scaffold: vi.fn(async () => {
      calls.push('scaffold');
      return '/repos/app/conductor/symbalance-api';
    }),
    createGroup: vi.fn(() => {
      calls.push('createGroup');
      return group();
    }),
    updateGroup: vi.fn(() => {
      calls.push('updateGroup');
    }),
    launchSession: vi.fn(async () => {
      calls.push('launchSession');
      return makeSession({ id: 'cond-new', groupId: 'grp-new' });
    }),
  };
});

describe('createConductor', () => {
  it('runs scaffold -> group -> launch -> bind, in that order', async () => {
    const result = await createConductor(deps, request);

    expect(calls).toEqual(['scaffold', 'createGroup', 'launchSession', 'updateGroup']);
    expect(deps.scaffold).toHaveBeenCalledWith(
      '/repos/app',            // the host scope's path
      'symbalance-api',
      'Deliver the API.',
      'Sympower'
    );
    expect(deps.launchSession).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        name: 'conductor',
        scopeId: 'scope-1',
        cwd: '/repos/app/conductor/symbalance-api',
        kind: 'conductor',
        groupId: 'grp-new',
        initialPrompt: 'Deliver the API.',
      })
    );
    expect(deps.updateGroup).toHaveBeenCalledWith('ws-1', 'grp-new', {
      conductorSessionId: 'cond-new',
    });
    expect(result.conductorSessionId).toBe('cond-new');
  });

  it('a scaffold collision fails fast: no group, no session', async () => {
    deps.scaffold = vi.fn(async () => {
      throw new Error('Conductor directory already exists: /repos/app/conductor/symbalance-api');
    });

    await expect(createConductor(deps, request)).rejects.toThrow(/already exists/);
    expect(deps.createGroup).not.toHaveBeenCalled();
    expect(deps.launchSession).not.toHaveBeenCalled();
  });

  it('a launch failure archives the group and names the surviving directory', async () => {
    deps.launchSession = vi.fn(async () => {
      throw new Error('spawn failed');
    });

    await expect(createConductor(deps, request)).rejects.toThrow(
      /spawn failed[\s\S]*\/repos\/app\/conductor\/symbalance-api/
    );
    expect(deps.updateGroup).toHaveBeenCalledWith(
      'ws-1',
      'grp-new',
      expect.objectContaining({ archivedAt: expect.any(Number) })
    );
  });

  it('rejects an unknown workspace or scope before touching the disk', async () => {
    deps.getWorkspace = vi.fn(() => undefined);
    await expect(createConductor(deps, request)).rejects.toThrow(/Workspace not found/);

    deps.getWorkspace = vi.fn(() => makeWorkspace());
    await expect(
      createConductor(deps, { ...request, scopeId: 'nope' })
    ).rejects.toThrow(/Scope not found/);
    expect(deps.scaffold).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/main/conductor/createConductor.test.ts`
Expected: FAIL — cannot resolve `./createConductor`.

- [ ] **Step 6: Implement createConductor.ts**

```ts
// src/main/conductor/createConductor.ts
import type { Group, NewSessionFields, Session, Workspace } from '../../shared/workspace';
import { generateId } from '../../shared/workspace';

/**
 * The orchestration door's spine: scaffold -> group -> conductor session.
 *
 * Ordering is the error handling. The scaffold goes first because a name
 * collision must fail before any record exists; the group precedes the
 * session because the session is born pointing at it. A launch failure does
 * NOT roll the scaffold back — the generated files are user-editable state
 * from the moment they land — and archives the group so a half-born
 * orchestration never lingers in the sidebar.
 */

export interface ConductorCreateRequest {
    workspaceId: string;
    scopeId: string;
    name: string;
    kickoff: string;
}

export interface CreateConductorDeps {
    getWorkspace(id: string): Workspace | undefined;
    scaffold(
        scopePath: string,
        name: string,
        kickoff: string,
        workspaceName: string
    ): Promise<string>;
    createGroup(
        workspaceId: string,
        fields: { name: string; parentGroupId?: string; conductorSessionId?: string }
    ): Group;
    updateGroup(
        workspaceId: string,
        groupId: string,
        updates: Partial<Pick<Group, 'conductorSessionId' | 'archivedAt'>>
    ): void;
    launchSession(
        workspaceId: string,
        fields: NewSessionFields & { initialPrompt?: string }
    ): Promise<Session>;
}

export async function createConductor(
    deps: CreateConductorDeps,
    request: ConductorCreateRequest
): Promise<Group> {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${request.workspaceId}`);

    const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId);
    if (!scope) throw new Error(`Scope not found in workspace: ${request.scopeId}`);

    const conductorDir = await deps.scaffold(
        scope.path,
        request.name,
        request.kickoff,
        workspace.name
    );

    const group = deps.createGroup(request.workspaceId, { name: request.name });

    let session: Session;
    try {
        session = await deps.launchSession(request.workspaceId, {
            name: 'conductor',
            workspaceId: request.workspaceId,
            instanceId: generateId(),
            harnessId: workspace.defaultHarnessId,
            scopeId: request.scopeId,
            cwd: conductorDir,
            kind: 'conductor',
            groupId: group.id,
            initialPrompt: request.kickoff,
        } as NewSessionFields & { initialPrompt?: string });
    } catch (error) {
        deps.updateGroup(request.workspaceId, group.id, { archivedAt: Date.now() });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Conductor launch failed: ${message}\n` +
                `The generated files remain at ${conductorDir} — fix the cause and try again ` +
                'with the same name after removing that directory, or a new name.'
        );
    }

    deps.updateGroup(request.workspaceId, group.id, { conductorSessionId: session.id });
    return { ...group, conductorSessionId: session.id };
}
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `npx vitest run src/main/conductor/createConductor.test.ts src/main/state/WorkspaceService.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/conductor/createConductor.ts src/main/conductor/createConductor.test.ts src/main/state/WorkspaceService.ts src/main/state/WorkspaceService.test.ts
git commit -m "feat: conductor creation ordering with archived-group failure path"
```

---

### Task 8: Main-process wiring — IPC channel, handlers, launch-path gates, preload, bridge

Everything meets: the `conductor:create` intent, the `ConductorControlServer` instance with real deps, kind-gated registration on both launch paths, cleanup on session delete and quit, and the renderer-facing API. This task edits Phase 2's `SessionLauncher` — the one cross-phase file modification.

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/SessionLauncher.ts` (Phase 2 file — additive edit)
- Modify: `src/preload/preload.ts`
- Create: `src/renderer/services/conductorBridge.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7; Phase 2's `SessionLauncher` instance in `ipc-handlers.ts` (adapt the variable name to what Phase 2 shipped).
- Produces: IPC channel `CONDUCTOR_CREATE: 'conductor:create'`; `ConductorAPI { create(request: ConductorCreateRequest): Promise<Group> }` on `window.conductorAPI`; `conductorBridge.create(request)` for Task 9.

- [ ] **Step 1: Add the channel to src/shared/constants.ts**

Inside `IPC_CHANNELS`, after the workspace block:

```ts
    // Conductor orchestration (renderer -> main; main scaffolds, groups, launches)
    CONDUCTOR_CREATE: 'conductor:create',
```

- [ ] **Step 2: Add the API types to src/shared/types.ts**

```ts
/** The orchestration door's intent: everything main needs, nothing it owns. */
export interface ConductorCreateRequest {
    workspaceId: string;
    scopeId: string;
    name: string;
    kickoff: string;
}

/**
 * Conductor orchestration exposed to the renderer. One intent: create. The
 * conductor itself is an ordinary session and rides every existing API.
 */
export interface ConductorAPI {
    create: (request: ConductorCreateRequest) => Promise<Group>;
}
```

Add `Group` to the existing `import type { ... } from './workspace';` line, and `conductorAPI: ConductorAPI;` to the `declare global { interface Window { ... } }` block. `src/main/conductor/createConductor.ts` re-exports its own identical `ConductorCreateRequest`; change it to `import type { ConductorCreateRequest } from '../../shared/types';` and re-export (`export type { ConductorCreateRequest };`) so there is exactly one definition.

- [ ] **Step 3: Wire the main process (src/main/ipc-handlers.ts)**

Add imports:

```ts
import {
    ConductorControlServer,
    mcpConfigForSession,
    type ConductorSessionStatus,
} from './conductor/ConductorControlServer';
import { createConductor } from './conductor/createConductor';
import { scaffold } from './conductor/ConductorScaffold';
import type { ConductorCreateRequest } from '../shared/types';
```

After `terminalManager` is created (and after Phase 2's `SessionLauncher` instance — adapt `sessionLauncher` below to its actual variable name):

```ts
    // The conductor control plane. Tool logic runs here in main, next to the
    // records and terminals it acts on; each conductor session reaches it
    // through its own private socket (see ConductorControlServer).
    const conductorControl = new ConductorControlServer({
        getWorkspaces: () => workspaces.getAll(),
        launchSession: (workspaceId, fields) => sessionLauncher.launchSession(workspaceId, fields),
        queuePrompt: (instanceId, prompt) => {
            const terminal = manager.get(instanceId);
            if (!terminal || terminal.hasClaudeExited()) return false;
            terminal.queuePrompt(prompt);
            return true;
        },
        // Derived from the same signals Phase 2's terminal:status event
        // promotes. If TerminalManager gained a first-class status query,
        // replace this body with that one call.
        getStatus: (instanceId): ConductorSessionStatus => {
            const terminal = manager.get(instanceId);
            if (!terminal || terminal.hasClaudeExited()) return 'exited';
            if (terminal.awaitingConfirmation()) return 'needs-attention';
            if (terminal.busy()) return 'working';
            return 'ready';
        },
        // In the packaged app the shim must be a real file on disk — the
        // claude CLI, an outside process, spawns it. Hence asarUnpack.
        shimEntryPath: () =>
            path
                .join(__dirname, 'conductor/conductorShim.js')
                .replace('app.asar', 'app.asar.unpacked'),
        configDir: () => path.join(app.getPath('userData'), 'conductor-mcp'),
    });
    sessionLauncher.conductorControl = conductorControl;
    app.on('will-quit', () => conductorControl.dispose());

    ipcMain.handle(IPC_CHANNELS.CONDUCTOR_CREATE, (_event, request: ConductorCreateRequest) =>
        createConductor(
            {
                getWorkspace: (id) => workspaces.getAll().find((workspace) => workspace.id === id),
                scaffold,
                createGroup: (workspaceId, fields) => workspaces.createGroup(workspaceId, fields),
                updateGroup: (workspaceId, groupId, updates) =>
                    workspaces.updateGroup(workspaceId, groupId, updates),
                launchSession: (workspaceId, fields) =>
                    sessionLauncher.launchSession(workspaceId, fields),
            },
            request
        )
    );
```

In the `TERMINAL_CREATE` handler, make the callback `async` and, immediately before the `return manager.ensure(...)` call, add — then pass `mcpConfigPath` as the last property of the options object given to `manager.ensure`:

```ts
        // Conductors get their control tools back on every relaunch: the
        // config file references this run's socket, so it is (re)generated
        // before the PTY spawns. Kind-gated — every other session passes
        // through untouched, and the renderer never sees the path.
        const record = workspaces
            .getAll()
            .flatMap((workspace) => workspace.sessions)
            .find((session) => session.instanceId === instanceId);
        const mcpConfigPath = record
            ? await mcpConfigForSession(record, conductorControl)
            : undefined;
```

In the `WORKSPACE_SESSION_DELETE` handler, before the delete: `conductorControl.unregister(sessionId);`. In the `WORKSPACE_DELETE` handler, next to the existing stranded-terminal teardown loop: `doomed?.sessions.forEach((session) => conductorControl.unregister(session.id));`.

- [ ] **Step 4: Gate SessionLauncher (Phase 2 file — additive edit)**

In `src/main/SessionLauncher.ts` add the collaborator property to the class and the gate where the spawn options are composed (after the session record exists, before the PTY spawns). Exact insertion point depends on Phase 2's delivered code; the addition is:

```ts
import { mcpConfigForSession } from './conductor/ConductorControlServer';
import type { Session } from '../shared/workspace';

    /**
     * Kind-gated MCP registration, set at wiring time (ipc-handlers).
     * Optional so unit tests and early boot need no conductor machinery.
     */
    public conductorControl?: { register(session: Session): Promise<string> };
```

and, in `launchSession`, with `session` being the freshly created record:

```ts
        const mcpConfigPath = this.conductorControl
            ? await mcpConfigForSession(session, this.conductorControl)
            : undefined;
```

then include `mcpConfigPath` in the `TerminalServiceOptions` it passes to the terminal spawn. Add one test to Phase 2's `SessionLauncher.test.ts` (adapting to its existing fixtures):

```ts
  it('registers MCP config for conductor sessions only', async () => {
    const register = vi.fn(async () => '/tmp/cond.json');
    launcher.conductorControl = { register };

    await launcher.launchSession(workspaceId, conductorFields);   // kind: 'conductor'
    expect(register).toHaveBeenCalledTimes(1);
    // Assert the spawn options captured by the test's terminal fake carry
    // mcpConfigPath: '/tmp/cond.json'.

    await launcher.launchSession(workspaceId, interactiveFields); // kind: 'interactive'
    expect(register).toHaveBeenCalledTimes(1);                    // unchanged
  });
```

- [ ] **Step 5: Expose the API (preload + bridge)**

`src/preload/preload.ts` — add `ConductorCreateRequest` to the types import and `Group` to the workspace types import, then after the `workspaceAPI` block:

```ts
// Conductor orchestration: one intent. The conductor itself is an ordinary
// session and rides the terminal and workspace APIs above.
contextBridge.exposeInMainWorld('conductorAPI', {
    create: (request: ConductorCreateRequest): Promise<Group> =>
        ipcRenderer.invoke(IPC_CHANNELS.CONDUCTOR_CREATE, request),
});
```

Create `src/renderer/services/conductorBridge.ts`:

```ts
import type { ConductorCreateRequest } from '../../shared/types';
import type { Group } from '../../shared/workspace';

/**
 * Bridge to conductor orchestration owned by the main process.
 *
 * One intent: create. Main scaffolds the directory, creates the group, and
 * launches the conductor session; the renderer learns the rest through the
 * ordinary workspace-changed broadcast.
 */
export const conductorBridge = {
    create(request: ConductorCreateRequest): Promise<Group> {
        return window.conductorAPI.create(request);
    },
};
```

- [ ] **Step 6: Typecheck and full test run**

Run: `npm run typecheck && npm test`
Expected: clean and green. Type errors here almost always mean a Phase 0/2 name drifted from this plan's contracts — fix at the wiring call site, not in the tested conductor modules.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/main/ipc-handlers.ts src/main/SessionLauncher.ts src/main/SessionLauncher.test.ts src/main/conductor/createConductor.ts src/preload/preload.ts src/renderer/services/conductorBridge.ts
git commit -m "feat: conductor:create intent and kind-gated MCP registration on both launch paths"
```

---

### Task 9: The orchestration door — dialog and menu item

The dialog from mockup scene 5 (`.superpowers/brainstorm/87378-1787218296/content/full-flow.html`): name, kickoff textarea, host-scope select, a read-only preview of the files about to be generated, and the "Start conductor" action. Phase 2 shipped the ＋ New menu with a disabled "Orchestration…" item; this task enables it.

**Files:**
- Create: `src/renderer/components/Dialogs/OrchestrationDialog.tsx`
- Modify: `src/renderer/components/Dialogs/styles.css`
- Modify: the Phase 2 New-menu component — locate it with `grep -rn "Orchestration" src/renderer/` (it renders the disabled item)

**Interfaces:**
- Consumes: `conductorBridge.create` (Task 8); v6 `Workspace`/`Scope`/`Group` types; Phase 2's group-selection mechanism (whatever the Groups sidebar uses).
- Produces: `OrchestrationDialog({ workspace, open, onOpenChange, onCreated })`.

- [ ] **Step 1: Write the dialog component**

```tsx
// src/renderer/components/Dialogs/OrchestrationDialog.tsx
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { conductorBridge } from '../../services/conductorBridge';
import type { Group, Scope, Workspace } from '../../../shared/workspace';
import './styles.css';

/** Mirrors CONDUCTOR_NAME_PATTERN in main's ConductorScaffold. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface OrchestrationDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new group so the caller can select it. */
  onCreated: (group: Group) => void;
}

/**
 * The orchestration door (mockup scene 5): one kickoff box. Everything
 * agent-deck makes users hand-author, Consola generates — as real files, and
 * the preview says exactly where they will land before anything is written.
 */
export function OrchestrationDialog({
  workspace,
  open,
  onOpenChange,
  onCreated,
}: OrchestrationDialogProps) {
  const [name, setName] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [scopeId, setScopeId] = useState(workspace.scopes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_PATTERN.test(name);
  const hostScope = workspace.scopes.find((scope) => scope.id === scopeId);
  const canSubmit = nameValid && kickoff.trim().length > 0 && Boolean(hostScope) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const group = await conductorBridge.create({
        workspaceId: workspace.id,
        scopeId,
        name,
        kickoff,
      });
      onOpenChange(false);
      setName('');
      setKickoff('');
      onCreated(group);
    } catch (raised) {
      setError(raised instanceof Error ? raised.message : String(raised));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="orchestration-dialog">
          <div className="orchestration-dialog-header">
            <Dialog.Title>New orchestration</Dialog.Title>
            <Dialog.Close asChild>
              <button className="orchestration-dialog-close" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <label className="orchestration-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="symbalance-api"
              autoFocus
            />
            {name.length > 0 && !nameValid && (
              <span className="orchestration-field-error">
                Letters, digits, dots, dashes and underscores only.
              </span>
            )}
          </label>

          <label className="orchestration-field">
            <span>Kickoff — the conductor takes it from here</span>
            <textarea
              rows={5}
              value={kickoff}
              onChange={(event) => setKickoff(event.target.value)}
              placeholder="Deliver the feature across the repos involved. Split into tasks, assign workers per repo, escalate contradictions to me."
            />
          </label>

          <label className="orchestration-field">
            <span>Host scope — where the conductor directory is generated</span>
            <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
              {workspace.scopes.map((scope: Scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.name} — {scope.path}
                </option>
              ))}
            </select>
          </label>

          <div className="orchestration-field">
            <span>Generated · editable on disk</span>
            <pre className="orchestration-preview">
{`${hostScope?.path ?? '<scope>'}/conductor/${nameValid ? name : '<name>'}/
  CLAUDE.md   · role, reading order
  POLICY.md   · auto vs escalate rules
  state.json  · survives compaction`}
            </pre>
          </div>

          {error && <div className="orchestration-error">{error}</div>}

          <div className="orchestration-dialog-footer">
            <Dialog.Close asChild>
              <button className="orchestration-button ghost">Cancel</button>
            </Dialog.Close>
            <button className="orchestration-button" disabled={!canSubmit} onClick={submit}>
              {busy ? 'Starting…' : 'Start conductor'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Add styles (append to src/renderer/components/Dialogs/styles.css)**

Reuse the existing `.dialog-overlay`; add:

```css
/* === Orchestration dialog === */
.orchestration-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(480px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  background: var(--color-panel-solid, var(--gray-2));
  border: 1px solid var(--gray-6);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  z-index: 1001;
}

.orchestration-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.orchestration-dialog-close {
  background: none;
  border: none;
  color: var(--gray-11);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.orchestration-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--gray-11);
}

.orchestration-field input,
.orchestration-field textarea,
.orchestration-field select {
  font: inherit;
  color: var(--gray-12);
  background: var(--gray-3);
  border: 1px solid var(--gray-6);
  border-radius: 6px;
  padding: 7px 9px;
  resize: vertical;
}

.orchestration-field-error {
  color: var(--red-11, #e5484d);
  font-size: 11px;
}

.orchestration-preview {
  margin: 0;
  font-family: 'JetBrains Mono Variable', ui-monospace, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  background: var(--gray-3);
  border: 1px solid var(--gray-6);
  border-radius: 6px;
  padding: 9px 11px;
  overflow-x: auto;
}

.orchestration-error {
  color: var(--red-11, #e5484d);
  font-size: 12px;
  white-space: pre-wrap;
}

.orchestration-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.orchestration-button {
  font: inherit;
  font-size: 12.5px;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--accent-9, #4f5bd5);
  background: var(--accent-9, #4f5bd5);
  color: white;
  cursor: pointer;
}

.orchestration-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.orchestration-button.ghost {
  background: none;
  border-color: var(--gray-7);
  color: var(--gray-12);
}
```

(Adapt the CSS-variable names to the tokens the existing `styles.css` in that folder actually uses — match its conventions, keep the layout.)

- [ ] **Step 3: Enable the menu item**

Find Phase 2's disabled item: `grep -rn "Orchestration" src/renderer/`. In that component, add state and swap the disabled item for a live one (adapt `DropdownMenu.Item` / prop names to the component's existing menu primitives):

```tsx
const [orchestrationOpen, setOrchestrationOpen] = useState(false);
```

```tsx
<DropdownMenu.Item onSelect={() => setOrchestrationOpen(true)}>
  Orchestration…
</DropdownMenu.Item>
```

and render next to the menu (where `workspace` is the current workspace the menu already has, and `selectGroup` is whatever the Groups sidebar uses to focus a group — if no such call exists yet, pass `() => {}`; the group still appears via the workspace-changed broadcast):

```tsx
<OrchestrationDialog
  workspace={workspace}
  open={orchestrationOpen}
  onOpenChange={setOrchestrationOpen}
  onCreated={(group) => selectGroup(group.id)}
/>
```

Keep the item disabled (as Phase 2 shipped it) when `workspace.scopes.length === 0` — the dialog needs a host scope.

- [ ] **Step 4: Typecheck, then verify by hand**

Run: `npm run typecheck` — clean.
Then: `npm run dev`, and in the app: ＋ New → Orchestration… → fill name `smoke-test`, a one-line kickoff, pick a scope → Start conductor. Verify: (1) `<scope>/conductor/smoke-test/` exists on disk with the three files and no `{{` anywhere; (2) the group appears in the sidebar with the conductor session in it; (3) opening the conductor session shows Claude starting with the kickoff delivered once the composer is ready — never into the trust gate; (4) typing `/mcp` in the conductor lists a `consola` server with the four tools; (5) creating the same name again surfaces "Conductor directory already exists" in the dialog without creating a second group.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Dialogs/OrchestrationDialog.tsx src/renderer/components/Dialogs/styles.css
git add -u src/renderer
git commit -m "feat: orchestration dialog behind the New menu door"
```

---

### Task 10: The conductor at the head of the group view, and the 🧠 glyph

Mockup scene 5's right side: the group view (Phase 2's group progress view) gains a conductor card at its head; the sidebar row for a conductor session shows 🧠. Escalations need nothing here — a conductor needing the human is just its session going `needs-attention`, riding Phase 2's existing notification pipeline.

**Files:**
- Create: `src/renderer/components/Views/ConductorCard.tsx`
- Modify: `src/renderer/components/Views/styles.css`
- Modify: the Phase 2 group view component (the main pane rendered when a group is selected — locate via the Groups sidebar's selection handler; expected under `src/renderer/components/Views/`)
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx` (or the Phase 2 group-row component that renders grouped sessions)

**Interfaces:**
- Consumes: v6 `Session.kind`; Phase 2's per-session status (the store fed by `terminal:status` / the status snapshot).
- Produces: `ConductorCard({ session, status, onOpen })`.

- [ ] **Step 1: Write ConductorCard.tsx**

```tsx
// src/renderer/components/Views/ConductorCard.tsx
import type { Session } from '../../../shared/workspace';
import './styles.css';

export type ConductorCardStatus = 'working' | 'ready' | 'needs-attention' | 'exited';

const STATUS_LABEL: Record<ConductorCardStatus, string> = {
  working: 'working',
  ready: 'idle — drains its inbox at turn ends',
  'needs-attention': 'needs you',
  exited: 'exited — open to restart',
};

interface ConductorCardProps {
  session: Session;
  status: ConductorCardStatus;
  onOpen: (session: Session) => void;
}

/**
 * The brain at the head of a group (mockup scene 5). Nothing here is special
 * beyond presentation: the conductor is an ordinary session, and Open goes
 * through the same navigation as every other session card.
 */
export function ConductorCard({ session, status, onOpen }: ConductorCardProps) {
  return (
    <div
      className={`conductor-card${status === 'needs-attention' ? ' conductor-card-attention' : ''}`}
    >
      <span className="conductor-card-glyph" aria-hidden>
        🧠
      </span>
      <div className="conductor-card-meta">
        <b>{session.name}</b>
        <div>{STATUS_LABEL[status]}</div>
      </div>
      <button className="conductor-card-open" onClick={() => onOpen(session)}>
        Open
      </button>
    </div>
  );
}
```

Append to `src/renderer/components/Views/styles.css`:

```css
/* === Conductor card (group view head) === */
.conductor-card {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--gray-6);
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 8px;
}

.conductor-card-attention {
  border-color: var(--amber-9, #f0a020);
}

.conductor-card-glyph {
  font-size: 16px;
}

.conductor-card-meta {
  flex: 1;
  min-width: 0;
}

.conductor-card-meta b {
  font-size: 13px;
}

.conductor-card-meta div {
  font-size: 11px;
  color: var(--gray-11);
  margin-top: 1px;
}

.conductor-card-open {
  font: inherit;
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--accent-9, #4f5bd5);
  background: none;
  color: var(--accent-9, #4f5bd5);
  cursor: pointer;
}
```

- [ ] **Step 2: Put the card at the head of the Phase 2 group view**

In the group view component, where it maps the group's member sessions into rows/cards, partition and pin (adapt `statusFor` — the derived status the view already uses for its counts — and `openSession` to that component's existing names):

```tsx
const conductor = members.find((session) => session.kind === 'conductor');
const workers = members.filter((session) => session !== conductor);
```

```tsx
{conductor && (
  <ConductorCard
    session={conductor}
    status={statusFor(conductor.instanceId)}
    onOpen={openSession}
  />
)}
{workers.map((session) => /* the existing Phase 2 row rendering, unchanged */)}
```

- [ ] **Step 3: The 🧠 glyph in the sidebar**

In `src/renderer/components/Sidebar/SessionNavItem.tsx` (and/or the Phase 2 grouped-session row if that is a different component), render the glyph in place of — or before — the usual status dot slot:

```tsx
{session.kind === 'conductor' && (
  <span className="session-conductor-glyph" aria-hidden>🧠</span>
)}
```

with, in `src/renderer/components/Sidebar/styles.css`:

```css
.session-conductor-glyph {
  font-size: 12px;
  flex: none;
}
```

The attention dot logic stays untouched — a conductor rings the same bell as everyone else.

- [ ] **Step 4: Typecheck and verify by hand**

Run: `npm run typecheck` — clean.
Then in `npm run dev`: select the group created in Task 9. The conductor card renders at the head with 🧠 and a live status line; the sidebar row shows 🧠; Open focuses the conductor's terminal. Ask the conductor (in its own session) to run `consola_group_status` and confirm it answers with the group's members — and that its result contains no token or socket path.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Views/ConductorCard.tsx src/renderer/components/Views/styles.css
git add -u src/renderer
git commit -m "feat: conductor card at the group head and sidebar glyph"
```

---

### Task 11: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green — including scaffold, control-server unit + integration, createConductor, WorkspaceService, ClaudeDriver, SessionLauncher.

- [ ] **Step 2: Typecheck all three processes**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Production build sanity**

Run: `npm run build && ls dist/main/main/conductor/templates && node -e "const s = require('./dist/main/main/conductor/conductorShim.js')" 2>&1 | head -1`
Expected: the three `.tmpl` files listed; the shim exits 1 with `missing CONSOLA_CONDUCTOR_SOCKET or _TOKEN` (proving it compiled and guards its env) rather than a module error.

- [ ] **Step 4: Invariant spot-checks (grep, no code changes)**

- `grep -rn "mcp-config" src/ --include='*.ts' | grep -v drivers | grep -v test` → only comments/config-file strings, no flag construction outside `src/main/drivers/`.
- `grep -rn "CONSOLA_CONDUCTOR_TOKEN" src/renderer src/preload` → no hits.
- `grep -rn "conductor" src/main/TerminalService.ts` → no hits beyond the opaque `mcpConfigPath` doc comment (no kind branching in the terminal layer).

- [ ] **Step 5: Commit any stragglers**

```bash
git status --short   # should be clean; commit anything intentional that remains
```

---

## Testing summary (what proves what)

| Concern | Test |
|---|---|
| Templates render, no placeholder leaks, state.json seed | `ConductorScaffold.test.ts` |
| Collision refusal, name traversal rejection | `ConductorScaffold.test.ts` |
| MCP SDK usable from the CJS main build | `mcpSdk.test.ts` |
| `--mcp-config` in argv, present on resume, driver-contained | `ClaudeDriver.test.ts` + Task 11 grep |
| Config generation: conductor gets it, interactive does not | `ConductorControlServer.test.ts` (`register`, `mcpConfigForSession`) + `SessionLauncher.test.ts` addition |
| Every tool's group/workspace boundary | `ConductorControlServer.test.ts` handler suite |
| Token handshake, real-socket MCP round trip, fake conductor client with mocked launcher | `ConductorControlServer.integration.test.ts` |
| scaffold → group → launch ordering; launch-failure archives group, keeps files | `createConductor.test.ts` |
| Group record updates | `WorkspaceService.test.ts` additions |
| The visible flow (dialog → files → group → tools in `/mcp`) | Task 9/10 manual verification steps |

No new Playwright E2E in this phase: the conductor loop needs a live `claude` login to exercise; the manual steps in Tasks 9–10 cover it, and the existing E2E suite must simply stay green.

## Self-review

Performed against the spec and the phase contract before finalizing:

1. **Spec coverage:** orchestration door (Tasks 8–9), scaffold + shipped templates (Task 1), conductor spawn/observe plumbing (Tasks 4–6), group head UI + glyph (Task 10), scaffold-collision refusal (Task 1), launch-failure atomicity with archived group (Task 7), attention riding the existing pipeline (Task 10, no new code — by design), no driver branching outside `drivers/` (Task 3 + Task 11 greps), tokens never renderer-bound (Task 8 injection point + Task 11 grep). ✓
2. **Placeholder scan:** every step carries real code or an exact command; the two knowingly-underdetermined edits (Phase 2's `SessionLauncher` internals, the Phase 2 menu/group-view components) give the complete added code plus a deterministic way to locate the insertion point. ✓
3. **Type consistency:** `scaffold(scopePath, name, kickoff, workspaceName)` is identical in Task 1, Task 7's deps, and Task 8's wiring; `ConductorSessionStatus` / `ConductorCardStatus` are the same union as Phase 2's `terminal:status` vocabulary; `ConductorCreateRequest` is defined once in `src/shared/types.ts` and re-exported by `createConductor.ts` (Task 8 Step 2); `mcpConfigForSession`'s widened `control` parameter matches both call sites. ✓
