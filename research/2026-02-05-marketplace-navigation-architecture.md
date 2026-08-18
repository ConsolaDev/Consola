---
date: 2026-02-05T00:00:00-08:00
git_commit: cb34d17d4d3debdc17e54090f33be32564bb324d
branch: main
repository: Consola
topic: "Sidebar Navigation Architecture and Marketplace Feature Integration"
tags: [research, codebase, navigation, sidebar, marketplace, ui-architecture]
status: complete
---

# Research: Sidebar Navigation Architecture and Marketplace Feature Integration

**Date**: 2026-02-05
**Git Commit**: cb34d17d4d3debdc17e54090f33be32564bb324d
**Branch**: main
**Repository**: Consola

## Research Question

How does the current main side navigation work and where/how can we add a way to add Claude Code marketplaces and browse the current ones? The end goal is for users to browse all marketplaces added to Claude Code and explore their plugins (skills, commands, etc.) to install them either globally (`~/.claude`) or to a specific project.

## Summary

The application uses a **tab-based navigation system** built on Zustand stores with a React Router shell. The sidebar (`Sidebar/index.tsx`) contains three zones: top navigation (Home), middle section (Workspaces), and footer (Settings). Content views are rendered based on active tab type through `TabContent`. The architecture supports adding a new **Marketplaces nav item** as a first-class navigation destination with a dedicated full-view browsing experience.

---

## Detailed Findings

### 1. Sidebar Navigation Architecture

**Component Hierarchy:**
```
Sidebar (src/renderer/components/Sidebar/index.tsx:11-69)
├── sidebar-nav (top section)
│   └── NavItem (Home link)
├── sidebar-section (main workspace content)
│   ├── sidebar-section-header
│   │   └── New Workspace Button + Tooltip
│   └── workspace-list
│       └── WorkspaceNavItem (for each workspace)
│           ├── Expand/Collapse Toggle (chevron)
│           ├── workspace-nav-item (clickable)
│           └── WorkspaceActionsMenu (dropdown)
│           └── workspace-collapsible-content (Radix Collapsible)
│               └── project-list
│                   └── ProjectNavItem (for each project)
└── sidebar-footer
    └── Settings Button
```

**Key Components:**

| Component | File | Purpose |
|-----------|------|---------|
| `Sidebar` | `Sidebar/index.tsx:11-69` | Main container, renders nav zones |
| `NavItem` | `Sidebar/NavItem.tsx:4-22` | Generic navigation link (used for Home) |
| `WorkspaceNavItem` | `Sidebar/WorkspaceNavItem.tsx:9-80` | Expandable workspace with projects |
| `ProjectNavItem` | `Sidebar/ProjectNavItem.tsx:6-43` | Individual project link |
| `SidebarToggle` | `Sidebar/SidebarToggle.tsx:5-28` | Toggle sidebar visibility |

**NavItem Props Interface** (`NavItem.tsx:4-22`):
```typescript
interface NavItemProps {
  icon: ReactNode;
  label: string;
  to: string;
  shortcut?: string;
}
```

---

### 2. State Management Architecture

**Library:** Zustand with localStorage persistence

**Stores:**

| Store | File | Key | State Managed |
|-------|------|-----|---------------|
| `navigationStore` | `stores/navigationStore.ts` | `'consola-navigation'` | Sidebar visibility, explorer visibility, workspace expansion |
| `workspaceStore` | `stores/workspaceStore.ts` | `'consola-workspaces'` | Workspaces and projects data |
| `tabStore` | `stores/tabStore.ts` | `'consola-tabs'` | Open tabs, active tab, tab ordering |
| `settingsStore` | `stores/settingsStore.ts` | `'consola-settings'` | Theme preference |
| `previewTabStore` | `stores/previewTabStore.ts` | Not persisted | File preview tabs |

**Tab Types** (`tabStore.ts:5`):
```typescript
type TabType = 'home' | 'workspace' | 'project';
```

**Tab Interface** (`tabStore.ts:7-12`):
```typescript
interface Tab {
  id: string;          // Generated: 'home' | '{type}-{targetId}'
  type: TabType;
  targetId: string;    // Workspace or project ID
  workspaceId?: string; // Only for project tabs
}
```

---

### 3. View Routing System

**Router:** React Router with HashRouter (`router.tsx`)
- Single root route at `/`
- All content navigation handled by tab system, not URL routes

**TabContent Component** (`Layout/TabContent.tsx:4-29`):
```typescript
switch (activeTab.type) {
  case 'home':
    return <HomeView />;
  case 'workspace':
    return <ContentView workspaceId={activeTab.targetId} />;
  case 'project':
    return (
      <ContentView
        workspaceId={activeTab.workspaceId!}
        projectId={activeTab.targetId}
      />
    );
  default:
    return <HomeView />;
}
```

**View Components:**
- `HomeView` (`Views/HomeView.tsx:6-38`): Welcome screen, workspace list
- `ContentView` (`Views/ContentView.tsx:16-115`): Workspace/project view with agent panel, file explorer, preview panel
- `WorkspaceView` (`Views/WorkspaceView.tsx`): Legacy component (unused in tab system)

---

### 4. Dialog/Modal Patterns

**Pattern:** Context Provider + Radix UI Dialog

**Components:**
- `CreateWorkspaceDialog` (`Dialogs/CreateWorkspaceDialog.tsx`)
- `SettingsModal` (`Dialogs/SettingsModal.tsx`)

**Context Structure:**
```typescript
// CreateWorkspaceContext.tsx:11-18
export function CreateWorkspaceProvider({ children }: { children: ReactNode }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = () => setDialogOpen(true);

  return (
    <CreateWorkspaceContext.Provider value={{ openDialog }}>
      {children}
      <CreateWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </CreateWorkspaceContext.Provider>
  );
}
```

**Usage Pattern:**
```typescript
const { openDialog } = useCreateWorkspace();
// ...
<button onClick={openDialog}>New Workspace</button>
```

**Radix Components Used:**
- `Dialog.Root`, `Dialog.Portal`, `Dialog.Overlay`, `Dialog.Content`, `Dialog.Title`, `Dialog.Close`

---

### 5. CSS Architecture

**Design Tokens:** CSS variables from `tokens.css`
- Spacing: `--space-1` through `--space-6`
- Colors: `--color-bg-*`, `--color-text-*`, `--color-border-*`, `--color-accent-*`
- Typography: `--font-size-*`, `--font-weight-*`
- Borders: `--radius-sm`, `--radius-md`, `--radius-lg`
- Shadows: `--shadow-elevation-*`
- Z-index: `--z-modal`, `--z-tooltip`, `--z-dropdown`
- Transitions: `--transition-fast`

**Sidebar Styling** (`Sidebar/styles.css`):
- Flexbox column layout
- Width: `var(--sidebar-width)`
- Three sections: `.sidebar-nav`, `.sidebar-section`, `.sidebar-footer`

**Key Patterns:**
- Hover states: `background: var(--color-bg-hover)`
- Active states: `background: var(--color-bg-active)`
- Transitions on background/color changes
- Collapsible animations via Radix data-state attributes

---

## Marketplace Integration Recommendations

### 1. Sidebar Placement

**Recommendation:** Add as top-level nav item below Home, above Workspaces

```
[Home]
[Marketplaces] ← NEW (same NavItem component)
─────────────────────────
WORKSPACES
  > Workspace A
  > Workspace B
─────────────────────────
[Settings] ⌘,
```

**Implementation:**
```typescript
// Sidebar/index.tsx - Add after Home NavItem
<NavItem
  icon={<Package size={16} />}  // or Store icon
  label="Marketplaces"
  to="/marketplaces"
/>
```

### 2. Tab System Extension

**Add new tab type:**
```typescript
// tabStore.ts
type TabType = 'home' | 'workspace' | 'project' | 'marketplace';
```

**Extend TabContent:**
```typescript
// TabContent.tsx
case 'marketplace':
  return <MarketplaceView />;
```

### 3. MarketplaceView Structure

**Recommended layout:**
```
┌─────────────────────────────────────────────────────────┐
│ MarketplaceView                                         │
├─────────────┬───────────────────────────────────────────┤
│ Category    │ Search + Filters                          │
│ Sidebar     ├───────────────────────────────────────────┤
│ (180px)     │                                           │
│             │ Plugin Grid                               │
│ - Featured  │ [Card] [Card] [Card]                     │
│ - Skills    │ [Card] [Card] [Card]                     │
│ - Commands  │                                           │
│ - Installed │                                           │
└─────────────┴───────────────────────────────────────────┘
```

### 4. Installation Target Selection

**Pattern:** Dropdown button with context-aware default

```
┌────────────────────┐
│ Install ▾          │
└────────────────────┘
        │
        ▼
┌────────────────────┐
│ ✓ Install Globally │  → ~/.claude/plugins/
│   Install to...    │  → Opens project picker
└────────────────────┘
```

**Project Picker Dialog:**
- Reuse `CreateWorkspaceDialog` modal styling
- Show workspace/project tree from `workspaceStore`
- Display target path: `/path/to/project/.claude/`

### 5. New Store: MarketplaceStore

```typescript
interface MarketplaceState {
  marketplaces: Marketplace[];
  plugins: Plugin[];
  installedPlugins: InstalledPlugin[];
  searchQuery: string;
  activeCategory: string;

  // Actions
  addMarketplace: (url: string) => Promise<void>;
  removeMarketplace: (id: string) => void;
  installPlugin: (pluginId: string, target: 'global' | { projectId: string }) => Promise<void>;
  uninstallPlugin: (pluginId: string, target: string) => Promise<void>;
  fetchPlugins: () => Promise<void>;
  setSearchQuery: (query: string) => void;
  setCategory: (category: string) => void;
}
```

---

## Code References

### Sidebar Components
- `src/renderer/components/Sidebar/index.tsx:11-69` - Main sidebar container
- `src/renderer/components/Sidebar/NavItem.tsx:4-22` - Reusable nav item component
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:9-80` - Expandable workspace item
- `src/renderer/components/Sidebar/styles.css:2-411` - All sidebar styling

### State Management
- `src/renderer/stores/tabStore.ts:5-12` - Tab type and interface definitions
- `src/renderer/stores/tabStore.ts:51-74` - `openTab()` implementation
- `src/renderer/stores/navigationStore.ts:7-9` - Navigation state shape
- `src/renderer/stores/workspaceStore.ts:4-19` - Project/Workspace interfaces

### Views and Routing
- `src/renderer/components/Layout/TabContent.tsx:14-28` - View switching logic
- `src/renderer/components/Views/HomeView.tsx:6-38` - Home view example
- `src/renderer/components/Views/ContentView.tsx:16-115` - Content view with panels
- `src/renderer/router.tsx:19-25` - Router configuration

### Dialog Patterns
- `src/renderer/contexts/CreateWorkspaceContext.tsx:11-18` - Context provider pattern
- `src/renderer/components/Dialogs/CreateWorkspaceDialog.tsx:36-55` - Form handling
- `src/renderer/components/Dialogs/SettingsModal.tsx:33-62` - Multi-section modal
- `src/renderer/components/Dialogs/styles.css:19-47` - Dialog content styling

---

## Architecture Documentation

### Key Patterns

1. **Tab-Based Navigation:** Content is rendered based on active tab type, not URL routes
2. **Zustand + Persistence:** All stores use Zustand with localStorage persistence
3. **Radix UI Primitives:** Dialogs, dropdowns, collapsibles, tooltips all use Radix
4. **Context for Dialogs:** Each dialog has a context provider wrapping the app
5. **CSS Variables:** Design tokens enable consistent theming
6. **Event Propagation Control:** `stopPropagation()` used strategically to prevent parent handlers

### Files to Create for Marketplace Feature

1. `src/renderer/components/Sidebar/index.tsx` - Modify to add Marketplaces nav item
2. `src/renderer/stores/marketplaceStore.ts` - New store for marketplace state
3. `src/renderer/stores/tabStore.ts` - Extend TabType to include 'marketplace'
4. `src/renderer/components/Views/MarketplaceView.tsx` - New view component
5. `src/renderer/components/Layout/TabContent.tsx` - Add marketplace case
6. `src/renderer/components/Marketplace/` - New component directory:
   - `MarketplaceView.tsx`
   - `MarketplaceSidebar.tsx`
   - `PluginGrid.tsx`
   - `PluginCard.tsx`
   - `PluginDetailPanel.tsx`
   - `InstallButton.tsx`
   - `ProjectPicker.tsx`
   - `styles.css`
7. `src/renderer/contexts/MarketplaceContext.tsx` - Optional context for dialogs

---

## Open Questions

1. **Marketplace Data Source:** How will marketplace data be fetched? REST API, local files, or mixed?
2. **Plugin Format:** What is the schema for plugins/skills/commands in a marketplace?
3. **Installation Mechanism:** How does installation work? Copy files, npm install, symlinks?
4. **Update Detection:** How to detect when installed plugins have updates available?
5. **Authentication:** Do marketplaces require authentication for private/paid plugins?
6. **Offline Support:** Should installed plugin metadata be cached for offline viewing?
