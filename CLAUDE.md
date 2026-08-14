# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Consola?

Consola is an Electron desktop application that provides a structured AI-assisted development workflow around the Claude Code CLI. It features a multi-workspace tabbed interface where each session runs `claude` in an embedded terminal, alongside file exploration with git status integration and a git review panel.

**The CLI owns the conversation.** Consola does not reimplement chat, tool rendering, permissions, or history — it spawns `claude` in a PTY and renders it with xterm.js, so improvements to Claude Code arrive without any work here. Consola's job is the surrounding workspace: sessions, files, git, and layout.

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
- `TerminalService.ts` - One session's PTYs (claude + shell), prompt delivery
- `TerminalManager.ts` - Owns a TerminalService per session, forwards events
- `ScreenModel.ts` - Headless xterm mirroring what a PTY displays
- `ClaudeCli.ts` - Binary resolution, login environment, headless `claude -p`
- `ClaudeSessionIndex.ts` - Reads Claude's own transcripts and session index

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
- `terminalBridge.ts` - Session terminals and Claude CLI queries
- `dialogBridge.ts` - Native dialogs
- `fileBridge.ts` - File system reads
- `gitBridge.ts` - Git status

### Terminals Outlive Their Views

A PTY belongs to the main process and is keyed by `instanceId`. Unmounting a
session pane (switching tabs) tears down only the xterm view — the terminal
keeps running so background work continues. Only closing a session destroys it.

Remounting repaints from `ScreenModel.snapshot()`, escape sequences that
reconstruct the current screen exactly. Do not try to reason about a TUI from
the raw byte stream: Claude paints with cursor movement and overwrites in
place, so recent bytes are not the current screen. Ask the `ScreenModel`.

### Session Identity

Consola assigns each tab a UUID and launches `claude --session-id <uuid>` the
first time, then `--resume <uuid>` afterwards (`Session.hasStarted`). Reusing
`--session-id` for an existing session is an error, hence the two paths. If a
resume fails because the conversation is gone, `TerminalService` falls back to
a fresh session automatically — so never gate resuming on a local existence
check, Claude is the authority.

### Never Type Into a Confirmation Menu

Queued prompts are delivered only when the emulated screen shows an *empty*
composer and no confirmation markers (`CONFIRMATION_MARKERS`). Claude shows a
workspace trust gate on first launch in an unfamiliar folder, and typing into
it would answer it. Any future automated input must respect the same guard.

### Claude's Own Storage

`ClaudeSessionIndex` reads transcripts under `$CLAUDE_CONFIG_DIR/projects`
(falling back to `~/.claude`) — always honour that variable. Locate files by
probing each project directory for `<sessionId>.jsonl`; the directory-name
encoding is lossy and cannot be derived from a working directory. The
transcript is authoritative and `sessions-index.json` is a cache that lags.

### IPC Channels

All channel names are defined in `src/shared/constants.ts`. Key patterns:
- `terminal:*` - Session terminal lifecycle and events
- `claude:*` - Claude CLI queries (availability, session names)
- `file:*` - File operations
- `git:*` - Git status and commit message generation
- `dialog:*` - Native dialogs

Every terminal message carries `instanceId`; there is one terminal per session.

## Tech Stack

- **Electron 28** - Desktop framework
- **React 19** - UI (with react-router-dom hash routing)
- **Zustand** - State management
- **claude CLI** - AI integration, driven as a subprocess (not a library)
- **node-pty** - Pseudo-terminals (native; rebuilt for Electron on install)
- **@xterm/xterm** - Terminal rendering, plus `@xterm/headless` in the main process
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
