---
date: 2026-02-04T00:30:00+01:00
git_commit: ae6e10f2058694ac8c408c39abfbabddea26463c
branch: master
repository: consola
topic: "Tab-based Navigation System Implementation"
tags: [research, codebase, tabs, navigation, workspaces, projects]
status: complete
---

# Research: Tab-based Navigation System Implementation

**Date**: 2026-02-04
**Git Commit**: ae6e10f2058694ac8c408c39abfbabddea26463c
**Branch**: master
**Repository**: consola

## Research Question

Implement a tab-based system in the AppHeader where:
- Opening a workspace/project creates a new tab
- Selecting an already-open workspace/project switches to its existing tab
- Each tab renders the current WorkspaceView (to be renamed)
- Workspaces and projects will render the same view initially

## Summary

The codebase currently uses React Router with an `<Outlet />` pattern for rendering views. The AppHeader has a placeholder comment for the future tab bar. The implementation will require:

1. A new **tabStore** to manage open tabs
2. A **TabBar** component in AppHeader
3. Modifying navigation to open/select tabs instead of just routing
4. Renaming WorkspaceView to a more generic name (e.g., `ContentView` or `EditorView`)
5. Changing the content rendering from `<Outlet />` to tab-based content switching

## Detailed Findings

### Current AppHeader Structure

**File**: `src/renderer/components/Layout/AppHeader.tsx`

```tsx
export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
      </div>
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        {/* Future: Tab bar will go here */}
      </div>
    </header>
  );
}
```

The `app-header-content` div is where the TabBar component should be placed.

### Current Layout Structure

**File**: `src/renderer/components/Layout/index.tsx`

```tsx
export function Layout() {
  return (
    <div className="layout">
      <AppHeader />
      <div className="layout-body">
        <Sidebar />
        <main className="content-area">
          <Outlet />  {/* Currently renders routed views */}
        </main>
      </div>
    </div>
  );
}
```

The `<Outlet />` currently renders HomeView, WorkspaceView, or SettingsView based on the route.

### Current Routing Configuration

**File**: `src/renderer/router.tsx`

```tsx
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [
      { index: true, element: <HomeView /> },
      { path: 'workspace/:workspaceId', element: <WorkspaceView /> },
      { path: 'settings', element: <SettingsView /> },
    ],
  },
]);
```

### Current WorkspaceView Component

**File**: `src/renderer/components/Views/WorkspaceView.tsx`

```tsx
export function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const workspace = workspaceId ? getWorkspace(workspaceId) : undefined;

  if (!workspace) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="workspace-view">
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">{workspace.name}</h1>
      </div>
      <div className="workspace-view-content">
        <div className="workspace-placeholder">
          <p>Workspace content will appear here</p>
          <p className="workspace-placeholder-hint">
            Chat panel and context tabs coming soon
          </p>
        </div>
      </div>
    </div>
  );
}
```

### Current Data Models

**File**: `src/renderer/stores/workspaceStore.ts`

```typescript
interface Project {
  id: string;
  name: string;
  path: string;
  isGitRepo: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

interface Workspace {
  id: string;
  name: string;
  projects: Project[];
  createdAt: number;
  updatedAt: number;
}
```

### Current Sidebar Navigation

**WorkspaceNavItem** (`src/renderer/components/Sidebar/WorkspaceNavItem.tsx`):
- Uses `NavLink` to navigate to `/workspace/{workspaceId}`
- Has expand/collapse for showing projects
- Currently triggers route change on click

**ProjectNavItem** (`src/renderer/components/Sidebar/ProjectNavItem.tsx`):
- Currently display-only (not clickable for navigation)
- Shows project name and git status icon
- Has remove action

## Code References

- `src/renderer/components/Layout/AppHeader.tsx:13-15` - Tab bar placeholder location
- `src/renderer/components/Layout/index.tsx:19` - Outlet that needs to change to tab content
- `src/renderer/components/Views/WorkspaceView.tsx` - View to be renamed and reused for tabs
- `src/renderer/stores/workspaceStore.ts` - Workspace and Project data models
- `src/renderer/stores/navigationStore.ts` - Navigation UI state (expand/collapse, sidebar)
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx` - Workspace click handling
- `src/renderer/components/Sidebar/ProjectNavItem.tsx` - Project item (needs click handling)
- `src/renderer/router.tsx` - Current routing configuration

## Architecture Documentation

### Current Navigation Flow

```
User clicks workspace in Sidebar
       ↓
NavLink navigates to /workspace/{id}
       ↓
React Router renders WorkspaceView in Outlet
       ↓
WorkspaceView fetches workspace from store
       ↓
Content displayed
```

### Proposed Tab Navigation Flow

```
User clicks workspace/project in Sidebar
       ↓
Check if tab already exists in tabStore
       ↓
If exists: Set as active tab
If not: Create new tab, set as active
       ↓
TabBar re-renders with updated tabs
       ↓
Content area renders active tab's view
```

### Key Components to Create/Modify

1. **tabStore** (new) - Zustand store for tab management
   - `tabs: Tab[]` - Array of open tabs
   - `activeTabId: string | null` - Currently active tab
   - `openTab(type, id)` - Open or focus a tab
   - `closeTab(id)` - Close a tab
   - `setActiveTab(id)` - Switch to a tab

2. **Tab interface** (new)
   ```typescript
   interface Tab {
     id: string;           // Unique tab identifier
     type: 'workspace' | 'project';
     targetId: string;     // workspaceId or projectId
     workspaceId: string;  // Always needed for context
   }
   ```

3. **TabBar component** (new) - Renders in AppHeader
   - List of tab buttons
   - Close button per tab
   - Active tab highlighting

4. **Layout modification** - Replace `<Outlet />` with tab-aware content
   - Render content based on active tab
   - Keep HomeView and SettingsView as routes (or convert to special tabs)

5. **WorkspaceNavItem modification** - Open/focus tab instead of navigate
6. **ProjectNavItem modification** - Make clickable, open/focus tab
7. **WorkspaceView rename** - Rename to `ContentView` or `EditorView`

## Open Questions

1. Should Home and Settings also be tabs, or remain as routes?
2. Should tabs persist across sessions (localStorage)?
3. What happens when a workspace/project is deleted while its tab is open?
4. Should there be a maximum number of tabs?
5. Should tabs support drag-to-reorder?
6. Should there be a "close all tabs" or "close other tabs" feature?
