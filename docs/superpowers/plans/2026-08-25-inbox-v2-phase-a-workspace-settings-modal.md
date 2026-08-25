# Inbox v2 Phase A — Workspace Settings Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything that belongs to one workspace leaves the global Settings modal for a dedicated `WorkspaceSettingsModal` titled by the workspace — General · Scopes · Provider · Actions · Groups · Danger zone — reachable from the workspace menu, the command palette and the Inbox header. `⌘,` keeps opening the global modal, which now holds only Appearance · Harnesses · Keyboard Shortcuts plus a one-line pointer where the Workspace tab was.

**Architecture:** A sibling context, `WorkspaceSettingsProvider`, owns "which workspace's modal is open" as a single `string | null` and mounts `WorkspaceSettingsModal` once, outermost in `router.tsx`, so the global modal's pointer row, the palette, the workspace menu and the Inbox can all reach `openWorkspaceSettings()`. The modal reuses the global modal's `.settings-modal-*` chrome and shows the six existing panels — moved, not rewritten — one at a time behind a `NAV_ORDER`/`NAV_META` left nav; its body is keyed by workspace id so retargeting discards drafts. The Actions entry ships with a placeholder panel that Phase C swaps for `ActionsPanel`. Nothing in `src/main`, no IPC channel and no migration changes in this phase.

**Tech Stack:** Electron 28 renderer (React 19, Zustand, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `lucide-react` 0.563), vitest (node environment, pure helpers only), Playwright e2e against `dist/`.

**Spec:** `docs/superpowers/specs/2026-08-25-inbox-actions-and-provider-seam-design.md` — "Workspace Settings modal" and the Phasing row **A**. UI source of truth: `.superpowers/brainstorm/79317-1787637506/content/workspace-settings.html`, option 2 (the dedicated modal). Cross-phase rulings: `contracts.md` ("Execution facts", "Phase A").

## Global Constraints

- **Starting point is the code after Phase B lands** on `feat/inbox-v2`. Names taken from Phase B's contract, consumed as given: `Workspace.provider?: { id: GitProviderId; accountLogin: string; org?: string }` (replaces `workspace.github`); `Workspace.actions` and `Workspace.sectionDefaults` (untouched here); `PROVIDER_META: Record<GitProviderId, ProviderMeta>` in `src/shared/providers.ts` with `displayName`; `ProviderBindingPanel` exported from `src/renderer/components/Provider` (`index.ts`), props `{ workspace: Workspace }`, **not** self-wrapped — the caller supplies `<section className="ws-panel">`; `CURRENT_WORKSPACE_STATE_VERSION` is `7`. If Phase B's `WorkspaceSettingsSection.tsx` import reads `from '../Provider'`, Task 4 deletes that file either way.
- **Nav ids and labels (exact):** `WorkspaceSettingsSectionId = 'general' | 'scopes' | 'provider' | 'actions' | 'groups' | 'danger'`, in that order. Labels: `General`, `Scopes`, the bound provider's `displayName` (`GitHub`) or `Provider` when unbound, `Actions`, `Groups`, `Danger zone`. Modal title is the workspace name; subtitle `Workspace settings`.
- **Entry-point labels (exact):** workspace menu item `Workspace settings…`; palette action id `action.workspace.settings`, label `Workspace settings…`, context = workspace name; Inbox header button `className="inbox-refresh inbox-settings-button"`, `aria-label="Workspace settings"`, icon lucide `Settings` (the spec's gear is that icon, never a text glyph).
- **Global modal pointer row (exact):** a `Dialog.Close`-composed button, `className="settings-modal-nav-pointer"`, copy `Workspace settings are in the workspace menu`; disabled with `title="Open a workspace to manage it here."` when no workspace is active. The global modal's sections become `'appearance' | 'harnesses' | 'shortcuts'`, default `'appearance'`; the sidebar footer gear and `⌘,` keep opening it.
- **Placeholder copy (exact):** `ActionsPlaceholderPanel` renders the hint `Actions are configured in the next release.` under a `ws-panel-title` of `Actions`.
- **Provider order in `router.tsx` (exact):** `WorkspaceSettingsProvider > SettingsProvider > CommandPaletteProvider > Layout`.
- **Context API (exact):** `src/renderer/contexts/WorkspaceSettingsContext.tsx` exports `WorkspaceSettingsProvider` and `useWorkspaceSettings()` → `{ openWorkspaceSettings(workspaceId?: string): void; closeWorkspaceSettings(): void }`. The modal closes itself when its workspace disappears and whenever `activeSessionId` changes.
- **Modal props (exact):** `WorkspaceSettingsModal({ workspaceId: string | null; onOpenChange(open: boolean): void })`; the body is keyed by `workspace.id`.
- **Commands:** `npm test` (vitest, node env, `src/**/*.test.ts` only — no jsdom, no testing-library; React components are covered by `npm run typecheck` + Playwright, pure helpers by vitest), `npx vitest run <path>`, `npm run typecheck`, `npm run build`, then `npx playwright test tests/e2e/<spec>.spec.ts` (e2e launches `dist/main/main/index.js`, so **build first**). `tests/e2e/terminal.spec.ts` fails standalone on main — not a regression signal.
- **Commits:** conventional prefix, a body line that says why, and the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Each task leaves `npm run typecheck` clean.
- **Bridge pattern is binding:** renderer code never touches `window.*API`; this phase adds no bridge and no IPC channel, and must not reach for one.
- **Style:** co-located `styles.css` using `var(--space-*)`, `var(--color-*)`, `var(--radius-*)`, `var(--font-*)` tokens; Radix dialogs use the shared `.dialog-overlay/.dialog-close/.settings-modal-*` classes from `src/renderer/components/Dialogs/styles.css`; dropdowns use `.dropdown-item`; icons from `lucide-react` only, each verified with `grep -c "declare const <Name>:" node_modules/lucide-react/dist/lucide-react.d.ts` (`Info`, `Folder`, `Plug`, `Sparkles`, `Boxes`, `Trash2`, `Settings`, `X` all resolve to `1`; `Github` exists but is deprecated and is not used). No emoji in code, comments or UI copy. Comments explain *why*, in the repo's voice.
- **The six panels move unchanged.** `ManifestHeader`, `HarnessPanel`, `ScopesPanel`, `ProviderBindingPanel`, `GroupsPanel`, `DangerZonePanel` are not edited in this phase.

---

### Task 1: `providerNavLabel` — the Provider nav item's label

**Files:**
- Create: `src/renderer/components/WorkspaceSettings/navLabels.ts`
- Test: `src/renderer/components/WorkspaceSettings/navLabels.test.ts`

**Interfaces:**
- Consumes: `Workspace` and `createWorkspaceRecord(name, path, isGitRepo)` from `src/shared/workspace.ts`; `PROVIDER_META` from `src/shared/providers.ts` (Phase B).
- Produces: `providerNavLabel(workspace: Workspace): string` — `'Provider'` when unbound or when the bound id is unknown, otherwise `PROVIDER_META[id].displayName`.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/components/WorkspaceSettings/navLabels.test.ts
import { describe, expect, it } from 'vitest';
import { createWorkspaceRecord, type Workspace } from '../../../shared/workspace';
import { providerNavLabel } from './navLabels';

/** Built from the real record factory so the fixture tracks the record shape. */
function workspaceWith(provider: Workspace['provider']): Workspace {
  return { ...createWorkspaceRecord('w', '/tmp/w', false), provider };
}

describe('providerNavLabel', () => {
  it('reads generically before anything is bound', () => {
    expect(providerNavLabel(workspaceWith(undefined))).toBe('Provider');
  });

  it("reads the bound provider's own display name", () => {
    expect(providerNavLabel(workspaceWith({ id: 'github', accountLogin: 'SymJavi' }))).toBe(
      'GitHub'
    );
  });

  it('falls back rather than throwing on an id PROVIDER_META no longer lists', () => {
    // A persisted binding outlives the code that wrote it; the modal must
    // still render so the user can unbind or delete from it.
    const stale = { id: 'gitlab', accountLogin: 'x' } as unknown as NonNullable<
      Workspace['provider']
    >;
    expect(providerNavLabel(workspaceWith(stale))).toBe('Provider');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/components/WorkspaceSettings/navLabels.test.ts`
Expected: FAIL — `Failed to resolve import "./navLabels"` (the module does not exist yet).

- [ ] **Step 3: Write the helper**

```ts
// src/renderer/components/WorkspaceSettings/navLabels.ts
import type { Workspace } from '../../../shared/workspace';
import { PROVIDER_META } from '../../../shared/providers';

/**
 * The Provider nav item's label: the bound provider's own display name once
 * one is chosen ("GitHub"), the generic word before that.
 *
 * Falls back rather than throwing on an id PROVIDER_META no longer lists — a
 * persisted binding must never make the modal itself unrenderable, or the
 * one place that could fix the binding would be the place that crashes.
 */
export function providerNavLabel(workspace: Workspace): string {
  const provider = workspace.provider;
  if (!provider) return 'Provider';
  return PROVIDER_META[provider.id]?.displayName ?? 'Provider';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/components/WorkspaceSettings/navLabels.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/renderer/components/WorkspaceSettings/navLabels.ts src/renderer/components/WorkspaceSettings/navLabels.test.ts
git commit -m "feat: providerNavLabel names the workspace modal's Provider entry

The nav item is named by what is bound (GitHub) and stays renderable on a
binding whose provider id the code no longer knows.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `WorkspaceSettingsModal` — shell, keyed body, nav, placeholder Actions panel

**Files:**
- Create: `src/renderer/components/WorkspaceSettings/ActionsPlaceholderPanel.tsx`
- Create: `src/renderer/components/WorkspaceSettings/WorkspaceSettingsModal.tsx`
- Modify: `src/renderer/components/WorkspaceSettings/styles.css:1-8` (header comment) and append at end
- Modify: `src/renderer/components/WorkspaceSettings/index.ts:1` (add an export; the old one stays until Task 4)

**Interfaces:**
- Consumes: `useWorkspaceStore`, `Workspace` (`src/renderer/stores/workspaceStore.ts`); `ProviderBindingPanel` from `../Provider` (Phase B); `ManifestHeader`, `HarnessPanel`, `ScopesPanel`, `GroupsPanel`, `DangerZonePanel` (this directory); `providerNavLabel` (Task 1); `.settings-modal-content/-nav/-nav-header/-nav-item/-body/-section` and `.dialog-overlay/.dialog-close` from `../Dialogs/styles.css`.
- Produces: `WorkspaceSettingsModal({ workspaceId: string | null; onOpenChange: (open: boolean) => void })`; `export type WorkspaceSettingsSectionId`; `ActionsPlaceholderPanel()`.

- [ ] **Step 1: Create the placeholder Actions panel**

```tsx
// src/renderer/components/WorkspaceSettings/ActionsPlaceholderPanel.tsx
/**
 * Where the Actions editor will stand. The nav entry ships now so the
 * modal's shape is final before the editor lands; Phase C swaps this one
 * component for ActionsPanel and deletes this file.
 */
export function ActionsPlaceholderPanel() {
  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Actions</h3>
      </div>
      <p className="ws-panel-hint">Actions are configured in the next release.</p>
    </section>
  );
}
```

- [ ] **Step 2: Create the modal**

```tsx
// src/renderer/components/WorkspaceSettings/WorkspaceSettingsModal.tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Boxes, Folder, Info, Plug, Sparkles, Trash2, X, type LucideIcon } from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ProviderBindingPanel } from '../Provider';
import { ManifestHeader } from './ManifestHeader';
import { HarnessPanel } from './HarnessPanel';
import { ScopesPanel } from './ScopesPanel';
import { GroupsPanel } from './GroupsPanel';
import { DangerZonePanel } from './DangerZonePanel';
import { ActionsPlaceholderPanel } from './ActionsPlaceholderPanel';
import { providerNavLabel } from './navLabels';
import '../Dialogs/styles.css';
import './styles.css';

export type WorkspaceSettingsSectionId =
  | 'general'
  | 'scopes'
  | 'provider'
  | 'actions'
  | 'groups'
  | 'danger';

interface WorkspaceSettingsNavMeta {
  /** A function of the workspace: the Provider entry is named by what is bound. */
  label: (workspace: Workspace) => string;
  icon: LucideIcon;
  danger?: boolean;
}

const NAV_ORDER: WorkspaceSettingsSectionId[] = [
  'general',
  'scopes',
  'provider',
  'actions',
  'groups',
  'danger',
];

// A Record, not a second array: TypeScript itself rejects a missing or
// duplicate section id here, which is what would otherwise need a vitest
// test — npm run typecheck already proves completeness.
const NAV_META: Record<WorkspaceSettingsSectionId, WorkspaceSettingsNavMeta> = {
  general: { label: () => 'General', icon: Info },
  scopes: { label: () => 'Scopes', icon: Folder },
  provider: { label: providerNavLabel, icon: Plug },
  actions: { label: () => 'Actions', icon: Sparkles },
  groups: { label: () => 'Groups', icon: Boxes },
  danger: { label: () => 'Danger zone', icon: Trash2, danger: true },
};

interface WorkspaceSettingsModalProps {
  /** The workspace to edit; null means closed. */
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * One workspace's settings as a dialog of its own, titled by the workspace
 * so it is visibly not the global Settings modal. The panels are the six the
 * old Workspace tab stacked; here a left nav shows one at a time.
 */
export function WorkspaceSettingsModal({ workspaceId, onOpenChange }: WorkspaceSettingsModalProps) {
  const workspace = useWorkspaceStore((state) =>
    workspaceId
      ? (state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null)
      : null
  );

  // The workspace can vanish out from under an open dialog — deleted from its
  // own danger zone, or from another window entirely. `open` follows the
  // record rather than the id, so the dialog is gone the same render; this
  // effect only tells the owner to drop the id. Closing, not a "not found"
  // state, matches DeleteWorkspaceDialog's callers, which have nothing left
  // to clear once main drops the record.
  useEffect(() => {
    if (workspaceId && !workspace) onOpenChange(false);
  }, [workspaceId, workspace, onOpenChange]);

  return (
    <Dialog.Root open={workspace !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-modal-content">
          {/* Keyed so retargeting the modal to another workspace remounts
              every panel: no draft, open rename or pending confirmation
              survives into another workspace's record — the contract the
              old Workspace tab kept, carried over. */}
          {workspace && <WorkspaceSettingsBody key={workspace.id} workspace={workspace} />}
          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkspaceSettingsBody({ workspace }: { workspace: Workspace }) {
  const [activeSection, setActiveSection] = useState<WorkspaceSettingsSectionId>('general');

  return (
    <>
      <nav className="settings-modal-nav">
        <div className="settings-modal-nav-header">
          {/* The visible text is the accessible title: unlike the global
              modal's decorative "Settings" header, this one names the thing
              being edited, so it doubles as Dialog.Title instead of hiding
              a duplicate. */}
          <Dialog.Title className="settings-modal-workspace-title">{workspace.name}</Dialog.Title>
          <Dialog.Description className="settings-modal-workspace-subtitle">
            Workspace settings
          </Dialog.Description>
        </div>
        {NAV_ORDER.map((id) => {
          const { label, icon: Icon, danger } = NAV_META[id];
          return (
            <button
              key={id}
              type="button"
              className={`settings-modal-nav-item ${activeSection === id ? 'active' : ''} ${
                danger ? 'danger' : ''
              }`}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={16} />
              <span>{label(workspace)}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-modal-body">
        <div className="settings-modal-section">
          {activeSection === 'general' && (
            <>
              <ManifestHeader workspace={workspace} />
              <HarnessPanel workspace={workspace} />
            </>
          )}
          {activeSection === 'scopes' && <ScopesPanel workspace={workspace} />}
          {activeSection === 'provider' && (
            <section className="ws-panel">
              <ProviderBindingPanel workspace={workspace} />
            </section>
          )}
          {/* Phase C swaps this one branch for <ActionsPanel workspace={workspace} />
              and deletes ActionsPlaceholderPanel.tsx; nothing else here changes. */}
          {activeSection === 'actions' && <ActionsPlaceholderPanel />}
          {activeSection === 'groups' && <GroupsPanel workspace={workspace} />}
          {activeSection === 'danger' && <DangerZonePanel workspace={workspace} />}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Retitle the stylesheet's header comment and append the modal's rules**

In `src/renderer/components/WorkspaceSettings/styles.css`, replace the first two lines of the header comment:

```css
/*
 * Workspace settings section.
```

with:

```css
/*
 * Workspace settings modal.
```

Then append at the end of the file:

```css

/* The modal's nav header names the thing being edited. */
.settings-modal-workspace-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-modal-workspace-subtitle {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-tertiary);
}

/* The danger entry raises only its color, like the panel's own title. */
.settings-modal-nav-item.danger,
.settings-modal-nav-item.danger:hover,
.settings-modal-nav-item.danger.active {
  color: var(--color-error);
}

/* A panel shown on its own has nothing above it to separate from: the
   hairline that stacked the panels under the old Workspace tab goes. */
.settings-modal-section > .ws-panel:first-child {
  padding-top: 0;
  border-top: none;
}
```

- [ ] **Step 4: Export the modal from the barrel**

`src/renderer/components/WorkspaceSettings/index.ts` becomes:

```ts
export { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
export { WorkspaceSettingsModal } from './WorkspaceSettingsModal';
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (Nothing renders the modal yet; the renderer tsconfig includes `src/renderer/**/*`, so the new files are checked regardless.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/WorkspaceSettings/ActionsPlaceholderPanel.tsx src/renderer/components/WorkspaceSettings/WorkspaceSettingsModal.tsx src/renderer/components/WorkspaceSettings/styles.css src/renderer/components/WorkspaceSettings/index.ts
git commit -m "feat: WorkspaceSettingsModal shows one workspace's panels behind a left nav

A dialog of its own, titled by the workspace, so what belongs to this
workspace stops looking like an app-wide setting. The six panels move
unchanged; Actions is a placeholder until Phase C.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `WorkspaceSettingsProvider` — open state, and its place in `router.tsx`

**Files:**
- Create: `src/renderer/contexts/WorkspaceSettingsContext.tsx`
- Modify: `src/renderer/router.tsx:1-16` (whole provider nest)

**Interfaces:**
- Consumes: `WorkspaceSettingsModal` (Task 2, via the barrel `../components/WorkspaceSettings`); `useNavigationStore` (`activeWorkspaceId`, `activeSessionId`).
- Produces: `WorkspaceSettingsProvider({ children })`; `useWorkspaceSettings(): { openWorkspaceSettings(workspaceId?: string): void; closeWorkspaceSettings(): void }`.

- [ ] **Step 1: Create the context**

```tsx
// src/renderer/contexts/WorkspaceSettingsContext.tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { WorkspaceSettingsModal } from '../components/WorkspaceSettings';
import { useNavigationStore } from '../stores/navigationStore';

interface WorkspaceSettingsContextType {
  /**
   * Opens for one workspace, or the window's active workspace when omitted.
   * A no-op if neither resolves to a workspace — there is nothing to edit.
   */
  openWorkspaceSettings: (workspaceId?: string) => void;
  closeWorkspaceSettings: () => void;
}

const WorkspaceSettingsContext = createContext<WorkspaceSettingsContextType | null>(null);

/**
 * A sibling to SettingsProvider, not an extension of it: the two modals are
 * opened from different places for different things, and only the global
 * one's pointer row ever needs to reach across.
 *
 * State is the workspace id or null rather than a boolean plus an id, so
 * "open" and "for whom" cannot disagree.
 */
export function WorkspaceSettingsProvider({ children }: { children: ReactNode }) {
  const [openForWorkspaceId, setOpenForWorkspaceId] = useState<string | null>(null);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);

  const openWorkspaceSettings = useCallback((workspaceId?: string) => {
    const target = workspaceId ?? useNavigationStore.getState().activeWorkspaceId;
    if (!target) return;
    setOpenForWorkspaceId(target);
  }, []);

  const closeWorkspaceSettings = useCallback(() => setOpenForWorkspaceId(null), []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeWorkspaceSettings();
    },
    [closeWorkspaceSettings]
  );

  // A session activating while the modal is open — an OS notification click
  // landing on this window, or the new-session chord reaching the layout
  // underneath — must not leave the dialog obscuring what the window just
  // switched to. The Inbox closes on the same cue.
  useEffect(() => {
    setOpenForWorkspaceId(null);
  }, [activeSessionId]);

  // Memoised so consumers that put the openers in dependency lists (the
  // palette's context snapshot) do not rebuild on every render here.
  const value = useMemo(
    () => ({ openWorkspaceSettings, closeWorkspaceSettings }),
    [openWorkspaceSettings, closeWorkspaceSettings]
  );

  return (
    <WorkspaceSettingsContext.Provider value={value}>
      {children}
      <WorkspaceSettingsModal workspaceId={openForWorkspaceId} onOpenChange={handleOpenChange} />
    </WorkspaceSettingsContext.Provider>
  );
}

export function useWorkspaceSettings() {
  const context = useContext(WorkspaceSettingsContext);
  if (!context) {
    throw new Error('useWorkspaceSettings must be used within a WorkspaceSettingsProvider');
  }
  return context;
}
```

- [ ] **Step 2: Nest the provider outermost in `router.tsx`**

Replace the whole of `src/renderer/router.tsx` with:

```tsx
import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { WorkspaceSettingsProvider } from './contexts/WorkspaceSettingsContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { CommandPaletteProvider } from './contexts/CommandPaletteContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <WorkspaceSettingsProvider>
      {/* Inside WorkspaceSettingsProvider: the global modal's pointer row
          opens the workspace modal, and the palette offers it. */}
      <SettingsProvider>
        {/* Inside SettingsProvider: the palette offers "Open settings". */}
        <CommandPaletteProvider>
          <Layout />
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

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; the three builds succeed. The modal is mounted (closed) in every window; nothing opens it yet.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/contexts/WorkspaceSettingsContext.tsx src/renderer/router.tsx
git commit -m "feat: WorkspaceSettingsProvider owns which workspace's modal is open

Outermost in the provider nest so the global modal, the palette, the
workspace menu and the Inbox can all open it; closes when a session
activates so it never sits over what the window just switched to.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Cutover — the global modal loses the Workspace tab and gains the pointer row

**Files:**
- Delete: `src/renderer/components/WorkspaceSettings/WorkspaceSettingsSection.tsx`
- Modify: `src/renderer/components/Dialogs/SettingsModal.tsx:1-97` (imports, `SettingsSection`, `sections`, default state, nav, body — the full file is given below; `AppearanceSection` and `ShortcutsSection` are reproduced unchanged)
- Modify: `src/renderer/components/Dialogs/styles.css` (append after `.sr-only`, the last rule)
- Modify: `src/renderer/components/WorkspaceSettings/index.ts:1-2`

**Interfaces:**
- Consumes: `useWorkspaceSettings()` (Task 3); `useNavigationStore` (`activeWorkspaceId`).
- Produces: the global modal with `SettingsSection = 'appearance' | 'harnesses' | 'shortcuts'`; the pointer row button `.settings-modal-nav-pointer`.

- [ ] **Step 1: Delete the old section and trim the barrel**

```bash
git rm src/renderer/components/WorkspaceSettings/WorkspaceSettingsSection.tsx
```

`src/renderer/components/WorkspaceSettings/index.ts` becomes:

```ts
export { WorkspaceSettingsModal } from './WorkspaceSettingsModal';
```

- [ ] **Step 2: Rewrite `SettingsModal.tsx`**

Replace the whole of `src/renderer/components/Dialogs/SettingsModal.tsx` with:

```tsx
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sun, Moon, Monitor, Palette, Keyboard, Boxes, Folder, Minus, Plus } from 'lucide-react';
import {
  useSettingsStore,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  type ThemeMode,
} from '../../stores/settingsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTheme } from '../../hooks/useTheme';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { COMMAND_PALETTE_SHORTCUT_LABEL, isMac } from '../../utils/platform';
import { HarnessesSection } from '../Harnesses';
import './styles.css';

type SettingsSection = 'appearance' | 'harnesses' | 'shortcuts';

interface SettingsSectionConfig {
  id: SettingsSection;
  label: string;
  icon: typeof Palette;
}

// Only what is global lives here. Everything that belongs to one workspace —
// name, harness, scopes, provider, actions, groups, deletion — has a modal of
// its own, opened from the workspace menu.
const sections: SettingsSectionConfig[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'harnesses', label: 'Harnesses', icon: Boxes },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard },
];

const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const { theme, setTheme, terminalFontSize, setTerminalFontSize } = useSettingsStore();
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const { openWorkspaceSettings } = useWorkspaceSettings();
  useTheme();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="settings-modal-content">
          <Dialog.Title className="sr-only">Settings</Dialog.Title>

          <nav className="settings-modal-nav">
            <div className="settings-modal-nav-header">Settings</div>
            {/* Stands where the Workspace tab was, so muscle memory has
                somewhere to land for this release. Dialog.Close composes its
                own onClick after ours: two independent state updates — open
                the workspace modal, close this one — in a single commit. */}
            <Dialog.Close asChild>
              <button
                type="button"
                className="settings-modal-nav-pointer"
                onClick={() => openWorkspaceSettings()}
                disabled={activeWorkspaceId === null}
                title={activeWorkspaceId === null ? 'Open a workspace to manage it here.' : undefined}
              >
                <Folder size={14} />
                <span>Workspace settings are in the workspace menu</span>
              </button>
            </Dialog.Close>
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`settings-modal-nav-item ${activeSection === id ? 'active' : ''}`}
                onClick={() => setActiveSection(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-modal-body">
            {activeSection === 'appearance' && (
              <AppearanceSection
                theme={theme}
                setTheme={setTheme}
                terminalFontSize={terminalFontSize}
                setTerminalFontSize={setTerminalFontSize}
              />
            )}
            {activeSection === 'harnesses' && <HarnessesSection />}
            {activeSection === 'shortcuts' && <ShortcutsSection />}
          </div>

          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AppearanceSection({
  theme,
  setTheme,
  terminalFontSize,
  setTerminalFontSize,
}: {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
}) {
  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Appearance</h2>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Theme</span>
          <span className="settings-modal-option-description">
            Select your preferred color theme
          </span>
        </div>
        <div className="settings-modal-theme-selector">
          {themeOptions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={`settings-modal-theme-button ${theme === value ? 'active' : ''}`}
              onClick={() => setTheme(value)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Terminal font size</span>
          <span className="settings-modal-option-description">
            Larger text is markedly easier to read on a non-Retina display
          </span>
        </div>
        <div className="settings-modal-stepper">
          <button
            className="settings-modal-stepper-button"
            onClick={() => setTerminalFontSize(terminalFontSize - 1)}
            disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
            aria-label="Decrease terminal font size"
          >
            <Minus size={14} />
          </button>
          <span className="settings-modal-stepper-value">{terminalFontSize}px</span>
          <button
            className="settings-modal-stepper-button"
            onClick={() => setTerminalFontSize(terminalFontSize + 1)}
            disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
            aria-label="Increase terminal font size"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsSection() {
  // Mirrors what useKeyboardShortcuts actually binds -- nothing aspirational.
  const mod = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const shortcuts = [
    { label: 'Command palette', key: COMMAND_PALETTE_SHORTCUT_LABEL },
    { label: 'New session', key: `${mod}N` },
    { label: 'Toggle sidebar', key: `${mod}\\` },
    { label: 'Toggle file explorer', key: `${mod}${shift}E` },
    { label: 'Open settings', key: `${mod},` },
    { label: 'Cycle theme', key: `${mod}${shift}T` },
  ];

  return (
    <div className="settings-modal-section">
      <h2 className="settings-modal-section-title">Keyboard Shortcuts</h2>
      <div className="settings-modal-shortcuts">
        {shortcuts.map(({ label, key }) => (
          <div key={label} className="settings-modal-shortcut">
            <span className="settings-modal-shortcut-label">{label}</span>
            <kbd className="settings-modal-shortcut-key">{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Style the pointer row**

Append at the end of `src/renderer/components/Dialogs/styles.css` (after the `.sr-only` rule):

```css

/* The one-line pointer that stands where the Workspace tab was: reads as a
   quiet nav row, acts as a door — it closes this modal and opens the
   workspace's. Disabled carries its reason in the title, like ws-row-action. */
.settings-modal-nav-pointer {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  margin-bottom: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--color-text-tertiary);
  text-align: left;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.settings-modal-nav-pointer svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.settings-modal-nav-pointer:hover:not(:disabled) {
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
}

.settings-modal-nav-pointer:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean (nothing imports `WorkspaceSettingsSection` any more — if it does, that import belongs to Phase B's rename and is deleted with the file); build succeeds.

- [ ] **Step 5: Smoke it by hand**

Run: `npm run dev`. `⌘,` opens the global modal on Appearance with three nav items and the pointer row above them; with a workspace held, clicking the row closes it and opens the workspace modal titled by the workspace; with no workspace held (`Select workspace` in the top bar), the row is disabled and its tooltip reads `Open a workspace to manage it here.`. Close the dev app.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Dialogs/SettingsModal.tsx src/renderer/components/Dialogs/styles.css src/renderer/components/WorkspaceSettings/index.ts
git commit -m "refactor: the global Settings modal keeps Appearance, Harnesses, Shortcuts

Workspace-scoped settings confused this app with this workspace; a
pointer row stands where the tab was so muscle memory lands on the door
to the new modal for one release.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: "Workspace settings…" in the workspace menu, with the first e2e test

**Files:**
- Modify: `src/renderer/components/Layout/WorkspaceSwitcher.tsx:3-22` (imports), `:41` (state), `:53` (`DropdownMenu.Root`), `:77-83` (`onCloseAutoFocus`), `:105-114` (the item, after the separator)
- Modify: `tests/e2e/helpers/electron.ts` (append two chord helpers after `newWindowChord`)
- Create: `tests/e2e/workspace-settings.spec.ts`

**Interfaces:**
- Consumes: `useWorkspaceSettings()` (Task 3); `createProfileDir`, `launchElectron` (`tests/e2e/helpers/electron.ts`); `tests/fixtures/stub-gh/gh`.
- Produces: the menu item `Workspace settings…`; `settingsChord()` and `commandPaletteChord()` in the e2e helpers; the spec's shared `seedWorkspaceState`, `launchSeeded`, `holdWorkspace` helpers that Task 6's test reuses.

- [ ] **Step 1: Add the menu item and the focus guard**

In `src/renderer/components/Layout/WorkspaceSwitcher.tsx`, change the lucide import to include `Settings`:

```tsx
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Plus,
  Settings,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
```

Add the context import directly after the `useHarnessStore` import line:

```tsx
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
```

Directly after `const [confirmingDelete, setConfirmingDelete] = useState(false);` add:

```tsx
  const { openWorkspaceSettings } = useWorkspaceSettings();
  // One-shot, like confirmingDelete: set as the item is chosen, read as the
  // menu closes, cleared on the next open so an ordinary dismissal refocuses
  // the trigger again.
  const [openingSettings, setOpeningSettings] = useState(false);
```

Replace the bare root:

```tsx
    <DropdownMenu.Root>
```

with:

```tsx
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) setOpeningSettings(false);
      }}
    >
```

Replace the close-focus guard:

```tsx
          // Selecting Delete opens a dialog; the menu refocusing its trigger
          // would race the dialog's own focus grab (see NewMenu).
          onCloseAutoFocus={(event) => {
            if (confirmingDelete) event.preventDefault();
          }}
```

with:

```tsx
          // Selecting Delete or Workspace settings opens a dialog; the menu
          // refocusing its trigger would race the dialog's own focus grab
          // (see NewMenu).
          onCloseAutoFocus={(event) => {
            if (confirmingDelete || openingSettings) event.preventDefault();
          }}
```

And insert the item between the separator and "Open new window", so the block reads:

```tsx
          {workspaces.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => {
                setOpeningSettings(true);
                openWorkspaceSettings(active.id);
              }}
            >
              <Settings size={14} />
              <span>Workspace settings…</span>
            </DropdownMenu.Item>
          )}

          {active && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void windowBridge.openWindow(null)}
            >
              <SquareArrowOutUpRight size={14} />
              <span>Open new window</span>
            </DropdownMenu.Item>
          )}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Add the chord helpers**

Append to `tests/e2e/helpers/electron.ts`, directly after `newWindowChord`:

```ts
/** The chord for the global Settings modal, matching useKeyboardShortcuts on this platform. */
export function settingsChord(): string {
  return process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma';
}

/** The command palette chord, matching isCommandPaletteShortcut on this platform. */
export function commandPaletteChord(): string {
  return process.platform === 'darwin' ? 'Meta+KeyK' : 'Control+Shift+KeyP';
}
```

- [ ] **Step 4: Write the spec**

```ts
// tests/e2e/workspace-settings.spec.ts
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron, settingsChord } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');

/**
 * Seed a provider-bound v7 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test, so the file must
 * land there. Shape per the v7 record in src/shared/workspace.ts: `provider`
 * replaces `github`; `actions` and `sectionDefaults` are the two fields the
 * migration adds, empty here because nothing in this spec reads them.
 */
function seedWorkspaceState(userDataDir: string, scopeDir: string): string {
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const workspaceId = 'ws-settings-e2e';
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
                id: 'scope-app',
                name: 'controller-app',
                path: scopeDir,
                isGitRepo: false,
                createdAt: now,
              },
            ],
            groups: [],
            provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
            actions: [],
            sectionDefaults: {},
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

/**
 * Launch against a seeded profile with the stub gh on the path: the sidebar
 * primes the Inbox for a bound workspace, and that must never reach a real
 * gh from a test.
 */
async function launchSeeded(): Promise<{
  app: ElectronApplication;
  page: Page;
  cleanup: () => Promise<void>;
}> {
  const userDataDir = createProfileDir();
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ws-settings-'));
  seedWorkspaceState(userDataDir, scopeDir);
  const { app, page } = await launchElectron({
    userDataDir,
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  // Guaranteed by the caller's finally: a mid-test failure must not leave a
  // real Electron process running for the rest of the worker, nor its
  // profile behind in the OS temp dir.
  const cleanup = async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(scopeDir, { recursive: true, force: true });
  };
  return { app, page, cleanup };
}

/** The switcher trigger; its accessible name never includes the workspace. */
function switcherTrigger(page: Page) {
  return page.getByRole('button', { name: /^Switch workspace/ });
}

/** Hold the seeded workspace through the real switcher UI (windows.spec.ts precedent). */
async function holdWorkspace(page: Page): Promise<void> {
  await switcherTrigger(page).click();
  await page.getByRole('menuitem', { name: /Sympower/ }).click();
  await expect(switcherTrigger(page)).toHaveText('Sympower');
}

test('the workspace menu opens a modal titled by the workspace; the global modal only points at it', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);

    // The front door: the workspace menu.
    await switcherTrigger(page).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();

    const modal = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item')).toHaveText([
      'General',
      'Scopes',
      'GitHub', // providerNavLabel: the bound provider's display name
      'Actions',
      'Groups',
      'Danger zone',
    ]);

    // General lands first: the manifest with the name editable in place.
    await expect(modal.getByLabel('Workspace name')).toHaveValue('Sympower');

    await modal.getByRole('button', { name: 'Scopes', exact: true }).click();
    await expect(modal.locator('.ws-row-name', { hasText: 'controller-app' })).toBeVisible();

    await modal.getByRole('button', { name: 'Danger zone', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Delete workspace…' })).toBeVisible();

    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();

    // The chord still opens the global modal, which no longer lists Workspace.
    await page.keyboard.press(settingsChord());
    const global = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(global).toBeVisible();
    await expect(global.locator('.settings-modal-nav-item')).toHaveText([
      'Appearance',
      'Harnesses',
      'Keyboard Shortcuts',
    ]);

    // The pointer row is a door: it closes this modal and opens the other.
    await global
      .getByRole('button', { name: 'Workspace settings are in the workspace menu' })
      .click();
    await expect(global).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('General');

    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 5: Build and run the spec**

Run: `npm run build && npx playwright test tests/e2e/workspace-settings.spec.ts`
Expected: 1 passed. If the `GitHub` label assertion fails with `Provider`, Phase B's `PROVIDER_META.github.displayName` is not `GitHub` — fix the constant there, not this test.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Layout/WorkspaceSwitcher.tsx tests/e2e/helpers/electron.ts tests/e2e/workspace-settings.spec.ts
git commit -m "feat: Workspace settings… in the workspace menu

The workspace menu is where the workspace already lives in the top bar,
so its settings open from there. The one-shot focus guard keeps the menu
from racing the dialog for focus, as Delete already does.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The command palette offers "Workspace settings…"

**Files:**
- Modify: `src/renderer/components/CommandPalette/buildItems.ts:46-64` (`PaletteContext`), `:93-106` (after the "New session" item)
- Modify: `src/renderer/components/CommandPalette/usePaletteResults.ts:9` (import), `:57` (hook), `:100-133` (memo object and deps)
- Modify: `tests/e2e/workspace-settings.spec.ts:7` (import) and append a second test

**Interfaces:**
- Consumes: `useWorkspaceSettings()` (Task 3); `ActionPaletteItem` (`CommandPalette/types.ts`); `Settings` from `lucide-react` (already imported in `buildItems.ts`).
- Produces: `PaletteContext.openWorkspaceSettings: (workspaceId?: string) => void`; the action item `action.workspace.settings`.

- [ ] **Step 1: Extend `PaletteContext` and add the item**

In `src/renderer/components/CommandPalette/buildItems.ts`, change the tail of the `PaletteContext` interface from:

```ts
  terminalFontSize: number;
  openSettings: () => void;
}
```

to:

```ts
  terminalFontSize: number;
  openSettings: () => void;
  openWorkspaceSettings: (workspaceId?: string) => void;
}
```

Then, inside `buildActionItems`, directly after the closing `}` of the `if (activeWorkspace) { … 'action.session.new-here' … }` block and before `if (ctx.workspaces.length > 1) {`, insert:

```ts
  if (activeWorkspace) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.workspace.settings',
      label: 'Workspace settings…',
      context: activeWorkspace.name,
      icon: Settings,
      // Explicit id rather than the context's fallback: the palette's
      // snapshot names the workspace this row was built for.
      run: () => ctx.openWorkspaceSettings(activeWorkspace.id),
    });
  }
```

- [ ] **Step 2: Supply the opener from the palette context hook**

In `src/renderer/components/CommandPalette/usePaletteResults.ts`, directly after:

```ts
import { useSettings } from '../../contexts/SettingsContext';
```

add:

```ts
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
```

Directly after `const { openSettings } = useSettings();` add:

```ts
  const { openWorkspaceSettings } = useWorkspaceSettings();
```

Replace the returned memo so both the object and the dependency list carry it:

```ts
  return useMemo(
    () => ({
      workspaces,
      activeWorkspace,
      activeSession,
      selectableHarnesses,
      allSessions,
      exitedSessions,
      terminals,
      fileStatuses,
      gitStatusRootPath,
      stagedCount,
      commitMessage,
      isGitReviewOpen,
      terminalFontSize,
      openSettings,
      openWorkspaceSettings,
    }),
    [
      workspaces,
      activeWorkspace,
      activeSession,
      selectableHarnesses,
      allSessions,
      exitedSessions,
      terminals,
      fileStatuses,
      gitStatusRootPath,
      stagedCount,
      commitMessage,
      isGitReviewOpen,
      terminalFontSize,
      openSettings,
      openWorkspaceSettings,
    ]
  );
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. (The `PaletteContext` type is only constructed in `usePaletteContext`; a missing field there is the compile error this step guards.)

- [ ] **Step 4: Append the palette test**

In `tests/e2e/workspace-settings.spec.ts`, change the helpers import to:

```ts
import {
  commandPaletteChord,
  createProfileDir,
  launchElectron,
  settingsChord,
} from './helpers/electron';
```

and append at the end of the file:

```ts

test('the command palette offers Workspace settings… for the held workspace', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);

    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill('workspace settings');
    // The row's accessible name is its label plus its context ("… Sympower"),
    // so this match is deliberately not exact.
    await palette.getByRole('option', { name: 'Workspace settings…' }).click();

    await expect(palette).toBeHidden();
    const modal = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 5: Build and run the spec**

Run: `npm run build && npx playwright test tests/e2e/workspace-settings.spec.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/CommandPalette/buildItems.ts src/renderer/components/CommandPalette/usePaletteResults.ts tests/e2e/workspace-settings.spec.ts
git commit -m "feat: the command palette offers Workspace settings…

Every door to the modal is one call on the same context; the palette
row carries the workspace name as its context so it reads as an action
on this workspace, not a global one.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The Inbox header's gear opens Workspace Settings

**Files:**
- Modify: `src/renderer/components/Inbox/index.tsx:2` (lucide import), after the `workspaceStore` type import (context import), after the `refresh` selector (hook), and the `.inbox-meta` refresh button
- Modify: `tests/e2e/inbox.spec.ts:120-124` (append one assertion block after the `#51 Extract billing client` visibility check)

**Interfaces:**
- Consumes: `useWorkspaceSettings()` (Task 3); `.inbox-refresh` from `Inbox/styles.css`.
- Produces: `<button className="inbox-refresh inbox-settings-button" aria-label="Workspace settings">` — the `.inbox-settings-button` selector Phase D's rewritten spec keeps using.

- [ ] **Step 1: Add the button**

In `src/renderer/components/Inbox/index.tsx`, change the lucide import to:

```tsx
import { ExternalLink, RefreshCw, Settings } from 'lucide-react';
```

Directly after the `import type { Workspace } from '../../stores/workspaceStore';` line add:

```tsx
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
```

Directly after `const refresh = useInboxStore((state) => state.refresh);` add:

```tsx
  const { openWorkspaceSettings } = useWorkspaceSettings();
```

Replace the refresh button at the end of `.inbox-meta`:

```tsx
          <button
            className="inbox-refresh"
            aria-label="Refresh inbox"
            onClick={() => void refresh(workspace.id)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
```

with:

```tsx
          <button
            className="inbox-refresh"
            aria-label="Refresh inbox"
            onClick={() => void refresh(workspace.id)}
          >
            <RefreshCw size={13} />
          </button>
          {/* Same quiet chrome as refresh; Phase C's Actions editor is what
              this door is for, so it sits where the Inbox is triaged. */}
          <button
            className="inbox-refresh inbox-settings-button"
            aria-label="Workspace settings"
            title="Workspace settings"
            onClick={() => openWorkspaceSettings(workspace.id)}
          >
            <Settings size={13} />
          </button>
        </div>
```

(Phase B's edit to this file renames `workspace.github` to `workspace.provider` and its imports; the refresh button is untouched by it. If the surrounding lines differ, the change is the same: the new button directly follows the refresh button inside `.inbox-meta`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Append the assertion to `inbox.spec.ts`**

In `tests/e2e/inbox.spec.ts`, directly after:

```ts
    // Remote-driven list from the stub's canned GraphQL payload.
    await expect(
      page.locator('.inbox-item-title', { hasText: '#51 Extract billing client' })
    ).toBeVisible({ timeout: 15_000 });
```

insert:

```ts
    // The header's gear opens Workspace Settings for this workspace and
    // leaves the Inbox where it was.
    await page.locator('.inbox-settings-button').click();
    const workspaceSettings = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(workspaceSettings).toBeVisible();
    await workspaceSettings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(workspaceSettings).toBeHidden();
    await expect(inboxRow).toHaveClass(/active/);
```

- [ ] **Step 4: Build and run both specs**

Run: `npm run build && npx playwright test tests/e2e/inbox.spec.ts tests/e2e/workspace-settings.spec.ts`
Expected: 3 passed. (`inbox.spec.ts` seeds v6; Phase B's migration brings it to v7 on load, so its selectors are unchanged by this phase.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Inbox/index.tsx tests/e2e/inbox.spec.ts
git commit -m "feat: the Inbox header's gear opens Workspace Settings

Actions are edited in the workspace modal and used from the Inbox, so
the Inbox gets a door to them next to refresh.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full pass — unit, typecheck, build, e2e, and the by-hand checks

**Files:**
- No planned edits. Anything this task turns up is fixed in place and committed as `fix:`.

**Interfaces:**
- Consumes: everything Tasks 1–7 produced.
- Produces: a branch on which `npm test`, `npm run typecheck`, `npm run build` and the three e2e specs are green, ready for Phase C.

- [ ] **Step 1: Unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: every vitest file passes (Phase B's baseline plus `navLabels.test.ts`); typecheck clean across main, preload and renderer.

- [ ] **Step 2: Build and the e2e specs this phase touches**

Run: `npm run build && npx playwright test tests/e2e/workspace-settings.spec.ts tests/e2e/inbox.spec.ts tests/e2e/sidebar.spec.ts`
Expected: 7 passed (2 + 1 + 4). `sidebar.spec.ts` is in the list because the sidebar's footer gear and the layout it measures are unchanged, and a regression there would mean the provider nest or the modal's mount moved something it should not have.

- [ ] **Step 3: By-hand checks in `npm run dev`**

Each is a behaviour a Playwright spec above does not cover:

- The sidebar footer gear still opens the **global** modal, on Appearance.
- Inside the workspace modal, Scopes → the remove button on a scope opens `ConfirmDialog` over the modal; Danger zone → `Delete workspace…` opens `DeleteWorkspaceDialog` over the modal; cancelling either leaves the modal open on the same section.
- Deleting the workspace from its danger zone closes the modal by itself (the window's workspace is dropped by main; nothing to clear).
- With the workspace modal open, a session activating from an OS notification click (or `⌘N` while a session is active) closes the modal.
- Open the modal, rename the workspace in General, confirm the top-bar switcher and the modal's title both follow.
- Provider section: the panel renders under the `GitHub` nav label with its `Re-check gh` button; unbind, and the nav label falls back to `Provider` without the modal closing.
- Actions section reads `Actions are configured in the next release.`
- The workspace menu, after choosing `Workspace settings…` and closing the modal, still refocuses its trigger on the next plain dismissal (the guard is one-shot).

- [ ] **Step 4: Commit only if something needed fixing**

If Steps 1–3 required a change, commit it on its own:

```bash
git add -A
git commit -m "fix: <what the full pass turned up>

<why it was wrong and what the by-hand check showed>

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Otherwise there is nothing to commit; the branch is ready for Phase C.
