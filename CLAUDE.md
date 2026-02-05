# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Consola?

Consola is an Electron desktop application that provides a structured AI-assisted development workflow using the Claude Agent SDK. It features a multi-workspace tabbed interface with real-time streaming responses, file exploration with git status integration, and rich markdown rendering.

## Build & Development Commands

```bash
npm run dev              # Full dev environment (Vite + Electron with HMR)
npm run build            # Production build (all processes)
npm start                # Run production build
npm run test:e2e         # Run Playwright E2E tests
```

Individual builds:
```bash
npm run build:main       # Main process only
npm run build:preload    # Preload script only
npm run build:renderer   # Renderer (Vite) only
```

## Architecture Overview

### Three-Process Structure

```
src/main/           → Electron main process (Node.js, CommonJS output)
src/preload/        → Context bridge (exposes APIs to renderer)
src/renderer/       → React frontend (Vite, ESM)
src/shared/         → Shared types and IPC channel constants
```

### Main Process Key Files
- `index.ts` - App lifecycle, window management
- `ipc-handlers.ts` - All IPC message routing
- `ClaudeAgentService.ts` - Claude SDK wrapper with streaming
- `SessionStorageService.ts` - Session persistence

### Renderer Organization
- `components/` - React components with co-located `styles.css`
- `stores/` - Zustand stores (agentStore, workspaceStore, navigationStore, etc.)
- `services/` - Bridge services for Electron API access
- `hooks/` - Custom React hooks

## Critical Patterns

### Electron IPC Bridge Pattern

**Always use bridge services** to access Electron APIs - never access `window.*API` directly.

```typescript
// Correct - use the bridge
import { dialogBridge } from '../../services/dialogBridge';
const result = await dialogBridge.selectFolder();

// Wrong - direct window access
const result = await window.dialogAPI.selectFolder();
```

Bridge services are in `src/renderer/services/`:
- `agentBridge.ts` - Claude agent operations
- `dialogBridge.ts` - Native dialogs
- `fileBridge.ts` - File system reads
- `gitBridge.ts` - Git status
- `sessionStorageBridge.ts` - Session persistence

### ESM/CJS Interop for claude-agent-sdk

The SDK is ESM-only but main process outputs CommonJS. Use this pattern:

```typescript
// Type-only imports (erased at compile time)
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Runtime dynamic import (bypasses TS import() -> require() transform)
const dynamicImport = new Function('modulePath', 'return import(modulePath)');
const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
```

### IPC Channels

All channel names are defined in `src/shared/constants.ts`. Key patterns:
- `agent:*` - Claude agent communication
- `file:*` - File operations
- `git:*` - Git status
- `dialog:*` - Native dialogs
- `session:*` - Session management

### Multi-Instance Support

The architecture supports multiple agent instances via `instanceId` in all IPC messages. Currently uses `DEFAULT_INSTANCE_ID` for single-instance mode.

## Tech Stack

- **Electron 28** - Desktop framework
- **React 19** - UI (with react-router-dom hash routing)
- **Zustand** - State management
- **@anthropic-ai/claude-agent-sdk** - AI integration
- **@radix-ui/themes** - Component library
- **Vite** - Build tool (dev server at localhost:5173)
- **Playwright** - E2E testing

## Build Outputs

- Main: `dist/main/main/index.js`
- Preload: `dist/preload/preload/preload.js`
- Renderer: `dist/renderer/`

## Research Documents

Architecture decisions are documented in `research/`:
- `2026-02-05-esm-commonjs-interop-claude-agent-sdk.md` - SDK integration
- `2026-02-05-git-status-file-explorer.md` - Git feature design
- `2026-02-03-workspace-feature-architecture.md` - Workspace system
