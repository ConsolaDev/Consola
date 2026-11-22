# AGENTS.md

This file guides coding agents working in `packages/sandbox` (`@consola/sandbox`).
`CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `AGENTS.md`. Paths below are relative to
`packages/sandbox`.

## What it is

One interface that every runner (desktop, headless, cloud) uses to start and
drive sandboxes, so the provider behind it can change without touching the
code that uses it. E2B is the first real provider; Modal, or Consola's own
sandboxes, can follow. A sandbox can be:

- created from a template (or image, in the provider's naming);
- asked to run a command, with its output streamed;
- read from and written to;
- asked to expose a port;
- stopped.

Anything more is a capability a provider declares (`pausing`, `snapshots`).
Beside the interface sit the contract every provider passes and an in-memory
fake provider for other packages' tests.

## Using it

- Build `Sandboxes` once, where the program wires itself together:
  `sandboxesFrom(provider)`. Hand `Sandboxes` around, never the provider. It
  checks every request before a provider sees it, refuses work for a sandbox
  that has stopped or is paused, stops each sandbox once, collects output, and
  turns every failure into a `SandboxError`.
- Prefer `withSandbox(options, use)`. It stops the sandbox however `use` ends;
  when both the work and the stop fail, it rejects with an `AggregateError`
  holding both, so a sandbox left running is never silent. Code that
  branches on a `SandboxError`'s code looks inside it then.
- A listener that throws is not called again, and its command is killed, so
  the result rejects at once with what it threw. A command that runs for long
  and is only listened to, such as a session's, sets `keepOutput: false`, so
  its output is not also kept in memory for a result nobody reads.
- A command is an argv, and no shell reads it. To run a script, name the shell
  (`['sh', '-c', script]`). Values that come from outside (an item, a branch
  name) go in as variables (`env`), never spliced into a script.
- Check a capability by its member (`if (sandboxes.pausing)`), or take it with
  `requireCapability(sandboxes, 'pausing')` where the work cannot go on
  without it. Never branch on which provider it is: a provider has no name or
  id to branch on, on purpose.
- Branch on a `SandboxError`'s `code`, never on its message. Messages are for
  people; for `provider`, the message is the provider's own.
- In a test, use the fake: `new FakeProvider({ templates, programs,
  capabilities, failCreate })`, then `sandboxesFrom(fake)`. A command runs the
  program registered under `argv[0]` (any other exits 127), so a test decides
  what each command prints and when it ends. A program that runs until stopped
  awaits `child.killed`, since the fake keeps no clock. The fake checks no
  command's folder (folders are only the paths of files), where a real
  provider fails a command whose folder is not there. `fake.sandboxes` says
  what was asked of it: each sandbox's template, variables, state, commands
  and exposed ports, and its files. `POSIX_PROGRAMS` holds stand-ins for the
  few POSIX tools the contract runs.

## The layers

The package is built in rings, and imports point inward only.

- `src/domain/` holds the values (`CreateSandboxOptions`, `Command`,
  `CommandResult`, `ExposedPort`), `SandboxError` and its codes,
  `SANDBOX_CAPABILITIES`, and in `rules.ts` the rules that every request and
  every answer from a provider keeps.
- `src/application/` holds the port, in `ports.ts` (`SandboxProvider` and the
  shapes it returns), and `sandboxes.ts` (`sandboxesFrom`,
  `requireCapability`). Every decision about a request is made there, once,
  for every provider.
- `src/contract/` holds the checks every provider passes. They use assertions
  of their own (`expect.ts`), not a test framework, so any test runner can run
  them.
- `src/providers/fake/` holds the in-memory provider and `POSIX_PROGRAMS`.
- `src/index.ts` is the entry point. It holds only `export … from`.
- A real provider lives in `src/providers/<name>/`, with an entry point of its
  own, `src/<name>.ts` (see below).

## The dependency rule

- Everything above but a real provider is the core, and the core does no I/O.
  It imports no package and no `node:` builtin, and refers to no global that
  reaches the machine: the process and its module system (`process`,
  `require`, `module`, `Buffer`, …), the network and storage (`fetch`,
  `WebSocket`, `localStorage`, …), `console`, the clock and the timers
  (`Date`, `setTimeout`, `AbortSignal`, …), code it cannot read (`eval`,
  `Function`), and the global object by any name (`globalThis`, `global`,
  `window`, `self`). The full list is `MACHINE_GLOBALS` in
  `src/boundary.test.ts`. Globals that do no I/O (`URL`, `TextEncoder`,
  `TextDecoder`, `Promise`) are fine.
- `domain` imports only `domain`. `application` imports `domain` and
  `application`. `contract` imports `domain`, `application` and `contract`.
  `providers/fake` imports `domain`, `application` and itself. `index.ts`
  re-exports the core, and never a real provider.
- A real provider imports `domain`, `application` and its own folder. It may
  import the packages listed in `dependencies` and reach the machine. It never
  imports another provider, the fake or the contract. Its entry point
  re-exports only its folder.
- No file imports a workspace package (`@consola/*`) or leaves `src/`, no
  file but a test imports test code (`*.test.ts`, `*.test-helpers.ts`), and
  every package a file imports is in `package.json` (`devDependencies` only
  in tests).
- Test files are exempt from the layer rules.

`src/boundary.test.ts` enforces all of it. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`,
`require()`, dynamic `import()`, `createRequire`), and the globals each core
file refers to: only a reference counts, never a property or a member that
shares the name. A file that sits in no layer fails it. The rules are data at
its top (`LAYERS`), so a new folder is added there first.

## Adding a provider

1. **Its folder.** Put it in `src/providers/<name>/`, the one place that
   imports its SDK. Add the SDK to `dependencies`. Add two entries to
   `LAYERS` in `src/boundary.test.ts`: the folder (reaching `domain`,
   `application` and itself, refusing nothing, no globals refused) and its
   entry point.
2. **Its entry point.** Export it from `src/<name>.ts`, which only
   re-exports the folder. `package.json` has only `main` and `types` so
   far: give it an `exports` map with `.` (`./dist/index.js`) and
   `./<name>` (`./dist/<name>.js`). Never export it from `src/index.ts`:
   code that only needs the interface, or the fake, must not load the SDK.
   Check that both an ESM (NodeNext) and a CommonJS consumer resolve it.
3. **Implement the port** (`SandboxProvider` in `src/application/ports.ts`).
   A provider translates and decides nothing: `sandboxesFrom` has already
   checked the request. What the contract holds it to, and what providers
   tend to get wrong:
   - every argument reaches the program verbatim. An SDK that takes a
     command line needs each argument quoted, and the contract's argument
     check fails a shell in between;
   - a non-zero exit resolves `wait`, never rejects it; a program that is not
     there exits 127; a command a signal ended (`kill`, the sandbox stopping)
     resolves with null;
   - all output reaches the listeners before `wait` settles;
   - `stop` ends the commands still running, and stopping again does
     nothing. After its own stop, every call on that handle rejects with
     `not-running`, so the provider keeps its own note that it stopped:
     some calls never ask the network (E2B's port address is worked out
     locally). A sandbox stopped from elsewhere (a timeout, another
     handle) rejects with `not-running` wherever the provider can tell;
   - a missing template, file or sandbox is `not-found`, a call on a stopped
     sandbox is `not-running`, and anything else either throws as it is
     (`sandboxesFrom` makes it a `provider` error with its message) or is a
     `provider` error with the provider's own words. Never put a key or a
     token in a message;
   - `exposePort` returns an http or https address: the same one each time
     for a port, a different one for each port and each sandbox.
   - Credentials come from configuration, handed to the provider's
     constructor where the program wires itself together. They are never
     committed, and never reach the core.
4. **Declare capabilities by implementing them.** A capability is its member
   (`pausing`, `snapshots`) and nothing else: no flag, no name. `pausing`
   keeps a sandbox's files and resumes it by its id from any process;
   `snapshots` returns a template name that `create` accepts, and removes
   it again, so the contract leaves no template behind.
5. **Pass the contract.** Add the provider to `PROVIDERS` in
   `src/contract.test.ts`, with `skipped` saying why when the variable that
   holds its credentials is unset (`E2B_API_KEY`, say), so a run without
   them, such as CI's, skips it rather than failing. Its template needs the
   programs in `CONTRACT_PROGRAMS` and a writable `/tmp`. Every check stops
   the sandboxes it starts, but real sandboxes are slow to start: give the
   suite a timeout to match.

## Adding a capability

1. Name it in `SANDBOX_CAPABILITIES`, and say what it lets code do in
   `CAPABILITY_ABILITIES` (`src/domain/capabilities.ts`).
2. Add the port's optional member in `src/application/ports.ts`. It takes
   sandbox ids, not handles.
3. Add the public member in `src/application/sandboxes.ts`: it checks that
   the handle is one of its own and running, calls the provider through
   `fromProvider`, and refuses an answer that breaks the port.
4. Implement it in the fake, behind `capabilities`.
5. Add contract checks with `needs` set to it. `src/contract.test.ts` fails
   while a capability has none.
6. Every provider that has it passes them.

## Tests

A test sits beside its module and is named after it. The rules in `domain`
are tested alone. `sandboxesFrom` is tested with a spy provider, which shows
that a refused request never reaches a provider, and with the fake. The fake
has its own tests, including a long-running command driven step by step, the
way a runner's tests drive it. `src/contract.test.ts` runs every check against
every provider, and shows that the contract fails providers broken in the
ways listed above. When a new check guards a new promise, add a broken
provider it catches.

## Licence

AGPL-3.0-only, like the automation engine: its providers are Consola's own.
If outside parties are ever meant to write providers against this interface,
the port and the contract move to an MIT package, since anything a third
party compiles against is MIT (root `AGENTS.md`, Licensing).
