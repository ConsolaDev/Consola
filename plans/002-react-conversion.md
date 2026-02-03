# Plan: Convert Renderer to React with Vite

**Status**: Ready for Implementation
**Priority**: High
**Created**: 2026-02-03

## Overview

Convert the Electron renderer from plain HTML/TypeScript to a React application using Vite as the bundler. The UI will be redesigned with Radix UI components for a polished look, and Zustand will manage application state. Playwright e2e tests will ensure visual verification of the terminal rendering.

## Current State Analysis

The renderer currently uses:
- Plain HTML (`src/renderer/index.html`) with import maps for ES modules
- Vanilla TypeScript (`src/renderer/index.ts`) for xterm.js initialization
- CSS file (`src/renderer/styles/main.css`) with CSS variables
- Mode switching via keyboard shortcuts (Esc+s/c, Cmd+1/2) and clickable tabs

### Key Discoveries:
- xterm.js requires a DOM element ref to mount (`src/renderer/index.ts:63`)
- IPC communication via `window.terminalAPI` must be preserved (`src/preload/preload.ts:14-67`)
- Terminal dimensions sync on resize (`src/renderer/index.ts:129-144`)
- Two modes: SHELL and CLAUDE with separate PTY instances (`src/main/TerminalService.ts:14-15`)

## Desired End State

- React-based renderer built with Vite
- Polished UI using Radix UI components (Tabs, etc.)
- Zustand store managing terminal state
- Mode switching via clickable tabs only (no keyboard shortcuts)
- Playwright e2e tests verifying terminal renders correctly
- All existing functionality preserved (terminal I/O, resize, mode switching)

### Verification:
```bash
npm run dev      # Development with HMR
npm run build    # Production build
npm run test:e2e # Playwright visual tests pass
npm start        # Application launches with working terminal
```

## What We're NOT Doing

- Not changing the main process or preload script architecture
- Not modifying TerminalService or IPC channels
- Not adding new features beyond the UI redesign
- Not implementing keyboard shortcuts (can be added later)

## Implementation Approach

1. Set up Vite with React and TypeScript
2. Create terminal bridge service (isolates `window.terminalAPI` access)
3. Create Zustand store for terminal state (uses bridge internally)
4. Build React components with Radix UI
5. Integrate xterm.js with React refs and useTerminal hook
6. Configure Electron to load Vite dev server / built files
7. Add Playwright e2e tests
8. Clean up old renderer files

---

## Phase 1: Set Up Vite with React

### Overview
Install and configure Vite for the Electron renderer process with React and TypeScript support.

### Changes Required:

#### 1. Install dependencies
```bash
npm install react react-dom @radix-ui/themes @radix-ui/react-tabs zustand
npm install -D @types/react @types/react-dom @vitejs/plugin-react vite
```

#### 2. Create Vite config
**File**: `vite.config.ts` (new file)

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyDirOnBuild: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  server: {
    port: 5173,
  },
});
```

#### 3. Create new HTML entry point
**File**: `src/renderer/index.html` (replace existing)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*">
    <title>Console-1</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
</body>
</html>
```

#### 4. Create React entry point
**File**: `src/renderer/main.tsx` (new file)

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import App from './App';
import '@radix-ui/themes/styles.css';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Theme appearance="dark" accentColor="cyan" grayColor="slate">
      <App />
    </Theme>
  </React.StrictMode>
);
```

#### 5. Update package.json scripts
**File**: `package.json`

Add/modify scripts:
```json
{
  "scripts": {
    "dev": "vite --config vite.config.ts",
    "build:renderer": "vite build --config vite.config.ts",
    "build": "npm run build:main && npm run build:preload && npm run build:renderer",
    "start": "electron .",
    "electron:dev": "concurrently \"npm run dev\" \"wait-on http://localhost:5173 && electron .\""
  }
}
```

#### 6. Update window-manager.ts for Vite dev server
**File**: `src/main/window-manager.ts`

```typescript
// In development, load from Vite dev server
// In production, load built files
const isDev = process.env.NODE_ENV === 'development';

if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
} else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm install` completes without errors
- [ ] `npm run dev` starts Vite dev server on port 5173
- [ ] `npm run build` compiles all targets without errors

#### Manual Verification:
- [ ] Running `npm run electron:dev` opens Electron window
- [ ] Window loads React app (even if just "Hello World")

---

## Phase 2: Create Terminal Bridge and Zustand Store

### Overview
Create a terminal bridge service that isolates all `window.terminalAPI` access to a single file. Then set up Zustand store and a `useTerminal` hook that use the bridge. This pattern:
- Keeps `window` access in ONE place
- Makes testing easier (mock the bridge module)
- Provides cleaner component code

### Changes Required:

#### 1. Create types file
**File**: `src/renderer/types/terminal.ts` (new file)

```typescript
export type TerminalMode = 'SHELL' | 'CLAUDE';

export type DataCallback = (data: string) => void;
export type ModeCallback = (mode: TerminalMode) => void;

export interface TerminalAPI {
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  switchMode: (mode: TerminalMode) => void;
  onData: (callback: DataCallback) => void;
  onModeChanged: (callback: ModeCallback) => void;
  removeDataListener: (callback: DataCallback) => void;
  removeModeChangedListener: (callback: ModeCallback) => void;
}

declare global {
  interface Window {
    terminalAPI: TerminalAPI;
  }
}
```

#### 2. Create terminal bridge service
**File**: `src/renderer/services/terminalBridge.ts` (new file)

This is the ONLY file that accesses `window.terminalAPI`.

```typescript
import type { TerminalMode, DataCallback, ModeCallback } from '../types/terminal';

/**
 * Terminal Bridge - Isolates all window.terminalAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  return window.terminalAPI;
}

export const terminalBridge = {
  /** Check if the terminal API is available */
  isAvailable: (): boolean => {
    return !!getAPI();
  },

  /** Send input data to the PTY */
  sendInput: (data: string): void => {
    getAPI()?.sendInput(data);
  },

  /** Resize the PTY */
  resize: (cols: number, rows: number): void => {
    getAPI()?.resize(cols, rows);
  },

  /** Switch between SHELL and CLAUDE modes */
  switchMode: (mode: TerminalMode): void => {
    getAPI()?.switchMode(mode);
  },

  /** Subscribe to PTY data output */
  onData: (callback: DataCallback): void => {
    getAPI()?.onData(callback);
  },

  /** Subscribe to mode change events */
  onModeChanged: (callback: ModeCallback): void => {
    getAPI()?.onModeChanged(callback);
  },

  /** Unsubscribe from PTY data output */
  removeDataListener: (callback: DataCallback): void => {
    getAPI()?.removeDataListener(callback);
  },

  /** Unsubscribe from mode change events */
  removeModeChangedListener: (callback: ModeCallback): void => {
    getAPI()?.removeModeChangedListener(callback);
  },
};
```

#### 3. Create useTerminal hook
**File**: `src/renderer/hooks/useTerminal.ts` (new file)

```typescript
import { useEffect, useCallback } from 'react';
import { terminalBridge } from '../services/terminalBridge';
import { useTerminalStore } from '../stores/terminalStore';
import type { TerminalMode } from '../types/terminal';

/**
 * Hook for terminal operations in React components.
 * Handles subscriptions with proper cleanup.
 */
export function useTerminal() {
  const { setMode, setConnected } = useTerminalStore();

  // Subscribe to mode changes from main process
  useEffect(() => {
    const handleModeChange = (mode: TerminalMode) => {
      setMode(mode);
    };

    terminalBridge.onModeChanged(handleModeChange);
    setConnected(terminalBridge.isAvailable());

    return () => {
      terminalBridge.removeModeChangedListener(handleModeChange);
    };
  }, [setMode, setConnected]);

  // Memoized actions
  const sendInput = useCallback((data: string) => {
    terminalBridge.sendInput(data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    terminalBridge.resize(cols, rows);
  }, []);

  return {
    sendInput,
    resize,
    onData: terminalBridge.onData,
    removeDataListener: terminalBridge.removeDataListener,
    isAvailable: terminalBridge.isAvailable(),
  };
}
```

#### 4. Create terminal store
**File**: `src/renderer/stores/terminalStore.ts` (new file)

```typescript
import { create } from 'zustand';
import { terminalBridge } from '../services/terminalBridge';
import type { TerminalMode } from '../types/terminal';

interface TerminalState {
  // State
  mode: TerminalMode;
  isConnected: boolean;
  dimensions: { cols: number; rows: number };

  // Actions
  setMode: (mode: TerminalMode) => void;
  setConnected: (connected: boolean) => void;
  setDimensions: (cols: number, rows: number) => void;
  switchMode: (mode: TerminalMode) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  // Initial state
  mode: 'SHELL',
  isConnected: false,
  dimensions: { cols: 80, rows: 24 },

  // Actions
  setMode: (mode) => set({ mode }),
  setConnected: (connected) => set({ isConnected: connected }),
  setDimensions: (cols, rows) => set({ dimensions: { cols, rows } }),

  switchMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode });
    terminalBridge.switchMode(mode);  // Uses bridge, not window
  },
}));
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles without errors
- [ ] No `window.terminalAPI` references outside of `terminalBridge.ts`
- [ ] Store and hook can be imported in components

#### Manual Verification:
- [ ] Store state updates correctly (verify via React DevTools)

---

## Phase 3: Build React Components

### Overview
Create React components using Radix UI for a polished, modern interface.

### Changes Required:

#### 1. Create global styles
**File**: `src/renderer/styles/global.css` (new file)

```css
:root {
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-tertiary: #1c1c1c;
  --border-color: #2a2a2a;
  --text-primary: #fafafa;
  --text-secondary: #a1a1a1;
  --accent-shell: #22d3ee;
  --accent-claude: #c084fc;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #root {
  height: 100%;
  overflow: hidden;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Scrollbar */
::-webkit-scrollbar {
  width: 8px;
}
::-webkit-scrollbar-track {
  background: var(--bg-primary);
}
::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--border-color);
}
```

#### 2. Create App component
**File**: `src/renderer/App.tsx` (new file)

```tsx
import { Flex } from '@radix-ui/themes';
import Header from './components/Header';
import Terminal from './components/Terminal';
import StatusBar from './components/StatusBar';
import { useTerminal } from './hooks/useTerminal';
import './styles/app.css';

export default function App() {
  // Initialize terminal connection and event subscriptions
  useTerminal();

  return (
    <Flex direction="column" height="100vh">
      <Header />
      <Terminal />
      <StatusBar />
    </Flex>
  );
}
```

#### 3. Create Header component with Radix Tabs
**File**: `src/renderer/components/Header/index.tsx` (new file)

```tsx
import { Flex, Text } from '@radix-ui/themes';
import * as Tabs from '@radix-ui/react-tabs';
import { useTerminalStore } from '../../stores/terminalStore';
import './styles.css';

export default function Header() {
  const { mode, switchMode } = useTerminalStore();

  return (
    <header className="header">
      <Tabs.Root value={mode} onValueChange={(v) => switchMode(v as 'SHELL' | 'CLAUDE')}>
        <Tabs.List className="tabs-list">
          <Tabs.Trigger value="SHELL" className="tab-trigger">
            <span className="indicator shell" />
            <Text size="2" weight="medium">Shell</Text>
          </Tabs.Trigger>
          <Tabs.Trigger value="CLAUDE" className="tab-trigger">
            <span className="indicator claude" />
            <Text size="2" weight="medium">Claude</Text>
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      <Text size="1" className="app-title">Console-1</Text>
    </header>
  );
}
```

**File**: `src/renderer/components/Header/styles.css` (new file)

```css
.header {
  height: 48px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  -webkit-app-region: drag;
}

.tabs-list {
  display: flex;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.tab-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-trigger:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.tab-trigger[data-state="active"] {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: background 0.15s ease;
}

.tab-trigger[data-state="active"] .indicator.shell {
  background: var(--accent-shell);
  box-shadow: 0 0 8px var(--accent-shell);
}

.tab-trigger[data-state="active"] .indicator.claude {
  background: var(--accent-claude);
  box-shadow: 0 0 8px var(--accent-claude);
}

.app-title {
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
}
```

#### 4. Create Terminal component
**File**: `src/renderer/components/Terminal/index.tsx` (new file)

```tsx
import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminal } from '../../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { setDimensions, mode } = useTerminalStore();
  const { sendInput, resize, onData, removeDataListener } = useTerminal();

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      fitAddonRef.current.fit();
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims) {
        setDimensions(dims.cols, dims.rows);
        resize(dims.cols, dims.rows);
      }
    }
  }, [setDimensions, resize]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    // Create terminal instance
    const terminal = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#fafafa',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#364559',
        black: '#0a0a0a',
        red: '#ff6b6b',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#fafafa',
        brightBlack: '#6b7280',
        brightRed: '#ff8a8a',
        brightGreen: '#6ee7a0',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
    });

    // Load addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    // Mount terminal
    terminal.open(containerRef.current);
    fitAddon.fit();

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle terminal input - uses hook's sendInput
    terminal.onData((data) => {
      sendInput(data);
    });

    // Handle PTY output - uses hook's onData
    const handleData = (data: string) => {
      terminal.write(data);
    };
    onData(handleData);

    // Initial resize
    setTimeout(handleResize, 100);

    // Resize observer for container
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Window resize handler
    window.addEventListener('resize', handleResize);

    // Focus terminal
    terminal.focus();

    // Log successful mount for debugging
    console.log('[Terminal] Successfully mounted and connected');

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      removeDataListener(handleData);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [handleResize, sendInput, onData, removeDataListener]);

  // Clear terminal on mode change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.clear();
      terminalRef.current.focus();
    }
  }, [mode]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      data-testid="terminal-container"
    />
  );
}
```

**File**: `src/renderer/components/Terminal/styles.css` (new file)

```css
.terminal-container {
  flex: 1;
  background: var(--bg-primary);
  padding: 8px;
  overflow: hidden;
}

.terminal-container .xterm {
  height: 100%;
}

.terminal-container .xterm-viewport {
  overflow-y: auto !important;
}

.terminal-container .xterm-screen {
  padding: 4px;
}
```

#### 5. Create StatusBar component
**File**: `src/renderer/components/StatusBar/index.tsx` (new file)

```tsx
import { Flex, Text } from '@radix-ui/themes';
import { useTerminalStore } from '../../stores/terminalStore';
import './styles.css';

export default function StatusBar() {
  const { mode, isConnected, dimensions } = useTerminalStore();

  return (
    <footer className="status-bar">
      <Flex gap="4" align="center">
        <span className={`status-indicator ${isConnected ? 'connected' : ''}`} />
        <Text size="1" className={`mode-label ${mode.toLowerCase()}`}>
          {mode}
        </Text>
      </Flex>

      <Text size="1" className="dimensions">
        {dimensions.cols} x {dimensions.rows}
      </Text>
    </footer>
  );
}
```

**File**: `src/renderer/components/StatusBar/styles.css` (new file)

```css
.status-bar {
  height: 28px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
}

.status-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
}

.status-indicator.connected {
  background: #4ade80;
  box-shadow: 0 0 6px #4ade80;
}

.mode-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.mode-label.shell {
  color: var(--accent-shell);
}

.mode-label.claude {
  color: var(--accent-claude);
}

.dimensions {
  color: var(--text-secondary);
  font-family: monospace;
}
```

#### 6. Create App styles
**File**: `src/renderer/styles/app.css` (new file)

```css
/* Additional app-level styles */
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` compiles without errors
- [ ] No TypeScript errors in components

#### Manual Verification:
- [ ] Header renders with Shell/Claude tabs
- [ ] Clicking tabs switches mode
- [ ] Terminal container is visible
- [ ] StatusBar shows mode and dimensions

---

## Phase 4: Configure Electron for Vite

### Overview
Update Electron main process to work with Vite dev server in development and built files in production.

### Changes Required:

#### 1. Install additional dev dependencies
```bash
npm install -D concurrently wait-on electron-is-dev
```

#### 2. Update window-manager.ts
**File**: `src/main/window-manager.ts`

```typescript
import { BrowserWindow } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
    const isDev = process.env.NODE_ENV === 'development';

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        webPreferences: {
            preload: path.join(__dirname, '../../../dist/preload/preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}
```

#### 3. Update package.json
**File**: `package.json`

```json
{
  "name": "console-1",
  "version": "1.0.0",
  "description": "A terminal wrapper with Claude Code integration",
  "main": "dist/main/main/index.js",
  "scripts": {
    "dev": "concurrently -k \"npm run dev:vite\" \"npm run dev:electron\"",
    "dev:vite": "vite --config vite.config.ts",
    "dev:electron": "wait-on http://localhost:5173 && NODE_ENV=development electron .",
    "build": "npm run build:main && npm run build:preload && npm run build:renderer",
    "build:main": "tsc -p tsconfig.main.json",
    "build:preload": "tsc -p tsconfig.preload.json",
    "build:renderer": "vite build --config vite.config.ts",
    "start": "electron .",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@radix-ui/react-tabs": "^1.0.4",
    "@radix-ui/themes": "^3.0.0",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-web-links": "^0.12.0",
    "@xterm/xterm": "^6.0.0",
    "node-pty": "^1.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.41.0",
    "@types/node": "^20.11.19",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "concurrently": "^8.2.0",
    "electron": "^28.0.0",
    "typescript": "^5.3.3",
    "vite": "^5.1.0",
    "wait-on": "^7.2.0"
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run dev` starts both Vite and Electron
- [ ] `npm run build` compiles everything

#### Manual Verification:
- [ ] Dev mode shows React app with HMR working
- [ ] Production build loads correctly with `npm run build && npm start`

---

## Phase 5: Add Playwright E2E Tests

### Overview
Set up Playwright for visual verification that the terminal renders correctly.

### Changes Required:

#### 1. Install Playwright
```bash
npx playwright install
```

#### 2. Create Playwright config
**File**: `playwright.config.ts` (new file)

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 1,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {},
    },
  ],
});
```

#### 3. Create Electron test helper
**File**: `tests/e2e/helpers/electron.ts` (new file)

```typescript
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';

export async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../../dist/main/main/index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page };
}
```

#### 4. Create terminal rendering test
**File**: `tests/e2e/terminal.spec.ts` (new file)

```typescript
import { test, expect } from '@playwright/test';
import { launchElectron } from './helpers/electron';

test.describe('Terminal Rendering', () => {
  test('should render terminal container', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal container to exist
    const terminalContainer = page.locator('[data-testid="terminal-container"]');
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });

    // Wait for xterm canvas to render
    const xtermCanvas = page.locator('.xterm-screen canvas');
    await expect(xtermCanvas).toBeVisible({ timeout: 10000 });

    // Take screenshot for visual verification
    await page.screenshot({ path: 'tests/e2e/screenshots/terminal-rendered.png' });

    await app.close();
  });

  test('should display shell prompt', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal
    const terminalContainer = page.locator('[data-testid="terminal-container"]');
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });

    // Wait a bit for PTY to initialize and send prompt
    await page.waitForTimeout(2000);

    // Check that terminal has content (xterm rows)
    const xtermRows = page.locator('.xterm-rows');
    await expect(xtermRows).toBeVisible();

    // Take screenshot showing prompt
    await page.screenshot({ path: 'tests/e2e/screenshots/shell-prompt.png' });

    await app.close();
  });

  test('should switch modes via tabs', async () => {
    const { app, page } = await launchElectron();

    // Wait for app to load
    await page.waitForSelector('[data-testid="terminal-container"]', { timeout: 10000 });

    // Click Claude tab
    const claudeTab = page.locator('button:has-text("Claude")');
    await claudeTab.click();

    // Verify mode changed in status bar
    const modeLabel = page.locator('.mode-label');
    await expect(modeLabel).toHaveText('CLAUDE');

    // Take screenshot of Claude mode
    await page.screenshot({ path: 'tests/e2e/screenshots/claude-mode.png' });

    // Switch back to Shell
    const shellTab = page.locator('button:has-text("Shell")');
    await shellTab.click();
    await expect(modeLabel).toHaveText('SHELL');

    await app.close();
  });

  test('should handle terminal input/output', async () => {
    const { app, page } = await launchElectron();

    // Wait for terminal
    await page.waitForSelector('.xterm-screen canvas', { timeout: 10000 });
    await page.waitForTimeout(1000); // Wait for PTY

    // Type a simple command
    await page.keyboard.type('echo "Hello from Playwright"');
    await page.keyboard.press('Enter');

    // Wait for output
    await page.waitForTimeout(500);

    // Take screenshot showing command and output
    await page.screenshot({ path: 'tests/e2e/screenshots/terminal-io.png' });

    await app.close();
  });
});
```

#### 5. Create screenshots directory
```bash
mkdir -p tests/e2e/screenshots
```

#### 6. Add .gitignore entries
**File**: `.gitignore` (append)

```
# Playwright
tests/e2e/screenshots/
test-results/
playwright-report/
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run test:e2e` runs without configuration errors
- [ ] All 4 tests pass
- [ ] Screenshots are generated in `tests/e2e/screenshots/`

#### Manual Verification:
- [ ] Review screenshots to confirm terminal renders correctly
- [ ] Screenshots show: terminal canvas, shell prompt, mode switching, command I/O

---

## Phase 6: Clean Up Old Files

### Overview
Remove deprecated renderer files that are no longer needed.

### Changes Required:

#### 1. Remove old renderer files
Delete:
- `src/renderer/index.ts` (replaced by React components)
- `src/renderer/types.d.ts` (moved to `src/renderer/types/terminal.ts`)
- `src/renderer/styles/main.css` (replaced by `global.css` and component styles)

#### 2. Update tsconfig.renderer.json
**File**: `tsconfig.renderer.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/renderer/**/*"],
  "exclude": ["node_modules"]
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` still works after cleanup
- [ ] No references to deleted files remain

#### Manual Verification:
- [ ] Application runs correctly after cleanup

---

## Testing Strategy

### E2E Tests (Playwright):
1. Terminal container renders
2. xterm canvas is visible
3. Shell prompt appears
4. Mode switching works
5. Terminal I/O works

### Manual Testing Steps:
1. Run `npm run dev` - verify HMR works
2. Run `npm run build && npm start` - verify production build
3. Run `npm run test:e2e` - verify all tests pass
4. Review screenshots in `tests/e2e/screenshots/`
5. Test mode switching by clicking tabs
6. Type commands and verify output

## File Structure After Implementation

```
src/renderer/
├── index.html              # Minimal HTML entry
├── main.tsx                # React entry point
├── App.tsx                 # Main app component
├── components/
│   ├── Header/
│   │   ├── index.tsx
│   │   └── styles.css
│   ├── Terminal/
│   │   ├── index.tsx
│   │   └── styles.css
│   └── StatusBar/
│       ├── index.tsx
│       └── styles.css
├── hooks/
│   └── useTerminal.ts      # Terminal hook (uses bridge)
├── services/
│   └── terminalBridge.ts   # ONLY file that accesses window.terminalAPI
├── stores/
│   └── terminalStore.ts    # Zustand store (uses bridge)
├── types/
│   └── terminal.ts         # TypeScript types
└── styles/
    ├── global.css          # Global styles
    └── app.css             # App-level styles

tests/e2e/
├── helpers/
│   └── electron.ts         # Electron test helper
├── screenshots/            # Generated screenshots
└── terminal.spec.ts        # E2E tests

vite.config.ts              # Vite configuration
playwright.config.ts        # Playwright configuration
```

### Architecture Note: Terminal Bridge Pattern

```
┌─────────────────────────────────────────────────────────────┐
│  Components (Header, Terminal, StatusBar)                   │
│  - Use useTerminal() hook                                   │
│  - Use useTerminalStore() for state                         │
│  - NEVER access window.terminalAPI                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│  useTerminal hook + Zustand store                           │
│  - Provide clean React-friendly API                         │
│  - Handle subscriptions and cleanup                         │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│  terminalBridge.ts (SINGLE SOURCE)                          │
│  - Only file that touches window.terminalAPI                │
│  - Easy to mock for testing                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│  window.terminalAPI (from Electron preload)                 │
└─────────────────────────────────────────────────────────────┘
```

## References

- Current renderer: `src/renderer/index.ts`
- Terminal service: `src/main/TerminalService.ts`
- IPC handlers: `src/main/ipc-handlers.ts`
- Preload script: `src/preload/preload.ts`
- Research: `research/2026-02-03-xterm-rendering-investigation.md`
