---
date: 2026-02-03T00:00:00-08:00
git_commit: 91af988c53ab671aa2d7ce3f4c84eed1cc7c20ff
branch: master
repository: console-1
topic: "Workspace Feature Architecture Research"
tags: [research, codebase, workspace, navigation, split-panes, mcp-integration]
status: complete
---

# Research: Workspace Feature Architecture

**Date**: 2026-02-03
**Git Commit**: 91af988c53ab671aa2d7ce3f4c84eed1cc7c20ff
**Branch**: master
**Repository**: console-1

## Research Question

How to add workspace management, collapsible side navigation, split panes for chat/research rendering, skill/command rendering, and MCP server integration for a comprehensive Claude Code UI.

## Summary

The console-1 application is an Electron-based terminal wrapper with integrated Claude Agent SDK. The current architecture provides a solid foundation for the proposed features, with established patterns for IPC communication, state management (Zustand), and event-driven SDK integration. Key architectural gaps for workspace support include: no persistence layer, no sidebar navigation, simple vertical layout without split panes, and limited skill/command rendering beyond tool status tracking.

---

## Current Architecture Overview

### Technology Stack
| Layer | Technology | Version |
|-------|------------|---------|
| Desktop Framework | Electron | ^28.0.0 |
| UI Framework | React | ^19.2.4 |
| Component Library | Radix UI | ^3.3.0 |
| State Management | Zustand | ^5.0.11 |
| Terminal Emulation | xterm.js | ^6.0.0 |
| Agent SDK | Claude Agent SDK | ^0.2.30 |
| PTY Management | node-pty | ^1.0.0 |

### Three-Process Architecture
```
Main Process (Node.js)
├── TerminalService (PTY management)
├── ClaudeAgentService (SDK integration)
└── IPC Handlers (event forwarding)
           ↓ IPC Channels
Preload Script (contextBridge)
├── window.terminalAPI
└── window.claudeAgentAPI
           ↓ Exposed APIs
Renderer Process (React)
├── Bridges (terminalBridge, agentBridge)
├── Zustand Stores (terminalStore, agentStore)
└── React Components
```

---

## Detailed Findings

### 1. Current Layout Structure

**File**: `src/renderer/App.tsx:17-22`

The current layout is a simple vertical stack:
```
┌──────────────────────────────────┐
│  Header (32px fixed)             │
├──────────────────────────────────┤
│                                  │
│  Content Area (flex-1)           │
│  - Terminal OR AgentPanel        │
│                                  │
├──────────────────────────────────┤
│  StatusBar (36px fixed)          │
└──────────────────────────────────┘
```

**Key Points:**
- Mode-based routing (SHELL, CLAUDE, AGENT) controlled by `terminalStore.mode`
- Only ONE content view visible at a time (no split panes)
- No sidebar navigation exists
- StatusBar contains mode tabs for switching

### 2. State Management Patterns

**Terminal Store**: `src/renderer/stores/terminalStore.ts:5-34`
- Tracks: `mode`, `isConnected`, `dimensions`
- Actions: `setMode`, `switchMode`, `setDimensions`

**Agent Store**: `src/renderer/stores/agentStore.ts:29-232`
- Tracks: `sessionId`, `model`, `messages[]`, `activeTools[]`, `toolHistory[]`, `availableTools`, `mcpServers`
- Actions: `sendMessage`, `interrupt`, `clearMessages`
- Internal handlers: `_handleInit`, `_handleAssistantMessage`, `_handleToolPending`, `_handleToolComplete`, `_handleResult`, `_handleError`

**Critical Gap**: No persistence layer exists. All state is in-memory and lost on app restart.

### 3. IPC Communication Patterns

**File**: `src/shared/constants.ts:3-34`

**Established Channel Patterns:**
- Terminal: `terminal:data`, `terminal:input`, `terminal:resize`
- Mode: `mode:switch`, `mode:changed`
- Agent: `agent:start`, `agent:interrupt`, `agent:get-status`, `agent:*` events

**Reserved but Unused (Future-Ready):**
```typescript
SESSION_CREATE: 'session:create'    // Line 14
SESSION_DESTROY: 'session:destroy'  // Line 15
SESSION_LIST: 'session:list'        // Line 16
```

These reserved channels indicate multi-session support was anticipated.

### 4. Claude Agent SDK Integration

**File**: `src/main/ClaudeAgentService.ts`

**Key Integration Points:**
- Dynamic ESM import for SDK (lines 76-86)
- Async iterator for message streaming (line 156)
- Hook system for tool lifecycle:
  - `PreToolUse`: Emits before tool execution (lines 122-129)
  - `PostToolUse`: Emits after with response (lines 131-139)
  - `Notification`: Agent notifications (lines 141-149)

**SDK Configuration Options** (`src/shared/types.ts:87-93`):
```typescript
interface AgentQueryOptions {
  prompt: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;      // Session resume
  continue?: boolean;   // Continue previous
}
```

**MCP Server Support**: The SDK already provides MCP server information in `init` events:
```typescript
// src/main/ClaudeAgentService.ts:175-180
availableTools: message.tools,
mcpServers: message.mcp_servers.map(s => ({
  name: s.name,
  status: s.status
}))
```

### 5. UI Component Architecture

**Component Hierarchy:**
```
App.tsx
├── Header/index.tsx (32px, window drag area)
├── Content (conditional)
│   ├── Terminal/index.tsx (xterm.js wrapper)
│   └── Agent/
│       ├── AgentPanel.tsx (main chat container)
│       ├── ChatMessage.tsx (message bubbles)
│       ├── ChatInput.tsx (input with send/stop)
│       └── ToolStatus.tsx (active tool display)
└── StatusBar/index.tsx (tabs, dimensions)
```

**Styling Approach:**
- Radix UI Theme with dark appearance, cyan accent
- CSS custom properties for theming (`--bg-primary`, `--accent-shell`, etc.)
- Component-scoped CSS files alongside components

### 6. File System Access Patterns

**Current Implementation:**
- Working directory passed to services (`process.cwd()`)
- No direct file system operations in renderer
- TerminalService spawns PTY with cwd option

**Main Process File Access** (for new persistence):
- Node.js `fs` module available
- Could use `electron-store` or plain JSON files
- Recommended location: `app.getPath('userData')` for cross-platform support

---

## Architecture Recommendations for Workspace Feature

### A. Workspace Data Model

```typescript
// Proposed: src/shared/types/workspace.ts
interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  projects: Project[];
  settings: WorkspaceSettings;
}

interface Project {
  id: string;
  name: string;
  path: string;          // Folder path (future repo)
  claudeConfig?: string; // Path to .claude config
  lastOpened: number;
}

interface WorkspaceSettings {
  defaultModel?: string;
  allowedTools?: string[];
  mcpServers?: MCPServerConfig[];
}
```

### B. Persistence Layer

**Recommended: JSON File Storage**

```typescript
// Proposed: src/main/WorkspaceService.ts
class WorkspaceService extends EventEmitter {
  private storagePath: string;
  private workspaces: Map<string, Workspace>;

  constructor() {
    this.storagePath = path.join(
      app.getPath('userData'),
      'workspaces.json'
    );
  }

  async loadWorkspaces(): Promise<Workspace[]>
  async saveWorkspace(workspace: Workspace): Promise<void>
  async deleteWorkspace(id: string): Promise<void>
}
```

**IPC Channels (extending reserved patterns):**
```typescript
WORKSPACE_LIST: 'workspace:list'
WORKSPACE_CREATE: 'workspace:create'
WORKSPACE_UPDATE: 'workspace:update'
WORKSPACE_DELETE: 'workspace:delete'
WORKSPACE_SELECT: 'workspace:select'
PROJECT_ADD: 'project:add'
PROJECT_REMOVE: 'project:remove'
PROJECT_SELECT: 'project:select'
```

### C. Collapsible Side Navigation

**Recommended Library**: Radix UI already included - use `@radix-ui/react-collapsible`

**Proposed Layout:**
```
┌─────────────────────────────────────────────┐
│  Header (32px)                              │
├──────┬──────────────────────────────────────┤
│      │                                      │
│  S   │  Split Pane Container                │
│  i   │  ┌──────────────┬──────────────────┐ │
│  d   │  │  Chat/       │  Research/       │ │
│  e   │  │  Prompting   │  Tasks/          │ │
│  b   │  │  Pane        │  Output Pane     │ │
│  a   │  │              │                  │ │
│  r   │  └──────────────┴──────────────────┘ │
│      │                                      │
├──────┴──────────────────────────────────────┤
│  StatusBar (36px)                           │
└─────────────────────────────────────────────┘
```

**Sidebar Component Structure:**
```typescript
// Proposed: src/renderer/components/Sidebar/index.tsx
<Sidebar collapsed={isCollapsed}>
  <WorkspaceSelector
    workspaces={workspaces}
    current={currentWorkspace}
    onSelect={selectWorkspace}
  />
  <Collapsible>
    <ProjectList projects={currentWorkspace.projects} />
  </Collapsible>
  <Collapsible>
    <SkillsList skills={availableSkills} />
  </Collapsible>
  <Collapsible>
    <MCPServerList servers={mcpServers} />
  </Collapsible>
</Sidebar>
```

### D. Split Pane Implementation

**Recommended Libraries:**
1. `allotment` - Modern, lightweight, good TypeScript support
2. `react-split-pane` - Mature, widely used
3. `react-resizable-panels` - From Radix creator, minimal bundle

**Proposed Split Pane Structure:**
```typescript
// Proposed: src/renderer/components/SplitPane/index.tsx
<Allotment defaultSizes={[60, 40]}>
  <Allotment.Pane minSize={300}>
    <ChatPane project={currentProject} />
  </Allotment.Pane>
  <Allotment.Pane minSize={200}>
    <ContextPane
      mode={contextMode} // 'research' | 'tasks' | 'skills' | 'terminal'
      project={currentProject}
    />
  </Allotment.Pane>
</Allotment>
```

### E. Skills/Commands Rendering

**Existing Foundation:**
- Tool tracking in agentStore: `activeTools[]`, `toolHistory[]`
- ToolStatus component shows running tools

**Extension for Skills:**
```typescript
// Proposed: src/renderer/components/SkillPanel/index.tsx
interface Skill {
  name: string;
  description: string;
  command: string;      // e.g., "/research-codebase"
  isBuiltIn: boolean;
  path?: string;        // Custom skill location
}

// Render available skills from:
// 1. Built-in Claude Code commands
// 2. .claude/skills/ directory
// 3. MCP server capabilities
```

### F. MCP Server Integration UI

**Current State:** SDK provides `mcpServers` in init event (name, status only)

**Required Extensions:**
```typescript
// Proposed: src/shared/types/mcp.ts
interface MCPServerConfig {
  name: string;
  type: 'notion' | 'linear' | 'jira' | 'custom';
  endpoint?: string;
  authConfig?: {
    type: 'oauth' | 'api_key';
    // Stored securely in keychain via electron-keytar
  };
}

// Proposed IPC channels
MCP_CONNECT: 'mcp:connect'
MCP_DISCONNECT: 'mcp:disconnect'
MCP_LIST: 'mcp:list'
MCP_STATUS: 'mcp:status'
```

### G. Task Breakdown Visualization

**From AgentStore** (`src/renderer/stores/agentStore.ts`):
- `activeTools[]` - Currently executing tools
- `toolHistory[]` - Completed tool executions

**Enhancement for Task Tracking:**
```typescript
// Proposed: src/renderer/components/TasksPanel/index.tsx
interface TaskVisualization {
  // Group tool executions into logical tasks
  // Parse TaskCreate/TaskUpdate tool calls from SDK
  // Render hierarchical task breakdown
}

// SDK message parsing for task tools:
// - tool_name: 'TaskCreate' → New task node
// - tool_name: 'TaskUpdate' → Update task status
// - tool_name: 'TaskList' → Refresh task tree
```

---

## Code References

### Current Implementation Files
- `src/main/index.ts:14-16` - App initialization
- `src/main/window-manager.ts:6-37` - BrowserWindow creation
- `src/main/ipc-handlers.ts:13-186` - IPC handler setup
- `src/main/TerminalService.ts:51-67` - Mode switching
- `src/main/ClaudeAgentService.ts:102-167` - Query execution
- `src/preload/preload.ts:74-204` - Context bridge APIs
- `src/renderer/App.tsx:17-22` - Root layout
- `src/renderer/stores/terminalStore.ts:18-34` - Terminal state
- `src/renderer/stores/agentStore.ts:92-232` - Agent state
- `src/renderer/components/Agent/AgentPanel.tsx:8-81` - Chat UI
- `src/renderer/components/StatusBar/index.tsx:7-38` - Mode tabs
- `src/shared/constants.ts:14-16` - Reserved session channels

### Styling References
- `src/renderer/styles/global.css:1-10` - CSS variables
- `src/renderer/components/Agent/styles.css:1-178` - Chat styling
- `src/renderer/components/StatusBar/styles.css:1-78` - Tab styling

---

## Implementation Priority Roadmap

Given user priority of **Workspace + Navigation**:

### Phase 1: Foundation
1. Create `WorkspaceService` in main process
2. Add workspace persistence (JSON file)
3. Create workspace IPC channels
4. Add workspace Zustand store

### Phase 2: Navigation
1. Implement collapsible Sidebar component
2. Add WorkspaceSelector component
3. Add ProjectList component
4. Integrate with App.tsx layout

### Phase 3: Split Panes
1. Add `allotment` or similar library
2. Create SplitPane wrapper component
3. Implement ChatPane (enhanced AgentPanel)
4. Implement ContextPane (research/tasks/skills views)

### Phase 4: Context-Aware Features
1. Task visualization from tool executions
2. Research document rendering
3. Skills browser with execution
4. MCP server status panel

### Phase 5: MCP Integration
1. MCP configuration UI
2. Service connection management
3. Linear/Notion task sync
4. Documentation rendering

---

## Open Questions

1. **Workspace Sharing**: Should workspaces be exportable/importable for team collaboration?
2. **Project Git Integration**: Should projects auto-detect git repos and show status?
3. **Claude Config Inheritance**: How should workspace settings merge with project-level .claude configs?
4. **Session Recovery**: Should agent sessions persist across workspace switches?
5. **MCP Auth Storage**: Use system keychain (electron-keytar) or encrypted local storage?

---

## Follow-up Research: 2026-02-03

### Updated Requirements

User clarified the UI layout requirements:

1. **No Header or StatusBar** - Remove both components entirely
2. **Simple Two-Panel Layout** - Left sidebar + main content area only
3. **Notion-Inspired Aesthetics** - Clean, minimal, focused on content
4. **Theme System from Day One** - Design tokens that support light/dark and custom themes

---

### Revised Layout Architecture

**Target Layout:**
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ┌─────────┬────────────────────────────────────┐   │
│  │         │                                    │   │
│  │  Side   │       Main Content Area            │   │
│  │  bar    │       (based on selection)         │   │
│  │         │                                    │   │
│  │  240px  │       flex-1                       │   │
│  │         │                                    │   │
│  │         │                                    │   │
│  └─────────┴────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Key Differences from Original Proposal:**
- Window drag region moves to sidebar top area (macOS) or custom title bar area
- No fixed header/footer stealing vertical space
- Content area spans full height for immersive experience
- Sidebar width similar to Notion (~240px, resizable)

---

### Notion Design Principles to Follow

Based on Notion's UI patterns:

#### 1. Visual Hierarchy Through Typography (Not Borders)
- Minimal use of borders and dividers
- Rely on spacing, font weight, and subtle color differences
- Large, readable text with generous line height

#### 2. Muted Color Palette
- Backgrounds: Very subtle gray tones, almost white in light mode
- Text: Not pure black, use `rgb(55, 53, 47)` style muted blacks
- Accents: Subtle, desaturated colors for interactive elements
- Hover states: Light background fills, not border changes

#### 3. Sidebar Patterns
- Collapsible sections with rotation chevrons
- Hover-to-reveal action buttons
- Drag handles for reordering (appears on hover)
- Subtle indentation for hierarchy
- Icons: Simple, monochrome, consistent stroke width

#### 4. Whitespace and Density
- Generous padding in content areas
- Tighter spacing in sidebar for density
- Content area: ~40-60px horizontal padding
- Sidebar items: ~8-12px vertical padding

#### 5. Interactive Feedback
- Subtle hover backgrounds (2-4% opacity change)
- Smooth transitions (150-200ms)
- No jarring color changes
- Focus rings: Subtle, using accent color at low opacity

---

### Theme System Architecture

**Recommended Approach: CSS Custom Properties with Theme Provider**

#### A. Design Token Structure

```typescript
// src/renderer/styles/tokens.ts
export const tokens = {
  colors: {
    // Semantic tokens (theme-aware)
    background: {
      primary: 'var(--color-bg-primary)',
      secondary: 'var(--color-bg-secondary)',
      tertiary: 'var(--color-bg-tertiary)',
      hover: 'var(--color-bg-hover)',
      active: 'var(--color-bg-active)',
    },
    text: {
      primary: 'var(--color-text-primary)',
      secondary: 'var(--color-text-secondary)',
      tertiary: 'var(--color-text-tertiary)',
      inverse: 'var(--color-text-inverse)',
    },
    border: {
      default: 'var(--color-border-default)',
      subtle: 'var(--color-border-subtle)',
    },
    accent: {
      primary: 'var(--color-accent-primary)',
      primaryHover: 'var(--color-accent-primary-hover)',
      secondary: 'var(--color-accent-secondary)',
    },
    status: {
      success: 'var(--color-status-success)',
      warning: 'var(--color-status-warning)',
      error: 'var(--color-status-error)',
      info: 'var(--color-status-info)',
    },
  },
  spacing: {
    xxs: '2px',
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
    xxxl: '48px',
  },
  typography: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      mono: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    },
    fontSize: {
      xs: '11px',
      sm: '12px',
      base: '14px',
      lg: '16px',
      xl: '18px',
      xxl: '24px',
      xxxl: '32px',
    },
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      tight: '1.25',
      normal: '1.5',
      relaxed: '1.75',
    },
  },
  radius: {
    sm: '3px',
    md: '6px',
    lg: '8px',
    full: '9999px',
  },
  shadow: {
    sm: 'var(--shadow-sm)',
    md: 'var(--shadow-md)',
    lg: 'var(--shadow-lg)',
  },
  transition: {
    fast: '100ms ease',
    normal: '150ms ease',
    slow: '250ms ease',
  },
  layout: {
    sidebarWidth: '240px',
    sidebarCollapsedWidth: '48px',
    contentMaxWidth: '900px',
    contentPadding: '48px',
  },
} as const;
```

#### B. Theme Definitions

```css
/* src/renderer/styles/themes/light.css */
:root[data-theme="light"] {
  /* Backgrounds - Notion-inspired warm grays */
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #fbfbfa;
  --color-bg-tertiary: #f7f6f3;
  --color-bg-hover: rgba(55, 53, 47, 0.04);
  --color-bg-active: rgba(55, 53, 47, 0.08);

  /* Text - Muted, not pure black */
  --color-text-primary: rgb(55, 53, 47);
  --color-text-secondary: rgba(55, 53, 47, 0.65);
  --color-text-tertiary: rgba(55, 53, 47, 0.45);
  --color-text-inverse: #ffffff;

  /* Borders - Very subtle */
  --color-border-default: rgba(55, 53, 47, 0.09);
  --color-border-subtle: rgba(55, 53, 47, 0.04);

  /* Accent - Can be customized per workspace */
  --color-accent-primary: #2383e2;
  --color-accent-primary-hover: #1a6dbe;
  --color-accent-secondary: #eb5757;

  /* Status */
  --color-status-success: #0f7b6c;
  --color-status-warning: #d9730d;
  --color-status-error: #e03e3e;
  --color-status-info: #2383e2;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.04), 0 0 1px rgba(0, 0, 0, 0.04);
  --shadow-lg: 0 8px 16px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.04);
}

/* src/renderer/styles/themes/dark.css */
:root[data-theme="dark"] {
  /* Backgrounds - Rich dark grays */
  --color-bg-primary: #191919;
  --color-bg-secondary: #202020;
  --color-bg-tertiary: #2f2f2f;
  --color-bg-hover: rgba(255, 255, 255, 0.055);
  --color-bg-active: rgba(255, 255, 255, 0.09);

  /* Text */
  --color-text-primary: rgba(255, 255, 255, 0.9);
  --color-text-secondary: rgba(255, 255, 255, 0.6);
  --color-text-tertiary: rgba(255, 255, 255, 0.4);
  --color-text-inverse: #191919;

  /* Borders */
  --color-border-default: rgba(255, 255, 255, 0.09);
  --color-border-subtle: rgba(255, 255, 255, 0.04);

  /* Accent */
  --color-accent-primary: #529cca;
  --color-accent-primary-hover: #6aaddb;
  --color-accent-secondary: #ff7369;

  /* Status */
  --color-status-success: #4dab9a;
  --color-status-warning: #ffa344;
  --color-status-error: #ff7369;
  --color-status-info: #529cca;

  /* Shadows - More subtle in dark mode */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.2), 0 0 1px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 8px 16px rgba(0, 0, 0, 0.3), 0 0 1px rgba(0, 0, 0, 0.3);
}
```

#### C. Theme Provider Component

```typescript
// src/renderer/providers/ThemeProvider.tsx
import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const systemTheme = mediaQuery.matches ? 'dark' : 'light';
      setResolvedTheme(systemTheme);
      root.setAttribute('data-theme', systemTheme);

      const handler = (e: MediaQueryListEvent) => {
        const newTheme = e.matches ? 'dark' : 'light';
        setResolvedTheme(newTheme);
        root.setAttribute('data-theme', newTheme);
      };

      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    } else {
      setResolvedTheme(theme);
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
};
```

#### D. Theme-Aware Store (Persist Selection)

```typescript
// src/renderer/stores/settingsStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  theme: 'light' | 'dark' | 'system';
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarCollapsed: false,
      sidebarWidth: 240,
      setTheme: (theme) => set({ theme }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: 'console-settings',
    }
  )
);
```

---

### Revised Component Architecture

```
src/renderer/
├── styles/
│   ├── tokens.ts              # Design token definitions
│   ├── global.css             # Base styles + resets
│   └── themes/
│       ├── light.css          # Light theme variables
│       └── dark.css           # Dark theme variables
├── providers/
│   └── ThemeProvider.tsx      # Theme context + system detection
├── stores/
│   ├── settingsStore.ts       # Theme + UI preferences (persisted)
│   ├── workspaceStore.ts      # Workspace + project state
│   ├── navigationStore.ts     # Current view/selection state
│   └── agentStore.ts          # Existing agent state
├── components/
│   ├── Layout/
│   │   └── AppShell.tsx       # Main layout (sidebar + content)
│   ├── Sidebar/
│   │   ├── index.tsx          # Sidebar container
│   │   ├── WorkspaceHeader.tsx # Workspace name + switcher
│   │   ├── NavSection.tsx     # Collapsible section wrapper
│   │   ├── NavItem.tsx        # Individual navigation item
│   │   ├── ProjectList.tsx    # Project tree/list
│   │   └── styles.css
│   ├── Content/
│   │   ├── ContentArea.tsx    # Dynamic content renderer
│   │   ├── WelcomeView.tsx    # Initial/empty state
│   │   ├── ChatView.tsx       # Agent conversation (renamed AgentPanel)
│   │   ├── TerminalView.tsx   # Terminal wrapper
│   │   ├── ResearchView.tsx   # Research documents
│   │   ├── TasksView.tsx      # Task breakdown
│   │   └── SettingsView.tsx   # App settings
│   └── common/
│       ├── Icon.tsx           # SVG icon component
│       ├── Button.tsx         # Theme-aware button
│       ├── Input.tsx          # Theme-aware input
│       └── Tooltip.tsx        # Tooltip component
└── App.tsx                    # Root with providers
```

---

### Revised App.tsx Structure

```typescript
// src/renderer/App.tsx
import { ThemeProvider } from './providers/ThemeProvider';
import { AppShell } from './components/Layout/AppShell';
import './styles/themes/light.css';
import './styles/themes/dark.css';
import './styles/global.css';

export function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
```

```typescript
// src/renderer/components/Layout/AppShell.tsx
import { Sidebar } from '../Sidebar';
import { ContentArea } from '../Content/ContentArea';
import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <Sidebar />
      <main className={styles.content}>
        <ContentArea />
      </main>
    </div>
  );
}
```

```css
/* src/renderer/components/Layout/AppShell.module.css */
.shell {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
}

.content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

---

### Migration Path

**Files to Remove:**
- `src/renderer/components/Header/` (entire directory)
- `src/renderer/components/StatusBar/` (entire directory)

**Files to Significantly Modify:**
- `src/renderer/App.tsx` - Complete rewrite with new structure
- `src/renderer/main.tsx` - Remove Radix Theme wrapper, add ThemeProvider
- `src/renderer/styles/global.css` - Replace with token-based system

**Files to Create:**
- Theme system files (tokens, themes, provider)
- Sidebar component tree
- Content views
- Settings store with persistence

**Radix UI Usage:**
- Keep: `@radix-ui/react-collapsible` for sidebar sections
- Keep: `@radix-ui/react-tooltip` for tooltips
- Remove: `@radix-ui/themes` - replace with custom theme system
- Consider: `@radix-ui/react-dropdown-menu` for workspace switcher

---

### Revised Implementation Priority

#### Phase 1: Theme Foundation
1. Create design token system (`tokens.ts`)
2. Create light and dark theme CSS files
3. Implement ThemeProvider with system detection
4. Create settingsStore with persistence
5. Update `main.tsx` and `App.tsx` with new structure

#### Phase 2: Layout Shell
1. Create AppShell component (sidebar + content)
2. Implement basic Sidebar container
3. Create ContentArea with view switching
4. Handle window dragging for Electron (macOS)

#### Phase 3: Sidebar Navigation
1. WorkspaceHeader with workspace name
2. NavSection for collapsible sections
3. NavItem for individual items
4. Integrate with navigationStore

#### Phase 4: Content Views
1. Migrate AgentPanel → ChatView
2. Migrate Terminal → TerminalView
3. Create placeholder views (Research, Tasks, Settings)

#### Phase 5: Workspace Persistence
1. WorkspaceService in main process
2. workspaceStore in renderer
3. IPC channels for CRUD
4. Project management UI

---

### Open Questions (Updated)

1. ~~Header/StatusBar removal~~ → **Confirmed: Remove both**
2. ~~Theme approach~~ → **Confirmed: CSS variables with light/dark from start**
3. ~~Sidebar resize~~ → **Confirmed: Not for now (fixed width)**
4. ~~Sidebar collapse~~ → **Confirmed: Collapse to icon-only (VS Code style)**
5. **Window controls**: Where should macOS traffic lights appear? (Sidebar top suggested)
6. ~~Keyboard shortcuts~~ → **Confirmed: Yes - sidebar toggle, theme switch, view navigation**
