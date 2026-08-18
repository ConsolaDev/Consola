---
date: 2026-02-09T12:00:00-08:00
git_commit: c5ab30d4949cb4b4c2a0b063b4c46416c4922c2a
branch: main
repository: Consola
topic: "Plugin Management Feature - Navigation, Claude Code Plugin System, and Architecture"
tags: [research, codebase, plugins, marketplace, navigation, sdk, mcp]
status: complete
---

# Research: Plugin Management Feature

**Date**: 2026-02-09
**Git Commit**: c5ab30d4949cb4b4c2a0b063b4c46416c4922c2a
**Branch**: main
**Repository**: Consola

## Research Question

Research the codebase for a new feature that allows users to manage Claude Code plugins directly from the main navigation menu (right below the Home icon). The feature should replicate and extend the Claude Code TUI plugin operations, allowing users to manage marketplaces/plugins and their content, discover new ones, and add them directly in the UI.

## Summary

This research covers three domains: (1) the existing Consola sidebar navigation structure and how a "Plugins" nav item would fit, (2) the complete Claude Code TUI plugin system (commands, configuration, marketplace model, plugin schema), and (3) the existing SDK integration that already surfaces plugin/skill data. The app already has foundations — the `agentStore` tracks `plugins`, `skills`, and `slashCommands` per instance, and the SDK exposes `SdkPluginConfig` and MCP server management APIs. However, there is no UI for managing plugins outside of the agent chat. The Claude Code CLI has a rich `/plugin` command system with Discover, Installed, Marketplaces, and Errors tabs that serves as the reference implementation.

---

## Part 1: Current Sidebar Navigation Architecture

### Sidebar Structure

**File**: `src/renderer/components/Sidebar/index.tsx` (82 lines)

The sidebar has three distinct zones:

```
<aside className="sidebar">
  ┌─────────────────────────────┐
  │ sidebar-nav (top)           │  ← NavItem: Home icon
  ├─────────────────────────────┤
  │ sidebar-section (middle)    │  ← "Workspaces" header + workspace list
  │  • Workspace 1              │     (scrollable, flex: 1)
  │    └ Session 1              │
  │    └ Session 2              │
  │  • Workspace 2              │
  │    └ Session 1              │
  ├─────────────────────────────┤
  │ sidebar-footer              │  ← Settings button
  └─────────────────────────────┘
```

### NavItem Component

**File**: `src/renderer/components/Sidebar/NavItem.tsx` (25 lines)

Currently only used for the "Home" button. It accepts `icon`, `label`, `onClick`, and optional `shortcut`. The `isActive` state is determined by checking if `activeWorkspaceId === null` — meaning it's always active when no workspace is selected.

**Key observation**: The NavItem's active state logic is hardcoded to `activeWorkspaceId === null`. For a "Plugins" nav item, this would need to support a more flexible active-state mechanism (e.g., a dedicated `activeNavItem` in the navigation store, or a new `activeView` concept).

### Navigation Store

**File**: `src/renderer/stores/navigationStore.ts` (67 lines)

Current state:
```typescript
{
  isSidebarHidden: boolean;
  isExplorerVisible: boolean;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  expandedWorkspaces: Record<string, boolean>;
}
```

The store currently only tracks workspace/session navigation. There is no concept of a "view" or "page" beyond workspace selection. Setting `activeWorkspaceId` to `null` shows the `HomeView`.

### MainContent Routing

**File**: `src/renderer/components/Layout/MainContent.tsx` (28 lines)

Routes content based on navigation state:
- No `activeWorkspaceId` → renders `HomeView`
- `activeWorkspaceId` but no `activeSessionId` → renders `NewSessionView`
- Both set → renders `ContentView`

A "Plugins" view would require a new routing condition in MainContent.

### HomeView

**File**: `src/renderer/components/Views/HomeView.tsx` (43 lines)

Currently a simple welcome screen with a "New Workspace" button. This is visible when clicking "Home" in the sidebar.

---

## Part 2: Claude Code TUI Plugin System (Complete Reference)

### 2.1 The `/plugin` Command - Interactive TUI

The `/plugin` command in Claude Code opens a **tabbed interface** with four tabs:

| Tab | Purpose |
|-----|---------|
| **Discover** | Browse available plugins from all added marketplaces |
| **Installed** | View and manage installed plugins (enable/disable/uninstall) |
| **Marketplaces** | Add, remove, update marketplace sources |
| **Errors** | View plugin loading errors |

Navigation between tabs uses `Tab`/`Shift+Tab`. Within each tab, users can type to filter/search.

### 2.2 CLI Commands (non-interactive)

```bash
# Plugin CRUD
claude plugin install <plugin-name>@<marketplace-name> [--scope user|project|local]
claude plugin uninstall <plugin-name>@<marketplace-name> [--scope ...]
claude plugin enable <plugin-name>@<marketplace-name> [--scope ...]
claude plugin disable <plugin-name>@<marketplace-name> [--scope ...]
claude plugin update <plugin-name>@<marketplace-name> [--scope managed]
claude plugin validate .

# Marketplace Management
claude plugin marketplace add <source>
claude plugin marketplace list
claude plugin marketplace update <name>
claude plugin marketplace remove <name>
```

### 2.3 Configuration Files

Plugin state is stored across a multi-scope settings hierarchy:

| Scope | File Path | Use Case |
|-------|-----------|----------|
| **User** | `~/.claude/settings.json` | Personal plugins, all projects (default) |
| **Project** | `.claude/settings.json` | Team plugins, shared via VCS |
| **Local** | `.claude/settings.local.json` | Per-machine project plugins, gitignored |
| **Managed** | Platform-specific (see below) | Admin-enforced (read-only) |

Managed settings locations:
- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Linux/WSL: `/etc/claude-code/managed-settings.json`

### 2.4 Settings File Schema (Plugin-Related Fields)

```json
{
  "enabledPlugins": {
    "code-formatter@company-tools": true,
    "deployment-tools@company-tools": true,
    "experimental-features@personal": false
  },
  "extraKnownMarketplaces": {
    "company-tools": {
      "source": {
        "source": "github",
        "repo": "acme-corp/claude-plugins"
      }
    }
  }
}
```

- **`enabledPlugins`**: Map of `"plugin-name@marketplace-name": boolean`. Controls active state.
- **`extraKnownMarketplaces`**: Defines auto-suggested marketplaces for team members (in project settings).
- **`strictKnownMarketplaces`** (managed only): Organizational policy restricting allowed marketplaces.

### 2.5 Plugin Cache

Installed plugins are cached at `~/.claude/plugins/cache`. Plugins are copied there for security (not used in-place).

### 2.6 Marketplace Concept

A **marketplace** is a catalog of plugins — a git repository (or URL) containing `.claude-plugin/marketplace.json`.

**Official Marketplaces:**
1. **`claude-plugins-official`** — Auto-available, maintained by Anthropic. Contains 40+ plugins (LSP servers, integrations, dev tools).
2. **`claude-code-plugins`** (demo) — Manually added. Contains example/demo plugins.

**Marketplace Sources:**

| Source Type | Example |
|-------------|---------|
| GitHub `owner/repo` | `anthropics/claude-code` |
| Git URL (HTTPS/SSH) | `https://gitlab.com/company/plugins.git` |
| Git URL with ref | `https://gitlab.com/company/plugins.git#v1.0.0` |
| Local directory | `./my-marketplace` |
| Direct file path | `./path/to/marketplace.json` |
| Remote URL | `https://example.com/marketplace.json` |

### 2.7 marketplace.json Schema

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "company-tools",
  "description": "Brief marketplace description",
  "version": "1.0.0",
  "owner": {
    "name": "DevTools Team",
    "email": "devtools@example.com"
  },
  "metadata": {
    "description": "...",
    "version": "1.0.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "code-formatter",
      "source": "./plugins/formatter",
      "description": "Automatic code formatting on save",
      "version": "2.1.0",
      "author": { "name": "DevTools Team" },
      "homepage": "https://docs.example.com",
      "repository": "https://github.com/user/plugin",
      "license": "MIT",
      "keywords": ["formatting", "lint"],
      "category": "productivity",
      "tags": ["community-managed"],
      "strict": true,
      "commands": ["./commands/"],
      "agents": ["./agents/reviewer.md"],
      "hooks": { ... },
      "mcpServers": { ... },
      "lspServers": { ... }
    }
  ]
}
```

Required fields: `name`, `owner.name`, `plugins` array.

### 2.8 Plugin Structure (plugin.json Schema)

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── commands/                # Slash commands (.md files)
├── skills/                  # Agent skills (SKILL.md directories)
├── agents/                  # Subagent definitions (.md files)
├── hooks/
│   └── hooks.json           # Lifecycle hooks
├── .mcp.json                # MCP server definitions
├── .lsp.json                # LSP server configs
└── scripts/                 # Hook/utility scripts
```

```json
// plugin.json
{
  "name": "plugin-name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": { "name": "Author Name", "email": "...", "url": "..." },
  "homepage": "https://...",
  "repository": "https://...",
  "license": "MIT",
  "keywords": ["keyword1"],
  "commands": ["./custom/commands/special.md"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "lspServers": "./.lsp.json"
}
```

### 2.9 Plugin Component Types

| Component | Location | Purpose |
|-----------|----------|---------|
| **Skills** (commands/) | `.md` files in `commands/` | Invoked as `/plugin-name:command-name` |
| **Skills** (skills/) | Directories with `SKILL.md` | Auto-invoked by context matching |
| **Agents** | `.md` files in `agents/` | Specialized subagents |
| **Hooks** | `hooks/hooks.json` | Lifecycle event handlers (PreToolUse, PostToolUse, etc.) |
| **MCP Servers** | `.mcp.json` | Model Context Protocol tools |
| **LSP Servers** | `.lsp.json` | Language Server Protocol configs |

### 2.10 Installation Scopes

| Scope | Settings File | Behavior |
|-------|---------------|----------|
| `user` (default) | `~/.claude/settings.json` | Personal, all projects |
| `project` | `.claude/settings.json` | Shared via VCS |
| `local` | `.claude/settings.local.json` | Personal, this project, gitignored |
| `managed` | system-level file | Admin-enforced, read-only |

### 2.11 Official Plugin Listing (from `claude-plugins-official`)

**LSP/Code Intelligence (11):** typescript-lsp, pyright-lsp, gopls-lsp, rust-analyzer-lsp, clangd-lsp, php-lsp, swift-lsp, kotlin-lsp, csharp-lsp, jdtls-lsp, lua-lsp

**Development Workflows:** agent-sdk-dev, commit-commands, pr-review-toolkit, feature-dev, security-guidance

**External Integrations (MCP-based):** github, gitlab, atlassian, asana, linear, notion, figma, vercel, firebase, supabase, slack, sentry, posthog, stripe, laravel-boost, context7, pinecone, huggingface-skills, firecrawl, coderabbit, sonatype-guide, superpowers, circleback

### 2.12 Auto-Updates

- Official Anthropic marketplaces: auto-update enabled by default
- Third-party/local: auto-update disabled by default
- Toggle per-marketplace via UI

---

## Part 3: Existing SDK Integration in Consola

### 3.1 ClaudeAgentService — Plugin Data Flow

**File**: `src/main/ClaudeAgentService.ts`

The service already extracts plugin, skill, and slash command data from the SDK's init message:

```typescript
// Lines 450-458
this.emit('init', {
  sessionId: message.session_id,
  model: message.model,
  tools: message.tools,
  mcpServers: message.mcp_servers,
  skills: (message as any).skills || [],
  slashCommands: (message as any).slash_commands || [],
  plugins: (message as any).plugins || []
});
```

### 3.2 SDK Plugin Configuration API

**File**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

```typescript
// SdkPluginConfig (Lines 1377-1389)
export declare type SdkPluginConfig = {
  type: 'local';     // Currently only 'local' is supported
  path: string;      // Absolute or relative path to plugin directory
};

// Options.plugins (Lines 675-688)
plugins?: SdkPluginConfig[];
```

### 3.3 SDK MCP Server APIs

```typescript
// Dynamic MCP server management
query.setMcpServers(servers: Record<string, McpServerConfig>): Promise<void>
query.mcpServerStatus(): Record<string, { status, tools[] }>

// MCP server config types
McpStdioServerConfig  // command + args + env
McpSSEServerConfig    // url-based SSE
McpHttpServerConfig   // direct HTTP
McpSdkServerConfig    // in-process
```

### 3.4 Agent Store — Plugin State

**File**: `src/renderer/stores/agentStore.ts`

Each agent instance already tracks:
```typescript
skills: string[];
slashCommands: string[];
plugins: { name: string; path: string }[];
```

These are populated via `initializeSession()` and the `_handleInit` event handler.

### 3.5 Pre-Session Initialization

**File**: `src/main/ClaudeAgentService.ts` (Lines 528-570)

`initializeSession()` method returns `{ skills, slashCommands, plugins }` without starting a full query. This is used for command palette pre-population.

### 3.6 IPC Bridge for Initialization

**File**: `src/renderer/services/agentBridge.ts` (Lines 61-68)

```typescript
initialize: async (instanceId: string, cwd: string): Promise<{
  skills: string[];
  slashCommands: string[];
  plugins: { name: string; path: string }[];
}>
```

---

## Part 4: Existing UI Patterns Relevant to Plugin Management

### 4.1 Dialog/Modal Pattern

**File**: `src/renderer/components/Dialogs/SettingsModal.tsx` (133 lines)

Uses `@radix-ui/react-dialog` with Portal rendering:
```tsx
<Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="settings-modal-content">
      {/* Sections with headers */}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
```

### 4.2 Context Menu / Dropdown Pattern

`WorkspaceActionsMenu.tsx` and `SessionActionsMenu.tsx` use `@radix-ui/react-dropdown-menu` for contextual actions (rename, delete, etc.).

### 4.3 Collapsible Pattern

Workspace and project items use `@radix-ui/react-collapsible` for expand/collapse behavior with animated transitions.

### 4.4 Tooltip Pattern

Sidebar buttons use `@radix-ui/react-tooltip` for hover hints with keyboard shortcut display.

### 4.5 Existing CSS Variables and Design System

The sidebar uses CSS custom properties:
- `--color-bg-sidebar`, `--color-bg-hover`, `--color-bg-active`
- `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary`
- `--space-1` through `--space-7` for spacing
- `--radius-sm`, `--radius-md` for border-radius
- `--transition-fast` for animations

---

## Part 5: IPC Architecture Patterns

### Pattern for Adding New Features

Following the existing patterns, a new plugin management feature would need:

1. **IPC Channels** in `src/shared/constants.ts`:
   ```typescript
   PLUGIN_LIST_MARKETPLACES: 'plugin:list-marketplaces'
   PLUGIN_ADD_MARKETPLACE: 'plugin:add-marketplace'
   PLUGIN_REMOVE_MARKETPLACE: 'plugin:remove-marketplace'
   PLUGIN_UPDATE_MARKETPLACE: 'plugin:update-marketplace'
   PLUGIN_DISCOVER: 'plugin:discover'
   PLUGIN_INSTALL: 'plugin:install'
   PLUGIN_UNINSTALL: 'plugin:uninstall'
   PLUGIN_ENABLE: 'plugin:enable'
   PLUGIN_DISABLE: 'plugin:disable'
   PLUGIN_GET_ERRORS: 'plugin:get-errors'
   PLUGIN_READ_SETTINGS: 'plugin:read-settings'
   ```

2. **Preload API** in `src/preload/preload.ts`:
   - New `window.pluginAPI` with invoke/send methods

3. **Bridge Service** in `src/renderer/services/pluginBridge.ts`:
   - Wraps `window.pluginAPI` calls

4. **IPC Handlers** in `src/main/ipc-handlers.ts`:
   - New `ipcMain.handle()` calls for each channel

5. **Main Process Service** (`src/main/PluginService.ts`):
   - Reads/writes `~/.claude/settings.json` and project-level settings
   - Clones/fetches marketplace repos
   - Parses `marketplace.json` and `plugin.json`
   - Manages plugin cache at `~/.claude/plugins/cache`

---

## Key Architecture Considerations

### How Plugin Management Differs from Agent Communication

The existing agent system is session-scoped and event-driven (streaming). Plugin management is fundamentally different:
- **CRUD operations** — request/response pattern (`ipcMain.handle` / `ipcRenderer.invoke`)
- **Global scope** — plugins exist outside of any workspace or session
- **File system operations** — reading settings files, cloning git repos, managing cache
- **No streaming** — all operations are one-shot

This means the plugin feature would primarily use the **Pattern 2** (Request-Response) IPC pattern, not the event streaming pattern used by the agent.

### Navigation State Changes Required

The current `navigationStore` routes views solely based on `activeWorkspaceId`. A plugin management view needs either:
- A new `activeView` state (e.g., `'home' | 'plugins' | 'workspace'`)
- Or treating plugins as a special workspace-like entity

The `NavItem` component's `isActive` check (`activeWorkspaceId === null`) would need to become view-aware.

### Settings File Access

Consola currently has **no main-process settings file access** — all settings are in browser localStorage. Plugin management requires reading/writing `~/.claude/settings.json` from the main process, which is a new capability.

---

## Code References

- `src/renderer/components/Sidebar/index.tsx` — Sidebar layout with nav zones
- `src/renderer/components/Sidebar/NavItem.tsx` — Navigation item component
- `src/renderer/stores/navigationStore.ts` — Navigation state (needs extension)
- `src/renderer/components/Layout/MainContent.tsx` — View routing (needs new condition)
- `src/renderer/components/Views/HomeView.tsx` — Current home view
- `src/renderer/stores/agentStore.ts:124-159` — Plugin/skill state in agent instances
- `src/main/ClaudeAgentService.ts:450-458` — Plugin data extraction from SDK
- `src/main/ClaudeAgentService.ts:528-570` — Session initialization with plugin loading
- `src/main/ipc-handlers.ts` — IPC handler registration patterns
- `src/preload/preload.ts` — Context bridge API patterns
- `src/shared/constants.ts` — IPC channel definitions
- `src/shared/types.ts:58-67` — AgentInitEvent with plugin fields
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:675-688` — SDK plugin options
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1377-1389` — SdkPluginConfig type

## Open Questions

1. **CLI vs SDK**: Should plugin management operations go through `claude plugin` CLI commands (spawning child processes) or directly through the SDK APIs? The SDK currently only supports `type: 'local'` plugins — full marketplace management may require using the CLI.

2. **Settings file synchronization**: Since Claude Code's settings files (`~/.claude/settings.json`) are shared between the TUI and Consola, how should concurrent access be handled? Should Consola watch for file changes?

3. **Marketplace git operations**: Cloning/fetching marketplace repos is potentially long-running. Should this use background task patterns with progress reporting?

4. **Plugin scope visibility**: Should the UI surface all four scopes (user/project/local/managed) with appropriate read-only indicators for managed plugins?

5. **Real-time plugin state**: Should plugin enable/disable propagate to active agent sessions, or only take effect on new sessions?
