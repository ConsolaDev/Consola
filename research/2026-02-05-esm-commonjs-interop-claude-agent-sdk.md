---
date: 2026-02-05T12:00:00+01:00
git_commit: bcf50be1b66d42aac0d84fe49cf5961878c7173c
branch: feature/multi-session-management
repository: console-1
topic: "ESM/CommonJS Interoperability for Claude Agent SDK"
tags: [research, esm, commonjs, typescript, electron, modules]
status: complete
---

# Research: ESM/CommonJS Interoperability for Claude Agent SDK

**Date**: 2026-02-05
**Git Commit**: bcf50be1b66d42aac0d84fe49cf5961878c7173c
**Branch**: feature/multi-session-management
**Repository**: console-1

## Research Question

How does the current `ClaudeAgentService` implementation handle ESM module compatibility, what is the root cause of the issue, and are there alternative approaches (including changing the build configuration)?

## Summary

The project uses a `new Function()` workaround to dynamically import an ESM-only package (`@anthropic-ai/claude-agent-sdk`) from a CommonJS main process. This is necessary because TypeScript transforms `import()` to `require()` when `"module": "commonjs"` is set. The workaround is valid but results in loss of type information. There are several alternatives, including using `import type` for type safety while keeping the dynamic import pattern, or converting the main process to ESM (which has significant implications for Electron app initialization timing).

## Root Cause Analysis

### The Problem

1. **SDK is ESM-only**: `@anthropic-ai/claude-agent-sdk` has `"type": "module"` in its `package.json`
2. **Main process is CommonJS**: `tsconfig.main.json` has `"module": "commonjs"`
3. **TypeScript transforms imports**: When compiling to CommonJS, TypeScript converts `import()` to `Promise.resolve(require())`, which cannot load ESM modules

### Why TypeScript Transforms `import()` to `require()`

When TypeScript is configured with `"module": "commonjs"`, it performs full module system transformation:

```typescript
// TypeScript source
const module = await import('@anthropic-ai/claude-agent-sdk');

// Compiled to CommonJS (approximately)
const module = Promise.resolve().then(() => __importStar(require('@anthropic-ai/claude-agent-sdk')));
```

The `require()` function is synchronous and designed for CommonJS modules. It cannot load ESM modules, causing `ERR_REQUIRE_ESM`.

### Current Workaround

`src/main/ClaudeAgentService.ts:115-124`:

```typescript
// Use Function constructor to prevent TypeScript from transforming import() to require()
const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<SDK>;

async function getSDK(): Promise<SDK> {
  if (!sdkModule) {
    // Dynamic import for ESM module compatibility
    sdkModule = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModule!;
}
```

**Why this works:**
- `new Function()` constructs the import statement at runtime as a string
- TypeScript cannot statically analyze code inside `new Function()`
- The actual Node.js runtime executes the true `import()` function

**Compiled output** (`dist/main/main/ClaudeAgentService.js:8`):
```javascript
const dynamicImport = new Function('modulePath', 'return import(modulePath)');
```

## Alternative Approaches

### Option 1: Keep CommonJS + `import type` for Type Safety (Recommended)

Use `import type` to get full type information while keeping the dynamic import pattern:

```typescript
// Type-only import (completely erased at compile time)
import type * as SDKTypes from '@anthropic-ai/claude-agent-sdk';

// Now you have full type safety
type SDK = typeof SDKTypes;
type SDKMessage = SDKTypes.Message; // or whatever the actual type is
type Options = Parameters<SDKTypes['query']>[0]['options'];

// Runtime: same dynamic import pattern
const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<SDK>;
```

**Pros:**
- Full IDE autocompletion and type checking
- No changes to build configuration
- Continues working with current setup

**Cons:**
- Still requires the `new Function()` workaround

### Option 2: Use `moduleResolution: "node16"` or `"nodenext"`

Change `tsconfig.main.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node16"  // or "nodenext"
  }
}
```

With this configuration, TypeScript may preserve `import()` calls in certain contexts. However, this is not guaranteed and depends on how the import is used.

**Pros:**
- More modern module resolution
- Better understanding of package exports

**Cons:**
- May not fully solve the problem for CommonJS output
- Requires testing

### Option 3: Convert Main Process to ESM

Change `tsconfig.main.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "node16"
  }
}
```

And add to `package.json`:
```json
{
  "type": "module"
}
```

**Critical Implications:**

1. **Asynchronous Module Loading**: ESM modules load asynchronously, which can cause timing issues with Electron's `ready` event

2. **Electron-specific concerns** (from Electron docs):
   > "Only side effects from the main process entry point's imports will execute before the ready event"

   > "If index.mjs calls import('./set-up-paths.mjs') at the top level, the app will likely already be ready by the time that dynamic import resolves."

3. **No `__dirname`/`__filename`**: Must derive from `import.meta.url`

4. **Preload script constraints**:
   - Preload scripts ignore `"type": "module"` in package.json
   - Must use `.mjs` extension
   - Sandboxed preload scripts cannot use ESM at all

**Pros:**
- Native ESM support
- No workarounds needed for ESM packages

**Cons:**
- Significant architectural changes
- Risk of timing issues with app initialization
- Affects preload scripts

### Option 4: Node.js 22+ `--experimental-require-module` Flag

Node.js 22+ has an experimental flag allowing `require()` of synchronous ESM modules.

```bash
node --experimental-require-module ./dist/main/index.js
```

**Pros:**
- Minimal code changes

**Cons:**
- Experimental feature
- Only works for synchronous ESM (no top-level await)
- Requires runtime flag

## Type Resolution Behavior

**Key insight**: TypeScript's type resolution is independent of the runtime module system.

| Import Style | Compile Output | Type Resolution | Works? |
|--------------|----------------|-----------------|--------|
| `import type * as X from 'pkg'` | Nothing (erased) | Via `types` field | Yes |
| `import { X } from 'pkg'` | `require()` | Via `types` field | No (runtime fails) |
| Dynamic `import()` | `require()` wrapper | N/A | No (runtime fails) |
| `new Function()` + `import()` | Preserved | Manual typing | Yes |

The `types` field in `package.json` is used for type resolution regardless of module format:

```json
// @anthropic-ai/claude-agent-sdk/package.json
{
  "type": "module",
  "main": "sdk.mjs",    // Runtime: ESM
  "types": "sdk.d.ts"   // Types: accessible from any module system
}
```

## Current Project Configuration

**Main Process** (`tsconfig.main.json`):
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true
  }
}
```

**SDK Package** (`@anthropic-ai/claude-agent-sdk/package.json`):
```json
{
  "type": "module",
  "main": "sdk.mjs",
  "types": "sdk.d.ts"
}
```

**Electron Version**: 28.0.0 (supports ESM in main process)

## Code References

- `src/main/ClaudeAgentService.ts:115-124` - Current `new Function()` workaround
- `src/main/ClaudeAgentService.ts:4-8` - Manual type definitions (using `any`)
- `tsconfig.main.json:4` - `"module": "commonjs"` setting
- `dist/main/main/ClaudeAgentService.js:8` - Compiled dynamic import

## Recommendation

**For immediate improvement**: Use Option 1 - add `import type` to get full type safety:

```typescript
// Replace lines 3-10 in ClaudeAgentService.ts
import type * as SDKModule from '@anthropic-ai/claude-agent-sdk';

type SDK = typeof SDKModule;
type SDKMessage = /* extract from SDK types */;
type Options = /* extract from SDK types */;
```

This provides type safety without architectural changes.

**For future consideration**: Option 3 (ESM conversion) could be explored if:
- The app architecture can handle async initialization
- Preload scripts are adjusted accordingly
- Electron's ESM timing implications are tested

## Sources

- [ES Modules (ESM) in Electron | Electron](https://www.electronjs.org/docs/latest/tutorial/esm)
- [TypeScript: TSConfig Option: moduleResolution](https://www.typescriptlang.org/tsconfig/moduleResolution.html)
- [TypeScript Issue #52775: Difficult to call import function from CommonJS](https://github.com/microsoft/TypeScript/issues/52775)
- [ts-node Discussion #1290: Dynamic import with module: commonjs](https://github.com/TypeStrong/ts-node/discussions/1290)
- [Node.js ESM Documentation](https://nodejs.org/api/esm.html)
