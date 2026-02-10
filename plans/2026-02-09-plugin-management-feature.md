# Plugin Management Feature Implementation Plan

## Overview

Create a dedicated Plugin Management view accessible from the main navigation sidebar (directly below the Home icon) that provides a comprehensive interface for managing Claude Code plugins and marketplaces. The feature replicates the Claude Code TUI's `/plugin` command functionality in a graphical interface, enabling users to discover, install, enable/disable, and manage plugins across different scopes (user, project, local, managed), as well as add and manage marketplace sources.

## Current State Analysis

### Existing Infrastructure:

- **Sidebar Navigation** (`src/renderer/components/Sidebar/index.tsx:1-82`) - Three-zone layout: top nav (Home), middle (Workspaces), footer (Settings)
- **NavItem Component** (`src/renderer/components/Sidebar/NavItem.tsx:1-25`) - Simple button component, but `isActive` is hardcoded to `activeWorkspaceId === null`
- **Navigation Store** (`src/renderer/stores/navigationStore.ts:1-67`) - Zustand store tracking workspace/session state, no view concept
- **MainContent Router** (`src/renderer/components/Layout/MainContent.tsx:1-28`) - Routes based on workspace/session, needs new view condition
- **Agent Store** (`src/renderer/stores/agentStore.ts:124-159`) - Already tracks `plugins`, `skills`, `slashCommands` per instance
- **ClaudeAgentService** (`src/main/ClaudeAgentService.ts:450-458`) - Extracts plugin data from SDK init
- **IPC Patterns** (`src/main/ipc-handlers.ts`) - Established request/response patterns for git, file operations
- **Bridge Services** (`src/renderer/services/`) - Established pattern for Electron API access

### Key Discoveries:

- The app has **no main-process settings file access** — all settings are in localStorage. Plugin management requires reading/writing `~/.claude/settings.json`
- Claude Code uses `claude plugin` CLI commands for full marketplace management; SDK only supports `type: 'local'` plugins
- Plugin configuration spans 4 scopes: user (`~/.claude/settings.json`), project (`.claude/settings.json`), local (`.claude/settings.local.json`), managed (system)
- The `/plugin` TUI has 4 tabs: **Discover**, **Installed**, **Marketplaces**, **Errors**
- Marketplaces are git repos containing `.claude-plugin/marketplace.json` with plugin catalogs
- The `enabledPlugins` map uses format `"plugin-name@marketplace-name": boolean`

## Desired End State

A new "Plugins" view where:
1. User clicks Plugins icon in sidebar (below Home) → Plugins view opens (full content area)
2. Tab bar shows four tabs: Discover, Installed, Marketplaces, Errors
3. **Discover tab**: Browse all plugins from all marketplaces, filter/search, one-click install
4. **Installed tab**: View installed plugins, toggle enable/disable, uninstall, see scope badges
5. **Marketplaces tab**: List sources, add new (GitHub, git URL, local path), remove, update
6. **Errors tab**: Show plugin loading errors with details
7. All operations work at the correct scope (user by default, with scope selector)
8. Changes sync with Claude Code TUI (shared settings files)

## What We're NOT Doing

- No plugin development/validation UI (use `claude plugin validate` CLI)
- No real-time plugin reload into active sessions (new sessions only)
- No partial settings editing (only plugin-related fields)
- No marketplace creation UI (read-only browsing)
- No git authentication flows (use system git credentials)

## Implementation Approach

Use `claude plugin` CLI commands via child process spawning rather than reimplementing git clone/settings parsing. This ensures compatibility with Claude Code's plugin system and leverages existing validation. Build UI incrementally: navigation foundation → backend service → tab views → polish.

---

## Phase 1: Navigation Foundation

### Overview
Extend the navigation system to support a "Plugins" view alongside the existing workspace-based views.

### Changes Required:

#### 1. Navigation Store Extension
**File**: `src/renderer/stores/navigationStore.ts`
**Changes**: Add `activeView` state to support view-based routing

```typescript
// Add new type
type ActiveView = 'home' | 'plugins' | 'workspace';

// Add to state
activeView: ActiveView;
setActiveView: (view: ActiveView) => void;

// Modify setActiveWorkspace to also set activeView
setActiveWorkspace: (id: string | null) => {
  set({
    activeWorkspaceId: id,
    activeSessionId: null,
    activeView: id ? 'workspace' : 'home',
  });
}
```

#### 2. NavItem Component Extension
**File**: `src/renderer/components/Sidebar/NavItem.tsx`
**Changes**: Accept optional `isActive` prop instead of computing from workspace state

```typescript
interface NavItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  shortcut?: string;
  isActive?: boolean;  // New: explicit active state
}

// In component:
const computedActive = isActive ?? (activeWorkspaceId === null && activeView === 'home');
```

#### 3. Sidebar: Add Plugins NavItem
**File**: `src/renderer/components/Sidebar/index.tsx`
**Changes**: Add Plugins button below Home

```typescript
import { Puzzle } from 'lucide-react';  // or Package2, Blocks

// After Home NavItem (line ~47):
<NavItem
  icon={<Puzzle size={16} />}
  label="Plugins"
  onClick={handleGoPlugins}
  isActive={activeView === 'plugins'}
/>

// Add handler:
const handleGoPlugins = () => {
  setActiveWorkspace(null);
  setActiveView('plugins');
};
```

#### 4. MainContent Router Update
**File**: `src/renderer/components/Layout/MainContent.tsx`
**Changes**: Add routing for plugins view

```typescript
import { PluginsView } from '../Views';

// Before workspace checks:
if (activeView === 'plugins') {
  return <PluginsView />;
}
```

#### 5. PluginsView Placeholder
**File**: `src/renderer/components/Views/PluginsView/index.tsx` (new)
**Changes**: Create placeholder component

```typescript
export function PluginsView() {
  return (
    <div className="plugins-view">
      <h1>Plugins</h1>
      <p>Coming soon...</p>
    </div>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Plugins icon appears in sidebar below Home
- [ ] Clicking Plugins shows PluginsView placeholder
- [ ] Home and Plugins buttons correctly show active state
- [ ] Clicking a workspace navigates away from Plugins view
- [ ] Clicking Home from Plugins view works correctly

---

## Phase 2: Backend Plugin Service

### Overview
Create the main process service that interfaces with Claude Code's plugin system via CLI commands and settings file access.

### Changes Required:

#### 1. IPC Channel Definitions
**File**: `src/shared/constants.ts`
**Changes**: Add plugin-related IPC channels

```typescript
// Plugin channels
PLUGIN_LIST_MARKETPLACES: 'plugin:list-marketplaces',
PLUGIN_ADD_MARKETPLACE: 'plugin:add-marketplace',
PLUGIN_REMOVE_MARKETPLACE: 'plugin:remove-marketplace',
PLUGIN_UPDATE_MARKETPLACE: 'plugin:update-marketplace',
PLUGIN_DISCOVER: 'plugin:discover',
PLUGIN_LIST_INSTALLED: 'plugin:list-installed',
PLUGIN_INSTALL: 'plugin:install',
PLUGIN_UNINSTALL: 'plugin:uninstall',
PLUGIN_ENABLE: 'plugin:enable',
PLUGIN_DISABLE: 'plugin:disable',
PLUGIN_GET_ERRORS: 'plugin:get-errors',
PLUGIN_GET_DETAILS: 'plugin:get-details',
```

#### 2. Plugin Service
**File**: `src/main/PluginService.ts` (new)
**Changes**: Create service for plugin operations

```typescript
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface Marketplace {
  name: string;
  source: MarketplaceSource;
  plugins: Plugin[];
  autoUpdate: boolean;
}

interface MarketplaceSource {
  source: 'github' | 'git' | 'local' | 'url';
  repo?: string;
  url?: string;
  path?: string;
  ref?: string;
}

interface Plugin {
  name: string;
  marketplace: string;
  description: string;
  version: string;
  author?: { name: string };
  keywords?: string[];
  category?: string;
  installed?: boolean;
  enabled?: boolean;
  scope?: 'user' | 'project' | 'local' | 'managed';
}

export class PluginService {
  private claudeDir = path.join(os.homedir(), '.claude');
  private settingsPath = path.join(this.claudeDir, 'settings.json');

  // Execute claude plugin CLI commands
  private async execClaudePlugin(args: string[]): Promise<string>;

  // Read settings.json
  async readSettings(): Promise<Record<string, any>>;

  // List all marketplaces (from settings + official)
  async listMarketplaces(): Promise<Marketplace[]>;

  // Add a marketplace source
  async addMarketplace(source: string): Promise<{ success: boolean; error?: string }>;

  // Remove a marketplace
  async removeMarketplace(name: string): Promise<{ success: boolean; error?: string }>;

  // Update marketplace (refresh plugin list)
  async updateMarketplace(name: string): Promise<{ success: boolean; error?: string }>;

  // Discover plugins from all marketplaces
  async discoverPlugins(): Promise<Plugin[]>;

  // List installed plugins
  async listInstalled(): Promise<Plugin[]>;

  // Install a plugin
  async installPlugin(pluginId: string, scope?: string): Promise<{ success: boolean; error?: string }>;

  // Uninstall a plugin
  async uninstallPlugin(pluginId: string, scope?: string): Promise<{ success: boolean; error?: string }>;

  // Enable a plugin
  async enablePlugin(pluginId: string, scope?: string): Promise<{ success: boolean; error?: string }>;

  // Disable a plugin
  async disablePlugin(pluginId: string, scope?: string): Promise<{ success: boolean; error?: string }>;

  // Get plugin errors
  async getErrors(): Promise<{ plugin: string; error: string }[]>;

  // Get detailed plugin info
  async getPluginDetails(pluginId: string): Promise<Plugin & {
    commands?: string[];
    skills?: string[];
    agents?: string[];
    hooks?: Record<string, any>;
    mcpServers?: Record<string, any>;
  }>;
}
```

#### 3. IPC Handlers
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add handlers for plugin operations

```typescript
import { PluginService } from './PluginService';

const pluginService = new PluginService();

// List marketplaces
ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST_MARKETPLACES, async () => {
  return pluginService.listMarketplaces();
});

// Add marketplace
ipcMain.handle(IPC_CHANNELS.PLUGIN_ADD_MARKETPLACE, async (_, { source }) => {
  return pluginService.addMarketplace(source);
});

// ... handlers for all plugin channels
```

#### 4. Preload API
**File**: `src/preload/preload.ts`
**Changes**: Expose plugin API to renderer

```typescript
pluginAPI: {
  listMarketplaces: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_MARKETPLACES),
  addMarketplace: (source: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_ADD_MARKETPLACE, { source }),
  removeMarketplace: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_REMOVE_MARKETPLACE, { name }),
  updateMarketplace: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UPDATE_MARKETPLACE, { name }),
  discover: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_DISCOVER),
  listInstalled: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_INSTALLED),
  install: (pluginId: string, scope?: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INSTALL, { pluginId, scope }),
  uninstall: (pluginId: string, scope?: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UNINSTALL, { pluginId, scope }),
  enable: (pluginId: string, scope?: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_ENABLE, { pluginId, scope }),
  disable: (pluginId: string, scope?: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_DISABLE, { pluginId, scope }),
  getErrors: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_ERRORS),
  getDetails: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_DETAILS, { pluginId }),
},
```

#### 5. Bridge Service
**File**: `src/renderer/services/pluginBridge.ts` (new)
**Changes**: Create bridge for plugin API

```typescript
export const pluginBridge = {
  listMarketplaces: async (): Promise<Marketplace[]> => {
    return window.pluginAPI.listMarketplaces();
  },
  addMarketplace: async (source: string): Promise<Result> => {
    return window.pluginAPI.addMarketplace(source);
  },
  // ... all methods
};
```

#### 6. Type Definitions
**File**: `src/renderer/types/electron.d.ts`
**Changes**: Add pluginAPI types

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Can call `pluginBridge.listMarketplaces()` in DevTools console
- [ ] Returns official marketplace with plugins
- [ ] Can call `pluginBridge.listInstalled()` and see any installed plugins
- [ ] Error handling works (invalid marketplace source, etc.)

---

## Phase 3: Plugin Store & Discover Tab

### Overview
Create the Zustand store for plugin state and build the Discover tab UI for browsing and installing plugins.

### Changes Required:

#### 1. Plugin Store
**File**: `src/renderer/stores/pluginStore.ts` (new)
**Changes**: Create Zustand store for plugin state

```typescript
interface PluginState {
  // Data
  marketplaces: Marketplace[];
  discoveredPlugins: Plugin[];
  installedPlugins: Plugin[];
  errors: PluginError[];

  // UI State
  activeTab: 'discover' | 'installed' | 'marketplaces' | 'errors';
  searchQuery: string;
  selectedCategory: string | null;
  selectedScope: 'user' | 'project' | 'local' | null;

  // Loading states
  isLoadingMarketplaces: boolean;
  isLoadingPlugins: boolean;
  isInstalling: Set<string>;  // Plugin IDs being installed

  // Actions
  setActiveTab: (tab: string) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string | null) => void;
  setSelectedScope: (scope: string | null) => void;

  // Data actions
  fetchMarketplaces: () => Promise<void>;
  fetchDiscoveredPlugins: () => Promise<void>;
  fetchInstalledPlugins: () => Promise<void>;
  fetchErrors: () => Promise<void>;

  // Plugin actions
  installPlugin: (pluginId: string, scope?: string) => Promise<void>;
  uninstallPlugin: (pluginId: string, scope?: string) => Promise<void>;
  enablePlugin: (pluginId: string, scope?: string) => Promise<void>;
  disablePlugin: (pluginId: string, scope?: string) => Promise<void>;

  // Marketplace actions
  addMarketplace: (source: string) => Promise<void>;
  removeMarketplace: (name: string) => Promise<void>;
  updateMarketplace: (name: string) => Promise<void>;
}
```

#### 2. PluginsView Tab Container
**File**: `src/renderer/components/Views/PluginsView/index.tsx`
**Changes**: Build tab container with header

```typescript
import * as Tabs from '@radix-ui/react-tabs';

export function PluginsView() {
  const activeTab = usePluginStore((s) => s.activeTab);
  const setActiveTab = usePluginStore((s) => s.setActiveTab);
  const errors = usePluginStore((s) => s.errors);

  return (
    <div className="plugins-view">
      <header className="plugins-header">
        <h1>Plugins</h1>
        <PluginSearchBar />
      </header>

      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="plugins-tabs">
          <Tabs.Trigger value="discover">Discover</Tabs.Trigger>
          <Tabs.Trigger value="installed">Installed</Tabs.Trigger>
          <Tabs.Trigger value="marketplaces">Marketplaces</Tabs.Trigger>
          <Tabs.Trigger value="errors">
            Errors {errors.length > 0 && <span className="badge">{errors.length}</span>}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="discover"><DiscoverTab /></Tabs.Content>
        <Tabs.Content value="installed"><InstalledTab /></Tabs.Content>
        <Tabs.Content value="marketplaces"><MarketplacesTab /></Tabs.Content>
        <Tabs.Content value="errors"><ErrorsTab /></Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
```

#### 3. Discover Tab Component
**File**: `src/renderer/components/Views/PluginsView/DiscoverTab.tsx` (new)
**Changes**: Grid of available plugins with categories

```typescript
export function DiscoverTab() {
  const plugins = usePluginStore((s) => s.discoveredPlugins);
  const searchQuery = usePluginStore((s) => s.searchQuery);
  const selectedCategory = usePluginStore((s) => s.selectedCategory);
  const isLoading = usePluginStore((s) => s.isLoadingPlugins);

  // Filter plugins by search and category
  const filtered = useMemo(() => {
    return plugins.filter(p => {
      const matchesSearch = !searchQuery ||
        p.name.includes(searchQuery) ||
        p.description?.includes(searchQuery);
      const matchesCategory = !selectedCategory || p.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [plugins, searchQuery, selectedCategory]);

  // Extract unique categories
  const categories = useMemo(() => {
    return [...new Set(plugins.map(p => p.category).filter(Boolean))];
  }, [plugins]);

  return (
    <div className="discover-tab">
      <aside className="discover-categories">
        <CategoryFilter categories={categories} />
      </aside>
      <main className="discover-grid">
        {isLoading ? <LoadingSpinner /> : (
          filtered.map(plugin => (
            <PluginCard key={plugin.name + '@' + plugin.marketplace} plugin={plugin} />
          ))
        )}
      </main>
    </div>
  );
}
```

#### 4. PluginCard Component
**File**: `src/renderer/components/Views/PluginsView/PluginCard.tsx` (new)
**Changes**: Individual plugin display card

```typescript
export function PluginCard({ plugin }: { plugin: Plugin }) {
  const installPlugin = usePluginStore((s) => s.installPlugin);
  const isInstalling = usePluginStore((s) => s.isInstalling.has(plugin.name + '@' + plugin.marketplace));

  const pluginId = `${plugin.name}@${plugin.marketplace}`;

  return (
    <div className="plugin-card">
      <div className="plugin-card-header">
        <h3>{plugin.name}</h3>
        {plugin.installed && <span className="badge installed">Installed</span>}
      </div>
      <p className="plugin-card-description">{plugin.description}</p>
      <div className="plugin-card-meta">
        <span className="plugin-version">v{plugin.version}</span>
        {plugin.author && <span className="plugin-author">by {plugin.author.name}</span>}
      </div>
      <div className="plugin-card-keywords">
        {plugin.keywords?.map(k => <span key={k} className="keyword">{k}</span>)}
      </div>
      <div className="plugin-card-actions">
        {plugin.installed ? (
          <button disabled>Installed</button>
        ) : (
          <button onClick={() => installPlugin(pluginId)} disabled={isInstalling}>
            {isInstalling ? 'Installing...' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}
```

#### 5. Styling
**File**: `src/renderer/components/Views/PluginsView/styles.css` (new)
**Changes**: Comprehensive plugin view styling

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Discover tab shows grid of available plugins
- [ ] Search filters plugins by name/description
- [ ] Category sidebar filters plugins
- [ ] Plugin cards show name, description, version, author
- [ ] Install button shows loading state and completes
- [ ] Installed plugins show "Installed" badge

---

## Phase 4: Installed Tab & Plugin Actions

### Overview
Build the Installed tab with plugin management actions (enable, disable, uninstall) and scope badges.

### Changes Required:

#### 1. Installed Tab Component
**File**: `src/renderer/components/Views/PluginsView/InstalledTab.tsx` (new)
**Changes**: List of installed plugins with management actions

```typescript
export function InstalledTab() {
  const plugins = usePluginStore((s) => s.installedPlugins);
  const searchQuery = usePluginStore((s) => s.searchQuery);

  // Group by enabled/disabled
  const enabled = plugins.filter(p => p.enabled !== false);
  const disabled = plugins.filter(p => p.enabled === false);

  // Filter by search
  const filter = (ps: Plugin[]) => ps.filter(p =>
    !searchQuery || p.name.includes(searchQuery)
  );

  return (
    <div className="installed-tab">
      <section className="plugin-section">
        <h2>Enabled ({filter(enabled).length})</h2>
        <div className="plugin-list">
          {filter(enabled).map(p => <InstalledPluginRow key={p.name} plugin={p} />)}
        </div>
      </section>

      {filter(disabled).length > 0 && (
        <section className="plugin-section">
          <h2>Disabled ({filter(disabled).length})</h2>
          <div className="plugin-list">
            {filter(disabled).map(p => <InstalledPluginRow key={p.name} plugin={p} />)}
          </div>
        </section>
      )}

      {plugins.length === 0 && (
        <div className="empty-state">
          <p>No plugins installed</p>
          <button onClick={() => setActiveTab('discover')}>Browse Plugins</button>
        </div>
      )}
    </div>
  );
}
```

#### 2. Installed Plugin Row Component
**File**: `src/renderer/components/Views/PluginsView/InstalledPluginRow.tsx` (new)
**Changes**: Row with toggle, details, and actions menu

```typescript
export function InstalledPluginRow({ plugin }: { plugin: Plugin }) {
  const enablePlugin = usePluginStore((s) => s.enablePlugin);
  const disablePlugin = usePluginStore((s) => s.disablePlugin);
  const uninstallPlugin = usePluginStore((s) => s.uninstallPlugin);

  const pluginId = `${plugin.name}@${plugin.marketplace}`;

  const handleToggle = () => {
    if (plugin.enabled === false) {
      enablePlugin(pluginId, plugin.scope);
    } else {
      disablePlugin(pluginId, plugin.scope);
    }
  };

  return (
    <div className="installed-plugin-row">
      <Switch checked={plugin.enabled !== false} onCheckedChange={handleToggle} />
      <div className="plugin-info">
        <div className="plugin-name">{plugin.name}</div>
        <div className="plugin-meta">
          <span className="plugin-marketplace">from {plugin.marketplace}</span>
          <ScopeBadge scope={plugin.scope} />
        </div>
      </div>
      <PluginActionsMenu
        plugin={plugin}
        onUninstall={() => uninstallPlugin(pluginId, plugin.scope)}
      />
    </div>
  );
}
```

#### 3. Scope Badge Component
**File**: `src/renderer/components/Views/PluginsView/ScopeBadge.tsx` (new)
**Changes**: Visual indicator for plugin scope

```typescript
export function ScopeBadge({ scope }: { scope?: string }) {
  const variants = {
    user: { label: 'User', color: 'blue' },
    project: { label: 'Project', color: 'green' },
    local: { label: 'Local', color: 'orange' },
    managed: { label: 'Managed', color: 'purple' },
  };

  const variant = variants[scope ?? 'user'];

  return (
    <span className={`scope-badge scope-badge--${variant.color}`}>
      {variant.label}
    </span>
  );
}
```

#### 4. Plugin Actions Menu
**File**: `src/renderer/components/Views/PluginsView/PluginActionsMenu.tsx` (new)
**Changes**: Dropdown menu for plugin actions

```typescript
export function PluginActionsMenu({ plugin, onUninstall }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="plugin-actions-trigger">
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content">
          <DropdownMenu.Item onClick={() => viewDetails(plugin)}>
            View Details
          </DropdownMenu.Item>
          {plugin.scope !== 'managed' && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                className="dropdown-item-destructive"
                onClick={onUninstall}
              >
                Uninstall
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Installed tab shows enabled/disabled sections
- [ ] Toggle switch enables/disables plugins
- [ ] Scope badges show correct scope (user, project, etc.)
- [ ] Uninstall action removes plugin
- [ ] Managed plugins cannot be uninstalled (action disabled)
- [ ] Empty state shows browse button

---

## Phase 5: Marketplaces Tab

### Overview
Build the Marketplaces tab for viewing, adding, and managing marketplace sources.

### Changes Required:

#### 1. Marketplaces Tab Component
**File**: `src/renderer/components/Views/PluginsView/MarketplacesTab.tsx` (new)
**Changes**: List of marketplace sources with add/remove/update

```typescript
export function MarketplacesTab() {
  const marketplaces = usePluginStore((s) => s.marketplaces);
  const addMarketplace = usePluginStore((s) => s.addMarketplace);
  const [showAddDialog, setShowAddDialog] = useState(false);

  return (
    <div className="marketplaces-tab">
      <header className="marketplaces-header">
        <h2>Marketplace Sources</h2>
        <button onClick={() => setShowAddDialog(true)}>
          <Plus size={16} /> Add Marketplace
        </button>
      </header>

      <div className="marketplaces-list">
        {marketplaces.map(mp => (
          <MarketplaceRow key={mp.name} marketplace={mp} />
        ))}
      </div>

      <AddMarketplaceDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdd={addMarketplace}
      />
    </div>
  );
}
```

#### 2. Marketplace Row Component
**File**: `src/renderer/components/Views/PluginsView/MarketplaceRow.tsx` (new)
**Changes**: Individual marketplace with plugin count and actions

```typescript
export function MarketplaceRow({ marketplace }: { marketplace: Marketplace }) {
  const updateMarketplace = usePluginStore((s) => s.updateMarketplace);
  const removeMarketplace = usePluginStore((s) => s.removeMarketplace);

  const isOfficial = marketplace.name === 'claude-plugins-official';

  return (
    <div className="marketplace-row">
      <div className="marketplace-icon">
        {getSourceIcon(marketplace.source)}
      </div>
      <div className="marketplace-info">
        <div className="marketplace-name">
          {marketplace.name}
          {isOfficial && <span className="badge official">Official</span>}
        </div>
        <div className="marketplace-source">
          {formatSource(marketplace.source)}
        </div>
        <div className="marketplace-meta">
          <span>{marketplace.plugins.length} plugins</span>
          {marketplace.autoUpdate && <span>Auto-update enabled</span>}
        </div>
      </div>
      <div className="marketplace-actions">
        <button onClick={() => updateMarketplace(marketplace.name)}>
          <RefreshCw size={14} /> Update
        </button>
        {!isOfficial && (
          <button
            className="destructive"
            onClick={() => removeMarketplace(marketplace.name)}
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>
    </div>
  );
}
```

#### 3. Add Marketplace Dialog
**File**: `src/renderer/components/Views/PluginsView/AddMarketplaceDialog.tsx` (new)
**Changes**: Dialog for adding new marketplace sources

```typescript
export function AddMarketplaceDialog({ open, onOpenChange, onAdd }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    setIsAdding(true);
    setError('');
    try {
      await onAdd(source);
      onOpenChange(false);
      setSource('');
    } catch (e) {
      setError(e.message);
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="add-marketplace-dialog">
          <Dialog.Title>Add Marketplace</Dialog.Title>

          <p className="dialog-description">
            Enter a marketplace source. Examples:
          </p>
          <ul className="source-examples">
            <li><code>owner/repo</code> - GitHub repository</li>
            <li><code>https://github.com/owner/repo</code> - Git URL</li>
            <li><code>./path/to/marketplace</code> - Local directory</li>
          </ul>

          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g., anthropics/claude-code"
            className="marketplace-source-input"
          />

          {error && <p className="dialog-error">{error}</p>}

          <div className="dialog-actions">
            <button onClick={() => onOpenChange(false)}>Cancel</button>
            <button onClick={handleAdd} disabled={!source || isAdding}>
              {isAdding ? 'Adding...' : 'Add Marketplace'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Marketplaces tab shows list of sources
- [ ] Official marketplace shows badge and cannot be removed
- [ ] "Add Marketplace" button opens dialog
- [ ] Can add marketplace by GitHub owner/repo
- [ ] Can add marketplace by git URL
- [ ] Update button refreshes plugin list
- [ ] Remove button removes third-party marketplace

---

## Phase 6: Errors Tab & Polish

### Overview
Build the Errors tab and add final polish including loading states, empty states, and keyboard navigation.

### Changes Required:

#### 1. Errors Tab Component
**File**: `src/renderer/components/Views/PluginsView/ErrorsTab.tsx` (new)
**Changes**: List of plugin loading errors

```typescript
export function ErrorsTab() {
  const errors = usePluginStore((s) => s.errors);
  const fetchErrors = usePluginStore((s) => s.fetchErrors);

  useEffect(() => {
    fetchErrors();
  }, []);

  if (errors.length === 0) {
    return (
      <div className="errors-tab-empty">
        <CheckCircle size={48} />
        <h2>No Errors</h2>
        <p>All plugins loaded successfully.</p>
      </div>
    );
  }

  return (
    <div className="errors-tab">
      <div className="errors-list">
        {errors.map((err, i) => (
          <div key={i} className="error-item">
            <AlertTriangle size={16} className="error-icon" />
            <div className="error-content">
              <div className="error-plugin">{err.plugin}</div>
              <div className="error-message">{err.error}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### 2. Plugin Details Modal
**File**: `src/renderer/components/Views/PluginsView/PluginDetailsModal.tsx` (new)
**Changes**: Full details view for a plugin

```typescript
export function PluginDetailsModal({ pluginId, open, onOpenChange }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (open && pluginId) {
      pluginBridge.getDetails(pluginId)
        .then(setDetails)
        .finally(() => setLoading(false));
    }
  }, [open, pluginId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="plugin-details-modal">
          {loading ? <LoadingSpinner /> : (
            <>
              <Dialog.Title>{details.name}</Dialog.Title>
              <p className="plugin-description">{details.description}</p>

              <section className="details-section">
                <h3>Information</h3>
                <dl>
                  <dt>Version</dt><dd>{details.version}</dd>
                  <dt>Author</dt><dd>{details.author?.name}</dd>
                  <dt>License</dt><dd>{details.license}</dd>
                  <dt>Marketplace</dt><dd>{details.marketplace}</dd>
                </dl>
              </section>

              {details.commands?.length > 0 && (
                <section className="details-section">
                  <h3>Commands</h3>
                  <ul>{details.commands.map(c => <li key={c}><code>/{c}</code></li>)}</ul>
                </section>
              )}

              {details.skills?.length > 0 && (
                <section className="details-section">
                  <h3>Skills</h3>
                  <ul>{details.skills.map(s => <li key={s}>{s}</li>)}</ul>
                </section>
              )}

              {details.mcpServers && Object.keys(details.mcpServers).length > 0 && (
                <section className="details-section">
                  <h3>MCP Servers</h3>
                  <ul>{Object.keys(details.mcpServers).map(s => <li key={s}>{s}</li>)}</ul>
                </section>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

#### 3. Data Fetching on Mount
**File**: `src/renderer/components/Views/PluginsView/index.tsx`
**Changes**: Fetch data when view mounts

```typescript
useEffect(() => {
  fetchMarketplaces();
  fetchDiscoveredPlugins();
  fetchInstalledPlugins();
  fetchErrors();
}, []);
```

#### 4. Keyboard Navigation
**File**: `src/renderer/components/Views/PluginsView/index.tsx`
**Changes**: Add keyboard shortcuts

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === '1' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setActiveTab('discover');
    }
    // ... tabs 2, 3, 4
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

#### 5. Loading States & Skeletons
**File**: `src/renderer/components/Views/PluginsView/PluginCardSkeleton.tsx` (new)
**Changes**: Skeleton loader for plugin cards

#### 6. Final Styling Polish
**File**: `src/renderer/components/Views/PluginsView/styles.css`
**Changes**: Final polish

- Smooth tab transitions
- Focus states for accessibility
- Hover states on interactive elements
- Badge styling consistency
- Responsive layout adjustments
- Dark mode compatibility

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Errors tab shows "No Errors" when none exist
- [ ] Errors tab shows plugin errors with details
- [ ] Plugin details modal shows full information
- [ ] Keyboard shortcuts switch tabs
- [ ] Loading skeletons appear during fetch
- [ ] All interactive elements have visible focus states
- [ ] Empty states guide users to appropriate actions

---

## Testing Strategy

### Unit Tests:
- PluginService CLI command execution (mock spawn)
- Plugin store state transitions
- Filter/search logic in Discover tab

### Integration Tests:
- Full flow: add marketplace → discover plugins → install → enable/disable → uninstall
- Settings file persistence (install in app, verify in Claude Code TUI)
- Error handling for network failures, invalid sources

### Manual Testing Steps:
1. Open app → click Plugins in sidebar
2. Verify Discover tab shows official plugins
3. Search for "typescript" → verify filtering
4. Install a plugin → verify it appears in Installed tab
5. Toggle plugin on/off → verify state persists
6. Go to Marketplaces tab → add `anthropics/claude-code`
7. Verify new plugins appear in Discover tab
8. Remove the added marketplace → verify plugins disappear
9. Check Errors tab (intentionally cause an error to verify)
10. Verify settings sync: open Claude Code TUI, run `/plugin` → same state

---

## File Summary

### New Files:
| File | Purpose |
|------|---------|
| `src/main/PluginService.ts` | Main process plugin operations via CLI |
| `src/renderer/services/pluginBridge.ts` | Bridge for plugin API |
| `src/renderer/stores/pluginStore.ts` | Zustand store for plugin state |
| `src/renderer/components/Views/PluginsView/index.tsx` | Main view container with tabs |
| `src/renderer/components/Views/PluginsView/DiscoverTab.tsx` | Plugin discovery grid |
| `src/renderer/components/Views/PluginsView/InstalledTab.tsx` | Installed plugins list |
| `src/renderer/components/Views/PluginsView/MarketplacesTab.tsx` | Marketplace management |
| `src/renderer/components/Views/PluginsView/ErrorsTab.tsx` | Plugin errors list |
| `src/renderer/components/Views/PluginsView/PluginCard.tsx` | Plugin card component |
| `src/renderer/components/Views/PluginsView/InstalledPluginRow.tsx` | Installed plugin row |
| `src/renderer/components/Views/PluginsView/MarketplaceRow.tsx` | Marketplace row |
| `src/renderer/components/Views/PluginsView/AddMarketplaceDialog.tsx` | Add marketplace dialog |
| `src/renderer/components/Views/PluginsView/PluginDetailsModal.tsx` | Plugin details modal |
| `src/renderer/components/Views/PluginsView/ScopeBadge.tsx` | Scope indicator badge |
| `src/renderer/components/Views/PluginsView/PluginActionsMenu.tsx` | Plugin actions dropdown |
| `src/renderer/components/Views/PluginsView/styles.css` | View styles |

### Modified Files:
| File | Changes |
|------|---------|
| `src/shared/constants.ts` | Add plugin IPC channels |
| `src/preload/preload.ts` | Expose pluginAPI |
| `src/main/ipc-handlers.ts` | Add plugin IPC handlers |
| `src/renderer/types/electron.d.ts` | Add pluginAPI types |
| `src/renderer/stores/navigationStore.ts` | Add `activeView` state |
| `src/renderer/components/Sidebar/index.tsx` | Add Plugins nav item |
| `src/renderer/components/Sidebar/NavItem.tsx` | Support explicit `isActive` prop |
| `src/renderer/components/Layout/MainContent.tsx` | Route to PluginsView |
| `src/renderer/components/Views/index.ts` | Export PluginsView |

---

## References

- Research document: `research/2026-02-09-plugin-management-feature.md`
- Existing sidebar: `src/renderer/components/Sidebar/index.tsx:1-82`
- Navigation store: `src/renderer/stores/navigationStore.ts:1-67`
- MainContent router: `src/renderer/components/Layout/MainContent.tsx:1-28`
- IPC patterns: `src/main/ipc-handlers.ts`
- Bridge patterns: `src/renderer/services/gitBridge.ts`
- Dialog patterns: `src/renderer/components/Dialogs/SettingsModal.tsx`
- Claude Code plugin docs: https://code.claude.com/docs/en/plugins-reference
- Claude Code marketplace docs: https://code.claude.com/docs/en/plugin-marketplaces
