# Tab System Implementation Plan

**Date**: 2026-02-04
**Status**: Ready for implementation

## Overview

Implement a tab-based navigation system where opening workspaces or projects creates tabs in the AppHeader. Clicking an already-open item focuses its existing tab.

## Requirements

- Home is a tab type (always available, cannot be closed)
- Settings remains a separate route (not a tab)
- Tabs persist to localStorage across app restarts
- Unlimited tabs
- Drag-to-reorder support

## Data Model

```typescript
// src/renderer/stores/tabStore.ts

type TabType = 'home' | 'workspace' | 'project';

interface Tab {
  id: string;                // Unique tab ID (e.g., 'home', 'workspace-{id}', 'project-{id}')
  type: TabType;
  targetId: string;          // workspaceId or projectId (empty string for home)
  workspaceId?: string;      // Parent workspace ID (required for projects)
}

interface TabState {
  tabs: Tab[];
  activeTabId: string;

  // Actions
  openTab: (type: TabType, targetId: string, workspaceId?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
}
```

## Files to Create

### 1. `src/renderer/stores/tabStore.ts`
Zustand store with localStorage persistence via `persist` middleware.

**Key behaviors:**
- `openTab`: If tab exists, focus it. Otherwise create and focus.
- `closeTab`: Remove tab. If it was active, activate the previous tab or home.
- Home tab is always present and cannot be closed.
- Initial state: `[{ id: 'home', type: 'home', targetId: '' }]`

### 2. `src/renderer/components/TabBar/index.tsx`
Main TabBar component for AppHeader.

**Structure:**
```
TabBar
├── TabList (draggable container)
│   └── TabItem[] (individual tabs)
└── (optional) NewTabButton
```

**Features:**
- Horizontal scrollable list of tabs
- Each tab shows: icon (based on type), name, close button (except home)
- Active tab highlighted
- Drag-to-reorder using `@dnd-kit/core` and `@dnd-kit/sortable`

### 3. `src/renderer/components/TabBar/TabItem.tsx`
Individual tab component.

**Props:**
- `tab: Tab`
- `isActive: boolean`
- `onClose: () => void`
- `onClick: () => void`

### 4. `src/renderer/components/TabBar/TabBar.css`
Styles matching existing app design patterns.

## Files to Modify

### 1. `src/renderer/components/Layout/AppHeader.tsx`
**Change:** Replace placeholder comment with `<TabBar />` component.

```tsx
// Before
<div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
  {/* Future: Tab bar will go here */}
</div>

// After
<div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
  <TabBar />
</div>
```

### 2. `src/renderer/components/Layout/index.tsx`
**Change:** Replace `<Outlet />` with tab-based content rendering.

```tsx
// Before
<main className="content-area">
  <Outlet />
</main>

// After
<main className="content-area">
  <TabContent />
</main>
```

Create a `TabContent` component (can be inline or separate) that:
- Reads `activeTabId` from tabStore
- Renders appropriate view based on active tab type:
  - `home` → `<HomeView />`
  - `workspace` → `<ContentView workspaceId={tab.targetId} />`
  - `project` → `<ContentView workspaceId={tab.workspaceId} projectId={tab.targetId} />`

### 3. `src/renderer/components/Views/WorkspaceView.tsx`
**Change:** Rename to `ContentView.tsx` and update to accept props instead of route params.

```tsx
// Before
export function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  // ...
}

// After
interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  // Use props instead of useParams
  // ...
}
```

### 4. `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
**Change:** Replace `NavLink` navigation with tab opening.

```tsx
// Before
<NavLink to={`/workspace/${workspace.id}`} ... >

// After
<button onClick={() => openTab('workspace', workspace.id)} ... >
```

Also add visual indicator if workspace has an open tab.

### 5. `src/renderer/components/Sidebar/ProjectNavItem.tsx`
**Change:** Make clickable to open project tab.

```tsx
// Before
<div className="project-nav-item">

// After
<button
  className="project-nav-item"
  onClick={() => openTab('project', project.id, workspaceId)}
>
```

### 6. `src/renderer/router.tsx`
**Change:** Simplify routes since tabs handle workspace/project navigation.

```tsx
// Before
children: [
  { index: true, element: <HomeView /> },
  { path: 'workspace/:workspaceId', element: <WorkspaceView /> },
  { path: 'settings', element: <SettingsView /> },
]

// After
children: [
  { index: true, element: <TabContent /> },
  { path: 'settings', element: <SettingsView /> },
]
```

Or alternatively, keep the router minimal and handle everything through tabs except settings.

## Implementation Order

1. **Phase 1: Tab Store**
   - Create `tabStore.ts` with all actions
   - Add localStorage persistence
   - Write basic tests if applicable

2. **Phase 2: TabBar Component**
   - Install `@dnd-kit/core` and `@dnd-kit/sortable` if not present
   - Create `TabBar/index.tsx` and `TabItem.tsx`
   - Add styles in `TabBar.css`
   - Integrate into `AppHeader.tsx`

3. **Phase 3: Content Rendering**
   - Rename `WorkspaceView` → `ContentView`
   - Update props interface
   - Create `TabContent` component in Layout
   - Replace `<Outlet />` with `<TabContent />`

4. **Phase 4: Sidebar Integration**
   - Update `WorkspaceNavItem` to open tabs
   - Update `ProjectNavItem` to be clickable and open tabs
   - Add active tab indicators in sidebar

5. **Phase 5: Router Cleanup**
   - Simplify router configuration
   - Ensure Settings route still works
   - Handle direct URL access (optional: URL sync with active tab)

## Edge Cases to Handle

1. **Deleted workspace/project**: Close its tab if open
2. **Tab persistence**: Validate stored tabs on app start (remove invalid ones)
3. **Home tab**: Always present, cannot be closed
4. **Empty state**: If all tabs closed somehow, ensure home tab exists

## Verification

1. Click workspace in sidebar → opens new tab or focuses existing
2. Click project in sidebar → opens new tab or focuses existing
3. Click tab → switches to that tab's content
4. Close tab → removes tab, activates adjacent tab
5. Drag tab → reorders tabs
6. Restart app → tabs persist and restore
7. Navigate to Settings → shows settings (not a tab)
8. Home tab → always visible, cannot be closed

## Dependencies

May need to install:
- `@dnd-kit/core`
- `@dnd-kit/sortable`
- `@dnd-kit/utilities`

Check existing dependencies first in `package.json`.
