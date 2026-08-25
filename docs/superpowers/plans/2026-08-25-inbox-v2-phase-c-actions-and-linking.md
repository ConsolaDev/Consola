# Inbox v2 Phase C — Actions, Sessions and Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Starting a session from an Inbox item names an *action* — a workspace-configured `{ name, appliesTo, prompt }` record rendered behind the provider's fixed context header — and every launch mints a fresh session that shares the item's worktree with its siblings. The session ↔ item relation becomes a mutable link visible from both ends: the Inbox detail pane lists an item's sessions and starts new ones; the sidebar names work-item sessions `PR #4118 · Review` (or `⑂ <name>` for a linked one) and its menu links and unlinks; the strip above a terminal shows the action pill and its sibling sessions. Actions are edited in the Workspace Settings modal's new `ActionsPanel`.

**Architecture:** Phase B already moved the seam (`src/main/providers/`, `GitProviderDriver`, `InboxService`, `workItems.ts`, v7 state with `actions` / `sectionDefaults` / mutable `workItem`, `workspace:set-actions`) and Phase A built `WorkspaceSettingsModal` with an `ActionsPlaceholderPanel`. This phase rewrites the launch payload (`provider:launch-work-item` takes `(workspaceId, ref, action)` and always creates a new session), adds prompt rendering (`renderActionPrompt`) and label derivation (`sessionLabel`) to `src/shared`, replaces the flat row's action button with a selectable row plus an `InboxItemPane`, introduces one self-mounting `LinkSessionDialog` serving two doors over a small `SearchableList` primitive, widens the sidebar's `SessionActionsMenu`, adds the strip's pill and sibling menu, and ships `ActionsPanel`. Nothing here branches on a provider id: the header template comes from `PROVIDER_META`, the driver renders it, main returns the finished `seedPrompt`.

**Tech Stack:** Electron 28 (main + preload + renderer), React 19, Zustand 5, Radix Dialog / DropdownMenu, `lucide-react`, vitest (node env, co-located `src/**/*.test.ts`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-inbox-actions-and-provider-seam-design.md` — "Domain model" (placeholders, default actions, name snapshot), "Behaviour" ("Starting a session from an action", "Linking", "Inbox view (layout B)" pane paragraph, "Workspace Settings modal" ActionsPanel paragraph, "Sidebar and strip"), "Error handling", "Testing". Binding cross-phase rulings: `contracts.md` "Execution facts", "Phase B", "Phase A", and "Phase C" rulings 1–12. Mockups: `.superpowers/brainstorm/79317-1787637506/content/actions-and-linking.html` (all three scenes) and `inbox-layout.html` option B (the detail pane).

## Global Constraints

- **Prompt placeholders are exactly five**: `{{number}}`, `{{repo}}`, `{{title}}`, `{{url}}`, `{{type}}`. `{{type}}` renders as `pull request` / `issue`. `{{title}}` falls back to `fallbackWorkItemTitle(ref)` (`PR #51` / `Issue #87`) and `{{url}}` to `workItemUrl(ref)` when the item is not cached. A template with no placeholders passes through untouched, so a bare slash command such as `/security-review` is a valid body. The rendered body is trimmed and **must be non-empty**; an empty body is refused before any disk I/O. `seedPrompt = driver.seedHeader(ref, item) + '\n\n' + renderedBody`.
- **`Session.workItemAction` is a name snapshot**, never an id: the action's `name` at launch time, or the literal `'Custom prompt'` for an ad-hoc body. Renaming or deleting an action later never rewrites a session. A *linked* session has `workItem` and no `workItemAction` — that absence is the discriminator.
- **Labels are derived, never stored**: `sessionLabel(session)` is `PR #4118 · Review` / `Issue #212 · Implement` for a launched session, `⑂ <name>` for a linked one, `name` otherwise; `sessionSubtitle(session)` is `name` only when the label stopped showing it. `name` stays renameable and the CLI-summary poll keeps refining it.
- **Every launch is a new session.** There is no re-attach; opening an existing session is an explicit "Open" on a listed session (`activateSession`). All sessions on one item share its worktree (`ensureWorktree` is idempotent and keyed by item).
- **Launch order** (cheap checks before I/O): workspace exists and `workspace.provider` bound → action resolution (`{ id }` looked up in `workspace.actions`, `{ customPrompt }` named `'Custom prompt'`) → header + body render (refuse empty) → `resolveRepo` (`not-cloned`) → `composeEnv` + `ensureWorktree` → `createSession`. No record is created on any failure.
- **Coalescer key** is `${workspaceId}:${workItemKey(ref)}:${workItemActionKey(action)}` where `workItemActionKey` is `action:<id>` or `custom:<trimmed body>` — a double-click on one button mints one session; two different actions on the same item each get their own.
- **Concurrency warning copy, verbatim:** `Another session is working on this — Start anyway`. Renderer-only: when any session on the item has `sessionStatusFor` of `'working'` or `'needs-attention'`, the first click turns the action button into that inline confirm; the second click launches. Never a dialog, never a block.
- **Linking refusals are main-side** (Phase B's `WorkspaceService.updateSession` throws): a `conductor` session, or a session already linked to a *different* item. Re-linking to the same item is a no-op success. The dialog shows the rejection inline in `.dialog-error` and stays open. **Linking never moves the session and never sends a prompt.**
- **Unlink uses presence semantics**: `updateSession(workspaceId, sessionId, { workItem: undefined })` — the key is present and `undefined`, exactly as `groupId` clears. Unlinking a session that runs in an item's worktree leaves it there.
- **Commands:** `npm test` (vitest, node env, `src/**/*.test.ts` — no jsdom, no testing-library; React components are covered by `npm run typecheck` + Playwright), `npx vitest run <path>`, `npm run typecheck`, `npm run build` then `npx playwright test tests/e2e/inbox.spec.ts tests/e2e/workspace-settings.spec.ts` (e2e launches `dist/main/main/index.js`, so build first). `tests/e2e/terminal.spec.ts` fails standalone on main and is not a regression signal.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Conventional prefix, a body that says why.
- **Bridge pattern is binding**: renderer code never touches `window.*API`; everything goes through `src/renderer/services/*Bridge.ts` (`providerBridge`, `inboxBridge`, `workspaceBridge`). Every IPC channel name lives in `IPC_CHANNELS`. Tokens never cross IPC.
- **Seeded prompts ride `initialPrompt`** → `TerminalService`'s guarded queue via `useTerminalStore.setPendingPrompt`. Never invent a second delivery path; never type into a confirmation menu.
- **Use `activateSession`, never `activateSessionAnywhere`**, from the pane, the dialog and the strip: all three only ever name a session in the workspace already on screen.
- **Dialog and dropdown conventions**: Radix dialogs use the shared `.dialog-overlay/.dialog-content/.dialog-title/.dialog-description/.dialog-actions/.dialog-button-primary/-secondary/-danger/.dialog-error` classes from `src/renderer/components/Dialogs/styles.css`; dropdowns use `.dropdown-content/.dropdown-item/.dropdown-item-destructive/.dropdown-separator`. Every nested `Dialog.Content` rendered from inside the Inbox flow calls `event.stopPropagation()` in `onEscapeKeyDown` so the Inbox's own `Esc` (close pane) listener does not fire underneath. A menu item that opens a dialog guards `onCloseAutoFocus` (the `WorkspaceSwitcher` pattern).
- **Styling**: co-located `styles.css` per component using `var(--space-*)`, `var(--color-*)`, `var(--radius-*)`, `var(--font-size-*)` tokens; icons from `lucide-react` only. Status dots come from one stylesheet, `src/renderer/styles/statusDots.css` (`.status-dot`, `.status-dot--working|--ready|--needs-attention|--done|--exited`), mirroring the colours `Sidebar/styles.css` gives `.session-status-indicator--*`.
- **No emoji** in code, comments or UI copy. The `⑂` glyph (U+2442) the spec uses for linked sessions is a symbol, not an emoji, and is allowed.
- **Phase B names are consumed as given** (contracts.md): `src/shared/workItems.ts` (`WorkItemRef`, `InboxItem`, `InboxSnapshot`, `sameWorkItem`, `workItemKey`, `workItemUrl`, `isValidWorkItemRef`), `src/shared/workItemPrompt.ts` (`fallbackWorkItemTitle`, `substitutePlaceholders`, `renderSeedHeader`), `src/shared/workItemActions.ts` (`WorkItemAction`, `createDefaultActions`, `createDefaultSectionDefaults`, `validateActionsWrite`), `src/shared/inboxSections.ts` (`InboxSection`, `sectionFor`, `sectionItemType`, `INBOX_SECTIONS`), `src/shared/providers.ts` (`GitProviderId`, `PROVIDER_META[id].seedHeaderTemplate`), `src/shared/workspace.ts` (`SessionUpdates` incl. `workItem`, `Workspace.provider/actions/sectionDefaults`, `Session.workItemAction`), `src/main/providers/launchWorkItem.ts` deps `getWorkspace, createSession, resolveRepo, ensureWorktree(clonePath, workItem, env), composeEnv(driver, login), findItem, resolveDriver(id)` (`pathExists` is deleted here), `src/main/providers/GitProviderDriver.ts`, `workspaceStore.setActions(workspaceId, actions, sectionDefaults)`. Phase A names: `WorkspaceSettingsModal.tsx` rendering `<ActionsPlaceholderPanel />` under nav id `'actions'`. Where an exact import path or line depends on B/A's output, the task says "verify at execution".

---

### Task 1: `renderActionPrompt` — header + rendered body, empty-body refusal

**Files:**
- Modify: `src/shared/workItemPrompt.ts` (Phase B created it with `fallbackWorkItemTitle`, `substitutePlaceholders`, `renderSeedHeader` — append)
- Modify: `src/shared/workItemPrompt.test.ts` (Phase B created it — append one `describe` block)

**Interfaces:**
- Consumes: `substitutePlaceholders(template, ref, item?)` from Phase B; `InboxItem`, `WorkItemRef` from `src/shared/workItems.ts`.
- Produces: `WorkItemPromptResult`, `renderActionPrompt(header: string, body: string, ref: WorkItemRef, item?: InboxItem): WorkItemPromptResult` — consumed by Task 5's `launchWorkItem`.

- [ ] **Step 1: Append the failing tests**

Append to `src/shared/workItemPrompt.test.ts`. Verify at execution: the file's existing import line from `'./workItemPrompt'` — add `renderActionPrompt` to it (and add `import type { InboxItem, WorkItemRef } from './workItems'` if B's file does not already import those names).

```ts
describe('renderActionPrompt', () => {
  const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
  const item51: InboxItem = {
    workItem: pr51,
    title: 'Extract billing client',
    author: 'steve-sympower',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    commentCount: 1,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
  };
  const header = 'HEADER';

  it('joins the header and the rendered body with a blank line', () => {
    const result = renderActionPrompt(header, 'Review {{type}} #{{number}}.', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\nReview pull request #51.' });
  });

  it('renders every placeholder from the cached item', () => {
    const result = renderActionPrompt(
      header,
      '{{number}} | {{repo}} | {{title}} | {{url}} | {{type}}',
      pr51,
      item51
    );
    expect(result).toEqual({
      ok: true,
      seedPrompt:
        'HEADER\n\n51 | sympower/controller-app | Extract billing client | https://github.com/sympower/controller-app/pull/51 | pull request',
    });
  });

  it('falls back to the plain title and canonical url without a cached item', () => {
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const result = renderActionPrompt(header, '{{title}} {{url}} {{type}}', issue87);
    expect(result).toEqual({
      ok: true,
      seedPrompt: 'HEADER\n\nIssue #87 https://github.com/sympower/controller-app/issues/87 issue',
    });
  });

  it('passes a bare slash command through untouched', () => {
    const result = renderActionPrompt(header, '/security-review', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\n/security-review' });
  });

  it('refuses an empty or whitespace-only rendered body', () => {
    expect(renderActionPrompt(header, '', pr51, item51)).toEqual({
      ok: false,
      message: 'This action has no prompt to send.',
    });
    expect(renderActionPrompt(header, '  \n\t ', pr51, item51).ok).toBe(false);
  });

  it('trims the body but never the header', () => {
    const result = renderActionPrompt(header, '  Fix CI.  \n', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\nFix CI.' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/workItemPrompt.test.ts`
Expected: FAIL — `renderActionPrompt` is not exported from `./workItemPrompt`.

- [ ] **Step 3: Append the implementation to `src/shared/workItemPrompt.ts`**

```ts
export type WorkItemPromptResult =
  | { ok: true; seedPrompt: string }
  | { ok: false; message: string };

/**
 * The prompt seeded into a session started from an action.
 *
 * `header` arrives already rendered — the driver resolved its own template's
 * placeholders — and `body` is the action's raw template, so the two halves
 * cannot disagree about what `{{title}}` means. An empty or whitespace-only
 * rendered body is refused rather than seeding a session with nothing but
 * the header: the header says where the agent is, the body is the job.
 */
export function renderActionPrompt(
  header: string,
  body: string,
  ref: WorkItemRef,
  item?: InboxItem
): WorkItemPromptResult {
  const renderedBody = substitutePlaceholders(body, ref, item).trim();
  if (!renderedBody) {
    return { ok: false, message: 'This action has no prompt to send.' };
  }
  return { ok: true, seedPrompt: `${header}\n\n${renderedBody}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/workItemPrompt.test.ts`
Expected: PASS (B's existing cases plus the six above).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workItemPrompt.ts src/shared/workItemPrompt.test.ts
git commit -m "feat(shared): renderActionPrompt joins the provider header and an action body

An action body is rendered with the same five placeholders as the header
and refused when it comes out empty, so a session is never seeded with
context and no job. A bare slash command passes through untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `sessionLabel` / `sessionSubtitle` — derived labels for work-item sessions

**Files:**
- Create: `src/shared/sessionLabel.ts`
- Create: `src/shared/sessionLabel.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/shared/workspace.ts` (`workItem?`, `workItemAction?`, `name`).
- Produces: `sessionLabel(session: Pick<Session, 'workItem' | 'workItemAction' | 'name'>): string`, `sessionSubtitle(session): string | undefined` — consumed by the pane (Task 10), the dialog (Task 9), the sidebar (Task 12) and the strip (Task 13).

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/sessionLabel.test.ts
import { describe, expect, it } from 'vitest';
import type { WorkItemRef } from './workItems';
import { sessionLabel, sessionSubtitle } from './sessionLabel';

const pr4118: WorkItemRef = { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number: 4118 };
const issue212: WorkItemRef = { ...pr4118, repo: 'sympower/schedule-api', type: 'issue', number: 212 };

describe('sessionLabel', () => {
  it('names a launched PR session by item and action, not by name', () => {
    expect(
      sessionLabel({ workItem: pr4118, workItemAction: 'Review', name: 'LC-416: fix energy axis' })
    ).toBe('PR #4118 · Review');
  });

  it('names a launched issue session the same way', () => {
    expect(
      sessionLabel({ workItem: issue212, workItemAction: 'Implement', name: 'DST drift' })
    ).toBe('Issue #212 · Implement');
  });

  it('keeps the custom-prompt snapshot as the action', () => {
    expect(
      sessionLabel({ workItem: pr4118, workItemAction: 'Custom prompt', name: 'whatever' })
    ).toBe('PR #4118 · Custom prompt');
  });

  it('marks a linked session with the fork glyph and keeps its own name', () => {
    expect(sessionLabel({ workItem: pr4118, name: 'energy axis investigation' })).toBe(
      '⑂ energy axis investigation'
    );
  });

  it('is the plain name for an ordinary session', () => {
    expect(sessionLabel({ name: 'scratch: grafana panels' })).toBe('scratch: grafana panels');
  });
});

describe('sessionSubtitle', () => {
  it('shows the name under a launched session, whose label no longer shows it', () => {
    expect(
      sessionSubtitle({ workItem: pr4118, workItemAction: 'Review', name: 'LC-416: fix energy axis' })
    ).toBe('LC-416: fix energy axis');
  });

  it('is absent for linked and ordinary sessions, whose label already is the name', () => {
    expect(sessionSubtitle({ workItem: pr4118, name: 'energy axis investigation' })).toBeUndefined();
    expect(sessionSubtitle({ name: 'scratch' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/sessionLabel.test.ts`
Expected: FAIL — cannot resolve `./sessionLabel`.

- [ ] **Step 3: Create `src/shared/sessionLabel.ts`**

```ts
import type { Session } from './workspace';

type LabelSource = Pick<Session, 'workItem' | 'workItemAction' | 'name'>;

/**
 * A session's primary label — derived from the record, never from `name`.
 *
 * `workItemAction` is present only for a session this app launched from an
 * action (absent for one linked after the fact), which is exactly the
 * discriminator between "PR #4118 · Review" and "⑂ <name>". Deriving it here
 * means the CLI-summary poll, which keeps rewriting `name`, no longer decides
 * what a work-item row reads; `name` survives as the subtitle.
 */
export function sessionLabel(session: LabelSource): string {
  if (!session.workItem) return session.name;
  if (session.workItemAction) {
    const kind = session.workItem.type === 'pr' ? 'PR' : 'Issue';
    return `${kind} #${session.workItem.number} · ${session.workItemAction}`;
  }
  return `⑂ ${session.name}`;
}

/** `name` as a subtitle or tooltip — only when the label above stopped showing it. */
export function sessionSubtitle(session: LabelSource): string | undefined {
  return session.workItem && session.workItemAction ? session.name : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/sessionLabel.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sessionLabel.ts src/shared/sessionLabel.test.ts
git commit -m "feat(shared): derive work-item session labels from the record

The sidebar and strip read 'PR #4118 · Review' for a launched session and
'⑂ <name>' for a linked one, so the CLI-summary poll that keeps rewriting
name no longer decides what a work-item row says.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `defaultActionFor`, `WorkItemLaunchAction` and `workItemActionKey`

**Files:**
- Modify: `src/shared/workItemActions.ts` (Phase B's file — append `defaultActionFor`)
- Modify: `src/shared/workItemActions.test.ts` (Phase B's file — append one `describe`)
- Modify: `src/shared/workItems.ts` (Phase B's file — append the action payload type and key)
- Modify: `src/shared/workItems.test.ts` (Phase B's file — append one `describe`)

**Interfaces:**
- Consumes: `WorkItemAction` from Phase B.
- Produces: `defaultActionFor(actions: WorkItemAction[], itemType: 'pr' | 'issue', preferredId?: string): WorkItemAction | undefined` (pane, Task 10); `WorkItemLaunchAction = { id: string } | { customPrompt: string }` and `workItemActionKey(action): string` (Tasks 4, 5, 7, 10).

- [ ] **Step 1: Append the failing `defaultActionFor` tests**

Append to `src/shared/workItemActions.test.ts`. Verify at execution: add `defaultActionFor` to the existing import from `'./workItemActions'`, and `import type { WorkItemAction } from './workItemActions'` if the type is not already imported.

```ts
describe('defaultActionFor', () => {
  const review: WorkItemAction = { id: 'a-review', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' };
  const fixCi: WorkItemAction = { id: 'a-fixci', name: 'Fix CI', appliesTo: ['pr'], prompt: 'Fix CI.' };
  const implement: WorkItemAction = { id: 'a-impl', name: 'Implement', appliesTo: ['issue'], prompt: 'Do it.' };
  const both: WorkItemAction = { id: 'a-both', name: 'Summarise', appliesTo: ['pr', 'issue'], prompt: 'Sum.' };
  const actions = [review, fixCi, implement, both];

  it('picks the first action whose appliesTo matches the item type', () => {
    expect(defaultActionFor(actions, 'pr')).toBe(review);
    expect(defaultActionFor(actions, 'issue')).toBe(implement);
  });

  it('honours a preferred id when it matches the type — the section default', () => {
    expect(defaultActionFor(actions, 'pr', 'a-fixci')).toBe(fixCi);
    expect(defaultActionFor(actions, 'issue', 'a-both')).toBe(both);
  });

  it('ignores a preferred id of the wrong type or one that no longer exists', () => {
    expect(defaultActionFor(actions, 'issue', 'a-review')).toBe(implement);
    expect(defaultActionFor(actions, 'pr', 'a-deleted')).toBe(review);
  });

  it('is undefined when nothing applies', () => {
    expect(defaultActionFor([review, fixCi], 'issue')).toBeUndefined();
    expect(defaultActionFor([], 'pr', 'a-review')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Append the failing `workItemActionKey` tests**

Append to `src/shared/workItems.test.ts`. Verify at execution: add `workItemActionKey` to the existing import from `'./workItems'`.

```ts
describe('workItemActionKey', () => {
  it('keys a stored action by id', () => {
    expect(workItemActionKey({ id: 'a-review' })).toBe('action:a-review');
  });

  it('keys a custom prompt by its trimmed body, so a retyped prompt coalesces', () => {
    expect(workItemActionKey({ customPrompt: '  /security-review \n' })).toBe(
      'custom:/security-review'
    );
    expect(workItemActionKey({ customPrompt: 'a' })).not.toBe(workItemActionKey({ customPrompt: 'b' }));
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npx vitest run src/shared/workItemActions.test.ts src/shared/workItems.test.ts`
Expected: FAIL — `defaultActionFor` and `workItemActionKey` are not exported.

- [ ] **Step 4: Append `defaultActionFor` to `src/shared/workItemActions.ts`**

```ts
/**
 * The action the Inbox pane highlights for an item.
 *
 * `preferredId` is the section default; it only wins when it still exists
 * and applies to the item's type, because a default can dangle after a
 * delete or point at an action whose appliesTo was edited underneath it.
 * Otherwise the first applicable action in the user's own order wins —
 * which is what "drag to reorder" is for.
 */
export function defaultActionFor(
  actions: WorkItemAction[],
  itemType: 'pr' | 'issue',
  preferredId?: string
): WorkItemAction | undefined {
  const applicable = actions.filter((action) => action.appliesTo.includes(itemType));
  const preferred = preferredId
    ? applicable.find((action) => action.id === preferredId)
    : undefined;
  return preferred ?? applicable[0];
}
```

- [ ] **Step 5: Append the launch action type and key to `src/shared/workItems.ts`**

```ts
/**
 * What a launch asks for: a stored action by id, or an ad-hoc body that is
 * rendered like an action's but never persisted (its session records the
 * name snapshot 'Custom prompt').
 */
export type WorkItemLaunchAction = { id: string } | { customPrompt: string };

/**
 * 'action:<id>' or 'custom:<trimmed body>' — the key under which one action
 * against one item is coalesced (main) and shown as in-flight (renderer).
 * The raw trimmed body rather than a hash: the strings are short, and an
 * inspectable key is worth more than a shorter one.
 */
export function workItemActionKey(action: WorkItemLaunchAction): string {
  return 'id' in action ? `action:${action.id}` : `custom:${action.customPrompt.trim()}`;
}
```

- [ ] **Step 6: Run both test files to verify they pass**

Run: `npx vitest run src/shared/workItemActions.test.ts src/shared/workItems.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/workItemActions.ts src/shared/workItemActions.test.ts src/shared/workItems.ts src/shared/workItems.test.ts
git commit -m "feat(shared): defaultActionFor and the launch-action payload key

defaultActionFor resolves a section default against what still exists and
applies; workItemActionKey is the one key main's coalescer and the
renderer's in-flight state share, so a double-click mints one session
while two different actions on one item each get their own.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire types — `WorkItemLaunchResult` without `reattached`, three-argument `launchWorkItem`

**Files:**
- Modify: `src/shared/types.ts` (the `WorkItemLaunchResult` union and `ProviderAPI.launchWorkItem`)

**Interfaces:**
- Consumes: `WorkItemLaunchAction` (Task 3), `Session`, `WorkItemRef`.
- Produces: `WorkItemLaunchResult = { ok: true; session: Session; seedPrompt: string } | { ok: false; reason: 'not-cloned' } | { ok: false; reason: 'error'; message: string }`; `ProviderAPI.launchWorkItem: (workspaceId: string, ref: WorkItemRef, action: WorkItemLaunchAction) => Promise<WorkItemLaunchResult>`.

**This task leaves `npm run typecheck` red** in `src/main/providers/launchWorkItem.ts` (returns `reattached`), `src/renderer/services/providerBridge.ts` (two-argument call) and `src/renderer/stores/inboxStore.ts` (reads `reattached`). Task 5 restores main, Task 6 the preload and bridge, Task 7 the store; the renderer stays red at `src/renderer/components/Inbox/index.tsx` until Task 11.

- [ ] **Step 1: Widen the result type**

In `src/shared/types.ts`, replace the union (Phase B kept Phase 1's shape):

```ts
export type WorkItemLaunchResult =
    | { ok: true; session: Session; seedPrompt?: string; reattached: boolean }
    | { ok: false; reason: 'not-cloned' }
    | { ok: false; reason: 'error'; message: string };
```

with:

```ts
/**
 * Outcome of starting a session from an action.
 *
 * Always a fresh session: re-attaching is an explicit "Open" on a listed
 * session, never a side effect of a launch. 'not-cloned' is a normal answer,
 * not an error — the renderer offers the clone-into-scope dialog. 'error'
 * carries the message and is surfaced in the pane, never as a dialog.
 */
export type WorkItemLaunchResult =
    | { ok: true; session: Session; seedPrompt: string }
    | { ok: false; reason: 'not-cloned' }
    | { ok: false; reason: 'error'; message: string };
```

- [ ] **Step 2: Widen the API signature**

In the same file, the `ProviderAPI` interface (Phase B) has:

```ts
    launchWorkItem: (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult>;
```

Replace it with:

```ts
    launchWorkItem: (
        workspaceId: string,
        ref: WorkItemRef,
        action: WorkItemLaunchAction
    ) => Promise<WorkItemLaunchResult>;
```

and extend the import from `./workItems` (verify at execution: B's exact import line) so it reads:

```ts
import type { InboxSnapshot, WorkItemLaunchAction, WorkItemRef } from './workItems';
```

- [ ] **Step 3: Confirm the red is exactly where expected**

Run: `npm run typecheck`
Expected: errors only in `src/main/providers/launchWorkItem.ts` (`reattached` not in type), `src/renderer/services/providerBridge.ts` (expected 3 arguments), `src/renderer/stores/inboxStore.ts` (`reattached` does not exist). Anything else is a Phase B drift to fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "refactor(shared): launch results drop reattached; launches name an action

A launch now takes (workspaceId, ref, action) and always answers with a
fresh session and its seed prompt. Typecheck is red until the main, preload
and renderer sides follow in the next tasks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `launchWorkItem` rewrite — action resolution, always a new session, action-keyed coalescer

**Files:**
- Modify: `src/main/providers/launchWorkItem.ts` (Phase B moved it here; rewrite the whole file)
- Modify: `src/main/providers/launchWorkItem.test.ts` (rewrite the whole file)
- Modify: `src/main/ipc-handlers.ts` (the launch deps object and the `PROVIDER_LAUNCH_WORK_ITEM` handler)
- Modify (only if needed): `src/shared/workspace.ts` (`NewSessionFields` must carry `workItemAction`)

**Interfaces:**
- Consumes: `renderActionPrompt` (Task 1), `WorkItemLaunchAction`, `workItemActionKey`, `workItemKey`, `isValidWorkItemRef` (Phase B, `src/shared/workItems.ts`), `fallbackWorkItemTitle` (Phase B), `GitProviderDriver` (Phase B, `src/main/providers/GitProviderDriver.ts`), `GitProviderId` (`src/shared/providers.ts`), `WorkItemLaunchResult` (Task 4).
- Produces:
  ```ts
  export interface WorkItemLaunchDeps {
    getWorkspace(id: string): Workspace | undefined;
    resolveDriver(id: GitProviderId): GitProviderDriver;
    createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
    resolveRepo(workspace: Workspace, repo: string): string | null;
    ensureWorktree(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<string>;
    composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
    findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
  }
  export async function launchWorkItem(deps, workspaceId, ref, action: WorkItemLaunchAction): Promise<WorkItemLaunchResult>;
  export function createLaunchCoalescer(deps): (workspaceId, ref, action) => Promise<WorkItemLaunchResult>;
  ```
  `pathExists`, `buildSeedPrompt` and `workItemSessionName` are deleted.

- [ ] **Step 1: Make sure `NewSessionFields` can carry the snapshot**

Verify at execution: in `src/shared/workspace.ts`, `NewSessionFields` must read

```ts
export type NewSessionFields = Pick<
  Session,
  'name' | 'workspaceId' | 'instanceId' | 'harnessId' | 'model' | 'scopeId'
> &
  Partial<Pick<Session, 'cwd' | 'groupId' | 'kind' | 'workItem' | 'workItemAction'>>;
```

If Phase B left `'workItemAction'` out of the `Partial<Pick<…>>`, add it now (it is a plain field spread by `createSessionRecord`, so nothing else changes).

- [ ] **Step 2: Rewrite the test file**

```ts
// src/main/providers/launchWorkItem.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../shared/workItems';
import type { WorkItemAction } from '../../shared/workItemActions';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { createLaunchCoalescer, launchWorkItem, type WorkItemLaunchDeps } from './launchWorkItem';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'steve-sympower',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 1,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
  additions: 210,
  deletions: 88,
};

const review: WorkItemAction = {
  id: 'a-review',
  name: 'Review',
  appliesTo: ['pr'],
  prompt: 'Review {{type}} #{{number}} ("{{title}}").',
};
const blank: WorkItemAction = { id: 'a-blank', name: 'Blank', appliesTo: ['pr'], prompt: '   ' };

// Only seedHeader matters to a launch; the seam is proven by the launch
// never naming 'github' itself — the driver comes from deps.resolveDriver.
const stubDriver = {
  id: 'github',
  tokenEnvVar: 'STUB_TOKEN',
  seedHeader: (ref: WorkItemRef, item?: InboxItem) =>
    `HEADER ${ref.type} #${ref.number}${item ? ` "${item.title}"` : ''}`,
} as unknown as GitProviderDriver;

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
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [review, blank],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workspace;
}

function makeDeps(workspace: Workspace, overrides: Partial<WorkItemLaunchDeps> = {}) {
  const created: NewSessionFields[] = [];
  let minted = 0;
  const deps: WorkItemLaunchDeps = {
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    resolveDriver: vi.fn(() => stubDriver),
    createSession: (workspaceId, fields) => {
      created.push(fields);
      minted += 1;
      return {
        ...fields,
        id: `session-${minted}`,
        claudeSessionId: `uuid-${minted}`,
        hasStarted: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      } as Session;
    },
    resolveRepo: vi.fn(() => '/repos/controller-app'),
    ensureWorktree: vi.fn(async () => '/worktrees/controller-app-pr-51'),
    composeEnv: vi.fn(async () => ({ STUB_TOKEN: 'gho_test' })),
    findItem: () => item51,
    ...overrides,
  };
  return { deps, created };
}

describe('launchWorkItem', () => {
  it('errors plainly for an unknown workspace', async () => {
    const { deps } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-missing', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown workspace: ws-missing' });
  });

  it('errors plainly for a workspace without a provider binding, touching nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ provider: undefined }));
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'This workspace has no provider account bound.',
    });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
  });

  it('rejects a malformed ref before anything else', async () => {
    const { deps } = makeDeps(makeWorkspace());
    const bad = { ...pr51, number: 1.5 } as WorkItemRef;
    const result = await launchWorkItem(deps, 'ws-1', bad, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Invalid work item reference.' });
    expect(deps.resolveRepo).not.toHaveBeenCalled();
  });

  it('refuses an unknown action id without resolving the repo', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: 'a-deleted' });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Unknown action.' });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('refuses an empty rendered body before touching disk', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: blank.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'This action has no prompt to send.' });
    expect(created).toHaveLength(0);
    expect(deps.resolveRepo).not.toHaveBeenCalled();
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('reports not-cloned when no scope resolves the repo, creating nothing', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { resolveRepo: vi.fn(() => null) });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'not-cloned' });
    expect(created).toHaveLength(0);
    expect(deps.ensureWorktree).not.toHaveBeenCalled();
  });

  it('creates no session record when the worktree step fails — atomicity', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), {
      ensureWorktree: vi.fn(async () => {
        throw new Error('fatal: not a valid ref');
      }),
    });
    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'fatal: not a valid ref' });
    expect(created).toHaveLength(0);
  });

  it('creates the record with the matched scope, worktree cwd, item and action name, and returns the seed', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);

    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seedPrompt).toBe(
      'HEADER pr #51 "Extract billing client"\n\nReview pull request #51 ("Extract billing client").'
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'Extract billing client',
      workspaceId: 'ws-1',
      harnessId: 'default',
      scopeId: 'scope-controller', // deepest matching scope, not the container
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      workItemAction: 'Review',
    });
    expect(created[0].instanceId).toMatch(/^workspace-ws-1-session-/);
    expect(deps.resolveDriver).toHaveBeenCalledWith('github');
    expect(deps.composeEnv).toHaveBeenCalledWith(stubDriver, 'SymJavi');
    expect(deps.ensureWorktree).toHaveBeenCalledWith('/repos/controller-app', pr51, {
      STUB_TOKEN: 'gho_test',
    });
  });

  it('renders a custom prompt like an action and snapshots the name "Custom prompt"', async () => {
    const { deps, created } = makeDeps(makeWorkspace({ actions: [] }));

    const result = await launchWorkItem(deps, 'ws-1', pr51, {
      customPrompt: '  /security-review on {{repo}}  ',
    });

    expect(result).toMatchObject({
      ok: true,
      seedPrompt: 'HEADER pr #51 "Extract billing client"\n\n/security-review on sympower/controller-app',
    });
    expect(created[0]).toMatchObject({ workItemAction: 'Custom prompt' });
  });

  it('refuses a whitespace-only custom prompt', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const result = await launchWorkItem(deps, 'ws-1', pr51, { customPrompt: ' \n ' });
    expect(result).toEqual({ ok: false, reason: 'error', message: 'This action has no prompt to send.' });
    expect(created).toHaveLength(0);
  });

  it('falls back to the plain label as the name when the inbox has no item', async () => {
    const { deps, created } = makeDeps(makeWorkspace(), { findItem: () => undefined });
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const implement: WorkItemAction = { id: 'a-impl', name: 'Implement', appliesTo: ['issue'], prompt: 'Go.' };
    const workspace = makeWorkspace({ actions: [implement] });
    const { deps: deps2, created: created2 } = makeDeps(workspace, { findItem: () => undefined });

    await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });
    const result = await launchWorkItem(deps2, 'ws-1', issue87, { id: implement.id });

    expect(created[0].name).toBe('PR #51');
    expect(created2[0].name).toBe('Issue #87');
    expect(result).toMatchObject({ ok: true, seedPrompt: 'HEADER issue #87\n\nGo.' });
  });

  it('always mints a new session — an existing one on the same item is not re-attached', async () => {
    const existing = {
      id: 'session-existing',
      name: 'Extract billing client',
      workspaceId: 'ws-1',
      instanceId: 'inst-existing',
      claudeSessionId: 'uuid-existing',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-controller',
      cwd: '/worktrees/controller-app-pr-51',
      kind: 'interactive',
      workItem: pr51,
      workItemAction: 'Review',
      createdAt: 1,
      lastActiveAt: 1,
    } as Session;
    const { deps, created } = makeDeps(makeWorkspace({ sessions: [existing] }));

    const result = await launchWorkItem(deps, 'ws-1', pr51, { id: review.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.id).not.toBe('session-existing');
    expect(created).toHaveLength(1);
    // The shared worktree is re-ensured (idempotent), so both sessions get the same cwd.
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(created[0].cwd).toBe(existing.cwd);
  });
});

describe('createLaunchCoalescer', () => {
  it('coalesces concurrent launches of the same item and action into one call', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    const [first, second] = await Promise.all([
      launch('ws-1', pr51, { id: review.id }),
      launch('ws-1', pr51, { id: review.id }),
    ]);

    expect(created).toHaveLength(1);
    expect(deps.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('does not coalesce two different actions on the same item', async () => {
    const fixCi: WorkItemAction = { id: 'a-fixci', name: 'Fix CI', appliesTo: ['pr'], prompt: 'Fix.' };
    const { deps, created } = makeDeps(makeWorkspace({ actions: [review, fixCi] }));
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51, { id: review.id }), launch('ws-1', pr51, { id: fixCi.id })]);

    expect(created).toHaveLength(2);
    expect(created.map((fields) => fields.workItemAction).sort()).toEqual(['Fix CI', 'Review']);
  });

  it('coalesces a custom prompt by its trimmed body', async () => {
    const { deps, created } = makeDeps(makeWorkspace());
    const launch = createLaunchCoalescer(deps);

    await Promise.all([
      launch('ws-1', pr51, { customPrompt: '/security-review' }),
      launch('ws-1', pr51, { customPrompt: '  /security-review\n' }),
    ]);

    expect(created).toHaveLength(1);
  });

  it('does not coalesce launches of different work items', async () => {
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const implement: WorkItemAction = { id: 'a-impl', name: 'Implement', appliesTo: ['issue'], prompt: 'Go.' };
    const { deps, created } = makeDeps(makeWorkspace({ actions: [review, implement] }));
    const launch = createLaunchCoalescer(deps);

    await Promise.all([launch('ws-1', pr51, { id: review.id }), launch('ws-1', issue87, { id: implement.id })]);

    expect(created).toHaveLength(2);
  });

  it('runs a later launch of the same item and action fresh once the first has settled', async () => {
    const workspace = makeWorkspace();
    const { deps, created } = makeDeps(workspace);
    const launch = createLaunchCoalescer(deps);

    const first = await launch('ws-1', pr51, { id: review.id });
    if (!first.ok) throw new Error('expected the first launch to succeed');
    workspace.sessions = [first.session];
    const second = await launch('ws-1', pr51, { id: review.id });

    // Two clicks, spaced out, are two sessions: always-a-new-session.
    expect(created).toHaveLength(2);
    expect(second.ok && second.session.id).not.toBe(first.session.id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/providers/launchWorkItem.test.ts`
Expected: FAIL — `launchWorkItem` takes three arguments and returns `reattached`; `WorkItemLaunchDeps` requires `pathExists`.

- [ ] **Step 4: Rewrite `src/main/providers/launchWorkItem.ts`**

```ts
import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { InboxItem, WorkItemLaunchAction, WorkItemRef } from '../../shared/workItems';
import { isValidWorkItemRef, workItemActionKey, workItemKey } from '../../shared/workItems';
import { fallbackWorkItemTitle, renderActionPrompt } from '../../shared/workItemPrompt';
import type { WorkItemLaunchResult } from '../../shared/types';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** The driver for the workspace's bound provider; throws on an unknown id. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus the provider's token var for this account. Composed main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
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

/**
 * The action's name snapshot and raw body. A stored action is looked up by
 * id; a custom prompt is named 'Custom prompt' so the sidebar and strip
 * still have a label, and its body is never persisted anywhere.
 */
function resolveAction(
  workspace: Workspace,
  action: WorkItemLaunchAction
): { name: string; body: string } | undefined {
  if ('customPrompt' in action) return { name: 'Custom prompt', body: action.customPrompt };
  const stored = workspace.actions.find((candidate) => candidate.id === action.id);
  return stored ? { name: stored.name, body: stored.prompt } : undefined;
}

/**
 * Start a session from an action: validate -> render -> resolve -> worktree
 * -> record.
 *
 * Everything that can be refused cheaply (workspace, binding, ref, action,
 * an empty rendered body) is refused before any subprocess runs. The
 * worktree exists before the record does, and the record exists before any
 * PTY spawns (the spawn happens when the session pane mounts, exactly like
 * every hand-made session). On any failure nothing is created.
 *
 * Always a new session. Several sessions on one item share its worktree —
 * ensureWorktree is idempotent and keyed by item — and re-attaching is an
 * explicit "Open" in the renderer, never a side effect here.
 */
export async function launchWorkItem(
  deps: WorkItemLaunchDeps,
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
): Promise<WorkItemLaunchResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) {
    return { ok: false, reason: 'error', message: `Unknown workspace: ${workspaceId}` };
  }
  if (!workspace.provider) {
    return { ok: false, reason: 'error', message: 'This workspace has no provider account bound.' };
  }
  if (!isValidWorkItemRef(ref)) {
    return { ok: false, reason: 'error', message: 'Invalid work item reference.' };
  }

  const resolved = resolveAction(workspace, action);
  if (!resolved) return { ok: false, reason: 'error', message: 'Unknown action.' };

  let driver: GitProviderDriver;
  try {
    driver = deps.resolveDriver(workspace.provider.id);
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const item = deps.findItem(workspaceId, ref);
  const prompt = renderActionPrompt(driver.seedHeader(ref, item), resolved.body, ref, item);
  if (!prompt.ok) return { ok: false, reason: 'error', message: prompt.message };

  const clonePath = deps.resolveRepo(workspace, ref.repo);
  if (!clonePath) return { ok: false, reason: 'not-cloned' };

  let worktreePath: string;
  try {
    const env = await deps.composeEnv(driver, workspace.provider.accountLogin);
    worktreePath = await deps.ensureWorktree(clonePath, ref, env);
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const session = deps.createSession(workspaceId, {
    name: item?.title ?? fallbackWorkItemTitle(ref),
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scopeIdForPath(workspace, clonePath),
    cwd: worktreePath,
    kind: 'interactive',
    workItem: ref,
    workItemAction: resolved.name,
  });
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return { ok: true, session, seedPrompt: prompt.seedPrompt };
}

/**
 * Coalesces concurrent launches of the same item *and action* into one
 * in-flight call — the same in-flight-Map pattern InboxService.refresh uses
 * for concurrent refreshes of one workspace.
 *
 * Keyed by item plus action (custom prompts by item plus trimmed body): a
 * double-click on one button still mints one session, while two different
 * actions started back to back on the same item each get their own. It also
 * keeps two concurrent ensureWorktree calls for one item from racing — one
 * call's failure cleanup removing a worktree the other just fast-pathed onto.
 */
export function createLaunchCoalescer(
  deps: WorkItemLaunchDeps
): (
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
) => Promise<WorkItemLaunchResult> {
  const inFlight = new Map<string, Promise<WorkItemLaunchResult>>();
  return (workspaceId, ref, action) => {
    const key = `${workspaceId}:${workItemKey(ref)}:${workItemActionKey(action)}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = launchWorkItem(deps, workspaceId, ref, action).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
```

Verify at execution: `isValidWorkItemRef` is Phase B's ref-shape validator (contracts.md B.5). If B placed it under `src/main/` rather than `src/shared/workItems.ts`, import it from there instead; its contract (known provider id, `owner/name`, `pr | issue`, integer number) is what the malformed-ref test relies on.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/providers/launchWorkItem.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 6: Rewire the handler in `src/main/ipc-handlers.ts`**

Phase B's deps object and handler (verify at execution: the exact variable names B chose for the inbox service and the env composer — the shape below assumes `inbox` and `composeProviderEnv`) become:

```ts
    // Start a session from an action. Worktree first, record second; the
    // spawn is third and happens when the renderer mounts the session pane —
    // the same terminal-create path every session uses.
    const launchWorkItemDeps: WorkItemLaunchDeps = {
        getWorkspace: (id) => workspaces.getAll().find((candidate) => candidate.id === id),
        resolveDriver: getProviderDriver,
        createSession: (id, fields) => workspaces.createSession(id, fields),
        resolveRepo: (workspace, repo) => worktrees.resolveRepo(workspace, repo),
        ensureWorktree: (clonePath, item, env) => worktrees.ensureWorktree(clonePath, item, env),
        composeEnv: composeProviderEnv,
        findItem: (id, ref) => inbox.findItem(id, ref),
    };
    // Coalesced (not just called directly) so two overlapping launches of the
    // same item and action can never mint two sessions for it — see
    // createLaunchCoalescer's doc comment.
    const launchWorkItem = createLaunchCoalescer(launchWorkItemDeps);
    ipcMain.handle(
        IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM,
        (_event, workspaceId: string, ref: WorkItemRef, action: WorkItemLaunchAction) =>
            launchWorkItem(workspaceId, ref, action)
    );
```

The only edits against B's version: the `pathExists` line is deleted, the handler takes `action` and passes it through, and the comments change. Extend the type import so `WorkItemLaunchAction` is available:

```ts
import type { InboxSnapshot, WorkItemLaunchAction, WorkItemRef } from '../shared/workItems';
```

`fs` stays imported — it has nine other uses in this file.

- [ ] **Step 7: Confirm main is green**

Run: `npm run typecheck`
Expected: no errors under `src/main/`. Remaining errors are only `src/renderer/services/providerBridge.ts` and `src/renderer/stores/inboxStore.ts` (restored by Tasks 6 and 7).

- [ ] **Step 8: Commit**

```bash
git add src/main/providers/launchWorkItem.ts src/main/providers/launchWorkItem.test.ts src/main/ipc-handlers.ts src/shared/workspace.ts
git commit -m "feat(main): launch a work item from an action, always as a new session

The launch resolves the action (stored by id, or an ad-hoc body named
'Custom prompt'), renders the provider header plus body and refuses an
empty result before any subprocess runs, then ensures the item's shared
worktree and mints a fresh record carrying the action's name snapshot.
Re-attach is gone: the coalescer is keyed by item and action so only a
double-click collapses into one session.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Preload and `providerBridge` — pass the action through

**Files:**
- Modify: `src/preload/preload.ts` (the `providerAPI.launchWorkItem` entry)
- Modify: `src/renderer/services/providerBridge.ts` (`launchWorkItem`)

**Interfaces:**
- Consumes: `IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM`, `WorkItemLaunchAction`, `WorkItemLaunchResult`.
- Produces: `providerBridge.launchWorkItem(workspaceId: string, ref: WorkItemRef, action: WorkItemLaunchAction): Promise<WorkItemLaunchResult | null>` (null only when the preload is missing, as today).

- [ ] **Step 1: Preload**

In `src/preload/preload.ts`, inside `contextBridge.exposeInMainWorld('providerAPI', { … })`, replace Phase B's

```ts
    launchWorkItem: (workspaceId: string, workItem: WorkItemRef): Promise<WorkItemLaunchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM, workspaceId, workItem),
```

with

```ts
    launchWorkItem: (
        workspaceId: string,
        ref: WorkItemRef,
        action: WorkItemLaunchAction
    ): Promise<WorkItemLaunchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LAUNCH_WORK_ITEM, workspaceId, ref, action),
```

and add `WorkItemLaunchAction` to the preload's type import from `'../shared/workItems'` (verify at execution: B's exact import line).

- [ ] **Step 2: Bridge**

In `src/renderer/services/providerBridge.ts`, replace the `launchWorkItem` member with:

```ts
    /** Start a session from an action: validate -> render -> worktree -> record. */
    launchWorkItem: async (
        workspaceId: string,
        ref: WorkItemRef,
        action: WorkItemLaunchAction
    ): Promise<WorkItemLaunchResult | null> => {
        const api = getAPI();
        if (!api) return null;
        return api.launchWorkItem(workspaceId, ref, action);
    },
```

and add `WorkItemLaunchAction` to its type import from `'../../shared/workItems'`.

- [ ] **Step 3: Confirm the red is now only the store**

Run: `npm run typecheck`
Expected: the only error left is in `src/renderer/stores/inboxStore.ts` (`reattached`, and now the two-argument `launchWorkItem` call). Task 7 restores it.

- [ ] **Step 4: Commit**

```bash
git add src/preload/preload.ts src/renderer/services/providerBridge.ts
git commit -m "feat(preload): launchWorkItem carries the action across the bridge

Positional (workspaceId, ref, action), matching the ProviderAPI contract.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `inboxStore` — action-aware `launch`, `launchKey`, `itemKey`, `cloneRepo` without auto-continue; `CloneDialog`

**Files:**
- Modify: `src/renderer/stores/inboxStore.ts` (rewrite the whole file)
- Modify: `src/renderer/stores/inboxStore.test.ts` (rewrite the whole file)
- Modify: `src/renderer/components/Inbox/CloneDialog.tsx` (rewrite the whole file)

**Interfaces:**
- Consumes: `providerBridge.launchWorkItem/cloneRepo/resolveRepos`, `inboxBridge.getInbox/refreshInbox/onInboxChanged` (Phase B), `workItemKey`, `workItemActionKey`, `WorkItemLaunchAction`, `useTerminalStore.setPendingPrompt`, `activateSession`.
- Produces:
  - `itemKey(workspaceId: string, item: InboxItem): string` — `${workspaceId}:${workItemKey(item.workItem)}`; the key for item-level state (clone in flight, clone error).
  - `launchKey(workspaceId: string, item: InboxItem, action: WorkItemLaunchAction): string` — `${itemKey}:${workItemActionKey(action)}`; the key for one action's in-flight state and error.
  - `launch(workspaceId, item, action: WorkItemLaunchAction): Promise<void>`, `cloneRepo(workspaceId, item, destinationDir): Promise<void>` (clones, records the path, closes the prompt — the user then starts an action from the pane), `openClonePrompt`, `dismissClonePrompt`, `launching: Record<string, boolean>`, `launchErrors: Record<string, string>` (both keyed by `launchKey` for launches and by `itemKey` for clones).

This task restores typecheck for the store but **leaves it red at `src/renderer/components/Inbox/index.tsx`** (it still calls `launch(workspace.id, item)` with two arguments). Task 11 restores it; Tasks 8–10 add new files only.

- [ ] **Step 1: Rewrite the test file**

Verify at execution: Phase B split `githubBridge` into `inboxBridge` and `providerBridge` — the two `vi.mock` blocks below name their methods per contracts.md B.9; keep whichever of B's mock blocks already match.

```ts
// src/renderer/stores/inboxStore.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../shared/workItems';

vi.mock('../services/inboxBridge', () => ({
  inboxBridge: {
    getInbox: vi.fn(async () => null),
    refreshInbox: vi.fn(async () => undefined),
    onInboxChanged: vi.fn(() => () => {}),
  },
}));

vi.mock('../services/providerBridge', () => ({
  providerBridge: {
    probe: vi.fn(),
    resolveRepos: vi.fn(async () => ({})),
    launchWorkItem: vi.fn(),
    cloneRepo: vi.fn(),
  },
}));

// navigationStore reads windowBridge.context at store-creation time, and
// sessionActions.activateSession calls windowBridge.setActiveSession — both
// reach through `window.windowAPI`, a global this suite's node environment
// doesn't have. Same workaround as navigationStore.test.ts: mock the module
// (hoisted above the import below) so the real stores load without a DOM.
vi.mock('../services/windowBridge', () => ({
  windowBridge: {
    context: { workspaceId: null, activeSessionId: null },
    activateWorkspace: vi.fn(),
    openWindow: vi.fn(),
    setActiveSession: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => {}),
  },
}));

import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
import { useNavigationStore } from './navigationStore';
import { useTerminalStore } from './terminalStore';
import { itemKey, launchKey, useInboxStore } from './inboxStore';

const item51: InboxItem = {
  workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
  title: 'Extract billing client',
  author: 'steve-sympower',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 0,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

const review = { id: 'a-review' };
const snapshot: InboxSnapshot = { workspaceId: 'ws-1', items: [item51], fetchedAt: Date.now() };

beforeEach(() => {
  useInboxStore.setState({
    snapshots: {},
    resolvedRepos: {},
    launchErrors: {},
    launching: {},
    clonePrompt: null,
  });
  useTerminalStore.setState({ pendingPrompts: {} });
  useNavigationStore.setState({ activeSessionId: null });
  vi.clearAllMocks();
});

describe('keys', () => {
  it('scopes a launch key by workspace, item and action; an item key by workspace and item', () => {
    expect(itemKey('ws-1', item51)).toBe('ws-1:github:sympower/controller-app:pr:51');
    expect(launchKey('ws-1', item51, review)).toBe(
      'ws-1:github:sympower/controller-app:pr:51:action:a-review'
    );
    expect(launchKey('ws-1', item51, { customPrompt: ' /x ' })).toBe(
      'ws-1:github:sympower/controller-app:pr:51:custom:/x'
    );
  });
});

describe('load', () => {
  it('adopts the snapshot when the bridge resolves one', async () => {
    vi.mocked(inboxBridge.getInbox).mockResolvedValue(snapshot);
    await useInboxStore.getState().load('ws-1');
    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
  });

  it('does not throw when the bridge call rejects', async () => {
    vi.mocked(inboxBridge.getInbox).mockRejectedValue(new Error('main process crashed'));
    await expect(useInboxStore.getState().load('ws-1')).resolves.toBeUndefined();
  });
});

describe('refresh', () => {
  it('does not throw when the bridge call rejects', async () => {
    vi.mocked(inboxBridge.refreshInbox).mockRejectedValue(new Error('main process crashed'));
    await expect(useInboxStore.getState().refresh('ws-1')).resolves.toBeUndefined();
  });
});

describe('adoptSnapshot', () => {
  it('stores the snapshot by workspace and asks main which repos are cloned', async () => {
    vi.mocked(providerBridge.resolveRepos).mockResolvedValue({
      'sympower/controller-app': '/repos/controller-app',
    });

    useInboxStore.getState().adoptSnapshot(snapshot);
    await vi.waitFor(() => {
      expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
        'sympower/controller-app': '/repos/controller-app',
      });
    });

    expect(useInboxStore.getState().snapshots['ws-1']).toEqual(snapshot);
    expect(providerBridge.resolveRepos).toHaveBeenCalledWith('ws-1', ['sympower/controller-app']);
  });
});

describe('launch', () => {
  it('passes the action through, seeds the prompt and activates the new session', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: true,
      seedPrompt: 'HEADER\n\nReview it.',
      session: { id: 'session-1', instanceId: 'inst-1' } as never,
    });

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(providerBridge.launchWorkItem).toHaveBeenCalledWith('ws-1', item51.workItem, review);
    expect(useTerminalStore.getState().pendingPrompts['inst-1']).toBe('HEADER\n\nReview it.');
    expect(useNavigationStore.getState().activeSessionId).toBe('session-1');
    expect(useInboxStore.getState().launching[launchKey('ws-1', item51, review)]).toBeUndefined();
  });

  it('marks only that action as in flight while the launch runs', async () => {
    let resolveLaunch!: (value: never) => void;
    vi.mocked(providerBridge.launchWorkItem).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve as never;
      })
    );

    const pending = useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launching[launchKey('ws-1', item51, review)]).toBe(true);
    expect(
      useInboxStore.getState().launching[launchKey('ws-1', item51, { id: 'a-fixci' })]
    ).toBeUndefined();

    resolveLaunch({ ok: false, reason: 'error', message: 'x' } as never);
    await pending;
  });

  it('records an error on the item+action key when the launch fails', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({
      ok: false,
      reason: 'error',
      message: 'fatal: not a valid ref',
    });

    await useInboxStore.getState().launch('ws-1', item51, review);

    const key = launchKey('ws-1', item51, review);
    expect(useInboxStore.getState().launchErrors[key]).toBe('fatal: not a valid ref');
    expect(useInboxStore.getState().launching[key]).toBeUndefined();
  });

  it('opens the clone prompt when the repo is not cloned', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue({ ok: false, reason: 'not-cloned' });

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().clonePrompt).toEqual({ workspaceId: 'ws-1', item: item51 });
  });

  it('records an error, keyed, when launchWorkItem rejects instead of resolving', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockRejectedValue(new Error('main process crashed'));

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51, review)]).toBe(
      'main process crashed'
    );
  });

  it('records an error when the bridge degrades to null', async () => {
    vi.mocked(providerBridge.launchWorkItem).mockResolvedValue(null);

    await useInboxStore.getState().launch('ws-1', item51, review);

    expect(useInboxStore.getState().launchErrors[launchKey('ws-1', item51, review)]).toBe(
      'Could not reach the main process to launch this item.'
    );
  });
});

describe('cloneRepo', () => {
  it('clones, records the resolved path, closes the prompt, and does not launch', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: true, path: '/repos/controller-app' });
    useInboxStore.setState({ clonePrompt: { workspaceId: 'ws-1', item: item51 } });

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(providerBridge.cloneRepo).toHaveBeenCalledWith('ws-1', 'sympower/controller-app', '/repos');
    expect(useInboxStore.getState().resolvedRepos['ws-1']).toEqual({
      'sympower/controller-app': '/repos/controller-app',
    });
    expect(useInboxStore.getState().clonePrompt).toBeNull();
    // No auto-continue: the pane now offers the actions and the user picks one.
    expect(providerBridge.launchWorkItem).not.toHaveBeenCalled();
    expect(useInboxStore.getState().launching[itemKey('ws-1', item51)]).toBeUndefined();
  });

  it('surfaces a clone failure on the item key and leaves the repo unresolved', async () => {
    vi.mocked(providerBridge.cloneRepo).mockResolvedValue({ ok: false, error: 'denied' });

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[itemKey('ws-1', item51)]).toBe('denied');
    expect(useInboxStore.getState().resolvedRepos['ws-1']).toBeUndefined();
  });

  it('records an error when the bridge rejects', async () => {
    vi.mocked(providerBridge.cloneRepo).mockRejectedValue(new Error('main process crashed'));

    await useInboxStore.getState().cloneRepo('ws-1', item51, '/repos');

    expect(useInboxStore.getState().launchErrors[itemKey('ws-1', item51)]).toBe('main process crashed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: FAIL — `itemKey` and `cloneRepo` are not exported / not on the store; `launch` ignores its third argument.

- [ ] **Step 3: Rewrite `src/renderer/stores/inboxStore.ts`**

```ts
import { create } from 'zustand';
import type { InboxItem, InboxSnapshot, WorkItemLaunchAction } from '../../shared/workItems';
import { workItemActionKey, workItemKey } from '../../shared/workItems';
import { inboxBridge } from '../services/inboxBridge';
import { providerBridge } from '../services/providerBridge';
import { activateSession } from '../utils/sessionActions';
import { useTerminalStore } from './terminalStore';

/** Key for per-item state: one workspace's view of one work item. */
export function itemKey(workspaceId: string, item: InboxItem): string {
  return `${workspaceId}:${workItemKey(item.workItem)}`;
}

/**
 * Key for one action against one item — the same key main's coalescer uses,
 * so what the UI shows as in flight is exactly what main would collapse.
 */
export function launchKey(
  workspaceId: string,
  item: InboxItem,
  action: WorkItemLaunchAction
): string {
  return `${itemKey(workspaceId, item)}:${workItemActionKey(action)}`;
}

interface InboxState {
  /** Per-workspace snapshots, fed by main's inbox:changed pushes. */
  snapshots: Record<string, InboxSnapshot>;
  /** Per-workspace map of remote repo -> local clone path (null = not cloned). */
  resolvedRepos: Record<string, Record<string, string | null>>;
  /**
   * Failures surfaced in the pane — never a dialog. Keyed by launchKey for a
   * launch (one action's error sits under its own button) and by itemKey for
   * a clone (the item's only error at that point).
   */
  launchErrors: Record<string, string>;
  /** Same keying as launchErrors: which button, or which item, is busy. */
  launching: Record<string, boolean>;
  /** The item whose repo needs cloning; renders the clone dialog when set. */
  clonePrompt: { workspaceId: string; item: InboxItem } | null;
  load: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  adoptSnapshot: (snapshot: InboxSnapshot) => void;
  launch: (workspaceId: string, item: InboxItem, action: WorkItemLaunchAction) => Promise<void>;
  cloneRepo: (workspaceId: string, item: InboxItem, destinationDir: string) => Promise<void>;
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
    try {
      const snapshot = await inboxBridge.getInbox(workspaceId);
      // null means main has no cache yet; it has kicked off a refresh and the
      // result will arrive on the push channel.
      if (snapshot) get().adoptSnapshot(snapshot);
    } catch (error) {
      // Same "degrade, never dialog" reasoning as launch(): this is called
      // fire-and-forget (`void load(...)`) from the Sidebar, and there is no
      // per-item error key to write into — so log rather than let the
      // rejection escape as unhandled.
      console.error('inboxStore.load failed:', error);
    }
  },

  refresh: async (workspaceId) => {
    try {
      await inboxBridge.refreshInbox(workspaceId);
    } catch (error) {
      // Same reasoning as load(): `void refresh(...)` from the refresh
      // button has no per-item error key either.
      console.error('inboxStore.refresh failed:', error);
    }
  },

  adoptSnapshot: (snapshot) => {
    set((state) => ({
      snapshots: { ...state.snapshots, [snapshot.workspaceId]: snapshot },
    }));
    // Repo resolution rides along so the pane is honest about "Clone into
    // scope...". Fire-and-forget: until it lands, items assume "cloned" and
    // the launch path corrects them.
    const repos = [...new Set(snapshot.items.map((item) => item.workItem.repo))];
    if (repos.length === 0) return;
    void providerBridge.resolveRepos(snapshot.workspaceId, repos).then((resolved) => {
      set((state) => ({
        resolvedRepos: { ...state.resolvedRepos, [snapshot.workspaceId]: resolved },
      }));
    });
  },

  launch: async (workspaceId, item, action) => {
    const key = launchKey(workspaceId, item, action);
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await providerBridge.launchWorkItem(workspaceId, item.workItem, action);
      if (!result) {
        // Only reachable when window.providerAPI itself is missing (a broken
        // preload) — the bridge already null-guarded, so this is main being
        // unreachable rather than a provider-side failure.
        set((state) => ({
          launchErrors: {
            ...state.launchErrors,
            [key]: 'Could not reach the main process to launch this item.',
          },
        }));
        return;
      }
      if (result.ok) {
        // Always a fresh session, so the prompt is always seeded. It rides
        // the existing pending-prompt path: the terminal pane consumes it on
        // mount and sends it as initialPrompt, where the main-side guarded
        // queue delivers it — never into a menu.
        useTerminalStore.getState().setPendingPrompt(result.session.instanceId, result.seedPrompt);
        activateSession(workspaceId, result.session.id);
      } else if (result.reason === 'not-cloned') {
        get().openClonePrompt(workspaceId, item);
      } else {
        set((state) => ({ launchErrors: { ...state.launchErrors, [key]: result.message } }));
      }
    } catch (error) {
      // "Degrade, never dialog" applies to a thrown/rejected launch too —
      // an unhandled rejection would otherwise leave the button silent
      // instead of surfacing the error under it.
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ launchErrors: { ...state.launchErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  cloneRepo: async (workspaceId, item, destinationDir) => {
    const key = itemKey(workspaceId, item);
    // Same shape as launch(): guard set before the first await, errors land
    // on the item (never a dialog), guard cleared on every path. The clone
    // does not continue into a launch: which action to start is the user's
    // choice, and the pane offers them all once the repo resolves.
    set((state) => {
      const { [key]: _cleared, ...launchErrors } = state.launchErrors;
      return { clonePrompt: null, launching: { ...state.launching, [key]: true }, launchErrors };
    });
    try {
      const result = await providerBridge.cloneRepo(workspaceId, item.workItem.repo, destinationDir);
      if (!result || !result.ok) {
        set((state) => ({
          launchErrors: { ...state.launchErrors, [key]: result?.error ?? 'Clone failed.' },
        }));
        return;
      }
      if (result.path) {
        // Record the resolved path immediately so the pane stops offering
        // "Clone into scope..." for a repo that now has one, without waiting
        // for the next snapshot's resolveRepos round trip.
        const path = result.path;
        set((state) => ({
          resolvedRepos: {
            ...state.resolvedRepos,
            [workspaceId]: { ...state.resolvedRepos[workspaceId], [item.workItem.repo]: path },
          },
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ launchErrors: { ...state.launchErrors, [key]: message } }));
    } finally {
      set((state) => {
        const { [key]: _done, ...launching } = state.launching;
        return { launching };
      });
    }
  },

  openClonePrompt: (workspaceId, item) => set({ clonePrompt: { workspaceId, item } }),

  dismissClonePrompt: () => set({ clonePrompt: null }),

  subscribeToEvents: () => inboxBridge.onInboxChanged((snapshot) => get().adoptSnapshot(snapshot)),
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/stores/inboxStore.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Rewrite `src/renderer/components/Inbox/CloneDialog.tsx`**

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import { dialogBridge } from '../../services/dialogBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

/**
 * "Clone into scope..." — the one dialog in the inbox flow, and it is about
 * the local disk, not the provider: where should this repo live? Container
 * scopes are offered first; an arbitrary folder becomes a new scope holding
 * the clone (main adds the scope record). Nothing launches afterwards: once
 * the repo resolves, the pane offers every action and the user picks one.
 */
export function CloneDialog() {
  const clonePrompt = useInboxStore((state) => state.clonePrompt);
  const dismiss = useInboxStore((state) => state.dismissClonePrompt);
  const cloneRepo = useInboxStore((state) => state.cloneRepo);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === clonePrompt?.workspaceId)
  );

  if (!clonePrompt || !workspace) return null;
  const { item, workspaceId } = clonePrompt;
  const containers = workspace.scopes.filter((scope) => !scope.isGitRepo);

  const chooseFolder = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    void cloneRepo(workspaceId, item, folder.path);
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
        <Dialog.Content
          className="clone-dialog"
          // The Inbox closes its detail pane on Esc; a dialog's Esc must not
          // reach that listener, or one keypress would close both.
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="clone-dialog-title">Clone {item.workItem.repo}</Dialog.Title>
          <Dialog.Description className="clone-dialog-description">
            This repo is not cloned in any scope of {workspace.name}. Pick where the clone should
            live; the item's actions become available once it lands.
          </Dialog.Description>
          <div className="clone-dialog-options">
            {containers.map((scope) => (
              <button
                key={scope.id}
                className="clone-dialog-option"
                onClick={() => void cloneRepo(workspaceId, item, scope.path)}
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

- [ ] **Step 6: Confirm the red is now only the Inbox view**

Run: `npm run typecheck`
Expected: errors only in `src/renderer/components/Inbox/index.tsx` (`launch` expects 3 arguments; `cloneAndLaunch` is not referenced there, so that one is already gone). Task 11 restores it.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/stores/inboxStore.ts src/renderer/stores/inboxStore.test.ts src/renderer/components/Inbox/CloneDialog.tsx
git commit -m "feat(renderer): inboxStore launches name an action; cloning no longer auto-launches

launch(workspaceId, item, action) keys its in-flight state and errors by
item plus action, so two buttons on one item never share a spinner or an
error. cloneRepo replaces cloneAndLaunch: with several actions per item
there is no single launch to continue into, so the clone lands, the repo
resolves, and the pane offers the choice.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `statusDots.css` and the `SearchableList` primitive

**Files:**
- Create: `src/renderer/styles/statusDots.css`
- Modify: `src/renderer/main.tsx` (import the stylesheet after `./styles/global.css`)
- Create: `src/renderer/components/SearchableList/rankSearchableItems.ts`
- Create: `src/renderer/components/SearchableList/rankSearchableItems.test.ts`
- Create: `src/renderer/components/SearchableList/SearchableList.tsx`
- Create: `src/renderer/components/SearchableList/styles.css`
- Create: `src/renderer/components/SearchableList/index.ts`

**Interfaces:**
- Consumes: `rankItem` from `src/renderer/components/CommandPalette/fuzzyMatch.ts`; `HighlightMatch`.
- Produces:
  - CSS classes `.status-dot`, `.status-dot--working`, `.status-dot--ready`, `.status-dot--needs-attention`, `.status-dot--done`, `.status-dot--exited` (global; used by Tasks 9, 10, 13; Phase D reuses them for rows).
  - `SearchableListItem { id; label; context?; disabled?; disabledHint? }`, `rankSearchableItems<T extends SearchableListItem>(items: T[], query: string): T[]`.
  - `SearchableList<T>` props: `{ items: T[]; query: string; onQueryChange(query): void; placeholder: string; inputAriaLabel: string; emptyMessage: string; activeId: string | null; onActiveChange(id: string | null): void; onActivate(item: T): void; leadingSlot?(item: T): React.ReactNode }`. The highlighted row is controlled (`activeId`) so a dialog's Link button can act on it; `onActivate` fires on Enter or double-click on an enabled row.

- [ ] **Step 1: Create `src/renderer/styles/statusDots.css`**

```css
/*
 * Session status dots, shared.
 *
 * The sidebar's `.session-status-indicator--*` rules (Sidebar/styles.css)
 * were the only place a session's status had a colour. The Inbox pane, the
 * link dialog and the strip's sibling menu all show the same vocabulary, so
 * the shapes and colours live here once: filled accent for working, a dim
 * ring for ready, a heavy warning ring for needs-attention, filled success
 * for done, an error ring for exited. Shape carries meaning alongside hue.
 */
.status-dot {
  box-sizing: border-box;
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot--working {
  background: var(--color-accent);
  animation: status-dot-pulse 1.5s ease-in-out infinite;
}

.status-dot--ready {
  border: 1px solid color-mix(in srgb, var(--color-text-secondary) 70%, transparent);
}

.status-dot--needs-attention {
  border: 2px solid var(--color-warning);
}

.status-dot--done {
  background: var(--color-success);
}

.status-dot--exited {
  border: 1px solid var(--color-error);
}

@keyframes status-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot--working {
    animation: none;
  }
}
```

- [ ] **Step 2: Import it globally**

In `src/renderer/main.tsx`, directly after `import './styles/global.css';` add:

```ts
import './styles/statusDots.css';
```

- [ ] **Step 3: Write the failing ranking test**

```ts
// src/renderer/components/SearchableList/rankSearchableItems.test.ts
import { describe, expect, it } from 'vitest';
import { rankSearchableItems, type SearchableListItem } from './rankSearchableItems';

const energy: SearchableListItem = { id: 's1', label: 'energy axis investigation', context: 'flex-portal' };
const scratch: SearchableListItem = { id: 's2', label: 'scratch: grafana panels', context: 'energy-tools' };
const renovate: SearchableListItem = { id: 's3', label: 'renovate triage', context: 'sympower' };
const linked: SearchableListItem = {
  id: 's4',
  label: 'PR #4118 · Fix CI',
  context: 'flex-portal',
  disabled: true,
  disabledHint: 'already linked',
};
const items = [scratch, renovate, energy, linked];

describe('rankSearchableItems', () => {
  it('keeps the caller order for an empty or blank query', () => {
    expect(rankSearchableItems(items, '')).toEqual(items);
    expect(rankSearchableItems(items, '   ')).toEqual(items);
  });

  it('drops items that match neither label nor context', () => {
    expect(rankSearchableItems(items, 'energy').map((item) => item.id)).not.toContain('s3');
  });

  it('ranks a label hit above a context-only hit', () => {
    expect(rankSearchableItems(items, 'energy').map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('keeps disabled items in the ranking — they are shown greyed, not hidden', () => {
    expect(rankSearchableItems(items, 'fix ci').map((item) => item.id)).toEqual(['s4']);
  });

  it('preserves caller order between equal scores', () => {
    const a = { id: 'a', label: 'Review' };
    const b = { id: 'b', label: 'Review' };
    expect(rankSearchableItems([a, b], 'rev')).toEqual([a, b]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/SearchableList/rankSearchableItems.test.ts`
Expected: FAIL — cannot resolve `./rankSearchableItems`.

- [ ] **Step 5: Create `rankSearchableItems.ts`**

```ts
// src/renderer/components/SearchableList/rankSearchableItems.ts
import { rankItem } from '../CommandPalette/fuzzyMatch';

export interface SearchableListItem {
  id: string;
  /** Matched against and shown; the highlight renders over it. */
  label: string;
  /** Trailing dim text, searchable as a substring (a repo, a folder). */
  context?: string;
  /** Listed but not activatable; `disabledHint` says why in its place. */
  disabled?: boolean;
  disabledHint?: string;
}

/**
 * Rank a picker's rows by the palette's matcher, so a session found here and
 * a session found in the palette agree on what "matches".
 *
 * A blank query keeps the caller's order — the caller sorted by recency or
 * by inbox position, and that order is the answer to "show me everything".
 * Disabled rows rank like any other: hiding an already-linked session would
 * make the user hunt for a row that is simply unavailable.
 */
export function rankSearchableItems<T extends SearchableListItem>(items: T[], query: string): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return items;

  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const match = rankItem(trimmed, item.label, item.context);
    if (match) scored.push({ item, score: match.score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/SearchableList/rankSearchableItems.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Create `SearchableList.tsx`**

```tsx
// src/renderer/components/SearchableList/SearchableList.tsx
import { useEffect, useMemo, useRef } from 'react';
import { HighlightMatch } from '../HighlightMatch';
import { rankSearchableItems, type SearchableListItem } from './rankSearchableItems';
import './styles.css';

interface SearchableListProps<T extends SearchableListItem> {
  items: T[];
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  inputAriaLabel: string;
  emptyMessage: string;
  /** The highlighted row. Controlled, so a dialog's primary button can act on it. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  /** Enter, or a double-click, on an enabled highlighted row. */
  onActivate: (item: T) => void;
  /** Rendered before the label — a status dot, an icon. */
  leadingSlot?: (item: T) => React.ReactNode;
}

/** Row ids double as `aria-activedescendant` targets, so they must be valid. */
function rowElementId(itemId: string): string {
  return `searchable-list-option-${encodeURIComponent(itemId)}`;
}

/**
 * A search box over a ranked, keyboard-navigable list — the picker inside
 * the link dialog. Deliberately smaller than the command palette (one flat
 * list, no sections, no modes) and built on its matcher and its listbox
 * conventions (`role="option"`, mousemove-not-mouseenter, scroll-into-view).
 */
export function SearchableList<T extends SearchableListItem>({
  items,
  query,
  onQueryChange,
  placeholder,
  inputAriaLabel,
  emptyMessage,
  activeId,
  onActiveChange,
  onActivate,
  leadingSlot,
}: SearchableListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const ranked = useMemo(() => rankSearchableItems(items, query), [items, query]);

  // Keep the highlight on something activatable: when the query drops the
  // active row, or the active row is disabled, fall to the first enabled one.
  useEffect(() => {
    const active = ranked.find((item) => item.id === activeId);
    if (active && !active.disabled) return;
    const first = ranked.find((item) => !item.disabled);
    onActiveChange(first ? first.id : null);
  }, [ranked, activeId, onActiveChange]);

  // Follow the keyboard when the selection moves past the visible rows.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const move = (delta: 1 | -1) => {
    if (ranked.length === 0) return;
    const current = ranked.findIndex((item) => item.id === activeId);
    let next = current;
    for (let step = 0; step < ranked.length; step++) {
      next = (next + delta + ranked.length) % ranked.length;
      if (!ranked[next].disabled) {
        onActiveChange(ranked[next].id);
        return;
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      const active = ranked.find((item) => item.id === activeId);
      if (active && !active.disabled) {
        event.preventDefault();
        onActivate(active);
      }
    }
  };

  return (
    <div className="searchable-list">
      <input
        type="text"
        className="dialog-input searchable-list-input"
        role="combobox"
        aria-expanded
        aria-controls="searchable-list-rows"
        aria-activedescendant={activeId ? rowElementId(activeId) : undefined}
        aria-label={inputAriaLabel}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="searchable-list-rows" role="listbox" id="searchable-list-rows" ref={listRef}>
        {ranked.length === 0 && <div className="searchable-list-empty">{emptyMessage}</div>}
        {ranked.map((item) => {
          const isActive = item.id === activeId;
          return (
            <div
              key={item.id}
              id={rowElementId(item.id)}
              role="option"
              aria-selected={isActive}
              aria-disabled={item.disabled || undefined}
              data-active={isActive}
              className={`searchable-list-row ${isActive ? 'selected' : ''}`}
              // mousemove rather than mouseenter: scrolling a row under a
              // stationary cursor fires mouseenter, which would steal the
              // keyboard's selection.
              onMouseMove={() => {
                if (!item.disabled && !isActive) onActiveChange(item.id);
              }}
              onClick={() => {
                if (!item.disabled) onActiveChange(item.id);
              }}
              onDoubleClick={() => {
                if (!item.disabled) onActivate(item);
              }}
            >
              {leadingSlot?.(item)}
              {/* Wrapped: the highlighter emits one element per character. */}
              <span className="searchable-list-row-label">
                <HighlightMatch label={item.label} query={query} />
              </span>
              <span className="searchable-list-row-context">
                {item.disabled && item.disabledHint ? item.disabledHint : item.context}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Create `styles.css` and `index.ts`**

```css
/* src/renderer/components/SearchableList/styles.css */
.searchable-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.searchable-list-input {
  width: 100%;
}

/* About seven rows before scrolling: enough to scan, short enough to keep
   the dialog's title and buttons on screen. */
.searchable-list-rows {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-1) 0;
}

.searchable-list-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* The 3px inset leaves room for the selected row's accent bar, as in the
     command palette. */
  padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-3) - 3px);
  border-left: 3px solid transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  user-select: none;
}

.searchable-list-row.selected {
  background: color-mix(in srgb, var(--color-accent) 28%, var(--color-bg-secondary));
  border-left-color: var(--color-accent);
  color: var(--color-text-primary);
}

/* Listed, greyed, and not a target: the hint in the context slot says why. */
.searchable-list-row[aria-disabled='true'] {
  opacity: 0.45;
  cursor: default;
}

.searchable-list-row-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.searchable-list-row-context {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.searchable-list-empty {
  padding: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
}
```

```ts
// src/renderer/components/SearchableList/index.ts
export { SearchableList } from './SearchableList';
export { rankSearchableItems, type SearchableListItem } from './rankSearchableItems';
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no new errors; the only error is still `src/renderer/components/Inbox/index.tsx` (from Task 7).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/styles/statusDots.css src/renderer/main.tsx src/renderer/components/SearchableList
git commit -m "feat(renderer): shared status dots and a SearchableList picker primitive

One stylesheet for session status dots, so the pane, the link dialog and
the strip agree with the sidebar on colour and shape. SearchableList is
the palette's matcher and listbox conventions in a flat, controlled
picker for the link dialog.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `LinkSessionDialog` — one dialog, two doors

**Files:**
- Create: `src/renderer/stores/linkSessionDialogStore.ts`
- Create: `src/renderer/components/Dialogs/linkSessionRows.ts`
- Create: `src/renderer/components/Dialogs/linkSessionRows.test.ts`
- Create: `src/renderer/components/Dialogs/LinkSessionDialog.tsx`
- Modify: `src/renderer/components/Dialogs/styles.css` (append one rule)
- Modify: `src/renderer/router.tsx` (mount the dialog once)

**Interfaces:**
- Consumes: `SearchableList`/`SearchableListItem` (Task 8), `sessionLabel` (Task 2), `sameWorkItem`/`workItemKey`, `sessionStatusFor`, `formatAge` (`Inbox/inboxPresentation.ts`), `basename`, `scopeForSession`, `useWorkspaceStore.updateSession` (Phase B: `SessionUpdates` carries `workItem`; main refuses conductors and already-linked sessions by throwing).
- Produces:
  - `LinkSessionDialogMode = { kind: 'pick-session'; workspaceId: string; item: InboxItem } | { kind: 'pick-item'; workspaceId: string; session: Session }`; `useLinkSessionDialogStore` with `mode`, `open(mode)`, `close()`.
  - `LinkRow extends SearchableListItem { sessionId: string; workItem: WorkItemRef; status?: SessionStatus }`; `sessionRowsFor(workspace, item, terminals, now?): LinkRow[]`; `itemRowsFor(items, session): LinkRow[]`.
  - `LinkSessionDialog(): JSX.Element | null` — self-mounting, zero props; mounted once in `router.tsx` (never inside `Sidebar`, which unmounts when hidden).

- [ ] **Step 1: Create the store**

```ts
// src/renderer/stores/linkSessionDialogStore.ts
import { create } from 'zustand';
import type { InboxItem } from '../../shared/workItems';
import type { Session } from '../../shared/workspace';

/**
 * The two doors into linking. From the Inbox pane the item is known and a
 * session is picked; from the sidebar the session is known and an item is
 * picked. One dialog serves both with the list flipped.
 */
export type LinkSessionDialogMode =
  | { kind: 'pick-session'; workspaceId: string; item: InboxItem }
  | { kind: 'pick-item'; workspaceId: string; session: Session };

interface LinkSessionDialogState {
  mode: LinkSessionDialogMode | null;
  open: (mode: LinkSessionDialogMode) => void;
  close: () => void;
}

/**
 * A store rather than props because the openers live in three unrelated
 * trees (the Inbox pane, a sidebar row's menu, a strip) and the dialog must
 * outlive all of them — the sidebar unmounts entirely when hidden.
 */
export const useLinkSessionDialogStore = create<LinkSessionDialogState>((set) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
}));
```

- [ ] **Step 2: Write the failing row-builder test**

```ts
// src/renderer/components/Dialogs/linkSessionRows.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import type { Session, Workspace } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { itemRowsFor, sessionRowsFor } from './linkSessionRows';

const pr4118: WorkItemRef = { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number: 4118 };
const pr4100: WorkItemRef = { ...pr4118, number: 4100 };
const now = Date.parse('2026-08-25T10:00:00Z');

function makeItem(ref: WorkItemRef, title: string): InboxItem {
  return {
    workItem: ref,
    title,
    author: 'steve-sympower',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'none',
    commentCount: 0,
    updatedAt: '2026-08-25T09:00:00Z',
    url: `https://github.com/${ref.repo}/pull/${ref.number}`,
  };
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session',
    name: 'session',
    workspaceId: 'ws-1',
    instanceId: 'inst',
    claudeSessionId: 'uuid',
    hasStarted: true,
    harnessId: 'default',
    scopeId: 'scope-1',
    kind: 'interactive',
    createdAt: now - 3_600_000,
    lastActiveAt: now - 2 * 3_600_000,
    ...overrides,
  };
}

const investigation = makeSession({ id: 's-inv', name: 'energy axis investigation', instanceId: 'inst-inv', cwd: '/repos/flex-portal', lastActiveAt: now - 2 * 3_600_000 });
const scratch = makeSession({ id: 's-scratch', name: 'scratch: grafana panels', instanceId: 'inst-scratch', lastActiveAt: now - 86_400_000 });
const fixCi = makeSession({ id: 's-fixci', name: 'LC-416', instanceId: 'inst-fixci', workItem: pr4118, workItemAction: 'Fix CI', cwd: '/worktrees/flex-portal-pr-4118' });
const other = makeSession({ id: 's-other', name: 'UI-25', instanceId: 'inst-other', workItem: pr4100, workItemAction: 'Review' });
const conductor = makeSession({ id: 's-cond', name: 'sweep', instanceId: 'inst-cond', kind: 'conductor' });

const workspace = {
  id: 'ws-1',
  name: 'Sympower',
  defaultHarnessId: 'default',
  scopes: [{ id: 'scope-1', name: 'sympower', path: '/repos', isGitRepo: false, createdAt: now }],
  groups: [],
  actions: [],
  sectionDefaults: {},
  sessions: [scratch, investigation, fixCi, other, conductor],
  createdAt: now,
  updatedAt: now,
} as Workspace;

const working: TerminalState = { isBusy: true, isAwaitingConfirmation: false, hasExited: false, completedWhileAway: false, status: 'working' };

describe('sessionRowsFor', () => {
  const rows = sessionRowsFor(workspace, makeItem(pr4118, 'LC-416'), { 'inst-inv': working }, now);

  it('hides conductors and orders by recency', () => {
    expect(rows.map((row) => row.id)).toEqual(['s-inv', 's-fixci', 's-other', 's-scratch']);
  });

  it('labels rows with sessionLabel, where they run, and their age', () => {
    expect(rows[0]).toMatchObject({
      label: 'energy axis investigation',
      context: 'flex-portal · 2h ago',
      status: 'working',
      sessionId: 's-inv',
      workItem: pr4118,
    });
    // No cwd: the scope's folder is where it runs.
    expect(rows[3].context).toBe('repos · 1d ago');
  });

  it('greys a session already on this item, and one linked elsewhere, with a hint', () => {
    expect(rows[1]).toMatchObject({ label: 'PR #4118 · Fix CI', disabled: true, disabledHint: 'already on this item' });
    expect(rows[2]).toMatchObject({ label: 'PR #4100 · Review', disabled: true, disabledHint: 'already linked' });
    expect(rows[0].disabled).toBeUndefined();
  });
});

describe('itemRowsFor', () => {
  const items = [makeItem(pr4118, 'LC-416: fix energy axis'), makeItem(pr4100, 'UI-25 one year cap')];

  it('lists inbox items with number, title and repo, all pointing at the session', () => {
    const rows = itemRowsFor(items, investigation);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'github:sympower/flex-portal:pr:4118',
      label: '#4118 LC-416: fix energy axis',
      context: 'sympower/flex-portal',
      sessionId: 's-inv',
      workItem: pr4118,
    });
    expect(rows[0].disabled).toBeUndefined();
  });

  it('greys the item the session is already linked to', () => {
    const rows = itemRowsFor(items, fixCi);
    expect(rows[0]).toMatchObject({ disabled: true, disabledHint: 'already linked here' });
    expect(rows[1].disabled).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/Dialogs/linkSessionRows.test.ts`
Expected: FAIL — cannot resolve `./linkSessionRows`.

- [ ] **Step 4: Create `linkSessionRows.ts`**

```ts
// src/renderer/components/Dialogs/linkSessionRows.ts
import { sessionLabel } from '../../../shared/sessionLabel';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { sameWorkItem, workItemKey } from '../../../shared/workItems';
import { scopeForSession, type Session, type Workspace } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import { formatAge } from '../Inbox/inboxPresentation';
import type { SearchableListItem } from '../SearchableList';

/**
 * One pickable row. Whichever door opened the dialog, a row knows the exact
 * (session, item) pair it would link, so submitting is the same call twice.
 */
export interface LinkRow extends SearchableListItem {
  sessionId: string;
  workItem: WorkItemRef;
  status?: SessionStatus;
}

/**
 * The Inbox-pane door: this workspace's sessions, most recent first.
 * Conductors are hidden — main would refuse them anyway, and a row that can
 * only ever fail is noise. A session already on an item stays listed but
 * greyed, with the reason in place of its context.
 */
export function sessionRowsFor(
  workspace: Workspace,
  item: InboxItem,
  terminals: Record<string, TerminalState>,
  now: number = Date.now()
): LinkRow[] {
  return workspace.sessions
    .filter((session) => session.kind !== 'conductor')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((session) => {
      const runsIn = session.cwd ?? scopeForSession(workspace, session)?.path ?? '';
      const row: LinkRow = {
        id: session.id,
        label: sessionLabel(session),
        context: `${basename(runsIn)} · ${formatAge(session.lastActiveAt, now)}`,
        status: sessionStatusFor(terminals[session.instanceId]),
        sessionId: session.id,
        workItem: item.workItem,
      };
      if (session.workItem) {
        row.disabled = true;
        row.disabledHint = sameWorkItem(session.workItem, item.workItem)
          ? 'already on this item'
          : 'already linked';
      }
      return row;
    });
}

/** The sidebar door: the workspace's cached inbox items, in inbox order. */
export function itemRowsFor(items: InboxItem[], session: Session): LinkRow[] {
  return items.map((item) => {
    const row: LinkRow = {
      id: workItemKey(item.workItem),
      label: `#${item.workItem.number} ${item.title}`,
      context: item.workItem.repo,
      sessionId: session.id,
      workItem: item.workItem,
    };
    if (sameWorkItem(session.workItem, item.workItem)) {
      row.disabled = true;
      row.disabledHint = 'already linked here';
    }
    return row;
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/Dialogs/linkSessionRows.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Create `LinkSessionDialog.tsx`**

```tsx
// src/renderer/components/Dialogs/LinkSessionDialog.tsx
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { sessionLabel } from '../../../shared/sessionLabel';
import { useInboxStore } from '../../stores/inboxStore';
import {
  useLinkSessionDialogStore,
  type LinkSessionDialogMode,
} from '../../stores/linkSessionDialogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { SearchableList } from '../SearchableList';
import { itemRowsFor, sessionRowsFor, type LinkRow } from './linkSessionRows';
import './styles.css';

/** A key that changes whenever the dialog is opened for a different target. */
function modeKey(mode: LinkSessionDialogMode): string {
  return mode.kind === 'pick-session'
    ? `pick-session:${mode.workspaceId}:${mode.item.workItem.repo}#${mode.item.workItem.number}`
    : `pick-item:${mode.workspaceId}:${mode.session.id}`;
}

/**
 * Link a session to a work item — from either end.
 *
 * Self-mounting from its store, like CloneDialog: the openers (the Inbox
 * pane, a sidebar row's menu) live in trees that unmount, and the dialog
 * must not. Linking is metadata only: main rewrites `workItem` on the
 * record, the session keeps its folder and gets no prompt. Main's refusals
 * (a conductor, a session already on another item) arrive as rejections
 * and are shown inline; the dialog stays open.
 */
export function LinkSessionDialog() {
  const mode = useLinkSessionDialogStore((state) => state.mode);
  const close = useLinkSessionDialogStore((state) => state.close);
  if (!mode) return null;
  // Keyed so reopening for another target starts with a clean query,
  // highlight and error rather than the previous target's leftovers.
  return <LinkSessionDialogBody key={modeKey(mode)} mode={mode} onClose={close} />;
}

interface LinkSessionDialogBodyProps {
  mode: LinkSessionDialogMode;
  onClose: () => void;
}

function LinkSessionDialogBody({ mode, onClose }: LinkSessionDialogBodyProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === mode.workspaceId)
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const terminals = useTerminalStore((state) => state.terminals);
  const items = useInboxStore((state) => state.snapshots[mode.workspaceId]?.items);

  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rows = useMemo<LinkRow[]>(() => {
    if (!workspace) return [];
    return mode.kind === 'pick-session'
      ? sessionRowsFor(workspace, mode.item, terminals)
      : itemRowsFor(items ?? [], mode.session);
  }, [workspace, mode, terminals, items]);

  const active = rows.find((row) => row.id === activeId && !row.disabled) ?? null;

  const submit = async (row: LinkRow) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await updateSession(mode.workspaceId, row.sessionId, { workItem: row.workItem });
      onClose();
    } catch (err) {
      // Main refused (conductor, or already linked to a different item):
      // say so in place and leave the picker where it was.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    mode.kind === 'pick-session'
      ? `Link a session to ${mode.item.workItem.repo.split('/').pop() ?? mode.item.workItem.repo}#${mode.item.workItem.number}`
      : `Link "${sessionLabel(mode.session)}" to a work item`;
  const emptyMessage =
    mode.kind === 'pick-session' ? 'No sessions in this workspace.' : 'No inbox items to link to.';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content link-session-dialog"
          // The Inbox closes its detail pane on Esc; a dialog's Esc must not
          // reach that listener, or one keypress would close both.
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Linking is metadata only: the session keeps its folder and gets no prompt.
          </Dialog.Description>
          <SearchableList
            items={rows}
            query={query}
            onQueryChange={setQuery}
            placeholder={mode.kind === 'pick-session' ? 'Search sessions...' : 'Search inbox items...'}
            inputAriaLabel={mode.kind === 'pick-session' ? 'Search sessions' : 'Search inbox items'}
            emptyMessage={emptyMessage}
            activeId={activeId}
            onActiveChange={setActiveId}
            onActivate={(row) => void submit(row)}
            leadingSlot={(row) =>
              row.status ? (
                <span className={`status-dot status-dot--${row.status}`} aria-hidden="true" />
              ) : null
            }
          />
          {error && <span className="dialog-error">{error}</span>}
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => active && void submit(active)}
              disabled={!active || submitting}
            >
              Link
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 7: Append the dialog's width rule to `src/renderer/components/Dialogs/styles.css`**

Append after the `.fan-out-failures` block:

```css
/* Link-session dialog: a picker wants a little more room than a confirm. */
.link-session-dialog {
  max-width: 480px;
}

.link-session-dialog .dialog-error {
  display: block;
  margin-top: var(--space-2);
}
```

- [ ] **Step 8: Mount it once in `src/renderer/router.tsx`**

Phase A's `LayoutWithProviders` (verify at execution: A's exact provider nesting is `WorkspaceSettingsProvider > SettingsProvider > CommandPaletteProvider > Layout`) becomes:

```tsx
import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LinkSessionDialog } from './components/Dialogs/LinkSessionDialog';
import { SettingsProvider } from './contexts/SettingsContext';
import { CommandPaletteProvider } from './contexts/CommandPaletteContext';
import { WorkspaceSettingsProvider } from './contexts/WorkspaceSettingsContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <WorkspaceSettingsProvider>
      <SettingsProvider>
        {/* Inside SettingsProvider: the palette offers "Open settings". */}
        <CommandPaletteProvider>
          <Layout />
          {/* Mounted here, not in the Sidebar: the sidebar unmounts when
              hidden, and the dialog is opened from three unrelated trees. */}
          <LinkSessionDialog />
        </CommandPaletteProvider>
      </SettingsProvider>
    </WorkspaceSettingsProvider>
  );
}

// Use HashRouter for Electron compatibility
// Navigation is handled via stores, not routes
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [{ index: true, element: null }],
  },
]);
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no new errors; the only error is still `src/renderer/components/Inbox/index.tsx` (from Task 7).

- [ ] **Step 10: Commit**

```bash
git add src/renderer/stores/linkSessionDialogStore.ts src/renderer/components/Dialogs/linkSessionRows.ts src/renderer/components/Dialogs/linkSessionRows.test.ts src/renderer/components/Dialogs/LinkSessionDialog.tsx src/renderer/components/Dialogs/styles.css src/renderer/router.tsx
git commit -m "feat(renderer): LinkSessionDialog links a session to a work item from either end

One dialog, two doors: the Inbox pane picks a session for a known item,
the sidebar picks an item for a known session. Every row carries the
exact pair it would link, so both doors submit the same updateSession
call. Main's refusals show inline and the dialog stays open.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `InboxItemPane` — facts, sessions, link, start a session

**Files:**
- Create: `src/renderer/components/Inbox/InboxItemPane.tsx`
- Modify: `src/renderer/components/Inbox/styles.css` (append the pane rules)

**Interfaces:**
- Consumes: `sectionFor` (Phase B, `src/shared/inboxSections.ts`), `defaultActionFor` (Task 3), `sessionLabel` (Task 2), `useInboxStore.launch/openClonePrompt/launching/launchErrors/resolvedRepos` + `launchKey`/`itemKey` (Task 7), `useLinkSessionDialogStore` (Task 9), `sessionStatusFor`, `activateSession`, `basename`, `formatAge`, `.status-dot--*` (Task 8).
- Produces: `InboxItemPane({ workspace: Workspace; item: InboxItem; onClose: () => void })` — Phase D consumes these props unchanged. Selectors D relies on: `data-testid="inbox-pane"`, `data-action-id` on every action button, `.inbox-pane-session-row`, `.inbox-pane-clone`.

- [ ] **Step 1: Create `InboxItemPane.tsx`**

```tsx
// src/renderer/components/Inbox/InboxItemPane.tsx
import { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { sectionFor } from '../../../shared/inboxSections';
import { sessionLabel } from '../../../shared/sessionLabel';
import { defaultActionFor } from '../../../shared/workItemActions';
import type { InboxItem, WorkItemLaunchAction } from '../../../shared/workItems';
import { sameWorkItem } from '../../../shared/workItems';
import type { Session, Workspace } from '../../../shared/workspace';
import { itemKey, launchKey, useInboxStore } from '../../stores/inboxStore';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import { formatAge } from './inboxPresentation';
import './styles.css';

export interface InboxItemPaneProps {
  workspace: Workspace;
  item: InboxItem;
  onClose: () => void;
}

/** Verbatim from the spec: the inline confirm that replaces a block. */
const CONFIRM_LABEL = 'Another session is working on this — Start anyway';

const STATUS_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  ready: 'ready',
  'needs-attention': 'needs you',
  done: 'done',
  exited: 'exited',
};

const REVIEW_LABELS: Record<InboxItem['reviewDecision'], string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Awaiting approval',
  none: 'No review',
};

function checksLabel(item: InboxItem): string {
  if (item.checks) {
    const parts = [`${item.checks.passed}/${item.checks.total} passing`];
    if (item.checks.failed > 0) parts.push(`${item.checks.failed} failing`);
    if (item.checks.pending > 0) parts.push(`${item.checks.pending} pending`);
    return parts.join(' · ');
  }
  return item.ciStatus ?? 'none';
}

/**
 * The right-hand detail pane (layout B): the item's provider facts, every
 * session on it, and the ways to add one — an action, a custom prompt, or
 * linking a session that already exists. Read-only against the provider;
 * the only verbs here create, open or link local sessions.
 *
 * The highlighted action is the section default, resolved here rather than
 * passed in: the pane knows the item, and the section is a pure function
 * of it.
 */
export function InboxItemPane({ workspace, item, onClose }: InboxItemPaneProps) {
  const terminals = useTerminalStore((state) => state.terminals);
  const launch = useInboxStore((state) => state.launch);
  const openClonePrompt = useInboxStore((state) => state.openClonePrompt);
  const launching = useInboxStore((state) => state.launching);
  const launchErrors = useInboxStore((state) => state.launchErrors);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);

  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');

  const siblings = workspace.sessions.filter((session) =>
    sameWorkItem(session.workItem, item.workItem)
  );
  const statusOf = (session: Session) => sessionStatusFor(terminals[session.instanceId]);
  // Only the renderer knows terminal status, so the warning lives here: a
  // second session while one is mid-work is allowed, but not by accident.
  const busy = siblings.some((session) => {
    const status = statusOf(session);
    return status === 'working' || status === 'needs-attention';
  });

  const applicable = workspace.actions.filter((action) =>
    action.appliesTo.includes(item.workItem.type)
  );
  const section = sectionFor(item);
  const preferredId = section ? workspace.sectionDefaults[section] : undefined;
  const highlighted = defaultActionFor(workspace.actions, item.workItem.type, preferredId);

  // null means "asked main, and no scope has it"; undefined means "not
  // asked yet", which optimistically reads as cloned — the launch corrects it.
  const uncloned = resolved?.[item.workItem.repo] === null;
  const repoKey = itemKey(workspace.id, item);

  const start = (action: WorkItemLaunchAction, key: string) => {
    if (busy && confirmingKey !== key) {
      setConfirmingKey(key);
      return;
    }
    setConfirmingKey(null);
    void launch(workspace.id, item, action);
  };

  const repoShort = item.workItem.repo.split('/').pop() ?? item.workItem.repo;
  const trimmedCustom = customPrompt.trim();
  const customKey = launchKey(workspace.id, item, { customPrompt: trimmedCustom });

  return (
    <aside className="inbox-pane" data-testid="inbox-pane" aria-label="Work item details">
      <div className="inbox-pane-header">
        <h2 className="inbox-pane-title">{item.title}</h2>
        <button className="inbox-pane-close" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </div>
      <div className="inbox-pane-meta">
        {item.workItem.repo}#{item.workItem.number} · {item.author} ·{' '}
        <a className="inbox-pane-link" href={item.url} target="_blank" rel="noreferrer">
          Open on GitHub <ExternalLink size={11} />
        </a>
      </div>

      {item.workItem.type === 'pr' && (
        <>
          <div className="inbox-pane-section-title">GitHub</div>
          <div className="inbox-pane-kv">
            <span>Review</span>
            <span>{REVIEW_LABELS[item.reviewDecision]}</span>
          </div>
          <div className="inbox-pane-kv">
            <span>Checks</span>
            <span>{checksLabel(item)}</span>
          </div>
          {(item.additions !== undefined || item.deletions !== undefined) && (
            <div className="inbox-pane-kv">
              <span>Diff</span>
              <span>
                +{item.additions ?? 0} −{item.deletions ?? 0}
              </span>
            </div>
          )}
        </>
      )}

      <div className="inbox-pane-section-title">Sessions · {siblings.length}</div>
      {siblings.length === 0 && <p className="inbox-pane-empty">No sessions on this item yet.</p>}
      {siblings.map((session) => {
        const status = statusOf(session);
        return (
          <div className="inbox-pane-session-row" key={session.id}>
            <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
            <div className="inbox-pane-session-text">
              <span className="inbox-pane-session-label">{sessionLabel(session)}</span>
              <span className="inbox-pane-session-sub">
                {STATUS_WORDS[status]} · {formatAge(session.lastActiveAt)}
                {session.cwd ? ` · ${basename(session.cwd)}` : ''}
              </span>
            </div>
            <button
              className="inbox-pane-open"
              onClick={() => activateSession(workspace.id, session.id)}
              aria-label={`Open ${sessionLabel(session)}`}
            >
              Open
            </button>
          </div>
        );
      })}
      <button
        className="inbox-pane-secondary"
        onClick={() =>
          useLinkSessionDialogStore.getState().open({
            kind: 'pick-session',
            workspaceId: workspace.id,
            item,
          })
        }
      >
        Link existing session...
      </button>

      <div className="inbox-pane-section-title">Start a session</div>
      {uncloned ? (
        <>
          <p className="inbox-pane-hint">
            {repoShort} is not cloned in any scope of this workspace.
          </p>
          <button
            className="inbox-pane-action inbox-pane-clone"
            disabled={launching[repoKey]}
            onClick={() => openClonePrompt(workspace.id, item)}
          >
            {launching[repoKey] ? 'Cloning...' : 'Clone into scope...'}
          </button>
          {launchErrors[repoKey] && (
            <span className="inbox-pane-action-error">{launchErrors[repoKey]}</span>
          )}
        </>
      ) : (
        <div className="inbox-pane-actions">
          {applicable.length === 0 && (
            <p className="inbox-pane-hint">
              No actions apply to {item.workItem.type === 'pr' ? 'pull requests' : 'issues'} —
              add one in Workspace settings.
            </p>
          )}
          {applicable.map((action) => {
            const key = launchKey(workspace.id, item, { id: action.id });
            const confirming = confirmingKey === action.id;
            return (
              <div className="inbox-pane-action-slot" key={action.id}>
                <button
                  className={`inbox-pane-action ${
                    highlighted?.id === action.id ? 'inbox-pane-action--default' : ''
                  } ${confirming ? 'inbox-pane-action--confirm' : ''}`}
                  data-action-id={action.id}
                  disabled={launching[key]}
                  onClick={() => start({ id: action.id }, action.id)}
                >
                  {launching[key] ? 'Preparing...' : confirming ? CONFIRM_LABEL : action.name}
                </button>
                {launchErrors[key] && (
                  <span className="inbox-pane-action-error">{launchErrors[key]}</span>
                )}
              </div>
            );
          })}
          {customOpen ? (
            <div className="inbox-pane-custom">
              <textarea
                className="inbox-pane-custom-textarea"
                rows={3}
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="A one-off prompt. Placeholders: {{number}} {{repo}} {{title}} {{url}} {{type}}"
                aria-label="Custom prompt"
                autoFocus
              />
              <div className="inbox-pane-custom-actions">
                <button
                  className="inbox-pane-secondary"
                  onClick={() => {
                    setCustomOpen(false);
                    setConfirmingKey(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={`inbox-pane-action ${
                    confirmingKey === 'custom' ? 'inbox-pane-action--confirm' : ''
                  }`}
                  data-action-id="custom"
                  disabled={trimmedCustom.length === 0 || launching[customKey]}
                  onClick={() => start({ customPrompt: trimmedCustom }, 'custom')}
                >
                  {launching[customKey]
                    ? 'Preparing...'
                    : confirmingKey === 'custom'
                      ? CONFIRM_LABEL
                      : 'Start'}
                </button>
              </div>
              {launchErrors[customKey] && (
                <span className="inbox-pane-action-error">{launchErrors[customKey]}</span>
              )}
            </div>
          ) : (
            <button className="inbox-pane-secondary" onClick={() => setCustomOpen(true)}>
              Custom prompt...
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Append the pane rules to `src/renderer/components/Inbox/styles.css`**

```css
/* The detail pane (layout B). Its width is fixed so the list does not
   reflow when a row is selected; it scrolls on its own. */
.inbox-pane {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left: 1px solid var(--color-border);
  padding: 0 0 var(--space-4) var(--space-4);
  overflow-y: auto;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

.inbox-pane-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.inbox-pane-title {
  flex: 1;
  margin: 0;
  font-size: 13.5px;
  font-weight: var(--font-weight-medium);
  line-height: 1.35;
  color: var(--color-text-primary);
}

.inbox-pane-close {
  display: flex;
  align-items: center;
  flex: none;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-sm);
}

.inbox-pane-close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.inbox-pane-meta {
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

.inbox-pane-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--color-text-secondary);
}

.inbox-pane-link:hover {
  color: var(--color-text-primary);
}

.inbox-pane-section-title {
  margin: var(--space-4) 0 var(--space-1);
  font-size: 10px;
  font-weight: var(--font-weight-medium);
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.inbox-pane-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 2px 0;
}

.inbox-pane-empty,
.inbox-pane-hint {
  margin: 0 0 var(--space-2);
  font-size: 11.5px;
  color: var(--color-text-tertiary);
  line-height: 1.4;
}

.inbox-pane-session-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 0;
  border-bottom: 1px solid var(--color-border);
}

.inbox-pane-session-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.inbox-pane-session-label {
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inbox-pane-session-sub {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.inbox-pane-open,
.inbox-pane-secondary {
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11.5px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}

.inbox-pane-secondary {
  align-self: flex-start;
  margin-top: var(--space-2);
}

.inbox-pane-open:hover,
.inbox-pane-secondary:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.inbox-pane-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inbox-pane-action-slot {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Every action is a button; the section default is the one drawn in the
   accent, and a confirm turns the whole label into the warning. */
.inbox-pane-action {
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 4px 10px;
  text-align: left;
  cursor: pointer;
}

.inbox-pane-action:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.inbox-pane-action--default {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.inbox-pane-action--confirm {
  border-color: var(--color-warning);
  color: var(--color-warning);
  white-space: normal;
}

.inbox-pane-action:disabled {
  opacity: 0.6;
  cursor: default;
}

.inbox-pane-action-error {
  font-size: 11px;
  color: var(--color-error);
}

.inbox-pane-custom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--space-2);
}

.inbox-pane-custom-textarea {
  width: 100%;
  resize: vertical;
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

.inbox-pane-custom-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

.inbox-pane-custom-actions .inbox-pane-secondary {
  margin-top: 0;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: the new file typechecks; the only error is still `src/renderer/components/Inbox/index.tsx` (from Task 7). Task 11 restores it.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Inbox/InboxItemPane.tsx src/renderer/components/Inbox/styles.css
git commit -m "feat(inbox): detail pane with facts, sessions, linking and every action

The pane is where the item-session relation is fully visible and edited:
every session on the item with its live status and an Open, 'Link
existing session...', and one button per applicable action with the
section default highlighted. A second session while one is mid-work is
an inline 'Start anyway' confirm, never a dialog and never a block.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Inbox rows become selectable; the row button and `actionFor` go

**Files:**
- Modify: `src/renderer/components/Inbox/index.tsx` (rewrite the whole file)
- Modify: `src/renderer/components/Inbox/styles.css` (row and layout rules)
- Modify: `src/renderer/components/Inbox/inboxPresentation.ts` (delete `InboxAction` and `actionFor`)
- Modify: `src/renderer/components/Inbox/inboxPresentation.test.ts` (delete the `actionFor` block)

**Interfaces:**
- Consumes: `InboxItemPane` (Task 10), `useWorkspaceSettings` (Phase A, `src/renderer/contexts/WorkspaceSettingsContext.tsx`), `workItemKey`, `sameWorkItem`, `dotClassFor`/`metaLineFor`/`formatAge` (Phase B's adapted `inboxPresentation.ts`).
- Produces: rows with `role="button"`, `data-work-item-key`, class `inbox-item` + `selected`; a selected row opens the pane, selecting it again or `Esc` closes it. **This task restores `npm run typecheck` to green.**

- [ ] **Step 1: Delete `actionFor` from `inboxPresentation.ts`**

Remove the `InboxAction` interface and the `actionFor` function — after Phase B's adaptation they read (verify at execution; delete whatever B left under these two names):

```ts
export interface InboxAction {
  label: string;
  kind: 'launch' | 'open' | 'clone';
}

/**
 * The one button an item shows.
 * ...
 */
export function actionFor(item: InboxItem, hasSession: boolean, cloned: boolean): InboxAction {
  ...
}
```

`formatAge`, `roleLabelFor`, `metaLineFor` and `dotClassFor` stay exactly as B left them.

- [ ] **Step 2: Delete the `actionFor` tests**

In `src/renderer/components/Inbox/inboxPresentation.test.ts`, remove `actionFor` from the import line so it reads

```ts
import { dotClassFor, formatAge, metaLineFor, roleLabelFor } from './inboxPresentation';
```

and delete the whole `describe('actionFor', () => { … });` block. Every other block stays.

Run: `npx vitest run src/renderer/components/Inbox/inboxPresentation.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite `src/renderer/components/Inbox/index.tsx`**

Verify at execution: Phase A added the header's settings (gear) button (`className="inbox-refresh inbox-settings-button"`, `aria-label="Workspace settings"`, calling `openWorkspaceSettings(workspace.id)` from `useWorkspaceSettings()`), and Phase B renamed `workspace.github` to `workspace.provider`. Both are reproduced below; keep A's button markup if it differs in detail.

```tsx
import { useEffect, useState } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import { sameWorkItem, workItemKey } from '../../../shared/workItems';
import { useInboxStore } from '../../stores/inboxStore';
import type { Workspace } from '../../stores/workspaceStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { CloneDialog } from './CloneDialog';
import { InboxItemPane } from './InboxItemPane';
import { dotClassFor, formatAge, metaLineFor } from './inboxPresentation';
import './styles.css';

interface InboxViewProps {
  workspace: Workspace;
}

/**
 * Morning triage. Remote-driven: items appear whether or not the repo is
 * cloned. Read-only against the provider — the only verbs here create, open
 * or link local sessions, and they live in the detail pane: a row is a
 * thing you select, not a button you press.
 */
export function InboxView({ workspace }: InboxViewProps) {
  const [tab, setTabState] = useState<'pr' | 'issue'>('pr');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const snapshot = useInboxStore((state) => state.snapshots[workspace.id]);
  const refresh = useInboxStore((state) => state.refresh);
  const { openWorkspaceSettings } = useWorkspaceSettings();

  useEffect(() => {
    void useInboxStore.getState().load(workspace.id);
  }, [workspace.id]);

  // Esc closes the pane. Bubble phase on window on purpose: a dialog open
  // above the Inbox stops its own Esc in the capture phase, so one keypress
  // closes the dialog and not the pane underneath it.
  useEffect(() => {
    if (!selectedKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedKey(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKey]);

  const items = snapshot?.items ?? [];
  const prs = items.filter((item) => item.workItem.type === 'pr');
  const issues = items.filter((item) => item.workItem.type === 'issue');
  const shown = tab === 'pr' ? prs : issues;
  const selectedItem = selectedKey
    ? shown.find((item) => workItemKey(item.workItem) === selectedKey)
    : undefined;

  const provider = workspace.provider;
  if (!provider) return null;

  const setTab = (next: 'pr' | 'issue') => {
    setTabState(next);
    setSelectedKey(null);
  };

  const toggle = (key: string) => setSelectedKey((current) => (current === key ? null : key));

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
            {provider.accountLogin}
            {provider.org ? ` · ${provider.org}` : ''}
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
          <button
            className="inbox-refresh inbox-settings-button"
            aria-label="Workspace settings"
            onClick={() => openWorkspaceSettings(workspace.id)}
          >
            <Settings size={13} />
          </button>
        </div>
      </div>

      <div className="inbox-body">
        <div className="inbox-main">
          <div className="inbox-list">
            {shown.length === 0 && (
              <p className="inbox-empty">
                {snapshot ? 'Nothing here right now.' : 'Fetching from GitHub...'}
              </p>
            )}
            {shown.map((item) => {
              const key = workItemKey(item.workItem);
              const sessionCount = workspace.sessions.filter((session) =>
                sameWorkItem(session.workItem, item.workItem)
              ).length;
              const isSelected = key === selectedKey;
              return (
                // A div with role="button": the row selects, and it may one
                // day host controls of its own — a <button> could not.
                <div
                  className={`inbox-item ${isSelected ? 'selected' : ''}`}
                  key={key}
                  data-work-item-key={key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onClick={() => toggle(key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggle(key);
                    }
                  }}
                >
                  <span className={`inbox-dot ${dotClassFor(item)}`} />
                  <div className="inbox-item-text">
                    <span className="inbox-item-title">
                      #{item.workItem.number} {item.title}
                    </span>
                    <span className="inbox-item-meta">
                      {metaLineFor(item)}
                      {sessionCount > 0 && (
                        <span className="inbox-item-sessions">
                          {' · '}
                          {sessionCount} session{sessionCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {selectedItem && (
          // Keyed by item so the pane's confirm and custom-prompt state never
          // carries from one item to the next.
          <InboxItemPane
            key={selectedKey}
            workspace={workspace}
            item={selectedItem}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
      <CloneDialog />
    </div>
  );
}
```

- [ ] **Step 4: Update the row and layout rules in `src/renderer/components/Inbox/styles.css`**

Replace the `.inbox-view` rule at the top of the file:

```css
.inbox-view {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-4);
  background: var(--color-bg-primary);
}
```

with

```css
.inbox-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--space-4);
  background: var(--color-bg-primary);
}

/* Two columns under the header: the list, and the pane when a row is
   selected. Each scrolls on its own so the pane's actions stay in reach. */
.inbox-body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: var(--space-4);
}

.inbox-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
```

Replace the `.inbox-item` rule:

```css
.inbox-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
}
```

with

```css
.inbox-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
}

.inbox-item:hover {
  background: var(--color-bg-hover);
}

.inbox-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}

.inbox-item.selected {
  border-color: var(--color-accent);
  background: var(--color-bg-active);
}

.inbox-item-sessions {
  color: var(--color-text-secondary);
}
```

Delete the `.inbox-item-error`, `.inbox-item-link`, `.inbox-item-link:hover`, `.inbox-item-action`, `.inbox-item-action.ghost` and `.inbox-item-action:disabled` rules — nothing renders them any more. The `.clone-dialog-*` rules and the Task 10 pane rules stay.

- [ ] **Step 5: Typecheck — green again**

Run: `npm run typecheck`
Expected: clean. Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Inbox/index.tsx src/renderer/components/Inbox/styles.css src/renderer/components/Inbox/inboxPresentation.ts src/renderer/components/Inbox/inboxPresentation.test.ts
git commit -m "feat(inbox): rows select the detail pane; the one-button-per-row action is gone

A row is now something you select — click toggles the pane, Esc closes
it — and every verb lives in the pane. actionFor and its hardcoded
Review / Address review / Start work labels are deleted: the label is
the action's own name now. Typecheck is green again.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Sidebar — derived labels, "Link to work item…" and "Unlink"

**Files:**
- Modify: `src/renderer/components/Sidebar/SessionNavItem.tsx` (four regions)
- Modify: `src/renderer/components/Sidebar/SessionActionsMenu.tsx` (rewrite the whole file)

**Interfaces:**
- Consumes: `sessionLabel`/`sessionSubtitle` (Task 2), `useLinkSessionDialogStore` (Task 9), `useWorkspaceStore.updateSession` with `{ workItem: undefined }` (presence semantics, Phase B).
- Produces: `SessionActionsMenu({ session: Session; workspaceId: string; onRename: () => void; onDelete: () => void })`. `GroupNavItem.tsx` and `Sidebar/index.tsx` are untouched: they pass `SessionNavItem` the same props as before, and a group member's runs-in subtitle is joined with the derived one inside `SessionNavItem`.

- [ ] **Step 1: `SessionNavItem.tsx` — imports**

Replace

```tsx
import { useState, useRef, useEffect } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
```

with

```tsx
import { useState, useRef, useEffect } from 'react';
import { sessionLabel, sessionSubtitle } from '../../../shared/sessionLabel';
import { useTerminalStore } from '../../stores/terminalStore';
```

- [ ] **Step 2: `SessionNavItem.tsx` — the accessible name**

Replace

```tsx
  const statusWord = STATUS_WORDS[displayStatus];
  const accessibleName = `${session.name} — ${STATUS_LABELS[displayStatus]}`;
```

with

```tsx
  const statusWord = STATUS_WORDS[displayStatus];
  // The row reads the derived label — "PR #4118 · Review", "⑂ name" — and
  // shows `name` underneath only when the label stopped saying it. A group
  // member's runs-in subtitle joins it rather than replacing it.
  const label = sessionLabel(session);
  const subtitleText = [sessionSubtitle(session), subtitle].filter(Boolean).join(' · ');
  const accessibleName = `${label} — ${STATUS_LABELS[displayStatus]}`;
```

- [ ] **Step 3: `SessionNavItem.tsx` — the text column**

Replace

```tsx
        <span className="session-nav-item-text">
          <span className="session-nav-item-name">{session.name}</span>
          {subtitle && <span className="session-nav-item-subtitle">{subtitle}</span>}
        </span>
```

with

```tsx
        <span className="session-nav-item-text">
          <span className="session-nav-item-name">{label}</span>
          {subtitleText && <span className="session-nav-item-subtitle">{subtitleText}</span>}
        </span>
```

The rename input is unchanged: it still edits `session.name`, which for a launched work-item session changes the subtitle and leaves the label alone.

- [ ] **Step 4: `SessionNavItem.tsx` — the menu**

Replace

```tsx
        <SessionActionsMenu
          sessionName={session.name}
          onRename={handleStartRename}
          onDelete={handleDelete}
        />
```

with

```tsx
        <SessionActionsMenu
          session={session}
          workspaceId={workspaceId}
          onRename={handleStartRename}
          onDelete={handleDelete}
        />
```

- [ ] **Step 5: Rewrite `SessionActionsMenu.tsx`**

```tsx
import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link2, MoreHorizontal, Pencil, Trash2, Unlink } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import type { Session } from '../../../shared/workspace';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

interface SessionActionsMenuProps {
  session: Session;
  workspaceId: string;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * The ⋯ menu on a sidebar row: rename, link or unlink, delete.
 *
 * Link and Unlink are the sidebar door into the session-item relation.
 * Linking is metadata only — the session keeps its folder and gets no
 * prompt — and unlinking a session that runs in an item's worktree leaves
 * it there. Conductors are never offered the link (main would refuse), and
 * a workspace with no provider has no items to link to.
 */
export function SessionActionsMenu({ session, workspaceId, onRename, onDelete }: SessionActionsMenuProps) {
  const bound = useWorkspaceStore((state) =>
    Boolean(state.workspaces.find((candidate) => candidate.id === workspaceId)?.provider)
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  // Selecting "Link to work item..." opens a dialog; the menu refocusing
  // its trigger would race the dialog's own focus grab (WorkspaceSwitcher
  // has the same guard for Delete).
  const openingDialog = useRef(false);

  const handleDelete = () => {
    if (
      window.confirm(
        `Delete session "${sessionLabel(session)}"? This will remove the session and its chat history.`
      )
    ) {
      onDelete();
    }
  };

  const handleLink = () => {
    openingDialog.current = true;
    useLinkSessionDialogStore.getState().open({ kind: 'pick-item', workspaceId, session });
  };

  const handleUnlink = () => {
    // Presence semantics: the key is sent, and undefined, which is what
    // main reads as "clear the link" — exactly as leaving a group works.
    void updateSession(workspaceId, session.id, { workItem: undefined }).catch((error) => {
      // The row visibly staying linked is the signal.
      console.error('Failed to unlink session', error);
    });
  };

  const canLink = bound && session.kind !== 'conductor';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="session-actions-trigger"
          onClick={(e) => e.stopPropagation()}
          aria-label="Session actions"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content"
          sideOffset={4}
          align="end"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) {
              event.preventDefault();
              openingDialog.current = false;
            }
          }}
        >
          <DropdownMenu.Item className="dropdown-item" onSelect={onRename}>
            <Pencil size={14} />
            <span>Rename</span>
          </DropdownMenu.Item>
          {canLink &&
            (session.workItem ? (
              <DropdownMenu.Item className="dropdown-item" onSelect={handleUnlink}>
                <Unlink size={14} />
                <span>Unlink</span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item className="dropdown-item" onSelect={handleLink}>
                <Link2 size={14} />
                <span>Link to work item...</span>
              </DropdownMenu.Item>
            ))}
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item
            className="dropdown-item dropdown-item-destructive"
            onSelect={handleDelete}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Sidebar/SessionNavItem.tsx src/renderer/components/Sidebar/SessionActionsMenu.tsx
git commit -m "feat(sidebar): work-item rows read their derived label; menu links and unlinks

A launched session reads 'PR #4118 · Review' with its name underneath, a
linked one '⑂ name'. The row menu gains 'Link to work item...' (the
sidebar door into the link dialog) and 'Unlink', which clears the
relation with presence semantics and moves nothing.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: `WorkItemStrip` — action pill and the sibling-sessions menu

**Files:**
- Modify: `src/renderer/components/WorkItemStrip/index.tsx` (rewrite the whole file)
- Modify: `src/renderer/components/WorkItemStrip/styles.css` (append two rules)

**Interfaces:**
- Consumes: `sessionLabel` (Task 2), `sameWorkItem`/`workItemUrl`, `sessionStatusFor`, `activateSession`, `.status-dot--*` (Task 8), `dotClassFor`/`metaLineFor` (Phase B's `inboxPresentation.ts`), `.dropdown-content/.dropdown-item` (Sidebar/styles.css, loaded globally).
- Produces: the strip's action pill (`.work-item-strip-action`, text `session.workItemAction`) and, when siblings exist, a "N sessions on this PR" Radix DropdownMenu (`.work-item-strip-siblings`) listing each sibling with its status dot and label, activating it on select. The fallback when the item has left the inbox is unchanged.

- [ ] **Step 1: Rewrite `src/renderer/components/WorkItemStrip/index.tsx`**

```tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import { sameWorkItem, workItemUrl } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import { useInboxStore } from '../../stores/inboxStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { dotClassFor, metaLineFor } from '../Inbox/inboxPresentation';
import '../Inbox/styles.css';
import './styles.css';

interface WorkItemStripProps {
  workspaceId: string;
  session: Session;
}

/**
 * The thin strip above a work-item session's terminal: live PR/issue facts,
 * the action this session was started as, its siblings on the same item,
 * and where it physically runs. It reads the same cache as the Inbox — one
 * fetcher, one rate-limit budget — and is read-only: every provider write
 * happens through the agent in the terminal below it.
 *
 * A merged/closed item drops out of the inbox; the strip then falls back to
 * the workItem on the session record, because the session and its
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
  // The whole workspace is selected (a stable reference) and the siblings
  // derived below: a selector returning a fresh array would re-render forever.
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const terminals = useTerminalStore((state) => state.terminals);

  if (!workItem) return null;
  const label = workItem.type === 'pr' ? 'PR' : 'Issue';
  const noun = workItem.type === 'pr' ? 'PR' : 'issue';
  const siblings = (workspace?.sessions ?? []).filter(
    (candidate) => candidate.id !== session.id && sameWorkItem(candidate.workItem, workItem)
  );
  const total = siblings.length + 1;

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
      {session.workItemAction && (
        <span className="work-item-strip-pill work-item-strip-action">{session.workItemAction}</span>
      )}
      {siblings.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="work-item-strip-pill work-item-strip-siblings"
              aria-label={`${total} sessions on this ${noun}`}
            >
              {total} sessions on this {noun} <ChevronDown size={11} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
              {siblings.map((sibling) => {
                const status = sessionStatusFor(terminals[sibling.instanceId]);
                return (
                  <DropdownMenu.Item
                    key={sibling.id}
                    className="dropdown-item"
                    onSelect={() => activateSession(workspaceId, sibling.id)}
                  >
                    <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
                    <span>{sessionLabel(sibling)}</span>
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
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

- [ ] **Step 2: Append to `src/renderer/components/WorkItemStrip/styles.css`**

```css
/* The action this session was started as — the same accent the pane's
   default action button uses, so the two read as one vocabulary. */
.work-item-strip-action {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* A pill that is also a menu trigger: reset the button chrome, keep the pill. */
.work-item-strip-siblings {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

.work-item-strip-siblings:hover,
.work-item-strip-siblings[data-state='open'] {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/WorkItemStrip/index.tsx src/renderer/components/WorkItemStrip/styles.css
git commit -m "feat(strip): show the session's action and its siblings on the same item

The strip above a work-item terminal names the action the session was
started as and, when the item has other sessions, offers a 'N sessions
on this PR' menu that jumps to them — the pane's list, reached from
inside a session.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: `ActionsPanel` in Workspace Settings

**Files:**
- Create: `src/renderer/components/WorkspaceSettings/ActionsPanel.tsx`
- Modify: `src/renderer/components/WorkspaceSettings/styles.css` (append the action rules)
- Modify: `src/renderer/components/WorkspaceSettings/WorkspaceSettingsModal.tsx` (Phase A — swap the placeholder for the panel)
- Modify: `src/renderer/components/WorkspaceSettings/index.ts` (export the panel)
- Delete: `src/renderer/components/WorkspaceSettings/ActionsPlaceholderPanel.tsx` (Phase A)

**Interfaces:**
- Consumes: `INBOX_SECTIONS`, `sectionItemType`, `InboxSection` (Phase B), `PROVIDER_META[id].seedHeaderTemplate` (Phase B), `createDefaultActions`, `createDefaultSectionDefaults`, `WorkItemAction` (Phase B), `generateId`, `useWorkspaceStore.setActions(workspaceId, actions, sectionDefaults)` (Phase B; main validates and rejects the whole write), `ConfirmDialog`.
- Produces: `ActionsPanel({ workspace: Workspace })` — ordered list (HTML5 drag + move up/down buttons), inline edit (name, applies-to chips, the raw header template greyed above the editable body), add, delete (clearing any section default pointing at it before the write), "Restore defaults" (confirmed), per-section `<select>` defaults, main's rejection inline. Selectors Phase D's e2e relies on: `data-testid="actions-panel"`, `.ws-action-row[data-action-id]`, `aria-label="Edit <name>"`, `aria-label="Action name"`, the `Save` button.

- [ ] **Step 1: Create `ActionsPanel.tsx`**

```tsx
import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { INBOX_SECTIONS, sectionItemType, type InboxSection } from '../../../shared/inboxSections';
import { PROVIDER_META } from '../../../shared/providers';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  type WorkItemAction,
} from '../../../shared/workItemActions';
import { generateId } from '../../../shared/workspace';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';

export interface ActionsPanelProps {
  workspace: Workspace;
}

type ItemType = WorkItemAction['appliesTo'][number];
type SectionDefaults = Workspace['sectionDefaults'];

interface Draft {
  name: string;
  appliesTo: ItemType[];
  prompt: string;
}

interface Editing {
  id: string;
  draft: Draft;
  isNew: boolean;
}

const PLACEHOLDERS = '{{number}} {{repo}} {{title}} {{url}} {{type}}';

const APPLIES_LABELS: Record<ItemType, string> = { pr: 'Pull requests', issue: 'Issues' };

function appliesSummary(appliesTo: ItemType[]): string {
  return appliesTo.map((type) => (type === 'pr' ? 'PRs' : 'Issues')).join(' · ');
}

/** What is wrong with a draft, or null when it can be saved. Mirrors main's rules. */
function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'An action needs a name.';
  if (draft.appliesTo.length === 0) return 'Pick at least one of pull requests and issues.';
  if (!draft.prompt.trim()) return 'An action needs a prompt.';
  return null;
}

function moveWithin<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The workspace's actions: what you can start on an Inbox item.
 *
 * Every mutation is one validated write of `actions` plus `sectionDefaults`
 * through workspace:set-actions — there is no per-action CRUD — so the
 * panel edits a draft locally and commits whole lists. Main's rejection is
 * shown inline and the panel keeps what is on disk. Sessions are never
 * touched: they hold a name snapshot, so renaming or deleting an action
 * changes nothing about what a past session was.
 */
export function ActionsPanel({ workspace }: ActionsPanelProps) {
  const setActions = useWorkspaceStore((state) => state.setActions);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  const provider = workspace.provider;
  if (!provider) {
    return (
      <section className="ws-panel" data-testid="actions-panel">
        <div className="ws-panel-header">
          <h3 className="ws-panel-title">Actions</h3>
        </div>
        <p className="ws-panel-hint">
          Actions become available once a provider account is bound in the Provider section.
        </p>
      </section>
    );
  }
  const headerTemplates = PROVIDER_META[provider.id].seedHeaderTemplate;
  const actions = workspace.actions;
  const defaults = workspace.sectionDefaults;

  const commit = async (nextActions: WorkItemAction[], nextDefaults: SectionDefaults) => {
    setError(null);
    try {
      await setActions(workspace.id, nextActions, nextDefaults);
      return true;
    } catch (err) {
      // The whole write was rejected; disk is unchanged, so is the list.
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const startEdit = (action: WorkItemAction) =>
    setEditing({
      id: action.id,
      draft: { name: action.name, appliesTo: [...action.appliesTo], prompt: action.prompt },
      isNew: false,
    });

  const startAdd = () =>
    setEditing({
      id: generateId(),
      draft: { name: '', appliesTo: ['pr'], prompt: '' },
      isNew: true,
    });

  const updateDraft = (patch: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const toggleApplies = (type: ItemType) =>
    setEditing((current) => {
      if (!current) return current;
      const has = current.draft.appliesTo.includes(type);
      const appliesTo = has
        ? current.draft.appliesTo.filter((candidate) => candidate !== type)
        : [...current.draft.appliesTo, type];
      return { ...current, draft: { ...current.draft, appliesTo } };
    });

  const saveEdit = async () => {
    if (!editing) return;
    const problem = draftProblem(editing.draft);
    if (problem) {
      setError(problem);
      return;
    }
    const record: WorkItemAction = {
      id: editing.id,
      name: editing.draft.name.trim(),
      appliesTo: editing.draft.appliesTo,
      prompt: editing.draft.prompt,
    };
    const nextActions = editing.isNew
      ? [...actions, record]
      : actions.map((action) => (action.id === record.id ? record : action));
    if (await commit(nextActions, defaults)) setEditing(null);
  };

  const deleteAction = async (id: string) => {
    // A default pointing at a deleted action would dangle; clear it in the
    // same write so main never sees the inconsistent pair.
    const nextDefaults: SectionDefaults = {};
    for (const [section, actionId] of Object.entries(defaults) as [InboxSection, string][]) {
      if (actionId !== id) nextDefaults[section] = actionId;
    }
    const ok = await commit(
      actions.filter((action) => action.id !== id),
      nextDefaults
    );
    if (ok) setEditing(null);
  };

  const reorder = (fromId: string, toId: string) => {
    const from = actions.findIndex((action) => action.id === fromId);
    const to = actions.findIndex((action) => action.id === toId);
    const next = moveWithin(actions, from, to);
    if (next !== actions) void commit(next, defaults);
  };

  const nudge = (id: string, delta: -1 | 1) => {
    const from = actions.findIndex((action) => action.id === id);
    const next = moveWithin(actions, from, from + delta);
    if (next !== actions) void commit(next, defaults);
  };

  const setDefault = (section: InboxSection, actionId: string) => {
    const nextDefaults: SectionDefaults = { ...defaults };
    if (actionId) {
      nextDefaults[section] = actionId;
    } else {
      delete nextDefaults[section];
    }
    void commit(actions, nextDefaults);
  };

  const restoreDefaults = async () => {
    const fresh = createDefaultActions();
    const ok = await commit(fresh, createDefaultSectionDefaults(fresh));
    if (!ok) throw new Error(error ?? 'Could not restore the default actions.');
    setEditing(null);
  };

  const renderEditor = (current: Editing) => {
    const headerType: ItemType = current.draft.appliesTo.includes('pr') ? 'pr' : 'issue';
    return (
      <div className="ws-action-edit" key={current.id} data-action-id={current.id}>
        <div className="ws-field">
          <label className="ws-field-label" htmlFor={`action-name-${current.id}`}>
            Name
          </label>
          <input
            id={`action-name-${current.id}`}
            className="dialog-input ws-input"
            aria-label="Action name"
            value={current.draft.name}
            onChange={(event) => updateDraft({ name: event.target.value })}
            autoFocus
          />
        </div>
        <div className="ws-field">
          <span className="ws-field-label">Applies to</span>
          <div className="ws-chips">
            {(['pr', 'issue'] as ItemType[]).map((type) => {
              const on = current.draft.appliesTo.includes(type);
              return (
                <button
                  type="button"
                  key={type}
                  className={`ws-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleApplies(type)}
                >
                  {APPLIES_LABELS[type]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ws-field">
          <span className="ws-field-label">Context header · sent first, not editable</span>
          {/* Raw template on purpose: the editor shows what is stored, and
              the placeholders are what the body may use too. */}
          <pre className="ws-action-header">{headerTemplates[headerType]}</pre>
        </div>
        <div className="ws-field">
          <label className="ws-field-label" htmlFor={`action-prompt-${current.id}`}>
            Prompt
          </label>
          <textarea
            id={`action-prompt-${current.id}`}
            className="dialog-input ws-textarea"
            aria-label="Action prompt"
            rows={4}
            value={current.draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            placeholder="A short job for the agent, or a bare slash command such as /security-review"
          />
        </div>
        <div className="ws-action-edit-actions">
          {!current.isNew && (
            <button
              type="button"
              className="dialog-button-secondary ws-panel-action ws-action-delete"
              onClick={() => void deleteAction(current.id)}
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}
          <span className="ws-action-edit-spacer" />
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dialog-button-primary ws-panel-action"
            onClick={() => void saveEdit()}
          >
            Save
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="ws-panel" data-testid="actions-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Actions</h3>
        <div className="ws-action-toolbar">
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={() => setConfirmingRestore(true)}
          >
            <RotateCcw size={13} />
            Restore defaults
          </button>
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={startAdd}
            disabled={editing !== null}
          >
            <Plus size={14} />
            Add action
          </button>
        </div>
      </div>
      <p className="ws-panel-hint">
        What you can start on an Inbox item. The section default is the highlighted button in the
        detail pane; drag to reorder. Placeholders: <code>{PLACEHOLDERS}</code>.
      </p>

      <div className="ws-row-list">
        {actions.map((action, index) => {
          if (editing && !editing.isNew && editing.id === action.id) return renderEditor(editing);
          return (
            <div
              key={action.id}
              className={`ws-row ws-action-row ${dragId === action.id ? 'dragging' : ''} ${
                overId === action.id && dragId !== action.id ? 'drop-target' : ''
              }`}
              data-action-id={action.id}
              draggable={editing === null}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragId(action.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (overId !== action.id) setOverId(action.id);
              }}
              onDragLeave={() => setOverId(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId) reorder(dragId, action.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              <span className="ws-row-icon ws-action-grip" aria-hidden="true">
                <GripVertical size={13} />
              </span>
              <span className="ws-row-name ws-action-name">{action.name}</span>
              <span className="ws-row-chip">{appliesSummary(action.appliesTo)}</span>
              <span className="ws-row-path ws-action-preview" title={action.prompt}>
                {action.prompt}
              </span>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => nudge(action.id, -1)}
                disabled={index === 0 || editing !== null}
                aria-label={`Move ${action.name} up`}
                title="Move up"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => nudge(action.id, 1)}
                disabled={index === actions.length - 1 || editing !== null}
                aria-label={`Move ${action.name} down`}
                title="Move down"
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => startEdit(action)}
                disabled={editing !== null}
                aria-label={`Edit ${action.name}`}
                title="Edit"
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
        {editing?.isNew && renderEditor(editing)}
        {actions.length === 0 && !editing && (
          <p className="ws-panel-hint">No actions. Add one, or restore the defaults.</p>
        )}
      </div>

      {error && <span className="dialog-error">{error}</span>}

      <div className="ws-archived-heading">Default per Inbox section</div>
      <div className="ws-defaults-grid">
        {INBOX_SECTIONS.map((section) => {
          const type = sectionItemType(section.id);
          const options = actions.filter((action) => action.appliesTo.includes(type));
          return (
            <label className="ws-default-row" key={section.id}>
              <span>{section.label}</span>
              <select
                className="ws-select"
                value={defaults[section.id] ?? ''}
                onChange={(event) => setDefault(section.id, event.target.value)}
                aria-label={`Default action for ${section.label}`}
              >
                <option value="">None</option>
                {options.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmingRestore}
        onOpenChange={setConfirmingRestore}
        title="Restore the default actions?"
        description="Replaces every action and section default with the built-in set. Sessions already started keep the names they were started with."
        confirmLabel="Restore defaults"
        onConfirm={restoreDefaults}
      />
    </section>
  );
}
```

- [ ] **Step 2: Append the rules to `src/renderer/components/WorkspaceSettings/styles.css`**

```css
/* Actions: draggable rows, an inline editor, and the per-section defaults. */
.ws-action-toolbar {
  display: flex;
  gap: var(--space-2);
}

.ws-action-row[draggable='true'] {
  cursor: grab;
}

.ws-action-row.dragging {
  opacity: 0.5;
}

.ws-action-row.drop-target {
  border-color: var(--color-accent);
}

.ws-action-grip {
  cursor: grab;
}

.ws-action-name {
  flex-shrink: 0;
  min-width: 110px;
}

.ws-action-preview {
  flex: 1;
}

.ws-action-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
}

.ws-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ws-field-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.ws-input,
.ws-textarea {
  width: 100%;
}

.ws-textarea {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}

.ws-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.ws-chip {
  padding: 1px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: transparent;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.ws-chip.on {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* The fixed header, greyed and dashed: shown so the body can be written
   against it, styled so nobody tries to edit it. */
.ws-action-header {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--color-text-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ws-action-edit-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.ws-action-edit-spacer {
  flex: 1;
}

.ws-action-delete:hover {
  color: var(--color-error);
  border-color: var(--color-error);
}

.ws-defaults-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-2) var(--space-4);
}

.ws-default-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.ws-select {
  padding: 2px var(--space-2);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}
```

- [ ] **Step 3: Swap the placeholder in `WorkspaceSettingsModal.tsx` and delete it**

Verify at execution against Phase A's file. Replace

```tsx
import { ActionsPlaceholderPanel } from './ActionsPlaceholderPanel';
```

with

```tsx
import { ActionsPanel } from './ActionsPanel';
```

and, in the body rendered for nav id `'actions'`, replace

```tsx
<ActionsPlaceholderPanel />
```

with

```tsx
<ActionsPanel workspace={workspace} />
```

where `workspace` is the modal's resolved `Workspace` record (the same value the other panels receive). Then:

```bash
git rm src/renderer/components/WorkspaceSettings/ActionsPlaceholderPanel.tsx
```

Append to `src/renderer/components/WorkspaceSettings/index.ts`:

```ts
export { ActionsPanel } from './ActionsPanel';
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (no reference left to `ActionsPlaceholderPanel`; `grep -rn ActionsPlaceholderPanel src/` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WorkspaceSettings/ActionsPanel.tsx src/renderer/components/WorkspaceSettings/styles.css src/renderer/components/WorkspaceSettings/WorkspaceSettingsModal.tsx src/renderer/components/WorkspaceSettings/index.ts
git commit -m "feat(settings): ActionsPanel edits the workspace's actions and section defaults

Reorder by drag or keyboard, edit name, applies-to and body with the
provider's fixed header shown greyed above it, add, delete (clearing a
default that pointed at it in the same write), restore the built-in set,
and pick a default per Inbox section. Every mutation is one validated
write; main's rejection shows inline.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: `ContentView` — say what the CLI-summary poll now decides

**Files:**
- Modify: `src/renderer/components/Views/ContentView.tsx` (one comment)

**Interfaces:**
- Consumes: nothing new. No functional change — the poll still writes `session.name` whenever `!nameIsUserSet`; what changed is that `name` is now the subtitle for a work-item session, and the label is derived.

- [ ] **Step 1: Replace the comment above the poll effect**

Replace

```tsx
  // The CLI writes a summary for a conversation once it has content. Adopt
  // what it knows as the tab name: a prompt-derived name is a stand-in, so the
  // poll continues past it and stops only once the CLI's own summary lands. A
  // name the user typed wins permanently and is never polled over. Drivers
  // whose transcripts Consola cannot read never produce a name, so they are
  // skipped outright rather than polled forever.
```

with

```tsx
  // The CLI writes a summary for a conversation once it has content. Adopt
  // what it knows as the session's name: a prompt-derived name is a stand-in,
  // so the poll continues past it and stops only once the CLI's own summary
  // lands. A name the user typed wins permanently and is never polled over.
  // Drivers whose transcripts Consola cannot read never produce a name, so
  // they are skipped outright rather than polled forever. For a work-item
  // session `name` is only the subtitle — the sidebar label is derived from
  // the record (sessionLabel), so this poll refines the subtitle and never
  // decides what the row reads.
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/renderer/components/Views/ContentView.tsx
git commit -m "docs(renderer): the summary poll refines a work-item session's subtitle only

No behaviour change; the comment now says why the poll no longer decides
what a work-item row reads.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: `tests/e2e/inbox.spec.ts` — row → pane → Review; a second Review shares the worktree

**Files:**
- Modify: `tests/e2e/inbox.spec.ts` (minimal edits: the flow after the list renders, the seeded-session shape, one helper)

**Interfaces:**
- Consumes: the v6 seed (unchanged — Phase B's migration brings it to v7 and seeds the default actions, so a "Review" button exists), the stub `gh` fixture (`#51 Extract billing client` in the cloned `sympower/controller-app`; issue `#87 Rate limit returns 500` in the un-cloned `sympower/msa-resource-bff`), the selectors from Tasks 10–11 (`.inbox-item`, `[data-testid="inbox-pane"]`, `[data-action-id]`, `.inbox-pane-clone`, `.inbox-pane-session-row`).
- Produces: the spec's new assertions — the pane opens from a row and closes on `Esc`; the un-cloned issue's pane offers only "Clone into scope..."; "Review" mints a session with `workItemAction: 'Review'`; a second "Review" mints a SECOND session with the same `cwd`.

- [ ] **Step 1: Extend the seeded-session shape and add the action helper**

Replace

```ts
interface SeededSession {
  workItem?: { provider: string; repo: string; type: string; number: number };
  cwd?: string;
  scopeId?: string;
  kind?: string;
}
```

with

```ts
interface SeededSession {
  id?: string;
  workItem?: { provider: string; repo: string; type: string; number: number };
  workItemAction?: string;
  cwd?: string;
  scopeId?: string;
  kind?: string;
}

/**
 * Click an action in the pane. When another session on the item is still
 * working, the button turns into the spec's inline "Start anyway" confirm
 * and wants a second click — that is the concurrency warning doing its job,
 * not a failure, so take it when it appears and move on when it does not.
 */
async function startAction(pane: Locator, name: string): Promise<void> {
  await pane.getByRole('button', { name, exact: true }).click();
  const confirm = pane.getByRole('button', { name: /Start anyway/ });
  try {
    await confirm.waitFor({ state: 'visible', timeout: 1_500 });
    await confirm.click();
  } catch {
    // No confirm appeared: nothing was working on the item.
  }
}
```

and extend the Playwright type import at the top of the file to

```ts
import type { ElectronApplication, Locator } from '@playwright/test';
```

- [ ] **Step 2: Retitle the test**

Replace

```ts
test('inbox renders, launch cuts a worktree and a session, relaunch re-attaches', async () => {
```

with

```ts
test('inbox renders, an action cuts a worktree and a session, a second action shares the worktree', async () => {
```

- [ ] **Step 3: Replace the flow from the Issues-tab check to the end of the `try` block**

Replace everything from

```ts
    // The un-cloned repo's issue offers the clone path instead of failing.
    await page.locator('.inbox-tab', { hasText: 'Issues' }).click();
```

through the end of the re-attach watch loop

```ts
    const reattachWatchUntil = Date.now() + 8_000;
    while (Date.now() < reattachWatchUntil) {
      expect(sessionsIn(stateFile)).toHaveLength(1);
      await page.waitForTimeout(400);
    }
```

with

```ts
    // The un-cloned repo's issue offers only the clone path, in the pane.
    await page.locator('.inbox-tab', { hasText: 'Issues' }).click();
    await page.locator('.inbox-item', { hasText: 'Rate limit returns 500' }).click();
    const pane = page.locator('[data-testid="inbox-pane"]');
    await expect(pane.locator('.inbox-pane-clone', { hasText: 'Clone into scope' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(pane.locator('[data-action-id]')).toHaveCount(0);
    // Esc closes the pane; selecting the row again would too.
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await page.locator('.inbox-tab', { hasText: 'PRs' }).click();

    // Select the row: the pane opens with the section default highlighted,
    // and "Review" is the seeded default for a PR awaiting your review.
    const item51 = page.locator('.inbox-item', { hasText: 'Extract billing client' });
    await item51.click();
    await expect(pane).toBeVisible();
    await expect(pane.locator('.inbox-pane-action--default')).toHaveText('Review');

    // One click: worktree first, record second, spawn third.
    await startAction(pane, 'Review');

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

    // The launch opened the session; back to the Inbox, the pane now lists
    // it. A second "Review" is a SECOND session — always a new session —
    // and it shares the item's worktree rather than cutting another.
    await inboxRow.click();
    await item51.click();
    await expect(pane.locator('.inbox-pane-session-row')).toHaveCount(1, { timeout: 10_000 });
    await startAction(pane, 'Review');

    await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(2);
    const [older, newer] = sessionsIn(stateFile);
    expect(newer.id).not.toBe(older.id);
    expect(newer.cwd).toBe(worktree);
    expect(newer.workItemAction).toBe('Review');
    expect(newer.workItem).toMatchObject({ repo: 'sympower/controller-app', type: 'pr', number: 51 });
```

Everything before the Issues-tab check (profile, clone, seed, launch, switcher, the `#51` title assertion) and the whole `finally` block stay exactly as they are.

- [ ] **Step 4: Build and run the spec**

Run: `npm run build && npx playwright test tests/e2e/inbox.spec.ts`
Expected: PASS. If the second `startAction` times out waiting for the pane's "Review" button, check that `busy` turned the label into the confirm before the helper's first click (it uses `exact: true` on `Review`); the helper's `/Start anyway/` branch then handles it.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/inbox.spec.ts
git commit -m "test(e2e): inbox launches from the pane; a second action shares the worktree

The row selects the pane and the pane starts 'Review'; the old re-attach
assertion becomes its opposite — a second 'Review' mints a second session
with the same cwd — and the un-cloned issue's clone path is asserted in
the pane, where it now lives.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: Full sweep — unit, typecheck, build, e2e, dead-name scan

**Files:**
- None new. Fix-ups only if a step below fails; each fix-up is its own commit with the trailer.

**Interfaces:**
- Consumes: everything above. Produces: a green branch that Phase D starts from.

- [ ] **Step 1: Unit tests and typecheck**

Run: `npm test`
Expected: all files pass — B's baseline plus this phase's new files (`workItemPrompt`, `sessionLabel`, `workItemActions`, `workItems`, `launchWorkItem`, `inboxStore`, `rankSearchableItems`, `linkSessionRows`, `inboxPresentation`).

Run: `npm run typecheck`
Expected: clean across main, preload and renderer.

- [ ] **Step 2: Dead-name scan**

Run:

```bash
grep -rn 'reattached\|cloneAndLaunch\|actionFor\b\|ActionsPlaceholderPanel\|pathExists\|workItemSessionName\|buildSeedPrompt\|githubBridge' src/ tests/
```

Expected: no output. Any hit is a leftover from a task above — remove it and commit as `chore: drop leftover <name>`.

- [ ] **Step 3: Build and e2e**

Run: `npm run build && npx playwright test tests/e2e/inbox.spec.ts tests/e2e/workspace-settings.spec.ts`
Expected: both PASS. (`tests/e2e/terminal.spec.ts` is known to fail standalone on main and is not run here.)

- [ ] **Step 4: Manual walk of the two doors and the strip (no code; the checklist is the verification)**

With `npm run dev` against a real provider-bound workspace:

- Select a PR row → pane shows facts, an empty Sessions list, every PR action with the section default in the accent, "Custom prompt..." and "Link existing session...".
- Start "Review" → the session opens; its sidebar row reads `PR #<n> · Review` with the title underneath; the strip shows the `Review` pill and no siblings menu.
- Back in the Inbox, the row hints `1 session`; the pane lists it with a status dot and "Open"; start "Fix CI" while the first is working → the button turns into `Another session is working on this — Start anyway`; the second click starts it; the strip in either session shows `2 sessions on this PR` and the menu jumps between them.
- Sidebar ⋯ on a hand-made session → "Link to work item..." → pick the PR → the row reads `⑂ <name>`; the pane lists three; ⋯ → "Unlink" → the row reads its plain name again; the session's cwd never changed.
- ⋯ on a conductor: no Link entry. Pane → "Link existing session..." → a session already on another item is greyed with "already linked"; picking an enabled one links it.
- Workspace settings → Actions: drag a row, use the arrows, edit a name and see the pane's button and the sidebar labels of *already started* sessions unchanged, delete an action that is a section default and see that select fall to "None", "Restore defaults", and a rejected write (empty prompt) shown inline without closing the editor.

- [ ] **Step 5: Confirm the branch is clean**

Run: `git status --porcelain`
Expected: empty. Every task above committed its own files; nothing is left staged or untracked.
