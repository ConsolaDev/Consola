# Workspace Projects Feature - Implementation Plan

## Overview

Add Notion-style expandable workspaces with hover actions and nested project items. Workspaces can contain multiple projects (folder paths), each with metadata. Users can expand/collapse workspaces, and both workspace and project items show action menus on hover.

## Current State Analysis

### Existing Implementation:
- **Workspace Store** (`src/renderer/stores/workspaceStore.ts:4-9`): Basic workspace with `id`, `name`, `createdAt`, `updatedAt` - no project concept
- **Navigation Store** (`src/renderer/stores/navigationStore.ts`): Persists `isSidebarCollapsed` to localStorage
- **WorkspaceNavItem** (`src/renderer/components/Sidebar/WorkspaceNavItem.tsx`): Simple NavLink with tooltip support, no expand/collapse or actions
- **IPC Pattern** (`src/main/ipc-handlers.ts`, `src/preload/preload.ts`): Uses `ipcMain.handle` for async ops, `ipcRenderer.invoke` on renderer side

### Key Discoveries:
- Radix UI `@radix-ui/react-collapsible` is already installed but unused
- Need to add `@radix-ui/react-dropdown-menu` for action menus
- Electron `dialog.showOpenDialog` available for folder picker
- CSS hover patterns exist at `styles.css:118-126`

## Desired End State

1. **Notion-style sidebar visibility**: When collapsed, sidebar is completely hidden (not icon-only). Toggle button in header (next to traffic lights) remains visible. Hover toggle to reveal sidebar as overlay. Click toggle to dock/undock.
2. Workspace items show expand/collapse chevron on left (on hover)
3. Workspace items show "..." action menu on right (on hover)
4. Expanded workspaces display nested project items
5. Project items have same hover action pattern
6. Create workspace flow includes project folder selection
7. All expand/collapse states persisted per workspace

## What We're NOT Doing

- Drag-and-drop reordering of workspaces or projects
- Renaming UI (can be added later)
- Project-level routing (clicking project doesn't navigate anywhere yet)
- Nested workspaces (workspaces within workspaces)
- Search/filter functionality

## Implementation Approach

Use Radix UI primitives for accessible collapsible and dropdown components. Extend existing Zustand stores with new state. Add Electron IPC for native folder picker.

---

## Phase 0: Notion-style Sidebar Visibility

### Overview
Change sidebar collapse behavior from "icon-only mode" to "completely hidden with hover-to-reveal overlay" like Notion. Move the toggle button to the header area next to traffic lights.

### Changes Required:

#### 1. Update Navigation Store State
**File**: `src/renderer/stores/navigationStore.ts`
**Changes**:
- Rename/repurpose `isSidebarCollapsed` to represent "sidebar hidden" state
- Add `isSidebarPinned: boolean` - whether sidebar is docked (true) or can auto-hide (false)
- Add `isSidebarHovered: boolean` - transient state for hover overlay
- Add actions:
  - `setSidebarPinned(pinned: boolean): void`
  - `setSidebarHovered(hovered: boolean): void`
- Computed: sidebar is visible when `isSidebarPinned || isSidebarHovered`
- Persist only `isSidebarPinned` (not hover state)

#### 2. Restructure Layout Component
**File**: `src/renderer/components/Layout/index.tsx`
**Changes**:
- Toggle button in header area (next to traffic lights) remains visible when sidebar is hidden
- Sidebar renders conditionally based on visibility state
- When sidebar is overlay (hovered but not pinned):
  - Position: `absolute`, `z-index: var(--z-sidebar-overlay)`
  - Content area does NOT shrink (sidebar overlaps content)
- When sidebar is pinned:
  - Position: normal flex layout
  - Content area shrinks to accommodate sidebar

#### 3. Update Layout Styles
**File**: `src/renderer/components/Layout/styles.css`
**Changes**:
- Add `.sidebar.overlay` styles:
  ```css
  .sidebar.overlay {
    position: absolute;
    left: 0;
    top: 0;
    z-index: var(--z-sidebar-overlay);
  }
  ```
- Add `.layout.sidebar-hidden .content-area` - full width when sidebar hidden
- Add `.header-toggle` - toggle button positioned in header next to traffic lights
- Add animation for sidebar slide-in/out

#### 4. Move Toggle to WorkspaceHeader (and Layout when hidden)
**File**: `src/renderer/components/Sidebar/WorkspaceHeader.tsx`
**Changes**:
- Add toggle button (PanelLeft/PanelLeftClose icon) as first element after drag region
- Position next to traffic lights (left side)
- Order: [Toggle] [Workspaces title] [+ button]
- Toggle behavior:
  - If sidebar is pinned → clicking unpins (hides sidebar)
  - If sidebar is overlay (hovered) → clicking pins it
- Hover behavior on toggle button: sets `setSidebarHovered(true)` when sidebar not pinned

**File**: `src/renderer/components/Layout/index.tsx`
**Changes**:
- Add a header toggle button in the top-left area (next to traffic lights) that is always visible
- When sidebar is hidden, this toggle is the only way to reveal it (hover or click)
- Hovering the toggle reveals sidebar as overlay
- Clicking the toggle pins/unpins the sidebar

#### 5. Remove SidebarToggle from Footer
**File**: `src/renderer/components/Sidebar/index.tsx`
**Changes**:
- Remove `<SidebarToggle />` from sidebar footer
- Keep Settings nav item in footer

#### 6. Toggle Button Hover Behavior
**File**: `src/renderer/components/Layout/index.tsx`
**Changes**:
- When sidebar is not pinned, only the header toggle button triggers hover reveal
- Header toggle button (next to traffic lights) is always visible
- Hovering the toggle button sets `setSidebarHovered(true)`
- Sidebar handles `onMouseLeave` to set hovered false (with small delay to prevent flicker)
- Only the header toggle button triggers hover reveal (no invisible hover zones)

#### 7. Update Sidebar Component
**File**: `src/renderer/components/Sidebar/index.tsx`
**Changes**:
- Remove all `isSidebarCollapsed` conditional rendering (no more icon-only mode)
- Add `onMouseLeave` handler to set `isSidebarHovered(false)` with 150ms delay
- Add className logic: `sidebar ${!isSidebarPinned ? 'overlay' : ''}`
- Always render full sidebar content (labels, workspace names, etc.)

#### 8. Update Sidebar Styles
**File**: `src/renderer/components/Sidebar/styles.css`
**Changes**:
- Remove all `.sidebar.collapsed` rules (no longer needed)
- Remove `.sidebar.collapsed .nav-item-label` hiding rules
- Add `.sidebar.overlay` positioning and shadow
- Add slide-in animation:
  ```css
  @keyframes sidebar-slide-in {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
  ```

#### 9. Update Theme Tokens
**File**: `src/renderer/styles/themes/tokens.css`
**Changes**:
- Add `--z-sidebar-overlay: 100;`
- Remove or keep `--sidebar-collapsed-width` (no longer used)

#### 10. Update Keyboard Shortcut
**File**: `src/renderer/hooks/useKeyboardShortcuts.ts`
**Changes**:
- `Cmd+\` now toggles `isSidebarPinned` instead of `isSidebarCollapsed`

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] When pinned: sidebar visible, content area shrunk
- [ ] Clicking toggle hides sidebar completely (no icons)
- [ ] Content area expands to full width when sidebar hidden
- [ ] Header toggle button (next to traffic lights) remains visible when sidebar hidden
- [ ] Hovering the header toggle reveals sidebar as overlay (over content, no shadow)
- [ ] Clicking toggle while hovering pins sidebar back
- [ ] Keyboard shortcut (Cmd+\) toggles pin state
- [ ] Pin state persists on page reload
- [ ] Hover state does NOT persist on reload
- [ ] Smooth animation on show/hide

---

## Phase 1: Data Model & Store Updates

### Overview
Extend the workspace data model to include projects and add expand/collapse state tracking.

### Changes Required:

#### 1. Project Interface & Workspace Extension
**File**: `src/renderer/stores/workspaceStore.ts`
**Changes**:
- Add `Project` interface with metadata:
  ```typescript
  export interface Project {
    id: string;
    name: string;           // Display name (folder name by default)
    path: string;           // Absolute folder path
    isGitRepo: boolean;     // Whether .git folder exists
    createdAt: number;
    lastOpenedAt: number;
  }
  ```
- Extend `Workspace` to include `projects: Project[]`
- Add store actions:
  - `addProjectToWorkspace(workspaceId: string, project: Omit<Project, 'id' | 'createdAt' | 'lastOpenedAt'>): Project`
  - `removeProjectFromWorkspace(workspaceId: string, projectId: string): void`
  - `updateProjectLastOpened(workspaceId: string, projectId: string): void`

#### 2. Expand/Collapse State in Navigation Store
**File**: `src/renderer/stores/navigationStore.ts`
**Changes**:
- Add `expandedWorkspaces: Record<string, boolean>` (workspace ID -> expanded state)
- Add actions:
  - `toggleWorkspaceExpanded(workspaceId: string): void`
  - `setWorkspaceExpanded(workspaceId: string, expanded: boolean): void`
  - `isWorkspaceExpanded(workspaceId: string): boolean` - returns `true` by default for new workspaces
- Update `partialize` to persist `expandedWorkspaces`

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] LocalStorage shows new data structures after page reload
- [ ] Existing workspaces still load correctly (migration)

---

## Phase 2: Electron IPC for Folder Picker

### Overview
Add native OS folder picker dialog with git repository detection.

### Changes Required:

#### 1. Add IPC Channels
**File**: `src/shared/constants.ts`
**Changes**:
- Add new channels:
  ```typescript
  // Dialog channels
  DIALOG_SELECT_FOLDERS: 'dialog:select-folders',  // Open folder picker
  ```

#### 2. Add IPC Handler in Main Process
**File**: `src/main/ipc-handlers.ts`
**Changes**:
- Import `dialog` from electron and `fs`, `path` from node
- Add handler for `DIALOG_SELECT_FOLDERS`:
  ```typescript
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDERS, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select Project Folders'
    });
    if (result.canceled) return [];

    // Check each folder for .git
    return result.filePaths.map(folderPath => ({
      path: folderPath,
      name: path.basename(folderPath),
      isGitRepo: fs.existsSync(path.join(folderPath, '.git'))
    }));
  });
  ```
- Add cleanup in `cleanupIpcHandlers`

#### 3. Expose in Preload
**File**: `src/preload/preload.ts`
**Changes**:
- Add new API:
  ```typescript
  contextBridge.exposeInMainWorld('dialogAPI', {
    selectFolders: (): Promise<Array<{path: string, name: string, isGitRepo: boolean}>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDERS);
    }
  });
  ```

#### 4. Add TypeScript Types
**File**: `src/renderer/types/electron.d.ts` (new file)
**Changes**:
- Declare global `window.dialogAPI` type

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Clicking a test button opens native folder picker
- [ ] Selecting multiple folders returns array with correct data
- [ ] Git repos are correctly detected

---

## Phase 3: Expand/Collapse UI (Workspace Items)

### Overview
Add chevron icon on hover (left side) with Radix Collapsible for workspace item expansion. Note: Since Phase 0 removes collapsed-sidebar icon-only mode, tooltips for nav items are no longer needed.

### Changes Required:

#### 1. Install Radix DropdownMenu
**Command**: `npm install @radix-ui/react-dropdown-menu`

#### 2. Refactor WorkspaceNavItem Component
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
**Changes**:
- Remove all tooltip logic (no longer needed after Phase 0)
- Wrap entire item in a container div with hover state
- Add expand/collapse chevron (ChevronRight/ChevronDown from lucide-react) on left
  - Only visible on hover (CSS opacity transition)
  - Replaces the FileText icon position on hover
- Use Radix `Collapsible.Root` and `Collapsible.Content` for expansion
- Connect to `navigationStore.toggleWorkspaceExpanded`
- Keep existing NavLink for workspace name (clicking name navigates)
- Clicking chevron only toggles expand (doesn't navigate)

#### 3. Simplify NavItem Component
**File**: `src/renderer/components/Sidebar/NavItem.tsx`
**Changes**:
- Remove tooltip wrapper logic (sidebar is always full-width when visible)
- Simplify to just render the NavLink directly

#### 4. Add CSS Styles for Hover Reveal
**File**: `src/renderer/components/Sidebar/styles.css`
**Changes**:
- Add `.workspace-nav-item-container` styles
- Add `.workspace-expand-toggle` styles:
  - `opacity: 0` by default
  - `opacity: 1` on container hover
  - Positioned absolute left
  - Smooth transition
- Add `.workspace-nav-item:hover .workspace-expand-toggle` rule
- Add Radix Collapsible content animation styles

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Hovering workspace shows chevron on left
- [ ] Clicking chevron expands/collapses (no navigation)
- [ ] Clicking workspace name still navigates
- [ ] Expand state persists on page reload
- [ ] Smooth animation on expand/collapse

---

## Phase 4: Actions Dropdown Menu

### Overview
Add "..." button on hover (right side) with Radix DropdownMenu for workspace actions.

### Changes Required:

#### 1. Create WorkspaceActionsMenu Component
**File**: `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx` (new)
**Changes**:
- Use Radix `DropdownMenu` primitives
- Props: `workspaceId: string`, `onDelete: () => void`
- Trigger: MoreHorizontal icon (lucide-react)
- Menu items:
  - "Delete workspace" with Trash2 icon
  - Confirmation dialog before delete (optional, can use window.confirm initially)

#### 2. Integrate into WorkspaceNavItem
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
**Changes**:
- Add `WorkspaceActionsMenu` on right side
- Only visible on hover (same pattern as chevron)
- Stop propagation on menu trigger click

#### 3. Add CSS Styles
**File**: `src/renderer/components/Sidebar/styles.css`
**Changes**:
- Add `.workspace-actions-trigger` styles (opacity on hover)
- Add dropdown menu styles (`.dropdown-content`, `.dropdown-item`)
- Destructive item styling for delete

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Hovering workspace shows "..." on right
- [ ] Clicking "..." opens dropdown menu
- [ ] Delete action removes workspace
- [ ] Menu closes on click outside
- [ ] Keyboard navigation works in menu

---

## Phase 5: Project Nav Items

### Overview
Render nested project items when workspace is expanded, with same hover/actions pattern.

### Changes Required:

#### 1. Create ProjectNavItem Component
**File**: `src/renderer/components/Sidebar/ProjectNavItem.tsx` (new)
**Changes**:
- Props: `project: Project`, `workspaceId: string`
- Display: Folder icon (or GitBranch if isGitRepo), project name
- Indented styling (nested under workspace)
- Hover shows "..." actions menu
- Click does nothing for now (future: could open in file manager or set as active)

#### 2. Create ProjectActionsMenu Component
**File**: `src/renderer/components/Sidebar/ProjectActionsMenu.tsx` (new)
**Changes**:
- Similar to WorkspaceActionsMenu
- Menu items:
  - "Remove from workspace" (doesn't delete folder, just removes reference)

#### 3. Integrate Projects into WorkspaceNavItem
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
**Changes**:
- Inside `Collapsible.Content`, map over `workspace.projects`
- Render `ProjectNavItem` for each

#### 4. Add CSS Styles
**File**: `src/renderer/components/Sidebar/styles.css`
**Changes**:
- Add `.project-nav-item` styles (indented, smaller)
- Add `.project-list` container styles

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Expanding workspace shows project list
- [ ] Projects display correct icon (folder vs git)
- [ ] Project hover shows "..." menu
- [ ] Remove action removes project from workspace

---

## Phase 6: Create Workspace Flow

### Overview
Dialog/modal to name workspace and select project folders via native picker.

### Changes Required:

#### 1. Create CreateWorkspaceDialog Component
**File**: `src/renderer/components/Dialogs/CreateWorkspaceDialog.tsx` (new)
**Changes**:
- Use Radix `Dialog` primitives (install `@radix-ui/react-dialog` if needed)
- Form with:
  - Workspace name input (default: "New Workspace")
  - "Add folders" button that calls `window.dialogAPI.selectFolders()`
  - List of selected folders with remove button
  - Cancel / Create buttons
- On create: call `createWorkspace` then `addProjectToWorkspace` for each folder

#### 2. Update WorkspaceHeader to Open Dialog
**File**: `src/renderer/components/Sidebar/WorkspaceHeader.tsx`
**Changes**:
- Replace direct `createWorkspace` call with opening dialog
- Add dialog state management

#### 3. Update Keyboard Shortcut
**File**: `src/renderer/hooks/useKeyboardShortcuts.ts`
**Changes**:
- Cmd+N opens dialog instead of creating workspace directly
- Need to expose dialog open function (context or callback)

#### 4. Add Dialog Styles
**File**: `src/renderer/components/Dialogs/styles.css` (new)
**Changes**:
- Dialog overlay styles
- Dialog content styles
- Form input styles
- Folder list styles

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Clicking "+" opens create workspace dialog
- [ ] Cmd+N opens dialog
- [ ] Can enter workspace name
- [ ] "Add folders" opens native folder picker
- [ ] Selected folders appear in list
- [ ] Can remove folders from list
- [ ] Create button creates workspace with projects
- [ ] Dialog closes and navigates to new workspace
- [ ] Cancel closes dialog without creating

---

## Testing Strategy

### Unit Tests:
- Workspace store: project CRUD operations
- Navigation store: expand/collapse state management

### Integration Tests:
- Create workspace with projects flow
- Delete workspace removes from store
- Expand/collapse persists across reloads

### Manual Testing Steps:
1. Create new workspace via dialog
2. Add 2-3 project folders
3. Verify workspace appears in sidebar
4. Expand workspace, verify projects visible
5. Collapse workspace, verify projects hidden
6. Reload page, verify expand state persisted
7. Delete a project from workspace
8. Delete entire workspace
9. Verify keyboard shortcuts work (Cmd+N)

---

## References

- Workspace Store: `src/renderer/stores/workspaceStore.ts`
- Navigation Store: `src/renderer/stores/navigationStore.ts`
- WorkspaceNavItem: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`
- WorkspaceHeader: `src/renderer/components/Sidebar/WorkspaceHeader.tsx`
- SidebarToggle: `src/renderer/components/Sidebar/SidebarToggle.tsx` (to be removed/merged)
- Sidebar: `src/renderer/components/Sidebar/index.tsx`
- Layout: `src/renderer/components/Layout/index.tsx`
- Layout Styles: `src/renderer/components/Layout/styles.css`
- Sidebar Styles: `src/renderer/components/Sidebar/styles.css`
- Theme Tokens: `src/renderer/styles/themes/tokens.css`
- IPC Handlers: `src/main/ipc-handlers.ts`
- Preload: `src/preload/preload.ts`
- Keyboard Shortcuts: `src/renderer/hooks/useKeyboardShortcuts.ts`
- Radix Collapsible: Already installed
- Radix DropdownMenu: Need to install
- Radix Dialog: Need to install
