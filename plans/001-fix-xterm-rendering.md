# Plan: Fix xterm.js Rendering Issues

**Status**: Ready for Implementation
**Priority**: High
**Created**: 2026-02-03
**Research**: [./research/2026-02-03-xterm-rendering-investigation.md](../research/2026-02-03-xterm-rendering-investigation.md)

## Overview

Fix the xterm.js terminal that is not rendering in the Electron application due to multiple path configuration issues. The terminal fails to display because the preload script cannot be loaded (breaking IPC) and the xterm.js CSS/modules cannot be resolved from the HTML file.

## Current State Analysis

The application has the following path resolution issues:

1. **Preload script path** (`src/main/window-manager.ts:15`): Points to `../../preload/preload/preload.js` from `dist/main/main/`, which resolves incorrectly
2. **xterm.css path** (`src/renderer/index.html:9`): Uses `../../../node_modules/...` but should be `../../node_modules/...`
3. **Import map paths** (`src/renderer/index.html:10-18`): Same incorrect `../../../` prefix for xterm module paths

### Key Discoveries:
- Compiled window-manager.js is at `dist/main/main/window-manager.js`
- Preload script is at `dist/preload/preload/preload.js`
- HTML is loaded from `src/renderer/index.html` (not compiled)
- The `rootDir` settings in tsconfig create nested output directories

## Desired End State

- The Electron application launches successfully
- The xterm.js terminal renders and displays in the terminal-container
- User input is sent to the PTY and output is displayed
- Mode switching between Shell and Claude works

### Verification:
```bash
npm run build && npm start
```
The terminal should display a working shell prompt.

## What We're NOT Doing

- Not restructuring the entire build system (keeping current tsconfig approach)
- Not adding a bundler (webpack/vite) for the renderer
- Not changing the overall architecture
- Not adding new features

## Implementation Approach

Fix paths in three locations to match the actual file structure at runtime. The changes are minimal and targeted.

---

## Phase 1: Fix Preload Script Path

### Overview
Correct the preload script path in window-manager.ts so Electron can load it and expose the terminalAPI to the renderer.

### Changes Required:

#### 1. Update preload path in window-manager.ts
**File**: `src/main/window-manager.ts`

**Current** (line 15):
```typescript
preload: path.join(__dirname, '../../preload/preload/preload.js'),
```

**Change to**:
```typescript
preload: path.join(__dirname, '../../../dist/preload/preload/preload.js'),
```

**Reasoning**:
- `__dirname` at runtime = `<project>/dist/main/main/`
- We need to reach `<project>/dist/preload/preload/preload.js`
- Path: `../../../dist/preload/preload/preload.js`
  - `../` → `dist/main/`
  - `../` → `dist/`
  - `../` → `<project>/`
  - `dist/preload/preload/preload.js` → target

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Open DevTools console - no "preload script not found" errors
- [ ] `window.terminalAPI` is defined in renderer console

---

## Phase 2: Fix xterm.js CSS and Import Map Paths

### Overview
Correct the relative paths in index.html for the xterm.css stylesheet and the ES module import map.

### Changes Required:

#### 1. Fix xterm.css path
**File**: `src/renderer/index.html`

**Current** (line 9):
```html
<link rel="stylesheet" href="../../../node_modules/@xterm/xterm/css/xterm.css">
```

**Change to**:
```html
<link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css">
```

**Reasoning**:
- HTML is at `src/renderer/index.html`
- node_modules is at `<project>/node_modules/`
- Path: `../../node_modules/...`
  - `../` → `src/`
  - `../` → `<project>/`
  - `node_modules/...` → target

#### 2. Fix import map paths
**File**: `src/renderer/index.html`

**Current** (lines 10-18):
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

**Change to**:
```html
<script type="importmap">
{
    "imports": {
        "@xterm/xterm": "../../node_modules/@xterm/xterm/lib/xterm.mjs",
        "@xterm/addon-fit": "../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
        "@xterm/addon-web-links": "../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs"
    }
}
</script>
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] No 404 errors for xterm.css in DevTools Network tab
- [ ] No module resolution errors in DevTools Console
- [ ] Terminal canvas element is visible in the DOM

---

## Phase 3: Verify End-to-End Functionality

### Overview
Verify the complete terminal functionality works after path fixes.

### Verification Steps:

1. **Build and run**:
   ```bash
   npm run build && npm start
   ```

2. **Check terminal rendering**:
   - Terminal container shows xterm canvas
   - Cursor is visible and blinking
   - Shell prompt appears

3. **Test input/output**:
   - Type a command (e.g., `ls`)
   - Output appears in terminal
   - Command history works (arrow keys)

4. **Test mode switching**:
   - Press Esc+c to switch to Claude mode
   - Press Esc+s to switch back to Shell mode
   - Click mode tabs in header

### Success Criteria:

- [ ] Terminal renders with proper styling (dark theme)
- [ ] Shell prompt displays
- [ ] User can type and execute commands
- [ ] Output displays correctly
- [ ] Mode switching works via keyboard shortcuts
- [ ] Mode switching works via tab clicks
- [ ] Window resize causes terminal to resize (fit addon)

---

## Testing Strategy

### Manual Testing Steps:
1. Run `npm run build` - verify no errors
2. Run `npm start` - app launches
3. Check DevTools Console for errors
4. Verify terminal prompt appears
5. Type `echo "hello"` and press Enter
6. Verify "hello" appears in output
7. Press Esc+c - verify mode switches to Claude
8. Press Esc+s - verify mode switches to Shell
9. Resize window - verify terminal adjusts

### Edge Cases:
- App launch with DevTools open (NODE_ENV=development)
- Rapid mode switching
- Large output (e.g., `cat /etc/passwd`)

## Summary of Changes

| File | Line(s) | Change |
|------|---------|--------|
| `src/main/window-manager.ts` | 15 | Fix preload path: `../../preload/...` → `../../../dist/preload/...` |
| `src/renderer/index.html` | 9 | Fix CSS path: `../../../node_modules/...` → `../../node_modules/...` |
| `src/renderer/index.html` | 13-15 | Fix import map paths: `../../../node_modules/...` → `../../node_modules/...` |

## References

- Research: `./research/2026-02-03-xterm-rendering-investigation.md`
- Preload script: `src/preload/preload.ts`
- Window manager: `src/main/window-manager.ts:6-35`
- Renderer HTML: `src/renderer/index.html`
- Terminal init: `src/renderer/index.ts:63`
