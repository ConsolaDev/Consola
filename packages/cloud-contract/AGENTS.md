# AGENTS.md

This file guides coding agents working in `packages/cloud-contract`
(`@consola/cloud-contract`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/cloud-contract`.

## What it is

What `cloud-global` and a regional cell (`cloud-region`) agree on, written
once so that neither keeps its own copy:

- the regions a workspace can be in (`REGIONS`, `isRegion`);
- the roles a person can have in a workspace (`WORKSPACE_ROLES`,
  `isWorkspaceRole`);
- the claims of the token `cloud-global` mints for a cell
  (`CellTokenClaims`, `cellTokenClaims`, `readCellTokenClaims`), and the
  algorithm, audience, lifetime and clock skew both sides use;
- the messages `cloud-global`'s outbox sends a cell (`OutboxMessage`,
  `WorkspaceChange`, `readOutboxMessage`).

It holds no signing, no verifying and no delivery. Minting and signing the
token are `cloud-global`'s (issue 5.3), checking its signature and its region
the cell's (5.4). The outbox table and its worker are `cloud-global`'s (6.1);
applying a message, checking its region and its order, and how delivery is
authenticated are the cell's (6.2).

Only the two cloud apps import it, from any of their layers, `domain` and
`application` included. It is AGPL-3.0-only, because only Consola's own apps
build against it; a contract outside parties compile against would be MIT
(root `AGENTS.md`, Licensing).

## The rule

The package does no I/O, so the apps' inner layers can import it:

- a source file imports only other source files in `src/`: no package, no
  `node:` builtin, no test code. `package.json` has no `dependencies`;
- it refers to no global that reaches the machine: the process and its module
  system, the network, storage, `crypto`, `console`, the clock and the timers
  (`Date`, `setTimeout`, …), `eval` and `Function`, and the global object by
  any name. The full list is `MACHINE_GLOBALS` in `src/boundary.test.ts`.
  Globals that do no I/O (`Number`, `Object`, `JSON`) are fine. A reader that
  needs the time is handed it (`nowSeconds`);
- `src/index.ts` is the entry point and holds only `export … from`. The
  package exports only it (`exports` in `package.json`), and the apps'
  boundary tests refuse a path inside it;
- no file, tests included, imports a workspace package (`@consola/*`) or
  leaves `src/`. Tests may use the machine and the `devDependencies`.

`src/boundary.test.ts` enforces all of it, from the TypeScript syntax tree,
like the apps' own boundary tests.

## Reading what the other side sent

Everything that crosses between the apps is read with its reader, after its
signature is checked: `readCellTokenClaims(payload, nowSeconds)` for a token's
claims, `readOutboxMessage(value)` for a message. Each returns
`{ ok: true, value }` or `{ ok: false, reason }`, and never throws on what it
reads.

- **Strict.** A field missing, a field the contract does not name, a role or
  region it does not list, or a change type it does not know is refused,
  never ignored. That keeps anything else about a person (an email, a name)
  from riding along to a cell, which holds no accounts.
- **Reasons name the field, never its contents**, so a reason can be logged.
  Branch on `ok`, never on a reason's wording.
- `cellTokenClaims` builds the claims `cloud-global` signs, and throws on a
  grant the cell's reader would refuse, so no such token is minted.

### The cell token

- A JWT signed with Ed25519: `alg` is `CELL_TOKEN_ALGORITHM` (`EdDSA`), and a
  cell allows that algorithm alone when it checks the signature.
- Its claims, by their JWT names: `aud` (always `CELL_TOKEN_AUDIENCE`, so a
  token minted with the same key for something else is no cell token), `sub`
  (the person's global id, never an email), `ws` (the workspace's id), `role`,
  `region`, `iat` and `exp`, in whole seconds.
- It lives `CELL_TOKEN_LIFETIME_SECONDS` (five minutes). A cell refuses one
  that lives longer, even when its signature is good, one minted in the future
  and one that has expired, each allowing `CLOCK_SKEW_SECONDS` between the
  clocks, so a cell takes a token until `exp` plus the skew and no longer.
- **The keys.** `cloud-global` holds the private key, from its configuration
  (`CELL_TOKEN_PRIVATE_KEY`, an Ed25519 JWK on one line), and never logs it or
  sends it anywhere. It publishes the public keys as a JSON Web Key Set at
  `CELL_TOKEN_KEYS_PATH`, on its own origin and without sign-in. Each key's
  `kid` is its JWK thumbprint (RFC 7638), and every token names its key's
  `kid` in its header. A cell fetches the set from `cloud-global` (`jose`'s
  `createRemoteJWKSet`, which caches it and fetches again for a `kid` it has
  not seen) and picks the key by `kid`. A key is rotated by publishing the
  new one beside the old until every token signed with the old has expired.
- A JWT library that checks the signature checks the times too, with its own
  tolerance (`jose`'s `clockTolerance` is 0 unless set). Give it
  `CLOCK_SKEW_SECONDS` and `CELL_TOKEN_AUDIENCE`, and the algorithm alone, so
  it agrees with the reader rather than adding a rule of its own.
- A role is one of `WORKSPACE_ROLES`, exactly one. Better Auth can keep
  several in one `member.role` (`admin,member`), so `cloud-global` maps what
  it stores to one role before it mints, and mints nothing for a role it
  cannot map.

### The outbox messages

- A message is `{ workspaceId, region, sequence, change }`, and `change.type`
  says which change: `workspace.created`, `member.added`,
  `member.role-changed` or `member.removed`. They hold ids and roles only.
- `region` is on every message, so a cell refuses another region's without
  knowing the workspace.
- `sequence` counts a workspace's messages: `FIRST_SEQUENCE` (1) for its
  first, which is always its `workspace.created`, then one more for each, in
  the order their changes committed. The reader refuses a `workspace.created`
  anywhere else, and any other change at 1. A cell applies a workspace's
  messages in sequence order, so one it has applied already changes nothing.

## Changing the contract

The two apps deploy apart, and every reader refuses what it does not know. So
the side that reads goes first:

- **Adding** a field, a claim or a change type: the cell's reader and its
  handling ship first. `cloud-global` sends it only once every cell accepts
  it.
- **Removing** one: `cloud-global` stops sending it first, and the reader
  drops it after.
- A rename is a removal and an addition.

A new region or role is an addition too: a cell must accept it before
`cloud-global` mints a token or sends a message that names it. A region also
needs its own running cell before any workspace is made in it.

## Building and using it

The apps import its build (`dist/`), not its source. Turborepo builds it
before any app task that depends on it (`build`, `test`, `typecheck` and
`dev` all depend on `^build` in `turbo.json`), so `pnpm dev:cloud`,
`pnpm dev:cloud-region` and `pnpm test` need nothing more. A direct
`pnpm --filter @consola/cloud-global …` does not build it: run
`pnpm --filter @consola/cloud-contract build` once first, and again after
changing it.

## Tests

A test sits beside its module and is named after it (`outbox.ts`,
`outbox.test.ts`). Each reader is tested on what the other side really sends:
the value as it is after `JSON.stringify` and `JSON.parse`. Every refusal has
its own case, and a new rule in a reader gets one too.
