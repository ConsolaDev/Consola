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
  `WorkspaceChange`, `readOutboxMessage`), and how it delivers them: the
  path, the signed body, and what each answer means (`OUTBOX_DELIVERY_PATH`,
  `OUTBOX_MESSAGE_TYPE`, `OUTBOX_ANSWER`, `readOutOfOrderAnswer`);
- a cell's signed request to `cloud-global` for a GitHub token
  (`GitHubTokenRequest`, `gitHubTokenRequest`, `readGitHubTokenRequest`,
  `GITHUB_TOKEN_PURPOSES`), the one thing a cell sends `cloud-global`.

It holds no signing, no verifying and no delivery. Minting and signing the
token are `cloud-global`'s (issue 5.3), checking its signature and its region
the cell's (5.4). The outbox table, signing a message and the worker that
delivers it are `cloud-global`'s (6.1); checking a delivery's signature,
applying its message, and checking its region and its order are the cell's
(6.2). Signing a request for a GitHub token is the cell's (9.4); checking it,
and minting, are `cloud-global`'s (14.3).

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

Everything that crosses between the apps is read with its reader:
`readCellTokenClaims(payload, nowSeconds)` for a token's claims,
`readOutboxMessage(value)` for a message and
`readGitHubTokenRequest(payload, nowSeconds)` for a cell's request, each once
its signature is checked, and `readOutOfOrderAnswer(value)` for a cell's
`outOfOrder` answer. Each
returns `{ ok: true, value }` or `{ ok: false, reason }`, and never throws on
what it reads.

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

### Delivering a message

- **One message a request**: `POST` to `OUTBOX_DELIVERY_PATH` on the cell's
  origin. It is the one route of a cell's, besides its health check, that
  carries no cell token: a delivery is no person's request, and its
  signature is what says it is `cloud-global`'s.
- **The body is the message, signed**: its JSON as the payload of a JWS in
  compact serialization (RFC 7515), sent as `OUTBOX_DELIVERY_MEDIA_TYPE`
  (`application/jose`). The protected header holds `alg`
  (`CELL_TOKEN_ALGORITHM`), the signing key's `kid`, and `typ`
  (`OUTBOX_MESSAGE_TYPE`), and nothing a cell must understand beyond them.
- **The key is the cell token's.** `cloud-global` signs with
  `CELL_TOKEN_PRIVATE_KEY`, and a cell checks against the key set it already
  fetches from `CELL_TOKEN_KEYS_PATH`, picking the key by `kid`, allowing
  `CELL_TOKEN_ALGORITHM` alone and refusing any other `typ`. One key means one
  secret to configure and one rotation. Neither can pass for the other: a cell
  token's claims are no message `readOutboxMessage` takes, and a message names
  no `aud`, so no cell takes it for a token.
- **No time in it.** A message is applied once, by its sequence, so one sent
  again, or captured and sent later, changes nothing a cell has applied.
- **The answers** are `OUTBOX_ANSWER`'s, by status: `applied` (200) when the
  cell has the message, applied now or before; `unreadable` (400);
  `unsigned` (401); `outOfOrder` (409), whose body
  (`readOutOfOrderAnswer`) names the sequence the cell applies next;
  `otherRegion` (421); and `unavailable` (503) when the cell cannot get the
  keys or its database. A cell checks in that order: the signature, then the
  message, then its region, then its sequence.
- **`cloud-global` takes a 2xx alone as confirmation**, and retries every
  other answer, a refusal or a failed connection included, waiting longer
  each time. It never skips a message, and a workspace's next message waits
  until this one is confirmed, so the order per workspace is kept. A refusal
  that never clears holds up its workspace alone, where it can be seen.

### A cell's request for a GitHub token

**Proposed** (14.3, CON-71), not yet confirmed. `cloud-global` holds the
GitHub App's key and mints; the cell holds the work a token is for, and asks.

- **The request** is `GitHubTokenRequest`: `aud` (always
  `GITHUB_TOKEN_REQUEST_AUDIENCE`, `consola-global`), `workspaceId`,
  `installationId`, `purpose` (one of `GITHUB_TOKEN_PURPOSES`: `review-run`,
  `factory-pull`, `factory-save`), `repositoryIds` (GitHub's ids, which a
  rename keeps), `iat` and `exp`. It names no permissions: `cloud-global`
  gives each purpose fixed ones, and the request cannot widen them. Build it
  with `gitHubTokenRequest`, which throws on what the reader would refuse.
- **The workspace is the one the cell serves**: the `ws` of the caller's cell
  token, or the workspace of the factory or run the cell holds, never one a
  request to the cell names. `cloud-global` checks it holds the installation
  and is in the signing cell's region.
- **Signed by the cell, with a key of its own**: the request's JSON as the
  payload of a compact JWS, with `alg` `CELL_TOKEN_ALGORITHM`, the cell's
  key's `kid` (its JWK thumbprint) and `typ` `GITHUB_TOKEN_REQUEST_TYPE` in
  the protected header. `cloud-global` holds each region's public key in its
  configuration (`CELL_PUBLIC_KEY_<REGION>`), never its private half, so the
  key that checks a request says which cell sent it. Nothing `cloud-global`
  signs passes for one: its key is no cell's, a cell token names another
  `aud`, and an outbox message another `typ` and no `aud`.
- **A minute at most** (`GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS`): a cell signs
  one for each request it sends. The reader refuses one that lives longer,
  one signed in the future and one that has expired, each allowing
  `CLOCK_SKEW_SECONDS`.
- **The reader checks the shape only.** How many repositories a purpose may
  name, and that none is named twice, are `cloud-global`'s rules, which name
  each problem.
- **Where it goes** is `cloud-global`'s API, `POST /api/github/tokens`
  `{ request }`, declared in its OpenAPI contract with every answer, so a
  cell's client is generated from `apps/cloud-global/openapi.json` like any
  other.

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
