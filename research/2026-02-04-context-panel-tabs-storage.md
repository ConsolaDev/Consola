---
date: 2026-02-04T00:00:00-08:00
git_commit: f648fbc9ca77edb001ff5192a52d48a625fa7964
branch: feature/agent-output-rendering
repository: console-1
topic: "Context Panel Tabs and Agent-Generated File Storage Architecture"
tags: [research, codebase, context-panel, tabs, file-storage, architecture]
status: complete
---

# Research: Context Panel Tabs and Agent-Generated File Storage Architecture

**Date**: 2026-02-04
**Git Commit**: f648fbc9ca77edb001ff5192a52d48a625fa7964
**Branch**: feature/agent-output-rendering
**Repository**: console-1

## Research Question

How to implement minimalistic tabs in the context panel (using Radix Navigation Menu) to display Research, Plans, and Task tracking content, and where to store agent-generated files for consistent referencing.

## Summary

The context panel currently exists as a simple placeholder component (`ContextPlaceholder.tsx`) that only renders markdown file previews. The codebase has `@radix-ui/react-tabs` installed but unused, while custom tab implementations exist for the main tab bar. For file storage, there are two viable options: project-local (`./consola/`) or user-home global (`~/.consola/`), each with distinct tradeoffs.

## Detailed Findings

### 1. Current Context Panel Architecture

**Location**: `src/renderer/components/Views/ContextPlaceholder.tsx` (lines 1-47)

The context panel is a minimal component that:
- Receives `contextId` and optional `selectedFile` props
- Routes to `MarkdownFileView` for `.md` files
- Shows a placeholder for other file types or when no file is selected

**Current Integration**: `src/renderer/components/Views/ContentView.tsx` (lines 68-80)
```
Panel Layout:
├── AgentPanel (60% default, min 20%)
├── Separator (resize handle)
└── ContextPlaceholder (remaining space, min 20%)
```

The `contextId` is computed as:
- `project-{projectId}` for project contexts
- `workspace-{workspaceId}` for workspace contexts

### 2. Available Tab Components

**Radix UI Tabs**: `@radix-ui/react-tabs` v1.1.13 is installed but **not currently used**

**Existing Custom Tab System** (for app-level tabs):
- `src/renderer/components/TabBar/index.tsx` - Uses `@dnd-kit` for drag-and-drop
- `src/renderer/components/TabBar/TabItem.tsx` - Individual tab rendering

**Settings Modal Navigation Pattern**: `src/renderer/components/Dialogs/SettingsModal.tsx` (lines 44-56)
- Custom button-based navigation
- State-based active section switching
- CSS classes: `.settings-modal-nav-item`, `.settings-modal-nav-item.active`

### 3. Current File Storage Locations

**Research Documents**: `./research/` (project root)
- 12 files with naming pattern `YYYY-MM-DD-description.md`
- Total ~11,749 lines of documentation

**Plan Documents**: `./plans/` (project root)
- 15 files, mix of numbered (`001-`, `002-`) and dated patterns
- Total ~253,573 bytes

**Configuration**: `./.claude/` (project root)
- `settings.local.json` - Permissions and execution settings
- `skills/` - Skill definitions directory

**Application State**: Browser localStorage
- `consola-settings` - Theme preferences
- `consola-workspaces` - Workspaces and projects
- `consola-tabs` - Open tabs state
- `consola-navigation` - UI state (sidebar, expanded items)

### 4. State Management Infrastructure

The codebase uses **Zustand** (v5.0.11) with 5 stores:

| Store | Persistence | Purpose |
|-------|-------------|---------|
| `agentStore` | No | Multi-instance agent sessions |
| `workspaceStore` | Yes (localStorage) | Workspace/project data |
| `tabStore` | Yes (localStorage) | Tab management |
| `navigationStore` | Yes (localStorage) | UI state |
| `settingsStore` | Yes (localStorage) | User preferences |

**Key Pattern**: Instance ID scoping
- Tab ID: `project-{id}` or `workspace-{id}`
- Agent instance: `{tabId}-main`
- Allows parallel agent sessions per context

### 5. File Access Infrastructure

**IPC Channel**: `FILE_READ` (read-only)
- Handler: `src/main/ipc-handlers.ts:225-233`
- Uses `fs.promises.readFile()`
- Exposed via `fileBridge` service

**Missing**: File write capability is not currently exposed to renderer process.

## Architecture Documentation

### Option A: Project-Local Storage (`./consola/`)

```
project-root/
├── .consola/
│   ├── research/
│   │   └── YYYY-MM-DD-topic.md
│   ├── plans/
│   │   └── YYYY-MM-DD-feature.md
│   └── tasks/
│       └── YYYY-MM-DD-task-tracking.json
├── .claude/           (existing)
└── ... project files
```

**Pros**:
- Files are version-controlled with project
- Easy to share research/plans in PRs
- Context stays with the project
- Matches current `./research/` and `./plans/` patterns

**Cons**:
- Pollutes project directory
- May conflict with `.gitignore` preferences
- Not accessible if project not opened

### Option B: User-Home Global Storage (`~/.consola/`)

```
~/.consola/
├── projects/
│   └── {project-hash}/
│       ├── research/
│       ├── plans/
│       └── tasks/
├── workspaces/
│   └── {workspace-id}/
│       └── ... workspace-level files
└── config.json
```

**Pros**:
- Clean project directories
- Accessible across all projects
- Single location for all consola data
- Good for sensitive/draft content not ready for commits

**Cons**:
- Files not version-controlled
- Harder to share with team
- Requires project identification mechanism
- Data orphaned if project moved/renamed

### Option C: Hybrid Approach (Recommended)

```
~/.consola/                    # Global metadata & index
├── config.json
└── index/
    └── projects.json         # Maps project paths to IDs

project-root/
├── .consola/                  # Project-specific content
│   ├── research/
│   ├── plans/
│   └── tasks/
└── .claude/                   # Existing Claude config
```

**Benefits**:
- Version-controlled project content
- Global index for cross-project queries
- Existing patterns preserved
- Clear separation of concerns

### Proposed Context Panel Tab Structure

```tsx
// Using Radix UI Tabs (already installed)
<Tabs.Root defaultValue="research">
  <Tabs.List className="context-panel-tabs">
    <Tabs.Trigger value="research">Research</Tabs.Trigger>
    <Tabs.Trigger value="plans">Plans</Tabs.Trigger>
    <Tabs.Trigger value="tasks">Tasks</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="research">
    <ResearchList projectPath={cwd} />
  </Tabs.Content>
  <Tabs.Content value="plans">
    <PlansList projectPath={cwd} />
  </Tabs.Content>
  <Tabs.Content value="tasks">
    <TasksView projectPath={cwd} />
  </Tabs.Content>
</Tabs.Root>
```

### File Storage Data Model

```typescript
// Research document metadata
interface ResearchDocument {
  id: string;
  filePath: string;          // Relative to .consola/research/
  topic: string;
  date: string;              // ISO format
  gitCommit?: string;
  tags: string[];
  status: 'draft' | 'complete';
}

// Plan document metadata
interface PlanDocument {
  id: string;
  filePath: string;
  title: string;
  date: string;
  status: 'draft' | 'in-progress' | 'completed';
  linkedResearch?: string[]; // Research doc IDs
}

// Task tracking
interface TaskTracking {
  planId: string;
  tasks: Task[];
  createdAt: string;
  updatedAt: string;
}

interface Task {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed';
  linkedFiles?: string[];
}
```

### Required Infrastructure Changes

1. **File Write IPC Handler** - New `FILE_WRITE` channel for saving documents
2. **Directory List IPC Handler** - `DIR_LIST` channel to enumerate files
3. **Context Panel Store** - New Zustand store for panel state (active tab, selected document)
4. **Document Index Store** - Track all research/plans/tasks per project

## Code References

- `src/renderer/components/Views/ContextPlaceholder.tsx:1-47` - Current placeholder
- `src/renderer/components/Views/ContentView.tsx:68-80` - Panel layout
- `src/renderer/stores/agentStore.ts:85-110` - Instance state pattern
- `src/main/ipc-handlers.ts:225-233` - File read handler
- `src/renderer/services/fileBridge.ts` - File access bridge

## Open Questions

1. Should the `.consola/` folder use a different name to avoid confusion with the app name?
2. Should research/plans created via Claude Code skills continue to go to `./research/` and `./plans/` or migrate to `.consola/`?
3. How to handle workspace-level research (not tied to a specific project)?
4. Should task tracking be JSON or Markdown for better human readability?
5. What's the migration strategy for existing `./research/` and `./plans/` content?
