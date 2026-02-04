# Implementation Plan: Workspace UI Foundation

## Overview

Transform the consola app from a simple terminal wrapper with Header/StatusBar layout into a Notion-inspired workspace UI with collapsible sidebar navigation and theme system support.

**Target Layout:**
```
┌──────────────────────────────────────────────────────┐
│  ┌─────────┬────────────────────────────────────┐   │
│  │ Sidebar │       Main Content Area            │   │
│  │  240px  │       (based on selection)         │   │
│  │         │                                    │   │
│  │ Icons   │       Chat / Terminal / Research   │   │
│  │ only    │       Tasks / Settings             │   │
│  │ when    │                                    │   │
│  │ collapsed│                                   │   │
│  └─────────┴────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

## Phase 1: Theme System Foundation

### 1.1 Create Settings Store with Persistence

**File:** `src/renderer/stores/settingsStore.ts`

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

interface SettingsState {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
  _setResolvedTheme: (theme: 'light' | 'dark') => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      setTheme: (theme) => set({ theme }),
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
    {
      name: 'consola-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
    }
  )
);
```

### 1.2 Create Theme CSS Files

**File:** `src/renderer/styles/themes/tokens.css`
- Spacing scale: --space-1 (4px) through --space-8 (32px)
- Typography: --font-sans, --font-mono, --font-size-xs through --font-size-lg
- Shadows: --shadow-sm, --shadow-md
- Layout: --sidebar-width (240px), --sidebar-collapsed-width (48px)

**File:** `src/renderer/styles/themes/light.css`
- Notion-inspired light palette
- --color-bg-primary: #ffffff
- --color-text-primary: rgb(55, 53, 47)
- --color-bg-hover: rgba(55, 53, 47, 0.04)

**File:** `src/renderer/styles/themes/dark.css`
- Notion-inspired dark palette
- --color-bg-primary: #191919
- --color-text-primary: rgba(255, 255, 255, 0.9)
- --color-bg-hover: rgba(255, 255, 255, 0.055)

**File:** `src/renderer/styles/themes/index.css`
- Import tokens, light, dark CSS files

### 1.3 Create useTheme Hook

**File:** `src/renderer/hooks/useTheme.ts`
- Handle system preference detection via matchMedia
- Compute resolvedTheme from theme setting
- Listen for system preference changes

### 1.4 Update Entry Point

**File:** `src/renderer/main.tsx`
- Import theme CSS files
- Create Root component reading resolvedTheme
- Pass appearance to Radix Theme component

---

## Phase 2: Navigation State & Keyboard Shortcuts

### 2.1 Create Navigation Store

**File:** `src/renderer/stores/navigationStore.ts`

```typescript
export type ViewType = 'home' | 'workspace' | 'settings';

interface NavigationState {
  isSidebarCollapsed: boolean;
  toggleSidebar: () => void;
}
```

Note: `activeView` and `selectedWorkspaceId` are now handled by React Router.

Persist: `isSidebarCollapsed` only

### 2.2 Create Workspace Store

**File:** `src/renderer/stores/workspaceStore.ts`

```typescript
interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  workspaces: Workspace[];
  createWorkspace: (name: string) => Workspace;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
}
```

Persist: Full `workspaces` array

### 2.3 Create Keyboard Shortcuts Hook

**File:** `src/renderer/hooks/useKeyboardShortcuts.ts`

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + \ | Toggle sidebar |
| Cmd/Ctrl + N | New workspace |
| Cmd/Ctrl + , | Open settings |
| Cmd/Ctrl + Shift + T | Toggle theme |

Implementation: Window event listener in useEffect, use `useNavigate()` from React Router for navigation.

---

## Phase 3: Sidebar Components

### 3.1 Install Dependencies

```bash
npm install @radix-ui/react-collapsible @radix-ui/react-tooltip lucide-react
```

### 3.2 Create Component Structure

```
src/renderer/components/
├── Layout/
│   ├── index.tsx          # Sidebar + Content wrapper
│   └── styles.css
├── Sidebar/
│   ├── index.tsx          # Sidebar container
│   ├── NavItem.tsx        # Navigation item with icon/label
│   ├── NavSection.tsx     # Collapsible section (Radix)
│   ├── WorkspaceHeader.tsx # Top area with drag region
│   ├── SidebarToggle.tsx  # Collapse/expand button
│   └── styles.css
```

### 3.3 Sidebar Component Details

**NavItem.tsx:**
- Icon (lucide-react) + label + keyboard shortcut hint
- Active state styling
- In collapsed mode: icon only + Radix Tooltip on hover

**NavSection.tsx:**
- Uses @radix-ui/react-collapsible
- Chevron rotation animation
- In collapsed mode: skip section headers, show items only

**WorkspaceHeader.tsx:**
- Height: 52px (accounts for macOS traffic lights)
- `-webkit-app-region: drag` for window dragging
- Placeholder for future workspace selector

**SidebarToggle.tsx:**
- Button at bottom of sidebar
- Shows collapse/expand icon based on state

### 3.4 Sidebar CSS

**Key styles:**
- `.sidebar { width: 240px; transition: width 0.2s ease; }`
- `.sidebar.collapsed { width: 48px; }`
- `.nav-item:hover { background: var(--color-bg-hover); }`
- `.nav-item.active { background: var(--color-bg-active); }`

---

## Phase 4: Layout Integration (Simplified & Workspace-Centric)

### 4.0 Architectural Decision: Routing

**Decision: Use React Router for workspace-based navigation**

Rationale:
- Enables deep linking to workspaces (`/workspace/:id`)
- Cleaner separation between workspace selection and content rendering
- Supports browser-like back/forward navigation
- Better state management for nested views
- Future-proof for split-pane layouts

**Install:**
```bash
npm install react-router-dom
```

### 4.1 Remove Terminal-Related Code

**Delete files:**
- `src/renderer/components/Terminal/index.tsx`
- `src/renderer/components/Terminal/styles.css`

**Remove from package.json dependencies:**
- `@xterm/xterm`
- `@xterm/addon-fit`
- `@xterm/addon-web-links`

**Remove/simplify:**
- `src/renderer/stores/terminalStore.ts` - Remove or repurpose for workspace state
- `src/renderer/hooks/useTerminal.ts` - Delete
- `src/renderer/services/terminalBridge.ts` - Delete
- `src/main/TerminalService.ts` - Keep for future, but not used in UI
- `src/preload/preload.ts` - Remove terminal API exposure (keep agent API)

### 4.2 Update Navigation Store for Workspaces

**File:** `src/renderer/stores/navigationStore.ts`

```typescript
export type ViewType = 'home' | 'workspace' | 'settings';

interface NavigationState {
  isSidebarCollapsed: boolean;
  activeView: ViewType;
  selectedWorkspaceId: string | null;

  toggleSidebar: () => void;
  setActiveView: (view: ViewType) => void;
  selectWorkspace: (id: string | null) => void;
}
```

### 4.3 Create Router Setup

**File:** `src/renderer/router.tsx`

```typescript
import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomeView } from './components/Views/HomeView';
import { WorkspaceView } from './components/Views/WorkspaceView';
import { SettingsView } from './components/Views/SettingsView';

// Use HashRouter for Electron compatibility
export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomeView /> },
      { path: 'workspace/:workspaceId', element: <WorkspaceView /> },
      { path: 'settings', element: <SettingsView /> },
    ],
  },
]);
```

### 4.4 Create Layout Component

**File:** `src/renderer/components/Layout/index.tsx`

```typescript
import { Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
```

### 4.5 Create View Components

**File:** `src/renderer/components/Views/HomeView.tsx`
- Welcome screen when no workspace selected
- "Create workspace" or "Select a workspace" prompt

**File:** `src/renderer/components/Views/WorkspaceView.tsx`
- Receives `workspaceId` from route params
- For now: Shows workspace name and placeholder content
- **Future:** Split pane layout with:
  - Left: Chat panel (conversation with Claude)
  - Right: Context tabs (Brief, Plan, Research, Tasks, Activity)

**File:** `src/renderer/components/Views/SettingsView.tsx`
- Theme selector (Light / Dark / System)
- Other app settings

### 4.6 Update Sidebar for Workspaces

**File:** `src/renderer/components/Sidebar/index.tsx`

The sidebar now shows:
1. **WorkspaceHeader** - App logo + "New Workspace" button
2. **WorkspaceList** - List of workspaces (like Notion pages)
3. **NavSection** - Settings at bottom

```typescript
export function Sidebar() {
  const { workspaces } = useWorkspaceStore();
  const { workspaceId } = useParams();

  return (
    <aside className="sidebar">
      <WorkspaceHeader />

      <nav className="workspace-list">
        {workspaces.map(ws => (
          <WorkspaceNavItem
            key={ws.id}
            workspace={ws}
            active={ws.id === workspaceId}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        <NavItem icon={<Settings />} label="Settings" to="/settings" />
        <SidebarToggle />
      </div>
    </aside>
  );
}
```

### 4.7 Update App.tsx

**File:** `src/renderer/App.tsx`

```typescript
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

export default function App() {
  useKeyboardShortcuts();

  return <RouterProvider router={router} />;
}
```

### 4.8 Remove Old Components

**Delete:**
- `src/renderer/components/Header/` (entire directory)
- `src/renderer/components/StatusBar/` (entire directory)
- `src/renderer/components/Terminal/` (entire directory)

### 4.9 Future: Split Pane Layout (Not in this phase)

When implementing the full workspace view later:

```
┌─────────────────────────────────────────────────────┐
│ Sidebar │           Workspace View                  │
│         │  ┌──────────────┬──────────────────────┐  │
│ [ws1]   │  │              │  [Brief][Plan][...]  │  │
│ [ws2] ← │  │   Chat       │                      │  │
│ [ws3]   │  │   Panel      │   Context Panel      │  │
│         │  │              │   (tabbed content)   │  │
│         │  │              │                      │  │
│─────────│  └──────────────┴──────────────────────┘  │
│ Settings│                                           │
└─────────────────────────────────────────────────────┘
```

This will use `allotment` or `react-resizable-panels` for the split.

---

## Phase 5: Global Styles Migration

### 5.1 Update global.css

**File:** `src/renderer/styles/global.css`

- Remove hardcoded dark theme values
- Use semantic tokens (--color-bg-primary, etc.)
- Keep reset styles and scrollbar styling

### 5.2 Update Component Styles

Migrate existing component CSS to use new tokens:
- `src/renderer/components/Agent/styles.css`
- `src/renderer/components/Terminal/styles.css`

---

## File Summary

### New Files
- `src/renderer/stores/settingsStore.ts` - Theme persistence
- `src/renderer/stores/navigationStore.ts` - Sidebar state
- `src/renderer/stores/workspaceStore.ts` - Workspace management
- `src/renderer/hooks/useTheme.ts` - System preference detection
- `src/renderer/hooks/useKeyboardShortcuts.ts` - Global shortcuts
- `src/renderer/router.tsx` - React Router configuration
- `src/renderer/styles/themes/tokens.css` - Design tokens
- `src/renderer/styles/themes/light.css` - Light theme
- `src/renderer/styles/themes/dark.css` - Dark theme
- `src/renderer/styles/themes/index.css` - Theme imports
- `src/renderer/components/Layout/index.tsx` - Main layout wrapper
- `src/renderer/components/Layout/styles.css`
- `src/renderer/components/Sidebar/index.tsx` - Sidebar container
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx` - Workspace list item
- `src/renderer/components/Sidebar/NavItem.tsx` - Generic nav item
- `src/renderer/components/Sidebar/WorkspaceHeader.tsx` - Top area + drag region
- `src/renderer/components/Sidebar/SidebarToggle.tsx` - Collapse button
- `src/renderer/components/Sidebar/styles.css`
- `src/renderer/components/Views/HomeView.tsx` - Welcome/empty state
- `src/renderer/components/Views/WorkspaceView.tsx` - Workspace content
- `src/renderer/components/Views/SettingsView.tsx` - App settings

### Modified Files
- `src/renderer/main.tsx` - Theme provider + RouterProvider
- `src/renderer/App.tsx` - Use router, remove old layout
- `src/renderer/styles/global.css` - Use semantic tokens
- `package.json` - Add/remove dependencies

### Deleted Files
- `src/renderer/components/Header/` (entire directory)
- `src/renderer/components/StatusBar/` (entire directory)
- `src/renderer/components/Terminal/` (entire directory)
- `src/renderer/stores/terminalStore.ts`
- `src/renderer/hooks/useTerminal.ts`
- `src/renderer/services/terminalBridge.ts`

### Dependencies to Remove (xterm)
- `@xterm/xterm`
- `@xterm/addon-fit`
- `@xterm/addon-web-links`

---

## Critical Existing Files to Keep

- `src/renderer/components/Agent/AgentPanel.tsx` - Will be used in workspace split pane (future)
- `src/renderer/stores/agentStore.ts` - Agent state management
- `src/main/ClaudeAgentService.ts` - SDK integration (keep for future)
- `src/main/window-manager.ts` - Traffic light positioning reference
- `src/preload/preload.ts` - Keep agent API, remove terminal API

---

## Verification Steps

1. **Theme switching:** Cmd+Shift+T should toggle between light/dark
2. **System preference:** Set theme to "system", change OS preference, verify app follows
3. **Sidebar collapse:** Cmd+\ should toggle sidebar, icons should show tooltips
4. **Workspace navigation:** Click workspace in sidebar, URL should change to `/workspace/:id`
5. **Create workspace:** Cmd+N or button should create new workspace
6. **Persistence:** Reload app, verify theme, sidebar state, and workspaces persist
7. **macOS dragging:** Drag window from sidebar header area
8. **Settings page:** Navigate to `/settings`, verify theme selector works

---

## Dependencies to Add

```json
{
  "react-router-dom": "^6.28.0",
  "@radix-ui/react-collapsible": "^1.1.3",
  "@radix-ui/react-tooltip": "^1.1.8",
  "lucide-react": "^0.468.0"
}
```

---

## Implementation Order

1. **Phase 1.1-1.4**: Theme system (can test toggle in console)
2. **Phase 2.1-2.3**: Navigation + workspace stores + shortcuts
3. **Phase 3.1-3.4**: Sidebar components (visual implementation)
4. **Phase 4.0-4.8**: Layout + routing + cleanup terminal code
5. **Phase 5.1-5.2**: Style migration (polish)

Each phase is independently testable before moving to the next.

---

## Future Phases (Not in this implementation)

### Split Pane Workspace View
When a workspace is selected, the main content area will be a split pane:
- **Left pane**: Chat panel (conversation with Claude using AgentPanel)
- **Right pane**: Context tabs (Brief, Plan, Research, Tasks, Activity)

This mirrors the reference UI where:
- Chat messages appear on the left
- Task details/planning appear on the right with tabbed navigation

### Libraries for Split Pane (future)
- `allotment` or `react-resizable-panels`
