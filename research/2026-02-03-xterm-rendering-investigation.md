---
date: 2026-02-03T18:00:00-08:00
git_commit: e987a18
branch: master
repository: consola
topic: "xterm.js rendering investigation"
tags: [research, codebase, xterm, electron, rendering]
status: complete
---

# Research: xterm.js Rendering Investigation

**Date**: 2026-02-03T18:00:00-08:00
**Git Commit**: e987a18
**Branch**: master
**Repository**: consola

## Research Question
Understand why the current xterm is not rendering in the application.

## Summary

The application is an Electron-based terminal wrapper that uses xterm.js for terminal rendering and node-pty for pseudo-terminal functionality. The research identified **three critical path configuration issues** that prevent the xterm terminal from rendering correctly:

1. **Preload script path is incorrect** - The BrowserWindow configuration references a non-existent path
2. **Renderer script path is incorrect** - The HTML references a path that doesn't match the compiled output structure
3. **xterm.js CSS path may be incorrect** - The relative path from HTML to node_modules may not resolve correctly

## Detailed Findings

### Architecture Overview

The application consists of four main components:

1. **Main Process** (`src/main/`) - Electron main process handling window creation, IPC, and terminal service
2. **Preload Script** (`src/preload/`) - Bridge between main and renderer using contextBridge
3. **Renderer Process** (`src/renderer/`) - xterm.js terminal UI
4. **Shared Types** (`src/shared/`) - Common types and constants

### Issue 1: Preload Script Path Configuration

**Location**: `src/main/window-manager.ts:15`

```typescript
webPreferences: {
    preload: path.join(__dirname, '../../preload/preload/preload.js'),
    ...
}
```

**Problem**: The preload path is constructed incorrectly.

- `__dirname` at runtime is `dist/main/main/` (because the compiled file is at `dist/main/main/window-manager.js`)
- The path `../../preload/preload/preload.js` resolves to `dist/main/preload/preload/preload.js`
- The actual preload file is at `dist/preload/preload/preload.js`

**Expected path**: `../../../dist/preload/preload/preload.js` from `dist/main/main/` or recalculate based on actual structure.

**Impact**: Without the preload script loading, `window.terminalAPI` is undefined in the renderer, causing all IPC communication to fail.

### Issue 2: Renderer Script Path Configuration

**Location**: `src/renderer/index.html:44`

```html
<script src="../../dist/renderer/index.js" type="module"></script>
```

**Problem**: The path is relative to the HTML file location.

- HTML file is at `src/renderer/index.html`
- The path `../../dist/renderer/index.js` resolves correctly to `dist/renderer/index.js`
- However, this path is correct. The HTML is loaded via `loadFile()` in `window-manager.ts:23`

**Verification**: This path appears correct when HTML is loaded from `src/renderer/index.html`.

### Issue 3: xterm.js CSS Path Configuration

**Location**: `src/renderer/index.html:9`

```html
<link rel="stylesheet" href="../../../node_modules/@xterm/xterm/css/xterm.css">
```

**Problem**: The relative path from `src/renderer/index.html` to `node_modules/`.

- From `src/renderer/`, going `../../../` leads to the parent of the project root
- The correct path should be `../../node_modules/@xterm/xterm/css/xterm.css` (two levels up)

**Impact**: Without xterm.css, the terminal canvas may not display correctly or at all.

### Issue 4: Import Map Configuration

**Location**: `src/renderer/index.html:10-18`

```html
<script type="importmap">
{
    "imports": {
        "@xterm/xterm": "../../../node_modules/@xterm/xterm/lib/xterm.mjs",
        "@xterm/addon-fit": "../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
        "@xterm/addon-web-links": "../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs"
    }
}
</script>
```

**Problem**: Same relative path issue - `../../../` is incorrect.

- The compiled renderer at `dist/renderer/index.js` uses ES modules
- The import map attempts to resolve `@xterm/xterm` etc.
- The paths have an extra `../` level

**Impact**: The xterm.js library and addons cannot be loaded, causing the terminal to fail to initialize.

### Build Output Structure

The TypeScript compilation produces the following structure:

```
dist/
├── main/
│   ├── main/           # Compiled from src/main/
│   │   ├── index.js
│   │   ├── window-manager.js
│   │   ├── ipc-handlers.js
│   │   └── TerminalService.js
│   └── shared/         # Compiled from src/shared/
├── preload/
│   ├── preload/        # Compiled from src/preload/
│   │   └── preload.js
│   └── shared/         # Compiled from src/shared/
└── renderer/
    └── index.js        # Compiled from src/renderer/
```

**Key observation**: The `rootDir` configuration in tsconfig files causes the directory structure to be preserved, leading to nested directories like `dist/main/main/`.

### File Reference Summary

| File | Location | Purpose |
|------|----------|---------|
| Main entry | `src/main/index.ts` | Electron app initialization |
| Window manager | `src/main/window-manager.ts:6-35` | BrowserWindow creation with incorrect preload path |
| IPC handlers | `src/main/ipc-handlers.ts` | Terminal service IPC setup |
| Terminal service | `src/main/TerminalService.ts` | node-pty management |
| Preload script | `src/preload/preload.ts` | contextBridge API exposure |
| Renderer entry | `src/renderer/index.ts` | xterm.js initialization |
| Renderer HTML | `src/renderer/index.html` | HTML with incorrect paths |
| CSS styles | `src/renderer/styles/main.css` | UI styling |
| Shared types | `src/shared/types.ts` | TypeScript interfaces |
| Shared constants | `src/shared/constants.ts` | IPC channel names |

### Code References

- `src/main/window-manager.ts:15` - Incorrect preload path configuration
- `src/renderer/index.html:9` - Incorrect xterm.css path
- `src/renderer/index.html:10-18` - Incorrect import map paths
- `src/renderer/index.html:44` - Renderer script path (appears correct)
- `src/renderer/index.ts:63` - `terminal.open(terminalContainer)` - xterm mounting point

### Terminal Initialization Flow

1. `src/main/index.ts:14-16` - App ready, creates window and sets up IPC
2. `src/main/window-manager.ts:7-20` - Creates BrowserWindow with webPreferences
3. `src/main/window-manager.ts:23` - Loads HTML from `src/renderer/index.html`
4. `src/preload/preload.ts:14-67` - Should expose `terminalAPI` to renderer (if loaded)
5. `src/renderer/index.ts:17-63` - Gets DOM elements, creates Terminal, mounts to container
6. `src/main/ipc-handlers.ts:34-35` - Starts terminal service, begins emitting data

### Configuration Files

- `package.json:5` - Main entry: `dist/main/main/index.js`
- `tsconfig.main.json:5-6` - Output to `./dist/main`, rootDir `./src`
- `tsconfig.preload.json:5-6` - Output to `./dist/preload`, rootDir `./src`
- `tsconfig.renderer.json:5-6` - Output to `./dist/renderer`, rootDir `./src/renderer`

## Open Questions

1. Has the application ever worked with the current configuration, or are these issues from the initial implementation?
2. Should the build system be restructured to flatten the output, or should paths be adjusted to match the current structure?
3. Is there a bundler (webpack, vite, esbuild) that should be used for the renderer to properly handle the xterm.js imports?
