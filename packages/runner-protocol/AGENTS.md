# AGENTS.md

This file guides coding agents working in `packages/runner-protocol`
(`@consola/runner-protocol`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/runner-protocol`.

## What it is

What a runner (`consola-host runner`) and a regional cell (`apps/cloud-region`)
say to each other, written once so that neither keeps its own copy:

- the messages over the runner's socket. Runner to cell: `hello`
  (`runnerId`, the `repositories` and `harnesses` it offers, the
  `runningSessionIds` it still holds, and `endedSessions`, the sessions that
  ended while the socket was down, each with its real end) and
  `session.update` (`status`, `hostUrl`, `title`, `error`). Cell to runner:
  `session.start` and `session.stop`. Read with `readRunnerMessage` and
  `readCellMessage`;
- the session pass both sides check: `PASS_AUDIENCE`, `PASS_TYPE` (the JWS
  `typ`), `PASS_MAX_LIFETIME_SECONDS`, `PassClaims`, `passClaims` (builds the
  claims, throws on a grant the reader would refuse) and `readPassClaims`;
- the start script's own line, `StartScriptLine` (`exit` with `clone-failed`),
  read with `readStartScriptLine`. It is not one of the host's lines.

It signs nothing and verifies nothing. The cell signs a pass; the host checks
its signature, the time against now (`exp <= now` is expired, and the clock
skew applies to `iat` only) and `sid`.

The cell and the host import it, from any layer (the cell's `domain` and
`application` included). It is MIT, with its own `LICENSE`, because people who
run their own runners build against it (root `AGENTS.md`, Licensing). It must
not import from `apps/*` or any other workspace package.

## The rule

The package does no I/O, so inner layers can import it:

- a source file imports only other source files in `src/`: no package, no
  `node:` builtin, no test code. `package.json` has no `dependencies`;
- it refers to no global that reaches the machine (`MACHINE_GLOBALS` in
  `src/boundary.test.ts`): the process, the network, `crypto`, `console`, the
  clock and the timers. Globals that do no I/O (`URL`, `Number`, `JSON`) are
  fine;
- `src/index.ts` holds only `export … from`;
- `src/read.ts` is this package's own copy of the readers' helpers, since it
  may import no workspace package, `@consola/cloud-contract` included.

`src/boundary.test.ts` enforces it from the syntax tree, like
`cloud-contract`'s.

## Reading what the other side sent

Each reader returns `{ ok: true, value }` or `{ ok: false, reason }`, and never
throws on what it reads.

- **Strict.** A missing field, a field the protocol does not name, a `type` it
  does not know, a repository that is not `owner/name` (no `.` or `..` name, no
  name starting with `.`) and a `hostUrl` that is not an origin are refused.
  `hostUrl` is exactly what `exposePort` gives: `https:`, or `http:` for
  `127.0.0.1`, `localhost` and `[::1]` (local sandboxes), with no user info,
  path, query or fragment. `ws:` and `wss:` are refused.
- **Reasons name the field, never its contents**, so a reason can be logged.
  Branch on `ok`, never on a reason's wording.
- **Sessions that ended while the socket was down** ride in `hello`'s
  `endedSessions`. The cell applies them before it judges `runningSessionIds`,
  so a session that ended keeps its real end instead of becoming "the runner
  restarted".

## Changing the protocol

The cell and the runner deploy apart and every reader refuses what it does not
know, so the side that reads goes first: add a field or a message to the
reader and its handling, then to the sender. Removing one goes the other way.

## Building and using it

Consumers import its build (`dist/`). `pnpm --filter @consola/runner-protocol
build` after changing it; Turborepo builds it before a dependent's tasks.

## Tests

A test sits beside its module. Each reader is tested on the value after
`JSON.stringify` and `JSON.parse`, with a case for every refusal.
