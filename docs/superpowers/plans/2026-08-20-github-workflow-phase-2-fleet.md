# GitHub Workflow Phase 2 — Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Many sessions with one attention stream — headless session start, a prompt FIFO, a unified status event, groups in the sidebar with derived counts, the fan-out door, and OS notifications.

**Architecture:** The main process gains the ability to create, start, and prompt a session with no pane mounted (`SessionLauncher` + `TerminalManager.startHeadless`), a real FIFO behind the existing guarded prompt delivery, and one derived status event (`terminal:status`) broadcast to every window. The renderer consumes that event for group badges and a restructured sidebar (Groups · Scopes), and adds a ＋ New menu whose Fan-out door mints N sessions into a fresh group through a single IPC intent. OS notifications ring only on a session's transition to `needs-attention` while no Consola window is focused.

**Tech Stack:** Electron 28, node-pty, @xterm/headless (ScreenModel), React 19, Zustand, Radix (DropdownMenu/Dialog/Tooltip), vitest (unit, co-located `src/**/*.test.ts`), Playwright (E2E in `tests/e2e/`).

**Spec:** `docs/superpowers/specs/2026-08-20-github-workflow-design.md` — this plan implements the "Phase 2 — Fleet" row of its Phasing table. Read especially "Groups, conductors, attention" and "What the main process must gain (the Layer-1 gap)". Design rationale: `research/2026-08-18-agent-deck-conductor-listeners-actions.md` §3.1. Event-routing rules: `docs/superpowers/specs/2026-08-19-workspace-windows-design.md` ("Event routing is per channel, not per window"). Mockups: `.superpowers/brainstorm/87378-1787218296/content/full-flow.html` scenes 4 and 6, `groups-conductors.html`.

## Global Constraints

- **The delivery guard survives byte-for-byte.** `COMPOSER_READY_PATTERN`, `CONFIRMATION_MARKERS`, and the guard conditions in `deliverPendingPrompt` (`!this.claudePty` / `this.isAwaitingConfirmation` / `!this.isComposerReady()`) are not edited. Never type into a confirmation menu; the FIFO drains only on ready-composer transitions.
- **Terminals outlive their views.** Only closing a session destroys a PTY; this phase adds "…and can be born without one". The existing mount-time `TERMINAL_CREATE` path keeps working unchanged for interactive sessions.
- **Bridge pattern.** Renderer components never touch `window.*API` directly — every new access goes through a service in `src/renderer/services/`.
- **All IPC channel names live in `src/shared/constants.ts`** (`IPC_CHANNELS`). Every terminal message carries `instanceId`.
- **Main owns records; renderers send intents** and replace their snapshot from broadcasts. The fan-out intent and group creation are main-side operations.
- **No stored group progress anywhere.** Counts are derived in the renderer from `terminalStore` statuses, recomputed per render.
- **Back-compat:** the four existing terminal event channels (`terminal:data`, `terminal:activity`, `terminal:awaiting-confirmation`, `terminal:exit`) stay exactly as they are. `terminal:status` is additive and broadcast to every window (it is light state, per the windows design's per-channel routing).
- **Session identity:** `scopeId`, `cwd`, `kind`, `workItem`, and `harnessId` are fixed at creation (kept out of `allowedSessionUpdates`); `groupId` is mutable.
- **Verification commands:** `npm test` (vitest), `npm run typecheck`, `npm run build && npm run test:e2e` (Playwright launches `dist/`). Targeted: `npx vitest run <path>`.
- **Commit after every task.** Do not modify CLAUDE.md, permissions, or configuration.

## Phase interface notes (Phase 0/1 contracts this plan consumes)

Phase 0 and Phase 1 land before this plan executes. This plan consumes, and must not re-implement:

- **v6 types in `src/shared/workspace.ts`:** `Group { id; name; parentGroupId?; conductorSessionId?; createdAt; archivedAt? }`, `Workspace.groups: Group[]`, `Workspace.scopes: Scope[]` (`Scope { id; name; path; isGitRepo; createdAt }`), `Session { scopeId: string; cwd?: string; groupId?: string; kind: 'interactive' | 'conductor'; workItem?; … }`. `NewSessionFields` includes the creation-time-only fields (`scopeId`, and optional `cwd`/`groupId`/`kind`/`workItem`).
- **`WorkspaceService.createGroup(workspaceId, fields): Group`** and **`archiveGroup(workspaceId, groupId)`** with IPC channels `WORKSPACE_GROUP_CREATE` / `WORKSPACE_GROUP_ARCHIVE`. This phase adds their **UI** (and preload/bridge exposure if Phase 0 did not add it), never their service layer.
- **`TerminalCreateOptions.workspaceId: string`** exists, and `GH_TOKEN` injection into PTYs is done inside `TerminalService`/driver env composition.
- If any consumed name differs on the ground from what a task below assumes, **stop and flag it in the task report** — do not invent a parallel API.

## Cross-plan reconciliation (added at integration)

- Phase 1 ships a main-side twin of `generateSessionInstanceId` inside its
  work-item launch module. Task 7's move to `src/shared/workspace.ts` must also
  re-point that call site and delete the twin — three copies (renderer
  original, Phase 1's main-side twin, the new shared one) must end as one.

---

### Task 1: Prompt FIFO in `TerminalService`

The single `pendingPrompt` overwrite slot becomes a queue drained one prompt per ready-composer transition. This is the regression-sensitive heart of the phase: the guard must survive byte-for-byte.

**Files:**
- Modify: `src/main/TerminalService.ts` (field at ~line 88, constructor at ~line 105, `queuePrompt` at ~line 117, `deliverPendingPrompt` at ~line 352)
- Test: `src/main/TerminalService.test.ts` (new)

**Interfaces:**
- Consumes: nothing new (existing `TerminalService`, real `ScreenModel`).
- Produces: `queuePrompt(prompt: string): void` now appends; queued prompts deliver FIFO, at most one per ready transition. Task 5's `startHeadless` and Task 7's fan-out ride this.

- [ ] **Step 1: Write the failing test**

Create `src/main/TerminalService.test.ts`. It mocks `node-pty`, the login environment, and the driver registry so the service is hermetic, but runs the **real** `ScreenModel` (headless xterm works in node — it is how the main process runs it). xterm parses writes on its own scheduled callbacks and the idle debounce is 500 ms, so timers are advanced with `advanceTimersByTimeAsync`, which flushes both.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node-pty', () => ({ spawn: spawnMock }));
vi.mock('./LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('./drivers', () => ({
    getDriver: () => ({
        id: 'claude',
        resolveBinary: () => 'claude-stub',
        buildSessionArgs: () => [],
        composeEnv: (_harness: unknown, env: Record<string, string | undefined>) => env,
    }),
    toHarnessConfig: (options: unknown) => options,
}));

import { TerminalService } from './TerminalService';

/** What deliverPendingPrompt writes: a bracketed paste, then Enter. */
function pasted(prompt: string): string[] {
    return [`\x1b[200~${prompt}\x1b[201~`, '\r'];
}

interface PtyHarness {
    writes: string[];
    feed: (data: string) => void;
    exit: (exitCode: number) => void;
}

/** Install a fake PTY behind the mocked spawn and hand back its controls. */
function installFakePty(): PtyHarness {
    const writes: string[] = [];
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    spawnMock.mockReturnValue({
        onData: (callback: (data: string) => void) => { onData = callback; },
        onExit: (callback: (event: { exitCode: number }) => void) => { onExit = callback; },
        write: (data: string) => { writes.push(data); },
        resize: () => {},
        kill: () => {},
    });
    return {
        writes,
        feed: (data) => onData?.(data),
        exit: (exitCode) => onExit?.({ exitCode }),
    };
}

// NOTE: if Phase 0 made `workspaceId` a required member of
// TerminalServiceOptions (for GH_TOKEN resolution), add `workspaceId: 'ws-1'`
// to these options — do not loosen the type.
function buildService(initialPrompt?: string): TerminalService {
    const service = new TerminalService({
        cwd: os.tmpdir(),
        claudeSessionId: '00000000-0000-4000-8000-000000000000',
        resume: false,
        initialPrompt,
    });
    service.start();
    return service;
}

/** Idle debounce (500 ms) plus one, so a settle is unambiguous. */
const SETTLE_MS = 501;

beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    return () => vi.useRealTimers();
});

describe('TerminalService prompt FIFO', () => {
    it('delivers two queued prompts in order, one per ready-composer transition', async () => {
        const pty = installFakePty();
        const service = buildService();

        service.queuePrompt('first prompt');
        service.queuePrompt('second prompt');
        // No screen yet, so the composer cannot be ready: nothing delivered.
        expect(pty.writes).toEqual([]);

        // The CLI paints an empty composer and goes quiet.
        pty.feed('❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('first prompt'));

        // Claude works: output flows, the composer is gone. Still one prompt out.
        pty.feed('\x1b[2J\x1b[3J\x1b[Hworking on it...');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('first prompt'));

        // A fresh empty composer: the second ready transition drains one more.
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual([...pasted('first prompt'), ...pasted('second prompt')]);

        service.destroy();
    });

    it('never types into a confirmation menu', async () => {
        const pty = installFakePty();
        const service = buildService();
        service.queuePrompt('would answer the menu');

        pty.feed('Do you want to proceed?\r\n❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        // A composer line is on screen, but so is a confirmation marker: hold.
        expect(pty.writes).toEqual([]);

        // The user answers; the menu clears and an empty composer returns.
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('would answer the menu'));

        service.destroy();
    });

    it('seeds the queue from initialPrompt', async () => {
        const pty = installFakePty();
        const service = buildService('seeded');

        pty.feed('❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('seeded'));

        service.destroy();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/TerminalService.test.ts`
Expected: the first test FAILS — with the single-slot implementation, `second prompt` overwrites `first prompt`, so the first settle delivers `pasted('second prompt')` and the final assertion never sees `first prompt`. (The other two tests pass already; that is fine — they pin current behavior.)

- [ ] **Step 3: Replace the slot with a queue**

In `src/main/TerminalService.ts`:

Replace the field declaration

```typescript
    private pendingPrompt: string | null = null;
```

with

```typescript
    /** Prompts waiting for the composer, oldest first. */
    private promptQueue: string[] = [];
```

Replace the constructor line

```typescript
        this.pendingPrompt = options.initialPrompt ?? null;
```

with

```typescript
        this.promptQueue = options.initialPrompt != null ? [options.initialPrompt] : [];
```

Replace `queuePrompt` (keep its doc comment, updating the first line):

```typescript
    /**
     * Queue a prompt to submit once the CLI is ready. Prompts append — they
     * are delivered oldest-first, one per ready-composer transition.
     *
     * Delivery waits for the terminal to go quiet and refuses to type into a
     * confirmation menu, so a prompt can never be mistaken for an answer to the
     * workspace trust gate or a permission request.
     */
    public queuePrompt(prompt: string): void {
        this.promptQueue.push(prompt);
        if (!this.isBusy) {
            this.deliverPendingPrompt();
        }
    }
```

Replace the body of `deliverPendingPrompt`. Only the first line (the queue check) and the take (`shift`) change; **the three guard conditions and the paste/Enter delivery are byte-for-byte what they were**:

```typescript
    private deliverPendingPrompt(): void {
        if (this.promptQueue.length === 0) return;
        if (!this.claudePty) return;
        if (this.isAwaitingConfirmation) return;
        if (!this.isComposerReady()) return;

        const prompt = this.promptQueue.shift()!;
        this.paste(prompt);
        this.claudePty.write('\r');
    }
```

No other call site changes: the idle-timer callback already calls `deliverPendingPrompt()` once per settle, which is exactly "one prompt per ready transition", and `TerminalManager.ensure`'s existing-terminal branch already calls `queuePrompt` — which now appends instead of clobbering.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/TerminalService.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/TerminalService.ts src/main/TerminalService.test.ts
git commit -m "feat: turn the pending-prompt slot into a FIFO drained one per ready transition"
```

---

### Task 2: The status vocabulary — `deriveTerminalStatus` (shared, pure)

One derivation, used by both sides: main derives the emitted event from its live flags; the renderer derives an initial status when hydrating from the snapshot. Putting it in `src/shared/` is what keeps the two from drifting.

**Files:**
- Create: `src/shared/terminalStatus.ts`
- Test: `src/shared/terminalStatus.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type TerminalStatus = 'working' | 'ready' | 'needs-attention' | 'exited'`; `interface TerminalStatusFlags { busy: boolean; awaitingConfirmation: boolean; exited: boolean }`; `deriveTerminalStatus(flags: TerminalStatusFlags): TerminalStatus`. Tasks 3, 4, 9, and 11 import these.

- [ ] **Step 1: Write the failing test**

Create `src/shared/terminalStatus.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { deriveTerminalStatus } from './terminalStatus';

describe('deriveTerminalStatus', () => {
    it.each([
        // A dead process wants nothing: exited wins over everything.
        [{ busy: false, awaitingConfirmation: false, exited: true }, 'exited'],
        [{ busy: true, awaitingConfirmation: true, exited: true }, 'exited'],
        // A menu on screen outranks output still trickling in.
        [{ busy: true, awaitingConfirmation: true, exited: false }, 'needs-attention'],
        [{ busy: false, awaitingConfirmation: true, exited: false }, 'needs-attention'],
        [{ busy: true, awaitingConfirmation: false, exited: false }, 'working'],
        [{ busy: false, awaitingConfirmation: false, exited: false }, 'ready'],
    ] as const)('derives %j as %s', (flags, expected) => {
        expect(deriveTerminalStatus(flags)).toBe(expected);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/terminalStatus.test.ts`
Expected: FAIL — `Cannot find module './terminalStatus'` (or equivalent resolution error).

- [ ] **Step 3: Implement**

Create `src/shared/terminalStatus.ts`:

```typescript
/**
 * One session's status, at the coarseness the fleet UI needs.
 *
 * The four states the design promotes to a first-class event:
 * `working` — output is flowing; `ready` — quiet, composer available;
 * `needs-attention` — a confirmation marker or permission prompt is on
 * screen; `exited` — the CLI process is gone.
 *
 * Shared between main (which derives and emits it) and the renderer (which
 * derives an initial value from the status snapshot), so the two can never
 * disagree about what the flags mean.
 */
export type TerminalStatus = 'working' | 'ready' | 'needs-attention' | 'exited';

export interface TerminalStatusFlags {
    /** Output is flowing. */
    busy: boolean;
    /** A confirmation menu or permission prompt is on screen. */
    awaitingConfirmation: boolean;
    /** The CLI process is gone. */
    exited: boolean;
}

export function deriveTerminalStatus(flags: TerminalStatusFlags): TerminalStatus {
    if (flags.exited) return 'exited';
    if (flags.awaitingConfirmation) return 'needs-attention';
    if (flags.busy) return 'working';
    return 'ready';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/terminalStatus.test.ts`
Expected: 1 passed (6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/terminalStatus.ts src/shared/terminalStatus.test.ts
git commit -m "feat: shared four-state terminal status derivation"
```

---

### Task 3: Emit `terminal:status` from main, broadcast to every window

`TerminalService` emits a `'status'` event on every derived change; `TerminalManager` broadcasts it on the new `TERMINAL_STATUS` channel to **all** windows (it is light state, per the windows design's per-channel routing table) and exposes an `onStatusChanged` callback that Task 11's notifications hook.

**Files:**
- Modify: `src/main/TerminalService.ts` (import, one field, one private method, six call sites)
- Modify: `src/main/TerminalManager.ts` (`wireEvents`, one public callback field)
- Modify: `src/shared/constants.ts` (channel), `src/shared/types.ts` (message type)
- Test: `src/main/TerminalService.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveTerminalStatus`, `TerminalStatus` from Task 2.
- Produces: IPC event `TERMINAL_STATUS = 'terminal:status'` carrying `TerminalStatusMessage { instanceId: string; status: TerminalStatus }`, broadcast to every window; `TerminalService` event `'status'` (payload `TerminalStatus`); `TerminalManager.onStatusChanged?: (instanceId: string, status: TerminalStatus) => void`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/TerminalService.test.ts`:

```typescript
describe('TerminalService status event', () => {
    it('emits one status per derived change across a session lifecycle', async () => {
        const pty = installFakePty();
        const service = buildService();
        const statuses: string[] = [];
        service.on('status', (status: string) => statuses.push(status));

        pty.feed('booting up');                        // output starts flowing
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // settles, no menu
        pty.feed('\x1b[2J\x1b[3J\x1b[HDo you want to proceed?');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // settles on a menu
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // menu answered
        pty.exit(0);

        // The spawn's initial 'ready' fired inside buildService(), before this
        // listener attached — real listeners do see it, because wireEvents()
        // runs before start() in TerminalManager. From here: data -> working,
        // settle -> ready, menu -> needs-attention, cleared -> ready, exit.
        expect(statuses).toEqual([
            'working',
            'ready',
            'working',
            'needs-attention',
            'ready',
            'exited',
        ]);
        service.destroy();
    });
});
```

Note the dedupe case baked in: while the confirmation menu is up, feeding new bytes makes the terminal busy, but `needs-attention` outranks `working`, so no event fires until the screen settles clean — which is why there is no `working` between `needs-attention` and the second-to-last `ready`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/TerminalService.test.ts`
Expected: the new test FAILS — no `'status'` events are emitted, so `statuses` is `[]`.

- [ ] **Step 3: Implement the emission in `TerminalService`**

Add to the imports in `src/main/TerminalService.ts`:

```typescript
import { deriveTerminalStatus, type TerminalStatus } from '../shared/terminalStatus';
```

Add a field next to `isAwaitingConfirmation`:

```typescript
    private lastStatus: TerminalStatus | null = null;
```

Add a private method next to `setBusy`:

```typescript
    /**
     * Emit 'status' when the derived status changed.
     *
     * Called at the seams where the flags settle — spawn, data starting to
     * flow, the idle debounce classifying the screen, and exit — never per
     * flag, so listeners see one event per transition. Deduped here, which
     * makes calling it liberally safe.
     */
    private emitStatus(): void {
        const status = deriveTerminalStatus({
            busy: this.isBusy,
            awaitingConfirmation: this.isAwaitingConfirmation,
            exited: this.claudeExited,
        });
        if (status === this.lastStatus) return;
        this.lastStatus = status;
        this.emit('status', status);
    }
```

Wire six call sites:

1. In `initClaude`, in the cwd-problem early exit, after `this.claudeExited = true;` add `this.emitStatus();`.
2. In `initClaude`, after the successful spawn's `this.claudeExited = false;` add `this.emitStatus();` (this is the leading `'ready'` — it also corrects the status after a restart).
3. In `initClaude`'s `catch`, after `this.claudeExited = true;` add `this.emitStatus();`.
4. In `handleData`, after `this.setBusy(true);` add `this.emitStatus();`.
5. In the idle-timer callback, after `this.deliverPendingPrompt();` add `this.emitStatus();`.
6. In the `onExit` handler, add `this.emitStatus();` immediately before `this.emit('exit', { exitCode } as TerminalExitInfo);` — deliberately **after** the resume-retry branch's early `return`, so a retried resume never flashes `exited`.

- [ ] **Step 4: Add the channel and message type**

In `src/shared/constants.ts`, under the "Terminal events (main -> renderer)" block, after `TERMINAL_EXIT`:

```typescript
    TERMINAL_STATUS: 'terminal:status',       // Derived status: working | ready | needs-attention | exited
```

In `src/shared/types.ts`, add the import at the top and the message next to `TerminalExitMessage`:

```typescript
import type { TerminalStatus } from './terminalStatus';
```

```typescript
export interface TerminalStatusMessage {
    instanceId: string;
    status: TerminalStatus;
}
```

- [ ] **Step 5: Broadcast from `TerminalManager`**

In `src/main/TerminalManager.ts`, add the import:

```typescript
import type { TerminalStatus } from '../shared/terminalStatus';
```

Add a public callback field next to `onAttentionChanged`:

```typescript
    /** Called on every status transition, after the broadcast. Drives OS notifications. */
    public onStatusChanged?: (instanceId: string, status: TerminalStatus) => void;
```

In `wireEvents`, after the `'exit'` wiring, add:

```typescript
        terminal.on('status', (status: TerminalStatus) => {
            // Light state, per the windows design: any window may need it for
            // group counts and attention dots, so it goes to all of them.
            this.broadcast(IPC_CHANNELS.TERMINAL_STATUS, { instanceId, status });
            this.onStatusChanged?.(instanceId, status);
        });
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run src/main/TerminalService.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/TerminalService.ts src/main/TerminalService.test.ts src/main/TerminalManager.ts src/shared/constants.ts src/shared/types.ts
git commit -m "feat: derive and broadcast terminal:status to every window"
```

---

### Task 4: The renderer adopts `terminal:status`

Preload exposes the subscription, the bridge wraps it, and `terminalStore` records a `status` per instance — seeded on hydration by deriving from the snapshot flags. The three existing flag fields stay: the sidebar dots (`sessionStatusFor`) keep working untouched.

**Files:**
- Modify: `src/shared/types.ts` (`TerminalAPI`)
- Modify: `src/preload/preload.ts` (terminalAPI)
- Modify: `src/renderer/services/terminalBridge.ts`
- Modify: `src/renderer/stores/terminalStore.ts`

**Interfaces:**
- Consumes: `TERMINAL_STATUS`, `TerminalStatusMessage` (Task 3); `deriveTerminalStatus`, `TerminalStatus` (Task 2).
- Produces: `TerminalState.status: TerminalStatus` in `terminalStore` — Task 9's group counts read exactly this field; `terminalBridge.onStatus(callback)`.

- [ ] **Step 1: Extend the API type**

In `src/shared/types.ts`, add to `TerminalAPI` after `onExit`:

```typescript
    onStatus: (callback: (message: TerminalStatusMessage) => void) => () => void;
```

- [ ] **Step 2: Expose it in preload**

In `src/preload/preload.ts`, add `TerminalStatusMessage` to the existing `../shared/types` import list, and add to the `terminalAPI` object after `onExit`:

```typescript
    onStatus: (callback: (message: TerminalStatusMessage) => void) =>
        subscribe(IPC_CHANNELS.TERMINAL_STATUS, callback),
```

- [ ] **Step 3: Wrap it in the bridge**

In `src/renderer/services/terminalBridge.ts`, add `TerminalStatusMessage` to the type imports and add after `onExit`:

```typescript
    /** Derived status for any session in any workspace: the fleet vocabulary. */
    onStatus(callback: (message: TerminalStatusMessage) => void): () => void {
        return window.terminalAPI.onStatus(callback);
    },
```

- [ ] **Step 4: Record it in `terminalStore`**

In `src/renderer/stores/terminalStore.ts`:

Add the import:

```typescript
import { deriveTerminalStatus, type TerminalStatus } from '../../shared/terminalStatus';
```

Extend `TerminalState` and `INITIAL_STATE`:

```typescript
export interface TerminalState {
    /** Output is flowing — Claude is working. */
    isBusy: boolean;
    /** A menu is on screen waiting for a keypress (trust gate, permissions). */
    isAwaitingConfirmation: boolean;
    /** The claude process exited; the pane offers a restart. */
    hasExited: boolean;
    /** Main's derived status — what group counts and badges consume. */
    status: TerminalStatus;
}

const INITIAL_STATE: TerminalState = {
    isBusy: false,
    isAwaitingConfirmation: false,
    hasExited: false,
    status: 'ready',
};
```

In `subscribeToEvents`, add a fourth subscription to the `unsubscribers` array:

```typescript
            terminalBridge.onStatus(({ instanceId, status }) => {
                setState(instanceId, { status });
            }),
```

In `hydrateTerminalStatus`, the snapshot carries the three flags but not the derived status, so derive it — rename the loop variable to `flags` to keep the property name free:

```typescript
        for (const [instanceId, flags] of Object.entries(snapshot)) {
            // The snapshot merges UNDERNEATH what is already here, not over it.
            // (See the original comment — the rule is unchanged; the derived
            // status obeys it too.)
            terminals[instanceId] = {
                ...INITIAL_STATE,
                ...flags,
                status: deriveTerminalStatus({
                    busy: flags.isBusy,
                    awaitingConfirmation: flags.isAwaitingConfirmation,
                    exited: flags.hasExited,
                }),
                ...terminals[instanceId],
            };
        }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: clean. (There is no React test rig in this repo; the store wiring is typechecked here and exercised end-to-end in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/preload/preload.ts src/renderer/services/terminalBridge.ts src/renderer/stores/terminalStore.ts
git commit -m "feat: adopt terminal:status in the renderer terminal store"
```

---

### Task 5: Headless birth — `TerminalManager.startHeadless` + `SessionLauncher`

The Layer-1 gap: an entry point that creates the record **and** spawns the PTY without `terminal:create` arriving from a mounted pane. `TerminalManager` already runs headless `ScreenModel`s; the change is the entry point, not the machinery. When a pane later mounts, the existing `TERMINAL_CREATE` → `ensure()` path takes ownership and repaints from `snapshot()`.

**Files:**
- Modify: `src/main/TerminalManager.ts` (one new public method)
- Create: `src/main/SessionLauncher.ts`
- Test: `src/main/SessionLauncher.test.ts`

**Interfaces:**
- Consumes: `TerminalService`/`TerminalServiceOptions`, `WorkspaceService.createSession/updateSession/deleteSession/getAll`, `HarnessService.getAll`, v6 `NewSessionFields` (Phase 0).
- Produces: `TerminalManager.startHeadless(instanceId: string, options: TerminalServiceOptions): void`; `class SessionLauncher` with `launchSession(workspaceId: string, fields: NewSessionFields & { initialPrompt?: string }): Promise<Session>` and the alias `type LaunchSessionFields`. **Phase 3's plan consumes `SessionLauncher.launchSession` with exactly this signature.**

- [ ] **Step 1: Add `startHeadless` to `TerminalManager`**

In `src/main/TerminalManager.ts`, after `ensure()`:

```typescript
    /**
     * Start a session's terminal with no view attached.
     *
     * Fan-out and conductors create sessions before any pane exists. This is
     * ensure() minus the owner: output lands in the ScreenModel, status
     * broadcasts to every window, and the first pane to mount goes through
     * ensure(), takes ownership, and repaints from the replay buffer.
     * "Terminals outlive their views" gains "…and can be born without one."
     */
    public startHeadless(instanceId: string, options: TerminalServiceOptions): void {
        const existing = this.terminals.get(instanceId);
        if (existing) {
            // Already running — the start is idempotent, but a prompt that
            // rode in with the call must not be dropped.
            if (options.initialPrompt) existing.queuePrompt(options.initialPrompt);
            return;
        }
        const terminal = new TerminalService(options);
        this.terminals.set(instanceId, terminal);
        this.wireEvents(instanceId, terminal);
        terminal.start();
    }
```

`ensure()` is not touched: an interactive session's mount path is byte-compatible with today.

- [ ] **Step 2: Write the failing `SessionLauncher` test**

Create `src/main/SessionLauncher.test.ts`. Dependencies are mocked structurally (the launcher declares narrow interfaces), which is what "creates record+PTY with no renderer involved" means here — and it shields the test from Phase-0 signature drift.

```typescript
import { describe, expect, it, vi } from 'vitest';
import { SessionLauncher } from './SessionLauncher';
import type { Session, Workspace } from '../shared/workspace';
import type { Harness } from '../shared/harness';

function workspaceFixture(): Workspace {
    return {
        id: 'ws-1',
        name: 'fleet',
        defaultHarnessId: 'default',
        scopes: [
            { id: 'scope-1', name: 'sympower', path: '/repos/sympower', isGitRepo: false, createdAt: 1 },
        ],
        groups: [],
        sessions: [],
        createdAt: 1,
        updatedAt: 1,
    } as unknown as Workspace;
}

function sessionFixture(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        name: 'flex-portal',
        workspaceId: 'ws-1',
        instanceId: 'instance-1',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        hasStarted: false,
        harnessId: 'work',
        scopeId: 'scope-1',
        kind: 'interactive',
        createdAt: 1,
        lastActiveAt: 1,
        ...overrides,
    } as Session;
}

const harnessFixture = {
    id: 'work',
    driverId: 'claude',
    name: 'Work',
    isBuiltIn: false,
    binaryPath: '/opt/claude/bin/claude',
    configDir: '/Users/me/.claude-work',
    extraArgs: ['--verbose'],
} as unknown as Harness;

// If Phase 0's NewSessionFields requires more members than these, extend the
// literal — never cast it away.
const launchFields = {
    name: 'flex-portal',
    workspaceId: 'ws-1',
    instanceId: 'instance-1',
    harnessId: 'work',
    scopeId: 'scope-1',
    kind: 'interactive' as const,
};

function buildLauncher(session: Session) {
    const workspaces = {
        getAll: vi.fn(() => [workspaceFixture()]),
        createSession: vi.fn(() => session),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
    };
    const harnesses = { getAll: vi.fn(() => [harnessFixture]) };
    const terminals = { startHeadless: vi.fn() };
    const launcher = new SessionLauncher(workspaces, harnesses, terminals);
    return { launcher, workspaces, harnesses, terminals };
}

describe('SessionLauncher', () => {
    it('creates the record and spawns the PTY with no renderer involved', async () => {
        const session = sessionFixture();
        const { launcher, workspaces, terminals } = buildLauncher(session);

        const launched = await launcher.launchSession('ws-1', {
            ...launchFields,
            initialPrompt: 'review the PR',
        });

        // The record was created without the delivery-only field.
        expect(workspaces.createSession).toHaveBeenCalledWith(
            'ws-1',
            expect.not.objectContaining({ initialPrompt: expect.anything() })
        );
        // The PTY spawned headlessly, resolved from the record.
        expect(terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({
                cwd: '/repos/sympower', // the scope's path: the session has no cwd of its own
                claudeSessionId: '11111111-1111-4111-8111-111111111111',
                resume: false,
                initialPrompt: 'review the PR',
                driverId: 'claude',
                binaryOverride: '/opt/claude/bin/claude',
                configDirOverride: '/Users/me/.claude-work',
                extraArgs: ['--verbose'],
            })
        );
        // The conversation exists now; every later attach must --resume it.
        expect(workspaces.updateSession).toHaveBeenCalledWith('ws-1', 'session-1', {
            hasStarted: true,
        });
        expect(launched.hasStarted).toBe(true);
    });

    it('prefers the session cwd over the scope path', async () => {
        const session = sessionFixture({ cwd: '/repos/sympower/flex-portal' });
        const { launcher, terminals } = buildLauncher(session);

        await launcher.launchSession('ws-1', { ...launchFields, cwd: '/repos/sympower/flex-portal' });

        expect(terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({ cwd: '/repos/sympower/flex-portal' })
        );
    });

    it('rolls the record back when the session has nowhere to run', async () => {
        const session = sessionFixture({ scopeId: 'gone' });
        const { launcher, workspaces, terminals } = buildLauncher(session);

        await expect(
            launcher.launchSession('ws-1', { ...launchFields, scopeId: 'gone' })
        ).rejects.toThrow(/no working folder/);
        expect(workspaces.deleteSession).toHaveBeenCalledWith('ws-1', 'session-1');
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('pins nothing for the built-in or an unknown harness', async () => {
        const session = sessionFixture({ harnessId: 'default' });
        const { launcher, terminals } = buildLauncher(session);

        await launcher.launchSession('ws-1', { ...launchFields, harnessId: 'default' });

        const options = terminals.startHeadless.mock.calls[0][1];
        expect(options.driverId).toBeUndefined();
        expect(options.binaryOverride).toBeUndefined();
        expect(options.configDirOverride).toBeUndefined();
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/SessionLauncher.test.ts`
Expected: FAIL — `Cannot find module './SessionLauncher'`.

- [ ] **Step 4: Implement `SessionLauncher`**

Create `src/main/SessionLauncher.ts`:

```typescript
import type { Harness } from '../shared/harness';
import type { HarnessLaunchFields } from '../shared/types';
import type { NewSessionFields, Session, Workspace } from '../shared/workspace';
import type { TerminalServiceOptions } from './TerminalService';

/**
 * Start a session with no renderer involved.
 *
 * The Layer-1 gap, closed: fan-out and conductors need sessions that exist
 * before any pane mounts. The launcher creates the record through the same
 * single writer every window uses, then spawns the PTY headlessly through
 * TerminalManager. A pane that mounts later goes through the ordinary
 * TERMINAL_CREATE path, takes ownership, and repaints from the replay buffer.
 *
 * Order matters and mirrors the spec: record first, spawn second — and the
 * record is rolled back if the session turns out to have nowhere to run,
 * because a tab that fails on every open is worse than no tab.
 */

/** The slice of WorkspaceService this launcher needs. Structural, for tests. */
export interface SessionRecordStore {
    getAll(): Workspace[];
    createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
    updateSession(
        workspaceId: string,
        sessionId: string,
        updates: Partial<Pick<Session, 'name' | 'lastActiveAt' | 'hasStarted'>>
    ): void;
    deleteSession(workspaceId: string, sessionId: string): void;
}

/** The slice of HarnessService this launcher needs. */
export interface HarnessRecordStore {
    getAll(): Harness[];
}

/** The slice of TerminalManager this launcher needs. */
export interface HeadlessTerminalStarter {
    startHeadless(instanceId: string, options: TerminalServiceOptions): void;
}

export type LaunchSessionFields = NewSessionFields & { initialPrompt?: string };

/**
 * How a harness record translates into launch fields.
 *
 * Absent or built-in pins nothing — the empty object resolves exactly the way
 * Consola did before harnesses existed, ambient CLAUDE_CONFIG_DIR included.
 */
function launchFieldsFor(harness: Harness | undefined): HarnessLaunchFields {
    if (!harness || harness.isBuiltIn) return {};
    return {
        driverId: harness.driverId,
        binaryOverride: harness.binaryPath,
        configDirOverride: harness.configDir,
        extraArgs: harness.extraArgs,
    };
}

export class SessionLauncher {
    constructor(
        private readonly workspaces: SessionRecordStore,
        private readonly harnesses: HarnessRecordStore,
        private readonly terminals: HeadlessTerminalStarter
    ) {}

    public async launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session> {
        const workspace = this.workspaces.getAll().find((candidate) => candidate.id === workspaceId);
        if (!workspace) {
            throw new Error(`Cannot launch a session: no workspace ${workspaceId}`);
        }

        // initialPrompt is delivery-only; it must never reach the record.
        const { initialPrompt, ...sessionFields } = fields;
        const session = this.workspaces.createSession(workspaceId, sessionFields);
        if (!session) {
            throw new Error(`Workspace ${workspaceId} refused the session record`);
        }

        // A session runs in its own cwd when it has one (worktrees, fan-out
        // targets) and in its scope's folder otherwise — the home-vs-runs-in
        // split from the spec.
        const scope = workspace.scopes.find((candidate) => candidate.id === session.scopeId);
        const cwd = session.cwd ?? scope?.path;
        if (!cwd) {
            // The record exists but can never spawn. Back the creation out
            // rather than leaving a tab that fails on every open.
            this.workspaces.deleteSession(workspaceId, session.id);
            throw new Error(
                `Session "${session.name}" has no working folder: scope ${session.scopeId} not found and no cwd given`
            );
        }

        const harness = this.harnesses.getAll().find((candidate) => candidate.id === session.harnessId);
        this.terminals.startHeadless(session.instanceId, {
            cwd,
            workspaceId,
            claudeSessionId: session.claudeSessionId,
            // First launch of a fresh record; later attaches resume.
            resume: false,
            initialPrompt,
            model: session.model,
            ...launchFieldsFor(harness),
        });

        this.workspaces.updateSession(workspaceId, session.id, { hasStarted: true });
        return { ...session, hasStarted: true };
    }
}
```

Note: `workspaceId` is passed into the terminal options because Phase 0 threads it through for GH_TOKEN resolution. If `TerminalServiceOptions` on the ground has no `workspaceId` member, remove that one property and flag it — do not add the member yourself.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/SessionLauncher.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: clean. (`WorkspaceService`, `HarnessService`, and `TerminalManager` must satisfy the three structural interfaces — if one does not, the mismatch is a real Phase-0 drift to flag, not to paper over.)

- [ ] **Step 7: Commit**

```bash
git add src/main/TerminalManager.ts src/main/SessionLauncher.ts src/main/SessionLauncher.test.ts
git commit -m "feat: headless session start via SessionLauncher and TerminalManager.startHeadless"
```

---

### Task 6: `SCOPE_LIST_REPOS` enumeration — a scope's launch targets

The fan-out dialog's target list: a container scope offers its direct child git repos; a repo scope offers itself. Pure filesystem logic, separated from the IPC handler so it tests with real temp directories.

**Files:**
- Modify: `src/shared/types.ts` (the `ScopeRepo` shape)
- Create: `src/main/scopeRepos.ts`
- Test: `src/main/scopeRepos.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface ScopeRepo { name: string; path: string }` (shared); `listScopeRepos(scope: { path: string; isGitRepo: boolean }): Promise<ScopeRepo[]>`. Task 8 registers the IPC handler over it; Task 10's dialog renders its result.

- [ ] **Step 1: Add the shared shape**

In `src/shared/types.ts`:

```typescript
/** One launch target inside a scope: a git repo the fan-out dialog can pick. */
export interface ScopeRepo {
    name: string;
    path: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/main/scopeRepos.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listScopeRepos } from './scopeRepos';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-scope-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('listScopeRepos', () => {
    it("lists a container scope's direct child git repos, sorted by name", async () => {
        fs.mkdirSync(path.join(dir, 'repo-b', '.git'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'repo-a', '.git'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'not-a-repo'));
        fs.writeFileSync(path.join(dir, 'README.md'), 'not a directory');

        const repos = await listScopeRepos({ path: dir, isGitRepo: false });

        expect(repos).toEqual([
            { name: 'repo-a', path: path.join(dir, 'repo-a') },
            { name: 'repo-b', path: path.join(dir, 'repo-b') },
        ]);
    });

    it('offers a repo scope as its own single target', async () => {
        fs.mkdirSync(path.join(dir, '.git'));

        const repos = await listScopeRepos({ path: dir, isGitRepo: true });

        expect(repos).toEqual([{ name: path.basename(dir), path: dir }]);
    });

    it('returns no targets for a folder that cannot be read', async () => {
        const repos = await listScopeRepos({ path: path.join(dir, 'gone'), isGitRepo: false });

        expect(repos).toEqual([]);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/scopeRepos.test.ts`
Expected: FAIL — `Cannot find module './scopeRepos'`.

- [ ] **Step 4: Implement**

Create `src/main/scopeRepos.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import type { ScopeRepo } from '../shared/types';

/**
 * The launch targets inside a scope.
 *
 * A repo scope is its own single target. A container scope (a 38-repo parent
 * folder) offers its direct children that are git repos — exactly one level
 * down, because that is what the scope's folder layout means; anything deeper
 * deserves a scope of its own.
 */
export async function listScopeRepos(scope: {
    path: string;
    isGitRepo: boolean;
}): Promise<ScopeRepo[]> {
    if (scope.isGitRepo) {
        return [{ name: path.basename(scope.path), path: scope.path }];
    }

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(scope.path, { withFileTypes: true });
    } catch {
        // A moved or unreadable folder offers no targets. The dialog shows an
        // empty list; an error dialog would be worse than the truth.
        return [];
    }

    const repos: ScopeRepo[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childPath = path.join(scope.path, entry.name);
        if (fs.existsSync(path.join(childPath, '.git'))) {
            repos.push({ name: entry.name, path: childPath });
        }
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/scopeRepos.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/scopeRepos.ts src/main/scopeRepos.test.ts
git commit -m "feat: enumerate a scope's launch targets for fan-out"
```

---

### Task 7: Fan-out core — group first, sessions appended, failures reported

The creation gesture: one fresh group, one session per target, no conductor, no stored progress. The group is created first so every session that does launch lands in it; launches are individually guarded so a mid-way failure leaves earlier sessions intact and names the targets that failed.

**Files:**
- Modify: `src/shared/workspace.ts` (move `generateSessionInstanceId` here)
- Modify: `src/renderer/utils/sessionActions.ts` (re-export instead of local copy)
- Modify: `src/shared/types.ts` (intent/result shapes)
- Create: `src/main/fanOut.ts`
- Test: `src/main/fanOut.test.ts`

**Interfaces:**
- Consumes: `LaunchSessionFields` and `SessionLauncher.launchSession` (Task 5); `WorkspaceService.createGroup` (Phase 0); v6 `Group`.
- Produces: `generateSessionInstanceId(workspaceId: string): string` (shared); `SessionFanOutIntent { workspaceId; scopeId; targetPaths: string[]; prompt: string; groupName: string }`; `SessionFanOutResult { group: Group; created: Session[]; failed: Array<{ path: string; error: string }> }`; `fanOut(deps, intent): Promise<SessionFanOutResult>`. Task 8 wires the IPC handler; Task 10's dialog sends the intent.

- [ ] **Step 1: Share the instance-id mint**

Both sides mint sessions now — the renderer on the new-session screen, main during fan-out — so the id format has to live in one place. In `src/shared/workspace.ts`, after `generateId`:

```typescript
/**
 * Terminal instance id for a new session in a workspace.
 *
 * Shared because both sides mint sessions: the renderer on the new-session
 * screen, and the main process when fan-out creates a fleet. One format, or
 * the "every terminal message carries instanceId" contract quietly forks.
 */
export function generateSessionInstanceId(workspaceId: string): string {
  return `workspace-${workspaceId}-session-${generateId()}`;
}
```

In `src/renderer/utils/sessionActions.ts`, delete the local `generateSessionInstanceId` function (and its doc comment) and replace it with a re-export so existing importers are untouched:

```typescript
export { generateSessionInstanceId } from '../../shared/workspace';
```

- [ ] **Step 2: Add the intent and result shapes**

In `src/shared/types.ts` (add `Group` to the existing `./workspace` type import):

```typescript
/** Renderer intent: fan one prompt out across target repos as a fresh group. */
export interface SessionFanOutIntent {
    workspaceId: string;
    scopeId: string;
    targetPaths: string[];
    prompt: string;
    groupName: string;
}

/**
 * What a fan-out produced. `failed` lists the targets whose launch failed;
 * the group and every session in `created` exist regardless — a 15-repo
 * fan-out that trips on repo 9 still yields 14 working sessions.
 */
export interface SessionFanOutResult {
    group: Group;
    created: Session[];
    failed: Array<{ path: string; error: string }>;
}
```

- [ ] **Step 3: Write the failing test**

Create `src/main/fanOut.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { fanOut } from './fanOut';
import type { Group, Session, Workspace } from '../shared/workspace';

const workspace = {
    id: 'ws-1',
    name: 'fleet',
    defaultHarnessId: 'work',
    scopes: [],
    groups: [],
    sessions: [],
} as unknown as Workspace;

const group = { id: 'group-1', name: 'bump lodash', createdAt: 1 } as Group;

const intent = {
    workspaceId: 'ws-1',
    scopeId: 'scope-1',
    targetPaths: ['/repos/flex-portal', '/repos/controller-app', '/repos/flextools'],
    prompt: 'Bump lodash to v5.',
    groupName: 'bump lodash',
};

function buildDeps(launchSession: ReturnType<typeof vi.fn>) {
    return {
        workspaces: {
            getAll: vi.fn(() => [workspace]),
            createGroup: vi.fn(() => group),
        },
        launcher: { launchSession },
    };
}

describe('fanOut', () => {
    it('creates the group first, then one session per target inside it', async () => {
        const launchSession = vi.fn((_workspaceId: string, fields: { name: string }) =>
            Promise.resolve({ id: `session-${fields.name}` } as Session)
        );
        const deps = buildDeps(launchSession);

        const result = await fanOut(deps, intent);

        // Group before sessions: a launch that lands has a group to land in.
        expect(deps.workspaces.createGroup.mock.invocationCallOrder[0]).toBeLessThan(
            launchSession.mock.invocationCallOrder[0]
        );
        expect(deps.workspaces.createGroup).toHaveBeenCalledWith('ws-1', { name: 'bump lodash' });
        expect(launchSession).toHaveBeenCalledTimes(3);
        expect(launchSession).toHaveBeenNthCalledWith(
            1,
            'ws-1',
            expect.objectContaining({
                name: 'flex-portal', // the target's basename
                workspaceId: 'ws-1',
                harnessId: 'work', // the workspace default
                scopeId: 'scope-1',
                cwd: '/repos/flex-portal',
                groupId: 'group-1',
                kind: 'interactive',
                initialPrompt: 'Bump lodash to v5.',
            })
        );
        expect(result.group).toBe(group);
        expect(result.created).toHaveLength(3);
        expect(result.failed).toEqual([]);
    });

    it('keeps earlier sessions and reports the target that failed', async () => {
        const launchSession = vi
            .fn()
            .mockResolvedValueOnce({ id: 's1' })
            .mockRejectedValueOnce(new Error('spawn failed'))
            .mockResolvedValueOnce({ id: 's3' });
        const deps = buildDeps(launchSession);

        const result = await fanOut(deps, intent);

        expect(result.created.map((session: Session) => session.id)).toEqual(['s1', 's3']);
        expect(result.failed).toEqual([{ path: '/repos/controller-app', error: 'spawn failed' }]);
    });

    it('mints a distinct instance id per session', async () => {
        const launchSession = vi.fn(() => Promise.resolve({ id: 's' } as Session));
        const deps = buildDeps(launchSession);

        await fanOut(deps, intent);

        const ids = launchSession.mock.calls.map(
            (call) => (call[1] as { instanceId: string }).instanceId
        );
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) {
            expect(id).toMatch(/^workspace-ws-1-session-/);
        }
    });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/main/fanOut.test.ts`
Expected: FAIL — `Cannot find module './fanOut'`.

- [ ] **Step 5: Implement**

Create `src/main/fanOut.ts`:

```typescript
import * as path from 'path';
import { generateSessionInstanceId } from '../shared/workspace';
import type { Group, Session, Workspace } from '../shared/workspace';
import type { SessionFanOutIntent, SessionFanOutResult } from '../shared/types';
import type { LaunchSessionFields } from './SessionLauncher';

/** The slices of WorkspaceService and SessionLauncher fan-out needs. */
export interface FanOutDeps {
    workspaces: {
        getAll(): Workspace[];
        createGroup(workspaceId: string, fields: { name: string }): Group;
    };
    launcher: {
        launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
    };
}

/**
 * Fan one prompt out: a fresh group, one session per target repo.
 *
 * A creation gesture, not an entity — it mints ordinary sessions into an
 * ordinary group and walks away. The group is created first so every session
 * that does launch lands in it. Launches are sequential and individually
 * guarded: a target that fails is reported and skipped, and the sessions
 * launched before it stay.
 */
export async function fanOut(
    deps: FanOutDeps,
    intent: SessionFanOutIntent
): Promise<SessionFanOutResult> {
    const workspace = deps.workspaces
        .getAll()
        .find((candidate) => candidate.id === intent.workspaceId);
    if (!workspace) {
        throw new Error(`Cannot fan out: no workspace ${intent.workspaceId}`);
    }

    const group = deps.workspaces.createGroup(intent.workspaceId, { name: intent.groupName });

    const created: Session[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const targetPath of intent.targetPaths) {
        try {
            created.push(
                await deps.launcher.launchSession(intent.workspaceId, {
                    name: path.basename(targetPath),
                    workspaceId: intent.workspaceId,
                    instanceId: generateSessionInstanceId(intent.workspaceId),
                    harnessId: workspace.defaultHarnessId,
                    scopeId: intent.scopeId,
                    cwd: targetPath,
                    groupId: group.id,
                    kind: 'interactive',
                    initialPrompt: intent.prompt,
                })
            );
        } catch (error) {
            failed.push({
                path: targetPath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { group, created, failed };
}
```

- [ ] **Step 6: Run the tests, full suite, typecheck**

Run: `npx vitest run src/main/fanOut.test.ts && npm test && npm run typecheck`
Expected: all green (the sessionActions re-export must not break renderer typecheck).

- [ ] **Step 7: Commit**

```bash
git add src/shared/workspace.ts src/renderer/utils/sessionActions.ts src/shared/types.ts src/main/fanOut.ts src/main/fanOut.test.ts
git commit -m "feat: fan-out core — one group, N guarded session launches"
```

---

### Task 8: Fan-out, repos, and groups over IPC — handlers, preload, bridge

Wire the main-side pieces to channels and give the renderer typed doors to all of them. Group create/archive get preload/bridge exposure here **only if Phase 0 did not already expose them** — check `src/preload/preload.ts` for `createGroup` first; if present, verify the signature matches and skip those fragments.

**Files:**
- Modify: `src/shared/constants.ts` (two channels)
- Modify: `src/main/ipc-handlers.ts` (launcher construction, two handlers, cleanup)
- Modify: `src/shared/types.ts` (`WorkspaceAPI`)
- Modify: `src/preload/preload.ts` (workspaceAPI)
- Modify: `src/renderer/services/workspaceBridge.ts`

**Interfaces:**
- Consumes: `SessionLauncher` (Task 5), `fanOut` (Task 7), `listScopeRepos` (Task 6), `WORKSPACE_GROUP_CREATE`/`WORKSPACE_GROUP_ARCHIVE` (Phase 0).
- Produces: IPC `SESSION_FAN_OUT = 'session:fan-out'` (invoke, `SessionFanOutIntent` → `SessionFanOutResult`) and `SCOPE_LIST_REPOS = 'workspace:scope-list-repos'` (invoke, `(workspaceId, scopeId)` → `ScopeRepo[]`); `workspaceBridge.fanOut / listScopeRepos / createGroup / archiveGroup`. Task 10's dialogs call the bridge.

- [ ] **Step 1: Add the channels**

In `src/shared/constants.ts`, after the `WORKSPACE_SESSION_DELETE` line (and Phase 0's group channels):

```typescript
    // Fleet creation (renderer -> main)
    SESSION_FAN_OUT: 'session:fan-out',              // N sessions into a fresh group
    SCOPE_LIST_REPOS: 'workspace:scope-list-repos',  // A scope's launch targets
```

- [ ] **Step 2: Register the handlers**

In `src/main/ipc-handlers.ts`, add imports:

```typescript
import { SessionLauncher } from './SessionLauncher';
import { fanOut } from './fanOut';
import { listScopeRepos } from './scopeRepos';
import type { SessionFanOutIntent } from '../shared/types';
```

After `terminalManager = new TerminalManager(...)` and the `manager.onAttentionChanged` block, add:

```typescript
    // Sessions born without a pane: fan-out (and, in Phase 3, conductors).
    const launcher = new SessionLauncher(workspaces, harnesses, manager);

    ipcMain.handle(IPC_CHANNELS.SESSION_FAN_OUT, (_event, intent: SessionFanOutIntent) =>
        fanOut({ workspaces, launcher }, intent)
    );

    ipcMain.handle(
        IPC_CHANNELS.SCOPE_LIST_REPOS,
        (_event, workspaceId: string, scopeId: string) => {
            const workspace = workspaces.getAll().find((candidate) => candidate.id === workspaceId);
            const scope = workspace?.scopes.find((candidate) => candidate.id === scopeId);
            return scope ? listScopeRepos(scope) : [];
        }
    );
```

In `cleanupIpcHandlers()`, next to the other terminal removals:

```typescript
    ipcMain.removeHandler(IPC_CHANNELS.SESSION_FAN_OUT);
    ipcMain.removeHandler(IPC_CHANNELS.SCOPE_LIST_REPOS);
```

- [ ] **Step 3: Extend `WorkspaceAPI`**

In `src/shared/types.ts`, add to `WorkspaceAPI` before `onChanged` (add `Group` to the `./workspace` import if Task 7 has not already; skip `createGroup`/`archiveGroup` here if Phase 0 declared them):

```typescript
    createGroup: (
        workspaceId: string,
        fields: { name: string; parentGroupId?: string }
    ) => Promise<Group>;
    archiveGroup: (workspaceId: string, groupId: string) => Promise<void>;
    fanOut: (intent: SessionFanOutIntent) => Promise<SessionFanOutResult>;
    listScopeRepos: (workspaceId: string, scopeId: string) => Promise<ScopeRepo[]>;
```

- [ ] **Step 4: Expose in preload**

In `src/preload/preload.ts`, add `Group` to the `../shared/workspace` import and `SessionFanOutIntent, SessionFanOutResult, ScopeRepo` to the `../shared/types` import. Add to the `workspaceAPI` object before `onChanged` (again, skip the two group methods if Phase 0 already added them):

```typescript
    createGroup: (
        workspaceId: string,
        fields: { name: string; parentGroupId?: string }
    ): Promise<Group> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_CREATE, workspaceId, fields),

    archiveGroup: (workspaceId: string, groupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GROUP_ARCHIVE, workspaceId, groupId),

    fanOut: (intent: SessionFanOutIntent): Promise<SessionFanOutResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.SESSION_FAN_OUT, intent),

    listScopeRepos: (workspaceId: string, scopeId: string): Promise<ScopeRepo[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SCOPE_LIST_REPOS, workspaceId, scopeId),
```

- [ ] **Step 5: Extend the bridge**

In `src/renderer/services/workspaceBridge.ts`, add the type imports (`Group` from `../../shared/workspace`; `SessionFanOutIntent`, `SessionFanOutResult`, `ScopeRepo` from `../../shared/types`) and the methods before `onChanged`:

```typescript
    /** Create an empty group. A folder for humans; no brain, no ceremony. */
    createGroup(
        workspaceId: string,
        fields: { name: string; parentGroupId?: string }
    ): Promise<Group> {
        return window.workspaceAPI.createGroup(workspaceId, fields);
    },

    archiveGroup(workspaceId: string, groupId: string): Promise<void> {
        return window.workspaceAPI.archiveGroup(workspaceId, groupId);
    },

    /** Fan one prompt out across target repos: N sessions in a fresh group. */
    fanOut(intent: SessionFanOutIntent): Promise<SessionFanOutResult> {
        return window.workspaceAPI.fanOut(intent);
    },

    /** The git repos a fan-out can target inside a scope. */
    listScopeRepos(workspaceId: string, scopeId: string): Promise<ScopeRepo[]> {
        return window.workspaceAPI.listScopeRepos(workspaceId, scopeId);
    },
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/services/workspaceBridge.ts
git commit -m "feat: fan-out and scope-repos IPC, preload and bridge doors"
```

---

### Task 9: Group counts + the sidebar's Groups/Scopes split

The sidebar becomes **Inbox · Groups · Scopes** (the Inbox row is Phase 1's; whatever Phase 1 put at the top of the sidebar stays above the Groups section). A grouped session renders under its group with its scope name as subtitle; an ungrouped session renders under its scope — that split is new; today every session renders in one flat list. Group badges are derived from `terminalStore` statuses on every render, never stored.

**Files:**
- Create: `src/renderer/utils/groupCounts.ts`
- Test: `src/renderer/utils/groupCounts.test.ts`
- Create: `src/renderer/components/Sidebar/GroupNavItem.tsx`
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx` (optional `subtitle` prop)
- Modify: `src/renderer/components/Sidebar/index.tsx` (the split)
- Modify: `src/renderer/components/Sidebar/styles.css`

**Interfaces:**
- Consumes: `TerminalState.status` (Task 4); v6 `Group`/`Scope`/`Session.groupId`/`Session.scopeId` (Phase 0).
- Produces: `groupCountsFor(sessions: Session[], terminals: Record<string, TerminalState>): GroupCounts` where `GroupCounts { total; needsAttention; working; exited }`; `formatGroupBadge(counts: GroupCounts): string`; `<GroupNavItem group sessions workspaceId scopeNameFor activeSessionId />`; `SessionNavItem`'s `subtitle?: string`. Task 12's E2E asserts on the `.group-nav-count` class.

- [ ] **Step 1: Write the failing counts test**

Create `src/renderer/utils/groupCounts.test.ts` (pure — runs in vitest's node environment):

```typescript
import { describe, expect, it } from 'vitest';
import { formatGroupBadge, groupCountsFor } from './groupCounts';
import type { Session } from '../../shared/workspace';
import type { TerminalState } from '../stores/terminalStore';

function session(instanceId: string): Session {
    return { instanceId } as Session;
}

function terminal(status: TerminalState['status']): TerminalState {
    return { isBusy: false, isAwaitingConfirmation: false, hasExited: false, status };
}

describe('groupCountsFor', () => {
    it('counts member statuses straight from the terminal store', () => {
        const sessions = [session('a'), session('b'), session('c'), session('d'), session('e')];
        const terminals = {
            a: terminal('needs-attention'),
            b: terminal('working'),
            c: terminal('ready'),
            d: terminal('exited'),
            // 'e' has no terminal yet: only the total sees it.
        };

        expect(groupCountsFor(sessions, terminals)).toEqual({
            total: 5,
            needsAttention: 1,
            working: 1,
            exited: 1,
        });
    });
});

describe('formatGroupBadge', () => {
    it('leads with the attention count when someone needs you', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 2, working: 3, exited: 0 })).toBe(
            '◐2 · 7'
        );
    });

    it('shows the plain total otherwise', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 0, working: 3, exited: 0 })).toBe('7');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/utils/groupCounts.test.ts`
Expected: FAIL — `Cannot find module './groupCounts'`.

- [ ] **Step 3: Implement the util**

Create `src/renderer/utils/groupCounts.ts`:

```typescript
import type { Session } from '../../shared/workspace';
import type { TerminalState } from '../stores/terminalStore';

/**
 * A group's derived progress.
 *
 * Computed fresh from the terminal status store on every render and never
 * stored anywhere — the design's rule is "no stored progress state", so a
 * group's numbers can never go stale or disagree with the dots.
 */
export interface GroupCounts {
    total: number;
    needsAttention: number;
    working: number;
    exited: number;
}

export function groupCountsFor(
    sessions: Session[],
    terminals: Record<string, TerminalState>
): GroupCounts {
    const counts: GroupCounts = { total: sessions.length, needsAttention: 0, working: 0, exited: 0 };
    for (const session of sessions) {
        switch (terminals[session.instanceId]?.status) {
            case 'needs-attention':
                counts.needsAttention += 1;
                break;
            case 'working':
                counts.working += 1;
                break;
            case 'exited':
                counts.exited += 1;
                break;
            default:
                // 'ready', or no terminal yet: counted only in the total.
                break;
        }
    }
    return counts;
}

/** The sidebar badge: "◐2 · 7" when someone needs you, a plain "7" otherwise. */
export function formatGroupBadge(counts: GroupCounts): string {
    return counts.needsAttention > 0
        ? `◐${counts.needsAttention} · ${counts.total}`
        : `${counts.total}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/utils/groupCounts.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Add the subtitle to `SessionNavItem`**

In `src/renderer/components/Sidebar/SessionNavItem.tsx`, extend the props:

```typescript
interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
  isActive: boolean;
  onClick: () => void;
  /** Rendered under the name — the scope a grouped session belongs to. */
  subtitle?: string;
}
```

Destructure `subtitle` in the component signature, and replace the name span in the JSX (the `) : (` branch of the rename ternary):

```tsx
      ) : (
        <span className="session-nav-item-text">
          <span className="session-nav-item-name">{session.name}</span>
          {subtitle && <span className="session-nav-item-subtitle">{subtitle}</span>}
        </span>
      )}
```

- [ ] **Step 6: Create `GroupNavItem`**

Create `src/renderer/components/Sidebar/GroupNavItem.tsx`:

```tsx
import { useState } from 'react';
import { Boxes, ChevronDown, ChevronRight } from 'lucide-react';
import type { Group } from '../../../shared/workspace';
import { type Session } from '../../stores/workspaceStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { formatGroupBadge, groupCountsFor } from '../../utils/groupCounts';
import { activateSession } from '../../utils/sessionActions';
import { SessionNavItem } from './SessionNavItem';

interface GroupNavItemProps {
  group: Group;
  sessions: Session[];
  workspaceId: string;
  /** The scope name a member session shows as its subtitle. */
  scopeNameFor: (scopeId: string) => string | undefined;
  activeSessionId: string | null;
}

/**
 * One group in the sidebar: a collapsible header with a derived badge, and
 * its member sessions beneath, each subtitled with its scope.
 *
 * The badge is recomputed from the terminal store on every render — progress
 * is derived, never stored (see groupCounts.ts).
 */
export function GroupNavItem({
  group,
  sessions,
  workspaceId,
  scopeNameFor,
  activeSessionId,
}: GroupNavItemProps) {
  const [isOpen, setIsOpen] = useState(true);
  const terminals = useTerminalStore((state) => state.terminals);
  const counts = groupCountsFor(sessions, terminals);

  return (
    <div className="group-nav-item">
      <button className="group-nav-header" onClick={() => setIsOpen((open) => !open)}>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Boxes size={14} />
        <span className="group-nav-name">{group.name}</span>
        <span className="group-nav-count">{formatGroupBadge(counts)}</span>
      </button>
      {isOpen &&
        sessions.map((session) => (
          <SessionNavItem
            key={session.id}
            session={session}
            workspaceId={workspaceId}
            isActive={activeSessionId === session.id}
            onClick={() => activateSession(workspaceId, session.id)}
            subtitle={scopeNameFor(session.scopeId)}
          />
        ))}
    </div>
  );
}
```

- [ ] **Step 7: Restructure the sidebar**

Replace the body of `src/renderer/components/Sidebar/index.tsx` with the split. **If Phase 1 already added an Inbox row/section here, keep it exactly where Phase 1 put it — above the Groups section — and merge this structure around it.** The full component:

```tsx
import { Plus, Settings } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Session } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { SessionNavItem } from './SessionNavItem';
import { GroupNavItem } from './GroupNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The workspace this window holds: Inbox · Groups · Scopes.
 *
 * A grouped session renders under its group with its scope as subtitle; an
 * ungrouped one renders under its scope. Group badges are derived from the
 * terminal status store on every render — progress is never stored.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const { openSettings } = useSettings();

  if (isSidebarHidden) {
    return null;
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  // Sessions appear once they are named — Claude names interactive ones after
  // the first turn; fan-out names its sessions at creation.
  const named = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];

  const groups = (workspace?.groups ?? []).filter((group) => !group.archivedAt);
  const liveGroupIds = new Set(groups.map((group) => group.id));

  const grouped = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  for (const session of named) {
    if (session.groupId && liveGroupIds.has(session.groupId)) {
      const members = grouped.get(session.groupId) ?? [];
      members.push(session);
      grouped.set(session.groupId, members);
    } else {
      ungrouped.push(session);
    }
  }

  const scopes = workspace?.scopes ?? [];
  const scopeNameFor = (scopeId: string) =>
    scopes.find((scope) => scope.id === scopeId)?.name;
  const scopeSections = scopes
    .map((scope) => ({
      scope,
      sessions: ungrouped.filter((session) => session.scopeId === scope.id),
    }))
    .filter((section) => section.sessions.length > 0);
  // A session whose scope record is gone still has to be reachable.
  const strays = ungrouped.filter(
    (session) => !scopes.some((scope) => scope.id === session.scopeId)
  );

  const newSessionButton = (
    <button
      className="sidebar-section-button"
      onClick={() => workspace && void createQuickSession(workspace.id)}
      disabled={!workspace}
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      {/* Phase 1's Inbox section, when present, stays above Groups. */}

      {workspace && groups.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Groups</span>
          </div>
          <nav className="session-list">
            {groups.map((group) => (
              <GroupNavItem
                key={group.id}
                group={group}
                sessions={grouped.get(group.id) ?? []}
                workspaceId={workspace.id}
                scopeNameFor={scopeNameFor}
                activeSessionId={activeSessionId}
              />
            ))}
          </nav>
        </div>
      )}

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Scopes</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{newSessionButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  New Session
                  <span className="tooltip-shortcut">⌘N</span>
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="session-list">
          {workspace &&
            scopeSections.map(({ scope, sessions }) => (
              <div key={scope.id}>
                <div className="sidebar-scope-header">{scope.name}</div>
                {sessions.map((session) => (
                  <SessionNavItem
                    key={session.id}
                    session={session}
                    workspaceId={workspace.id}
                    isActive={activeSessionId === session.id}
                    onClick={() => activateSession(workspace.id, session.id)}
                  />
                ))}
              </div>
            ))}
          {workspace &&
            strays.map((session) => (
              <SessionNavItem
                key={session.id}
                session={session}
                workspaceId={workspace.id}
                isActive={activeSessionId === session.id}
                onClick={() => activateSession(workspace.id, session.id)}
              />
            ))}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings-button" onClick={openSettings}>
          <Settings size={16} />
          <span>Settings</span>
          <span className="sidebar-settings-shortcut">⌘,</span>
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 8: Styles**

Append to `src/renderer/components/Sidebar/styles.css`. If `.session-nav-item-name` already carries `flex: 1` / ellipsis rules, move the flexing to `.session-nav-item-text` and keep the ellipsis on both text spans — match the neighboring rules' variables rather than inventing new tokens:

```css
/* Groups */
.group-nav-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 12px;
  background: none;
  border: none;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  opacity: 0.85;
}

.group-nav-header:hover {
  opacity: 1;
}

.group-nav-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-nav-count {
  flex: none;
  font-size: 11px;
  opacity: 0.6;
}

.group-nav-item .session-nav-item {
  padding-left: 26px;
}

/* Scope headings for ungrouped sessions */
.sidebar-scope-header {
  padding: 6px 12px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.5;
}

/* Two-line session rows (name + scope subtitle) */
.session-nav-item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.session-nav-item-subtitle {
  max-width: 100%;
  font-size: 10px;
  opacity: 0.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 9: Verify**

Run: `npm run typecheck && npm test`
Expected: clean. Then a visual smoke: `npm run dev`, open a workspace — ungrouped sessions appear under their scope heading; no Groups section until a group exists (Task 10 provides the door; the E2E in Task 12 exercises the grouped rendering end to end).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/utils/groupCounts.ts src/renderer/utils/groupCounts.test.ts src/renderer/components/Sidebar/
git commit -m "feat: sidebar groups with derived counts and per-scope session sections"
```

---

### Task 10: The ＋ New menu — New group, Fan-out dialog, Orchestration disabled

The whole creation surface, per mockup scene 4: **New session… · New group · Fan-out… · Orchestration…** in one top-bar dropdown, in increasing order of machinery. Orchestration is present but disabled with a "Coming soon" tooltip — Phase 3 enables it.

**Files:**
- Create: `src/renderer/components/Layout/NewMenu.tsx`
- Create: `src/renderer/components/Dialogs/NewGroupDialog.tsx`
- Create: `src/renderer/components/Dialogs/FanOutDialog.tsx`
- Modify: `src/renderer/components/Layout/AppHeader.tsx` (render the menu)
- Modify: `src/renderer/components/Layout/styles.css` (trigger button)
- Modify: `src/renderer/components/Dialogs/styles.css` (fan-out pieces)

**Interfaces:**
- Consumes: `workspaceBridge.createGroup / fanOut / listScopeRepos` (Task 8); `createQuickSession` (existing); `ScopeRepo` (Task 6). Dialog chrome reuses the existing classes in `Dialogs/styles.css`: `dialog-overlay`, `dialog-content`, `dialog-title`, `dialog-form`, `dialog-field`, `dialog-label`, `dialog-input`, `dialog-actions`, `dialog-button-primary`, `dialog-button-secondary`.
- Produces: a top-bar button with `aria-label="New"` (Task 12's E2E clicks it); menu items named exactly `New session…`, `New group`, `Fan-out…`, `Orchestration…`; a fan-out dialog whose submit button reads `Create group · N sessions`.

- [ ] **Step 1: Create `NewMenu`**

Create `src/renderer/components/Layout/NewMenu.tsx`:

```tsx
import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { createQuickSession } from '../../utils/sessionActions';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { FanOutDialog } from '../Dialogs/FanOutDialog';

/**
 * The ＋ New menu: everything that creates work, in one place, in increasing
 * order of machinery — a session, a group, a fan-out, and (Phase 3) an
 * orchestration. This is the whole creation surface a casual user ever sees.
 */
export function NewMenu() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const [openDialog, setOpenDialog] = useState<'group' | 'fan-out' | null>(null);

  if (!activeWorkspaceId) return null;

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="new-menu-trigger" aria-label="New">
            <Plus size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content" sideOffset={6} align="start">
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void createQuickSession(activeWorkspaceId)}
            >
              <span>New session…</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>⌘N</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => setOpenDialog('group')}>
              <span>New group</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => setOpenDialog('fan-out')}>
              <span>Fan-out…</span>
            </DropdownMenu.Item>
            <Tooltip.Provider delayDuration={200}>
              <Tooltip.Root>
                {/* Radix disables pointer events on a disabled item, so the
                    tooltip trigger is a wrapper that still receives hover. */}
                <Tooltip.Trigger asChild>
                  <span style={{ display: 'block' }}>
                    <DropdownMenu.Item className="dropdown-item" disabled>
                      <span>Orchestration…</span>
                    </DropdownMenu.Item>
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                    Coming soon
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {openDialog === 'group' && (
        <NewGroupDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
      {openDialog === 'fan-out' && (
        <FanOutDialog workspaceId={activeWorkspaceId} onClose={() => setOpenDialog(null)} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Render it in the header, style the trigger**

In `src/renderer/components/Layout/AppHeader.tsx`, import and render it beside the switcher:

```tsx
import { NewMenu } from './NewMenu';
```

```tsx
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        <WorkspaceSwitcher />
        <NewMenu />
      </div>
```

Append to `src/renderer/components/Layout/styles.css` (the header is a drag region, so the button must opt out):

```css
.new-menu-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 4px;
  border: none;
  border-radius: 5px;
  background: none;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.new-menu-trigger:hover {
  opacity: 1;
}
```

- [ ] **Step 3: Create `NewGroupDialog`**

Create `src/renderer/components/Dialogs/NewGroupDialog.tsx`:

```tsx
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { workspaceBridge } from '../../services/workspaceBridge';
import './styles.css';

interface NewGroupDialogProps {
  workspaceId: string;
  onClose: () => void;
}

/** Name it, and that is all: a group is a folder for humans. */
export function NewGroupDialog({ workspaceId, onClose }: NewGroupDialogProps) {
  const [name, setName] = useState('');

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await workspaceBridge.createGroup(workspaceId, { name: trimmed });
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">New group</Dialog.Title>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="new-group-name">
                Name
              </label>
              <input
                id="new-group-name"
                className="dialog-input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create();
                }}
                placeholder="e.g. bump lodash v5"
              />
            </div>
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => void create()}
              disabled={!name.trim()}
            >
              Create
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Create `FanOutDialog`**

Per mockup scene 4: scope select → target checkboxes from `SCOPE_LIST_REPOS` → prompt textarea → `Create group · N sessions`. The intent needs a `groupName` the mockup's dialog does not ask for, so an editable Name field is pre-filled from the scope. Partial failure keeps the dialog open and lists the targets that did not launch — everything that did launch exists.

Create `src/renderer/components/Dialogs/FanOutDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { workspaceBridge } from '../../services/workspaceBridge';
import type { ScopeRepo } from '../../../shared/types';
import './styles.css';

interface FanOutDialogProps {
  workspaceId: string;
  onClose: () => void;
}

/**
 * Fan-out: pick a scope, pick target repos inside it, write one prompt.
 *
 * A creation gesture, not an entity: submitting mints one group and N
 * ordinary sessions in the main process, then this dialog walks away.
 */
export function FanOutDialog({ workspaceId, onClose }: FanOutDialogProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const scopes = workspace?.scopes ?? [];

  const [scopeId, setScopeId] = useState<string | undefined>(scopes[0]?.id);
  const [repos, setRepos] = useState<ScopeRepo[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState<Array<{ path: string; error: string }>>([]);

  const scope = scopes.find((candidate) => candidate.id === scopeId);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void workspaceBridge.listScopeRepos(workspaceId, scope.id).then((found) => {
      if (cancelled) return;
      setRepos(found);
      setSelected(new Set());
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, scope?.id]);

  useEffect(() => {
    if (scope && !nameTouched) setGroupName(`Fan-out — ${scope.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, nameTouched]);

  const toggle = (repoPath: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  };

  const canSubmit =
    !!scope &&
    selected.size > 0 &&
    prompt.trim().length > 0 &&
    groupName.trim().length > 0 &&
    !submitting;

  const submit = async () => {
    if (!canSubmit || !scope) return;
    setSubmitting(true);
    try {
      const result = await workspaceBridge.fanOut({
        workspaceId,
        scopeId: scope.id,
        targetPaths: [...selected],
        prompt: prompt.trim(),
        groupName: groupName.trim(),
      });
      if (result.failed.length > 0) {
        // Partial success: the group and the launched sessions exist. Show
        // what did not launch, and let the user close after reading it.
        setFailed(result.failed);
      } else {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content fan-out-dialog">
          <Dialog.Title className="dialog-title">Fan-out</Dialog.Title>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-scope">
                Scope
              </label>
              <select
                id="fan-out-scope"
                className="dialog-input"
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
              >
                {scopes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">Targets · {selected.size} selected</span>
              <div className="fan-out-targets">
                {repos.map((repo) => (
                  <label key={repo.path} className="fan-out-target">
                    <input
                      type="checkbox"
                      checked={selected.has(repo.path)}
                      onChange={() => toggle(repo.path)}
                    />
                    <span>{repo.name}</span>
                  </label>
                ))}
                {repos.length === 0 && (
                  <span className="fan-out-empty">No git repositories inside this scope.</span>
                )}
              </div>
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-group-name">
                Group name
              </label>
              <input
                id="fan-out-group-name"
                className="dialog-input"
                value={groupName}
                onChange={(event) => {
                  setNameTouched(true);
                  setGroupName(event.target.value);
                }}
              />
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-prompt">
                Prompt — runs in each target
              </label>
              <textarea
                id="fan-out-prompt"
                className="dialog-input fan-out-prompt"
                rows={4}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Bump lodash to v5. Fix breaking changes, run the tests, open a PR."
              />
            </div>

            {failed.length > 0 && (
              <div className="fan-out-failures">
                <span>These targets did not launch — the rest did:</span>
                <ul>
                  {failed.map((failure) => (
                    <li key={failure.path}>
                      {failure.path}: {failure.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              {failed.length > 0 ? 'Close' : 'Cancel'}
            </button>
            {failed.length === 0 && (
              <button
                className="dialog-button-primary"
                onClick={() => void submit()}
                disabled={!canSubmit}
              >
                Create group · {selected.size} session{selected.size === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 5: Fan-out styles**

Append to `src/renderer/components/Dialogs/styles.css`:

```css
.fan-out-dialog {
  width: 440px;
  max-width: 90vw;
}

.fan-out-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  max-height: 160px;
  overflow-y: auto;
  padding: 4px 0;
}

.fan-out-target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.fan-out-empty {
  font-size: 12px;
  opacity: 0.6;
}

.fan-out-prompt {
  resize: vertical;
  font-family: inherit;
}

.fan-out-failures {
  font-size: 12px;
  color: #e5484d;
}

.fan-out-failures ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: clean. Visual smoke via `npm run dev`: the ＋ opens the menu; New group creates a group that appears in the sidebar; Orchestration… is greyed out and shows "Coming soon" on hover. (The fan-out path is driven deterministically by Task 12's E2E.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Layout/NewMenu.tsx src/renderer/components/Layout/AppHeader.tsx src/renderer/components/Layout/styles.css src/renderer/components/Dialogs/NewGroupDialog.tsx src/renderer/components/Dialogs/FanOutDialog.tsx src/renderer/components/Dialogs/styles.css
git commit -m "feat: the ＋ New menu with New group and Fan-out doors"
```

---

### Task 11: OS notifications — the fourth attention altitude

One Electron `Notification` when a session transitions to `needs-attention` while **no** Consola window is focused: `"<session name> needs you — <workspace name>"`. Clicking focuses (or opens, via the existing `focusOrCreate`) the session's workspace window and activates the session. No repeat while the session stays `needs-attention`. The Inbox never notifies — structurally guaranteed, because only terminal status transitions reach this code.

**Files:**
- Create: `src/main/attention.ts` (pure policy + lookup)
- Test: `src/main/attention.test.ts`
- Modify: `src/shared/constants.ts` (`WINDOW_ACTIVATE_SESSION`)
- Modify: `src/main/window-manager.ts` (`focusOrCreate` gains a session)
- Modify: `src/main/ipc-handlers.ts` (wiring)
- Modify: `src/shared/types.ts` (`WindowAPI.onActivateSession`)
- Modify: `src/preload/preload.ts`, `src/renderer/services/windowBridge.ts`
- Modify: `src/renderer/stores/navigationStore.ts`, `src/renderer/components/Layout/index.tsx`

**Interfaces:**
- Consumes: `TerminalManager.onStatusChanged` (Task 3); `TerminalStatus` (Task 2); existing `focusOrCreate`/`setActiveSession` in `window-manager.ts`.
- Produces: `class NotificationPolicy { shouldNotify(instanceId, status, anyWindowFocused): boolean; forget(instanceId): void }`; `findSessionByInstanceId(workspaces, instanceId): { workspace; session } | null`; IPC `WINDOW_ACTIVATE_SESSION = 'window:activate-session'` (main → one renderer, payload `sessionId: string`); `focusOrCreate(workspaceId: string, activeSessionId?: string | null)`; `subscribeToActivateSession()` in navigationStore.

- [ ] **Step 1: Write the failing policy test**

Create `src/main/attention.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { NotificationPolicy, findSessionByInstanceId } from './attention';
import type { Workspace } from '../shared/workspace';

describe('NotificationPolicy', () => {
    it('notifies once per needs-attention episode while unfocused', () => {
        const policy = new NotificationPolicy();
        expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
        // Still parked on the same prompt: never a repeat.
        expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(false);
        // The user dealt with it; the episode ends…
        expect(policy.shouldNotify('a', 'ready', false)).toBe(false);
        // …and the next episode rings again.
        expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
    });

    it('stays silent while any Consola window is focused', () => {
        const policy = new NotificationPolicy();
        expect(policy.shouldNotify('a', 'needs-attention', true)).toBe(false);
    });

    it('only needs-attention rings — working, ready and exited never do', () => {
        const policy = new NotificationPolicy();
        expect(policy.shouldNotify('a', 'working', false)).toBe(false);
        expect(policy.shouldNotify('a', 'ready', false)).toBe(false);
        expect(policy.shouldNotify('a', 'exited', false)).toBe(false);
    });

    it('tracks sessions independently', () => {
        const policy = new NotificationPolicy();
        expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
        expect(policy.shouldNotify('b', 'needs-attention', false)).toBe(true);
    });

    it('forget() ends an episode so a recreated terminal can ring again', () => {
        const policy = new NotificationPolicy();
        policy.shouldNotify('a', 'needs-attention', false);
        policy.forget('a');
        expect(policy.shouldNotify('a', 'needs-attention', false)).toBe(true);
    });
});

describe('findSessionByInstanceId', () => {
    it('finds the workspace and session owning an instance', () => {
        const workspaces = [
            { id: 'ws-1', name: 'alpha', sessions: [{ id: 's1', name: 'one', instanceId: 'i1' }] },
            { id: 'ws-2', name: 'beta', sessions: [{ id: 's2', name: 'two', instanceId: 'i2' }] },
        ] as unknown as Workspace[];

        const found = findSessionByInstanceId(workspaces, 'i2');
        expect(found?.workspace.id).toBe('ws-2');
        expect(found?.session.id).toBe('s2');
        expect(findSessionByInstanceId(workspaces, 'missing')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/attention.test.ts`
Expected: FAIL — `Cannot find module './attention'`.

- [ ] **Step 3: Implement the pure pieces**

Create `src/main/attention.ts`:

```typescript
import type { TerminalStatus } from '../shared/terminalStatus';
import type { Session, Workspace } from '../shared/workspace';

/**
 * When a needs-attention transition earns an OS notification.
 *
 * Pure on purpose — no Electron imports — so the debounce is testable as a
 * table. The rule: ring once per needs-attention episode, only while no
 * Consola window is focused. Any other status ends the episode, so the next
 * needs-attention rings again. Status events are edge-triggered upstream, so
 * a session parked on one prompt can never ring twice.
 */
export class NotificationPolicy {
    private readonly notified = new Set<string>();

    public shouldNotify(
        instanceId: string,
        status: TerminalStatus,
        anyWindowFocused: boolean
    ): boolean {
        if (status !== 'needs-attention') {
            this.notified.delete(instanceId);
            return false;
        }
        if (anyWindowFocused) return false;
        if (this.notified.has(instanceId)) return false;
        this.notified.add(instanceId);
        return true;
    }

    /** A destroyed terminal must not suppress a future session's episode. */
    public forget(instanceId: string): void {
        this.notified.delete(instanceId);
    }
}

/** The workspace and session a terminal instance belongs to, if any. */
export function findSessionByInstanceId(
    workspaces: Workspace[],
    instanceId: string
): { workspace: Workspace; session: Session } | null {
    for (const workspace of workspaces) {
        const session = workspace.sessions.find(
            (candidate) => candidate.instanceId === instanceId
        );
        if (session) return { workspace, session };
    }
    return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/attention.test.ts`
Expected: 6 passed.

- [ ] **Step 5: The channel and the click landing path**

In `src/shared/constants.ts`, after `WINDOW_WORKSPACE_CHANGED`:

```typescript
    WINDOW_ACTIVATE_SESSION: 'window:activate-session', // A notification click chose a session
```

In `src/main/window-manager.ts`, add the import:

```typescript
import { IPC_CHANNELS } from '../shared/constants';
```

Replace `focusOrCreate` (the existing one-argument callers are unaffected by the defaulted parameter):

```typescript
/**
 * Focus the window already holding a workspace, or open one for it —
 * optionally landing on a specific session, which is how a notification
 * click reaches the right pane.
 */
export function focusOrCreate(
    workspaceId: string,
    activeSessionId: string | null = null
): BrowserWindow {
    const existing = findWindowForWorkspace(workspaceId);
    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        if (activeSessionId) {
            // Recorded in the registry (for relaunch) and pushed to the
            // renderer (for right now) — the two views of one fact.
            setActiveSession(existing, activeSessionId);
            existing.webContents.send(IPC_CHANNELS.WINDOW_ACTIVATE_SESSION, activeSessionId);
        }
        return existing;
    }
    // A fresh window learns its session the way every restored window does:
    // through the context injected at construction.
    return createWindow({ workspaceId, activeSessionId });
}
```

- [ ] **Step 6: Wire the notifier in `ipc-handlers.ts`**

Add `Notification` to the electron import at the top of `src/main/ipc-handlers.ts`, and:

```typescript
import { NotificationPolicy, findSessionByInstanceId } from './attention';
```

After the `manager.onAttentionChanged` block (and before the terminal handler registrations), add:

```typescript
    const notificationPolicy = new NotificationPolicy();

    // The fourth attention altitude: session dot → group count → switcher dot
    // → OS notification. Rings only for a session hitting needs-attention
    // while no Consola window is focused; the Inbox never notifies — only
    // terminals emit status. Clicking lands on the right window and session.
    manager.onStatusChanged = (instanceId, status) => {
        const anyWindowFocused = BrowserWindow.getFocusedWindow() !== null;
        if (!notificationPolicy.shouldNotify(instanceId, status, anyWindowFocused)) return;
        if (!Notification.isSupported()) return;

        const located = findSessionByInstanceId(workspaces.getAll(), instanceId);
        if (!located) return;

        const notification = new Notification({
            title: `${located.session.name || 'A session'} needs you — ${located.workspace.name}`,
            body: 'Click to open it in Consola.',
        });
        notification.on('click', () => {
            focusOrCreate(located.workspace.id, located.session.id);
        });
        notification.show();
    };
```

Extend the existing `TERMINAL_DESTROY` listener so a closed session's episode is forgotten:

```typescript
    ipcMain.on(IPC_CHANNELS.TERMINAL_DESTROY, (_event, instanceId: string) => {
        manager.destroy(instanceId);
        notificationPolicy.forget(instanceId);
    });
```

- [ ] **Step 7: The renderer side of the click**

In `src/shared/types.ts`, add to `WindowAPI`:

```typescript
    /** A notification click chose a session; this window should show it. */
    onActivateSession: (callback: (sessionId: string) => void) => () => void;
```

In `src/preload/preload.ts`, add to the `windowAPI` object:

```typescript
    onActivateSession: (callback: (sessionId: string) => void) =>
        subscribe<string>(IPC_CHANNELS.WINDOW_ACTIVATE_SESSION, callback),
```

In `src/renderer/services/windowBridge.ts`:

```typescript
    /** A notification click chose a session in this window's workspace. */
    onActivateSession(callback: (sessionId: string) => void): () => void {
        return window.windowAPI.onActivateSession(callback);
    },
```

In `src/renderer/stores/navigationStore.ts`, next to `subscribeToWindowWorkspace`:

```typescript
/**
 * React to main pointing this window at a session — an OS notification click.
 * Main already recorded the session on the window's registry entry, so only
 * the store moves here; echoing setActiveSession back would be a loop.
 */
export function subscribeToActivateSession(): () => void {
  return windowBridge.onActivateSession((sessionId) => {
    useNavigationStore.setState({ activeSessionId: sessionId });
  });
}
```

In `src/renderer/components/Layout/index.tsx`, extend the navigationStore import and add the subscription beside the existing ones:

```typescript
import {
  useNavigationStore,
  subscribeToWindowWorkspace,
  subscribeToActivateSession,
} from '../../stores/navigationStore';
```

```typescript
  // A notification click can land on a window that is already open.
  useEffect(() => subscribeToActivateSession(), []);
```

- [ ] **Step 8: Verify**

Run: `npm test && npm run typecheck`
Expected: clean. Manual verification (notifications cannot be asserted from Playwright): `npm run dev`, start a session in a folder Claude has not trusted, unfocus every Consola window before the trust gate paints → one notification appears, a second never does; clicking it focuses the window with that session active.

- [ ] **Step 9: Commit**

```bash
git add src/main/attention.ts src/main/attention.test.ts src/shared/constants.ts src/main/window-manager.ts src/main/ipc-handlers.ts src/shared/types.ts src/preload/preload.ts src/renderer/services/windowBridge.ts src/renderer/stores/navigationStore.ts src/renderer/components/Layout/index.tsx
git commit -m "feat: OS notification on needs-attention with click-to-focus"
```

---

### Task 12: E2E — a fan-out of two stub sessions shows a group with counts

The whole pipeline under Playwright: seed a stub harness and a container workspace, drive the ＋ New → Fan-out dialog through the real UI, and assert the sidebar renders the group, its two members, and the derived count. The stub CLI is a shell script that paints a composer prompt and sleeps — real PTYs, no network, no real `claude`.

**Files:**
- Create: `tests/e2e/fanout.spec.ts`

**Interfaces:**
- Consumes: `launchElectron` helper (`tests/e2e/helpers/electron.ts`); the `aria-label="New"` trigger and dialog labels (Task 10); the `.group-nav-count` badge (Task 9).
- Produces: the phase's end-to-end proof.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/fanout.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * Fan-out, end to end: two stub sessions land in a fresh group and the
 * sidebar shows the group with its derived count.
 */

function makeFixture(): { containerDir: string; stubPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-fanout-'));
  const containerDir = path.join(root, 'repos');
  fs.mkdirSync(path.join(containerDir, 'repo-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(containerDir, 'repo-b', '.git'), { recursive: true });

  // \342\235\257 is UTF-8 for ❯ — the composer-ready pattern matches it, so
  // each stub session settles as 'ready' and the badge shows a plain total.
  const stubPath = path.join(root, 'stub-cli.sh');
  fs.writeFileSync(stubPath, "#!/bin/sh\nprintf '\\342\\235\\257 '\nsleep 300\n", {
    mode: 0o755,
  });
  return { containerDir, stubPath };
}

test('fan-out of two stub sessions shows a group with counts', async () => {
  const { containerDir, stubPath } = makeFixture();
  const { app, page } = await launchElectron();

  try {
    // Seed a harness whose binary is the stub, and a workspace whose single
    // scope is the container folder. (If Phase 0 changed createWorkspace's
    // signature, adapt the call — the intent is exactly that workspace.)
    await page.evaluate(
      ([binaryPath]) =>
        window.harnessStateAPI.addHarness({
          id: 'stub',
          driverId: 'claude',
          name: 'Stub',
          accentColor: '#4f5bd5',
          binaryPath,
        }),
      [stubPath] as const
    );
    await page.evaluate(
      ([name, folder]) => window.workspaceAPI.createWorkspace(name, folder, false, 'stub'),
      ['fleet', containerDir] as const
    );

    // Point this window at the workspace through the real switcher UI.
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /fleet/ }).click();

    // ＋ New → Fan-out…
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: 'Fan-out…' }).click();

    // The default scope is the workspace's folder; its child repos appear.
    await page.getByRole('checkbox', { name: 'repo-a' }).check();
    await page.getByRole('checkbox', { name: 'repo-b' }).check();
    await page.getByLabel('Group name').fill('bump-deps');
    await page.getByLabel(/Prompt/).fill('Say hello in each repo.');
    await page.getByRole('button', { name: /Create group · 2 sessions/ }).click();

    // The dialog closes; the sidebar shows the group with both members.
    await expect(page.getByText('bump-deps')).toBeVisible();
    await expect(page.getByText('repo-a')).toBeVisible();
    await expect(page.getByText('repo-b')).toBeVisible();
    // The derived badge: two members, none needing attention.
    await expect(page.locator('.group-nav-count')).toHaveText('2');
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Build and run it**

Run: `npm run build && npx playwright test tests/e2e/fanout.spec.ts`
Expected: PASS. If the repo checkboxes never appear, the scope id resolution is the first suspect: assert what `window.workspaceAPI.getSnapshot()` reports for the workspace's `scopes` before debugging the dialog.

- [ ] **Step 3: Full E2E suite**

Run: `npx playwright test`
Expected: the pre-existing specs (`terminal.spec.ts`, `windows.spec.ts`) still pass alongside the new one.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/fanout.spec.ts
git commit -m "test: e2e fan-out of two stub sessions renders a counted group"
```

---

## Execution order and dependencies

Tasks are ordered to be executed 1 → 12. The hard edges: 3 needs 2; 4 needs 3; 7 needs 5; 8 needs 5, 6, and 7; 9 needs 4; 10 needs 8; 11 needs 3; 12 needs 9 and 10. Tasks 1, 2, 5, and 6 are independent starting points.
