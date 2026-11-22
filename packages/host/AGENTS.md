# AGENTS.md

This file guides coding agents working in `packages/host` (`@consola/host`).
`CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `CLAUDE.md`. Paths below are relative to
`packages/host`.

The host runs t3code's agent adapters (vendored under `vendor/t3code/`) for one
Consola session and serves t3's chat RPC to a browser.

## The rings

Imports point inward only; `src/boundary.test.ts` fails on any that does not.

- `src/core/` holds the pure decisions and the types they speak of: which
  commands are offered (`decideCommand`), whether a session pass's claims hold
  (`checkPassClaims`), when the host is idle (`isIdle`) and `SessionSpec`. No
  `node:` builtin, no `effect/process`, `ws` or `jose`, and no global that
  touches the machine (`process`, `fetch`, `WebSocket`, timers). It may name the
  vendored `@t3tools/contracts`.
- `src/runtime/` holds Effect services over the vendored t3 packages. It may
  import them and `core/`, never `adapters/`.
- `src/adapters/` is everything that touches the outside: the WebSocket server,
  verifying a pass's signature, process I/O. It may import `core/` and
  `runtime/`.
- `src/bin.ts` is the only wiring: it builds the adapters and hands them to the
  runtime.

To add a ring, add a row to `LAYERS` and a case to the table in
`boundary.test.ts`. Test files are exempt from the layer rules, but never import
another `@consola/*` package: the host stands alone.

## Vendored t3 code is imported, never copied

The agent adapters, contracts and chat RPC come from `vendor/t3code/` and are
imported by their package names. Never copy t3 code into `packages/host`, and
never edit a vendored file from here. A change to a vendored file is recorded in
`vendor/t3code/UPSTREAM.md` with its reason, in the same commit.

## Running it

```bash
pnpm --filter @consola/host test        # vp test run (Vite+), config in vite.config.ts
pnpm --filter @consola/host typecheck   # effect-tsgo, hoisted by publicHoistPattern
```

## Licensing

`@consola/host` is AGPL-3.0-only, Consola's own code. The vendored packages keep
t3's MIT licence (`vendor/t3code/LICENSE`).

- On a Mac the host runs the person's installed CLI with its existing login. It
  never shows a sign-in, never reads or stores a CLI's credentials, and passes
  `pathToClaudeCodeExecutable` for Claude, never the SDK's bundled copy.
- The Cursor SDK (`@cursor/sdk`) is never bundled into anything the host builds.
- Nothing that bundles `@anthropic-ai/claude-agent-sdk` is published or released
  (Linear CON-21). Local builds are fine.
- Fixtures and examples use Acme, Sprocket and the `sprocket` org, never real
  names.
