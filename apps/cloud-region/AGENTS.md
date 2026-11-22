# AGENTS.md

This file guides coding agents working in `apps/cloud-region`, Consola Cloud's
regional cell. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads
it too. The repository's guide is the root `AGENTS.md`, and setup is in
`README.md`. Paths below are relative to `apps/cloud-region`.

## What the cell is

The control plane has a global part, `cloud-global` (`apps/cloud-global`), and
one cell per region. Each region runs a copy of this app, configured with its
region (`REGION`, `eu` or `us`) and given a database of its own, never
`cloud-global`'s, so the global side cannot read regional data.

- **The cell holds no accounts.** People, sign-in, sessions, workspaces and
  their members are `cloud-global`'s. A cell refers to a person by their global
  id (the id `cloud-global` gives them), never by an email, and keeps no copy
  of an account. No file imports Better Auth, and no table is named after one
  of its tables (`user`, `session`, `account`, `verification`, `member`,
  `invitation`). What it does keep is a copy of which workspaces are in its
  region and who their members are, ids and roles only, from `cloud-global`'s
  outbox (below, "The outbox").
- **Every table carries the workspace id**: a not-null `workspace_id`, the
  workspace's id in `cloud-global`.
- **The cell does hold the workspace's content.** Under the Warp model
  (decided 2026-11-22), Consola hosts the runners and keeps what a workspace
  makes, such as its factory files and runs, so that content lives here, in
  the workspace's region.
- **The cell trusts only `cloud-global`'s token.** Every request but
  `GET /api/health` and the outbox's deliveries (`POST /api/outbox`, signed
  with the same key) carries a cell token `cloud-global` minted, and the cell
  learns who is asking, in which workspace, from that token and nothing else
  (below, "Who is asking").

The cell listens on `127.0.0.1:3101` by default, beside `cloud-global`'s 3100.
`PORT` moves it, so two cells (`eu` and `us`) can run on one machine.
`CLOUD_GLOBAL_URL` (default `http://127.0.0.1:3100`) is where it fetches
`cloud-global`'s keys.

## Who is asking

A request names its caller with `Authorization: Bearer <cell token>`, the
token whose claims `packages/cloud-contract` defines (read its "The cell
token" first). Nothing else counts: not a query parameter, a cookie or another
header.

- **The check.** A token is accepted only if jose verifies it with
  `cloud-global`'s public keys (`CELL_TOKEN_ALGORITHM` alone,
  `CELL_TOKEN_AUDIENCE`, `CLOCK_SKEW_SECONDS`), the contract's
  `readCellTokenClaims` reads its claims, both at one moment from the
  `Clock`, and then only if its `region` is the cell's own. A token must name
  its key's `kid`, and its `typ` must not be `OUTBOX_MESSAGE_TYPE`: the same
  key signs the outbox's deliveries, and a delivery is never a token, whatever
  its payload holds. `application/authenticate.ts` holds the steps,
  `domain/caller.ts` (`admitClaims`) the rule on the claims and the region, and
  `adapters/token` the signature check, behind the `TokenVerifier` port. Every
  constant comes from the contract; never retype one.
- **The answers.** No bearer credentials (no header, or another scheme) is
  401 with `WWW-Authenticate: Bearer` and `{"error":"token_required"}`. A
  token that is not accepted, malformed, forged, signed by another key, expired
  or with a claim the contract does not name, is 401 with
  `WWW-Authenticate: Bearer error="invalid_token"` and
  `{"error":"invalid_token"}`: getting a new token is the fix. A good token for
  a workspace in another region is 421 Misdirected Request with
  `{"error":"wrong_region","region":"<this cell's>"}`: no new token helps,
  sending it to the right cell does, and 403 stays free for what a role may not
  do. The region is judged only on a token that is otherwise accepted, so a
  bad one is always 401. When the keys cannot be had (`cloud-global` down, an
  answer that is no key set), every token is refused with 503 and
  `{"error":"token_check_unavailable"}`, never let through, and the cell logs
  why, never the token. No answer says more than these.
- **The keys.** `cloudGlobalKeys` is jose's `createRemoteJWKSet` on
  `CELL_TOKEN_KEYS_PATH` at `CLOUD_GLOBAL_URL`. It keeps the set ten minutes,
  fetches it again for a `kid` it has not seen at most once every 30 seconds,
  and follows no redirect. So `cloud-global` must publish a new key at least
  30 seconds before it signs with it. `CLOUD_GLOBAL_URL` is an origin, and
  plain http only on this machine, since whoever can answer that fetch can
  mint any token the cell takes.
- **The caller.** `requireCaller` (`adapters/http/caller.ts`) is the Hono
  middleware that runs the check and sets the `Caller` on the context
  (`c.var.caller`, typed by `CellEnv`): the person's global id, the
  workspace's id, the role and the region, no more. Only `admitClaims` makes a
  `Caller` (a type-only brand keeps a hand-written one from type-checking).
- **Open routes.** Two routes answer without a token: `GET /api/health`, for
  whatever probes cells, and `POST /api/outbox`, where `cloud-global`
  delivers its outbox, each delivery signed instead (below, "The outbox").
  `createApp` registers both before `requireCaller`, and every route after, so
  an unknown path is 401 before it is 404, and any other method on
  `/api/outbox` needs a token. A new open route needs a reason as good, and
  the HTTP suite's "every route" test has to name it (`OPEN_ROUTES`).
- **A workspace's rows.** A route never takes a workspace id from the request
  (path, query, body or header). A use case that reads or writes a
  workspace's rows takes the `Caller` and scopes every query by its
  `workspaceId`; the workspace is the token's, so a token for one workspace
  cannot reach another's rows. A role check is the use case's too, from
  `caller.role`. The outbox route is the one exception: no person calls it,
  and the workspace it writes is the one its signed message names, which only
  `cloud-global` can sign.

## The outbox

`cloud-global` tells the cell about each workspace in the cell's region, and
its members, through its outbox (`packages/cloud-contract`, "The outbox
messages" and "Delivering a message": read them first). The cell keeps a copy
from those messages and nothing else.

- **What it keeps.** Two tables, each with its `workspace_id`: `workspace`,
  one row per workspace once its `workspace.created` is applied, with
  `last_applied_sequence`; and `workspace_member`, one row per member, with
  `person_id` and `role`, keyed by both ids. Ids and roles only: never an
  email, a name or anything else of an account, which the contract's reader
  refuses anyway, and a test pins the columns (`workspaceCopies.test.ts`).
- **How a delivery is authenticated** is the contract's choice: the body is
  the message as a compact JWS signed with the cell token's key, `typ`
  `OUTBOX_MESSAGE_TYPE`. The cell checks it (`adapters/token/outboxDeliveries.ts`,
  jose's `compactVerify`) against the very key set it checks tokens with
  (`cloudGlobalKeys`, built once in `compose.ts`), with `CELL_TOKEN_ALGORITHM`
  alone, a `kid` required, and no other `typ`. Another `typ` or no `kid` is
  refused before the key set is asked. There is no secret of the cell's own,
  and nothing more to configure: `CLOUD_GLOBAL_URL` already gives the keys.
- **The order of the checks** is the contract's, and each answer is
  `OUTBOX_ANSWER`'s, by status. Before anything, the route
  (`adapters/http/outbox.ts`) refuses a body not sent as
  `OUTBOX_DELIVERY_MEDIA_TYPE` (any case, parameters ignored) and one over
  `MAX_DELIVERY_BYTES` (16 KiB), each 400, without reading it. Then
  `receiveDelivery` (`application/receiveDelivery.ts`):
  1. the signature: not `cloud-global`'s is 401 `{"error":"unsigned"}`; keys
     that cannot be had are 503 `{"error":"unavailable"}`, never 401, logged
     the way tokens log it;
  2. the message: the payload as UTF-8, `JSON.parse` and `readOutboxMessage`;
     what does not read is 400 `{"error":"unreadable"}`, and the log gets
     the contract's reason, never the body;
  3. the region: another region's message is 421
     `{"error":"otherRegion","region":"<this cell's>"}`;
  4. the sequence (`placeMessage`, `domain/workspaceCopy.ts`): at or below the
     last applied is 200 `{"applied":true}` with nothing changed; the next is
     applied, then 200; further ahead is 409 with exactly `{ nextSequence }`
     (`OutOfOrderAnswer`), the last applied plus one, or `FIRST_SEQUENCE` for
     a workspace the cell holds nothing of. A database that does not answer
     is 503 `{"error":"unavailable"}`.
  Every refusal is logged in one line, never the body.
- **Applied once, in order, in one transaction.** `WorkspaceCopies.applyAfter`
  makes the change and moves `last_applied_sequence` in one transaction, by a
  compare-and-set from the sequence the message was placed against (for a new
  workspace, an insert that does nothing on conflict). A delivery that loses
  it to another, the same message delivered twice at once, places the message
  again and finds it applied, so it changes nothing.
- **What each change does** (`copyChangeOf`) is a state to reach, not a step,
  so a copy that differs from `cloud-global`'s records converges rather than
  refusing a message `cloud-global` would send forever: `workspace.created`
  makes the row; `member.added` and `member.role-changed` both put the member
  with the message's role (an added member already there takes it, a role
  change for someone not there adds them); `member.removed` deletes the member,
  and for someone not there changes nothing. Each still moves the sequence.

## The layers

The service is built in rings, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of, such as the
  regions (`region.ts`, which takes them from the contract) and the order a
  workspace's copy applies its messages in (`workspaceCopy.ts`). It is plain
  TypeScript, with no I/O, and no package but the two contracts (below).
- `src/application/` holds the use cases (`checkHealth`, `authenticate`,
  `describeMe`, `receiveDelivery`, and the cloud sessions' `sessionOptions`,
  `startSession`, `listSessions`, `getSession`, `stopSession` and
  `applyRunnerUpdate`) and, in `ports.ts`, the stores, probes,
  the `TokenVerifier`, the `DeliveryVerifier`, the `WorkspaceCopies`, the
  `CloudSessionStore`, the `RunnerChannel`, `Ids` and the `Clock` they need. A use case is a plain function that takes its ports
  first.
- `src/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle on PGlite or Postgres: the database
    (`database.ts`), the tables (`tables.ts`, re-exported as `schema` by
    `schema.ts`), and one store per port, which `stores.ts` builds together;
  - `http/` is the Hono routes (`app.ts`), the token check in front of them
    (`caller.ts`) and the outbox's route (`outbox.ts`). Each route asks a use
    case and maps its answer to a status and a body;
  - `token/` is jose: the `TokenVerifier` and where its keys come from
    (`cellTokens.ts`), and the `DeliveryVerifier`, on the same keys
    (`outboxDeliveries.ts`);
  - `clock/` is the machine's clock, the `Clock`;
  - `runner/` is the `RunnerChannel`, how the cell reaches a workspace's
    runner. Until the runner's socket exists, `noRunner` answers that none is
    connected. It imports no database library, HTTP framework or `jose`.
- The composition ring wires them together. `src/compose.ts` is the one place
  adapters are built and handed the ports they need (`composeCell`), and the
  place startup steps go. Adapters call use cases themselves; what they never
  do is build another adapter. `src/main.ts` loads the environment, opens and
  migrates the database, calls `compose.ts` and serves, and
  `src/startupError.ts` words a failure to start.
- `src/config.ts` parses the environment. It is shared configuration that any
  adapter may read, so it stays a pure parser with no I/O. It may import
  `domain`, whose list of regions it checks `REGION` against (`cloud-global`'s
  config imports nothing).

## The dependency rule

- `domain` imports only `domain`. `application` imports only `domain` and
  `application`. Neither imports a package (but the two contracts) or a `node:`
  builtin, and neither refers to a global that reaches the machine: `process`,
  `fetch`, `require`,
  `XMLHttpRequest`, `WebSocket`, the timers (`setTimeout`, `setInterval`,
  `setImmediate`), `globalThis` or `global`.
- An adapter imports `domain`, `application`, its own folder and
  `src/config.ts`, and never the composition ring or another adapter. Beyond
  that:
  - `adapters/http` never imports a database library (`drizzle-orm`,
    `@electric-sql/pglite`, `pg`) or `jose`;
  - `adapters/persistence` never imports `hono` or `jose`;
  - `adapters/token` is the one place `jose` is imported, and never imports
    `hono` or a database library;
  - `adapters/clock` imports no package;
  - `adapters/runner` never imports a database library, `hono` or `jose`.
- No file, tests included, imports another app, Better Auth
  (`better-auth`, `@better-auth/*`) or a workspace package (`@consola/*`, or
  `consola`, the desktop), with two exceptions, the contracts the cell shares
  with the others it talks to:
  - `@consola/cloud-contract` (`packages/cloud-contract`), shared with
    `cloud-global`. It holds the regions, the workspace roles, the claims of
    the token `cloud-global` mints for a cell, and the outbox messages it
    sends one. Before changing it, read `packages/cloud-contract/AGENTS.md`.
  - `@consola/runner-protocol` (`packages/runner-protocol`, MIT), shared with
    the runners. It holds what a cell and its runners say to each other: the
    messages over a runner's socket, the readers of a repository and a
    harness, and the session pass's claims. Before changing it, read
    `packages/runner-protocol/AGENTS.md`.

  Each does no I/O, which its own boundary test proves, so any layer may
  import it, `domain` and `application` included. Only an entry point counts:
  a path inside one is refused.
- Test files (`*.test.ts`) are exempt from the layer rules, because they wire
  real pieces together the way `compose.ts` does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the globals `domain` and `application` refer to. Only a
reference counts, directly or through `globalThis`, never a property or a
member that shares the name (`request.process`, `{ fetch: 1 }`). A file that
sits in no layer fails it too. The rules are data at its top (`LAYERS`,
`NEVER`, `CONTRACTS`), so a new layer or folder is added there first. It
also reads every package in the workspace and checks that each one but the
two contracts is refused, so a new package is covered without being named.

`src/adapters/persistence/schema.test.ts` enforces the table rules: every table
in `schema` has a not-null `workspace_id`, and none is an account table (the
copy of a workspace's members is `workspace_member`, ids and a role, never
`member`).

## Cloud sessions

A person's cloud session (`cloud_session`, `domain/cloudSession.ts`) is a
sandbox a workspace's runner runs for them. The cell records it, checks that
the connected runner offers the repository and the harness, and hands the start
or stop to the runner through the `RunnerChannel` port.

- **Routes** (`adapters/http/cloudSessions.ts`, behind `requireCaller`):
  `GET /api/cloud-sessions/options`, `POST /api/cloud-sessions`,
  `GET /api/cloud-sessions`, `GET /api/cloud-sessions/:id` and
  `POST /api/cloud-sessions/:id/stop` (202). They answer codes: `no_runner`
  (503), `repository_not_offered`, `harness_not_offered` and `invalid_request`
  (400), `not_found` (404). The body is exactly `{ repository, harness }`.
- **Whose.** A session is visible only to the person who started it, in the
  workspace of their token: another person's, or another workspace's, is
  `not_found`, never 403.
- **No runner, nothing recorded.** A start is checked against the runner's
  offer before any row is written, and before anything is sent. Until Task 3's
  socket, `composeCell` passes `noRunner`, so every start is 503.
- **Statuses** (`nextStatus`): `starting` goes to `running` or `failed`, and
  `running` to `stopped` or `failed`. An ended session never moves again, and
  an ended row ignores every update. A person's stop is the one other way to
  end: it takes a `starting` or `running` row to `stopped`.
- **A failure's two sources, kept apart.** `error` is the message a runner
  reported (the provider's or the start script's), shown as it came.
  `errorCode` is a code the cell decided itself (`CELL_FAILURE_CODES`:
  `runner_restarted`, `runner_unreachable`), which `cloud-web` words. A failed
  row has one of them, never both, so a runner can never forge a code by
  naming one in its message, and the web never shows a code as text.
- **Stop never waits for the runner.** A person can always end their session:
  the row becomes `stopped` at once, and the runner is told only when it is the
  session's own runner and connected. A runner that is away or cannot be told
  still holds the sandbox, but the row is ended, so its `hello` finds the
  session ended and gets a `session.stop` for it. The runner therefore never
  keeps a sandbox for a session the cell considers ended.
- **Updates from a runner** (`applyRunnerUpdate`) count only from the runner
  the row names, and are compare-and-set on the row's status, so a late update
  never overwrites an end.

## Adding a feature

1. A rule or a type goes in `domain`.
2. A use case goes in `application`, with any port it needs in `ports.ts`.
3. An adapter implements the port. For the database, that is a table in
   `tables.ts` (with its `workspace_id`) and a store in `adapters/persistence`,
   added to `createDrizzleStores`.
4. A route in `adapters/http` calls the use case. It is registered after
   `requireCaller` in `createApp` (or on a `Hono<CellEnv>` mounted there), and
   hands the use case `c.var.caller`, never a workspace id from the request.
5. `compose.ts` builds the adapter and hands it its ports, and nothing else
   does. A startup step goes there too.

## Tests

A test sits beside its module and is named after it (`healthProbe.ts`,
`healthProbe.test.ts`). Rules in `domain` are tested alone. Stores and use
cases are tested on a migrated `pglite:memory` database through the real
Drizzle stores: the database is never mocked. `src/app.test.ts` is the HTTP
suite, end to end. It builds the cell through `compose.ts` (`composeCell`), as
`main.ts` does, so it tests the wiring that runs.

No test needs `cloud-global` running. A test makes an Ed25519 key pair, signs
tokens with jose's `SignJWT` over the contract's `cellTokenClaims` and outbox
deliveries with its `CompactSign` over a message's JSON, and hands the cell
the public key as a local key set (`composeCell`'s `cellTokenKeys`, which only
tests pass). The tests of the remote key set start a small `node:http` server
on port 0 and point `CLOUD_GLOBAL_URL` at it. The HTTP suite's "every route"
test asks every route the app has without a token and expects 401 from all
but the open ones it names (`OPEN_ROUTES`), so a new route is covered without
being named. That deliveries apply once is asserted on the tables, and on the
use case's answer (`now`) for deliveries made at once: PGlite runs one
transaction at a time, so the compare-and-set is also tested directly
(`workspaceCopies.test.ts`).

## Generated files

`drizzle/` holds the migrations, written by
`pnpm --filter @consola/cloud-region db:generate --name <what>` after
`tables.ts` changes. They apply when the cell starts. The first is
`0000_workspace_copy`, then `0001_cloud_session`. `cloud_session` has no
foreign key to `workspace`, so a session does not wait for the outbox.
