# Plan: Convert CLI to Electron Application

## Overview

Convert the existing CLI terminal wrapper into an Electron desktop application that provides a graphical interface with embedded terminal (xterm.js), supporting switching between Shell and Claude Code modes.

## Current State

- CLI tool using `node-pty` for terminal management
- Dual mode: Shell and Claude Code with escape sequence switching
- Files: `src/index.ts` (entry), `src/TerminalManager.ts` (core logic)

## New File Structure

```
src/
├── main/                      # Main process (Node.js)
│   ├── index.ts               # Electron entry point
│   ├── TerminalService.ts     # Refactored from TerminalManager.ts
│   ├── ipc-handlers.ts        # IPC communication
│   └── window-manager.ts      # Window creation
├── preload/
│   └── preload.ts             # Context bridge (IPC exposure)
├── renderer/                  # Renderer process (Browser)
│   ├── index.html             # UI structure
│   ├── index.ts               # xterm.js integration
│   └── styles/
│       └── main.css           # Dark theme styling
└── shared/                    # Shared types
    ├── types.ts               # TerminalMode, interfaces
    └── constants.ts           # IPC channel names
```

## Implementation Phases

### Phase 1: Project Setup
1. Install dependencies: `electron`, `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`
2. Create folder structure: `src/main`, `src/preload`, `src/renderer`, `src/shared`
3. Update `package.json` with Electron scripts and dependencies
4. Update `tsconfig.json` for Electron compatibility

### Phase 2: Shared Types & Constants
1. Create `src/shared/types.ts` with `TerminalMode` enum and interfaces
2. Create `src/shared/constants.ts` with IPC channel names

### Phase 3: Main Process
1. Create `src/main/TerminalService.ts` - refactor from `TerminalManager.ts`:
   - Remove stdin/stdout handling (xterm.js handles this)
   - Remove status bar rendering (now in UI)
   - Add event emitters for IPC
   - Keep PTY spawn logic for shell and claude
2. Create `src/main/window-manager.ts` - Electron window creation
3. Create `src/main/ipc-handlers.ts` - handle terminal input/output/resize/mode-switch
4. Create `src/main/index.ts` - Electron app entry point

### Phase 4: Preload Script
1. Create `src/preload/preload.ts` with `contextBridge` exposing:
   - `sendInput(data)` - send keystrokes to PTY
   - `resize(cols, rows)` - resize terminal
   - `switchMode(mode)` - change shell/claude mode
   - `onData(callback)` - receive PTY output
   - `onModeChanged(callback)` - mode change notifications

### Phase 5: Renderer Process
1. Create `src/renderer/index.html` with:
   - Header with mode tabs (Shell/Claude)
   - Terminal container
   - Status bar
2. Create `src/renderer/index.ts`:
   - Initialize xterm.js with FitAddon
   - Wire up IPC communication
   - Implement escape sequence handling for mode switching
   - Handle keyboard shortcuts (Cmd/Ctrl+1, Cmd/Ctrl+2)
3. Create `src/renderer/styles/main.css` - dark theme styling

### Phase 6: Testing & Polish
1. Test mode switching (buttons + escape sequences)
2. Test terminal resize handling
3. Test shell and Claude PTY lifecycle
4. Handle edge cases (window minimize/restore)

## Key Technical Details

### IPC Channels
- `terminal:data` - PTY output to renderer
- `terminal:input` - User input to PTY
- `terminal:resize` - Terminal dimension changes
- `mode:switch` - Request mode change
- `mode:changed` - Notify mode changed

### Mode Switching
- **UI**: Click Shell/Claude tabs
- **Keyboard**: Esc+s/1 for Shell, Esc+c/2 for Claude
- **Shortcuts**: Cmd/Ctrl+1 for Shell, Cmd/Ctrl+2 for Claude

### Future Multi-Instance Support
Architecture prepared with:
- Instance IDs in all IPC messages
- `terminalServices` Map for multiple instances
- Reserved session management channels

## Files to Modify

- `package.json` - Add Electron, xterm.js dependencies and scripts
- `tsconfig.json` - Adjust for Electron multiple entry points

## Files to Create

1. `src/shared/types.ts`
2. `src/shared/constants.ts`
3. `src/main/index.ts`
4. `src/main/TerminalService.ts`
5. `src/main/window-manager.ts`
6. `src/main/ipc-handlers.ts`
7. `src/preload/preload.ts`
8. `src/renderer/index.html`
9. `src/renderer/index.ts`
10. `src/renderer/styles/main.css`

## Files to Keep (for reference/later removal)

- `src/index.ts` - Original CLI entry (can be removed after migration)
- `src/TerminalManager.ts` - Reference for refactoring

## Verification

1. Run `npm run dev` to start Electron app
2. Verify shell mode works (type commands, see output)
3. Switch to Claude mode (click tab or Esc+c)
4. Verify Claude Code spawns and works
5. Switch back to shell mode
6. Test terminal resize (resize window)
7. Test keyboard shortcuts (Cmd+1, Cmd+2)
