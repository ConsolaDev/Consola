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
- **Each change keeps the workspace's teams true to it**, in the same
  transaction (below, "Teams"): opening a workspace makes its first team, a
  person who becomes a member joins it, and one who stops being a member leaves
  every team.

## Teams

A workspace's teams live in its cell, because their names are the company's
information (decided 2026-11-21: teams own factories; a new workspace starts
with one team; no team-level roles). Better Auth's teams are not used: they
would put teams in `cloud-global`'s database. The rules are in
`domain/team.ts`, the use cases in `application/teams.ts`, the store in
`adapters/persistence/teams.ts` and the routes in `adapters/http/teams.ts`.

- **Two tables**, each with its `workspace_id`: `team` (`team_id`, which the
  cell gives it, `name`, `is_first`) and `team_member` (`team_id`,
  `person_id`, `added_at`). A team member's row points at the workspace's copy
  of the member (`workspace_member`), so only a member of the workspace can
  be in one of its teams, and a member who leaves the workspace leaves every
  team as their copy's row goes. It also points at its team through both ids,
  so a place is always in a team of its own workspace.
- **The first team.** Every workspace has exactly one (`team_first_unique`),
  called `FIRST_TEAM_NAME` until someone renames it. The cell makes it as it
  applies `workspace.created`, and every person who becomes a member of the
  workspace joins it: an added member, or a role change for someone the copy
  did not have. A member whose role changes keeps the teams they are in, so a
  person taken out of the first team is not put back by a role change. It can
  be renamed, and its members taken out, but it is never deleted (409
  `first_team`), so every factory always has a team to belong to. The
  migration that added teams (`0001_teams`) made a first team, holding every
  member, for each workspace the cell held already.
- **Names** are trimmed, 1 to `TEAM_NAME_MAX` characters with no control
  character (`checkTeamName`, every problem at once as 400 `invalid_team`),
  and unique in the workspace whatever their case (`team_name_unique`, on
  `lower(name)`; 409 `name_taken`).
- **Who may do what**, by the role in the caller's token
  (`mayManageTeams`): owners and admins make, rename and delete teams and
  choose their members, and see every team; a member sees only the teams they
  are in, and is refused any change (403 `not_allowed`). The list says which
  (`canManage`), so the web app shows controls by the answer, never by the
  role.
- **The order of the checks** is the same in every use case: the role, then
  the name, then whether the cell holds the workspace yet (409
  `workspace_pending` until `cloud-global` has delivered its
  `workspace.created`; asking again later helps), then what the store finds.
  A team id is looked up in the caller's workspace alone, so another
  workspace's team is 404 `team_not_found`, never changed.
- **Members** are added by their global id, `PUT
  /api/teams/{teamId}/members/{personId}`, and only if the cell's copy has
  them (409 `not_a_workspace_member`); adding someone already in the team, or
  taking out someone not in it (`DELETE`), changes nothing. The store holds
  the member's copy row while it writes (`for key share`), so they cannot
  leave the workspace in between.
- **A team that owns something** is a later rule: when factories arrive
  (9.2), deleting a team that owns one needs a rule of its own.

## The API's contract

Every route is declared in `adapters/http/contract.ts` with
`@hono/zod-openapi`'s `createRoute`, and `ROUTES` lists them. `createApp`
returns an `OpenAPIHono`, registers each with `app.openapi`, and TypeScript
checks every answer a handler gives against its route's responses. It is
built the way `cloud-global`'s contract is
(`apps/cloud-global/src/adapters/http/contract.ts`), so the two read alike.

- **Answers are strict objects** (`z.strictObject`); request bodies are
  checked for their shape only (`z.object`), never for the domain's rules.
  The HTTP suite reads every teams answer with the schema its route declares
  for its status (`answerOf`), so an undeclared status or a field the
  contract does not name fails a test.
- **The token check's answers** (401 `token_required`/`invalid_token`, 421
  `wrong_region`, 503 `token_check_unavailable`) are declared once
  (`tokenFailures`) and spread into every route behind the check.
- **A body** of the wrong shape is 400 `invalid_request` (`defaultHook`); one
  that is not JSON is 400 too, and one without a JSON content type 415
  `unsupported_media_type` (`onError`, since the validator throws before any
  hook). A body is checked after the token.
- **The outbox's body** is declared as `OUTBOX_DELIVERY_MEDIA_TYPE`, which the
  library neither validates nor gates, so the route keeps its own checks of
  the media type and size.
- **`openapi.json`**, at the app's root, is generated from the routes by
  `adapters/http/openapi.test.ts` (`pnpm --filter @consola/cloud-region
  openapi:generate`), which fails while it is stale. The same test checks
  that the contract describes every route the app serves, and only those, and
  that no named schema may be null (a use that may be null is
  `z.union([Named, z.null()])`, never `.nullable()`). The web app generates
  its client for the cell from this file, and Biome leaves it alone.

## The layers

The service is built in rings, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of, such as the
  regions (`region.ts`, which takes them from the contract), the order a
  workspace's copy applies its messages in (`workspaceCopy.ts`) and teams
  (`team.ts`). It is plain TypeScript, with no I/O, and no package but the
  contract (below).
- `src/application/` holds the use cases (`checkHealth`, `authenticate`,
  `describeMe`, `receiveDelivery`, and the teams' in `teams.ts`) and, in
  `ports.ts`, the stores, probes, the `TokenVerifier`, the
  `DeliveryVerifier`, the `WorkspaceCopies`, the `TeamStore` and the `Clock`
  they need. A use case is a plain function that takes its ports first.
- `src/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle on PGlite or Postgres: the database
    (`database.ts`), the tables (`tables.ts`, re-exported as `schema` by
    `schema.ts`), and one store per port, which `stores.ts` builds together;
  - `http/` is the contract (`contract.ts`), the Hono routes (`app.ts`), the
    token check in front of them (`caller.ts`), the outbox's route
    (`outbox.ts`) and the teams' (`teams.ts`). Each route asks a use case and
    maps its answer to a status and a body;
  - `token/` is jose: the `TokenVerifier` and where its keys come from
    (`cellTokens.ts`), and the `DeliveryVerifier`, on the same keys
    (`outboxDeliveries.ts`);
  - `clock/` is the machine's clock, the `Clock`.
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
  `application`. Neither imports a package (but the contract) or a `node:`
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
  - `adapters/clock` imports no package.
- No file, tests included, imports another app, Better Auth
  (`better-auth`, `@better-auth/*`) or a workspace package (`@consola/*`, or
  `consola`, the desktop), with one exception: `@consola/cloud-contract`
  (`packages/cloud-contract`), the contract the cell shares with
  `cloud-global`. It holds the regions, the workspace roles, the claims of the
  token `cloud-global` mints for a cell, and the outbox messages it sends one.
  It does no I/O, which its own boundary test proves, so any layer may import
  it, `domain` and `application` included. Only its entry point counts: a path
  inside it is refused. Before changing it, read
  `packages/cloud-contract/AGENTS.md`.
- Test files (`*.test.ts`) are exempt from the layer rules, because they wire
  real pieces together the way `compose.ts` does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the globals `domain` and `application` refer to. Only a
reference counts, directly or through `globalThis`, never a property or a
member that shares the name (`request.process`, `{ fetch: 1 }`). A file that
sits in no layer fails it too. The rules are data at its top (`LAYERS`,
`NEVER`, `CLOUD_CONTRACT`), so a new layer or folder is added there first. It
also reads every package in the workspace and checks that each one but the
contract is refused, so a new package is covered without being named.

`src/adapters/persistence/schema.test.ts` enforces the table rules: every table
in `schema` has a not-null `workspace_id`, and none is an account table (the
copy of a workspace's members is `workspace_member`, ids and a role, never
`member`).

## Adding a feature

1. A rule or a type goes in `domain`.
2. A use case goes in `application`, with any port it needs in `ports.ts`.
3. An adapter implements the port. For the database, that is a table in
   `tables.ts` (with its `workspace_id`) and a store in `adapters/persistence`,
   added to `createDrizzleStores`.
4. A route is declared in `adapters/http/contract.ts` (and listed in
   `ROUTES`), and a handler in `adapters/http` calls the use case. It is
   registered with `app.openapi` after `requireCaller` in `createApp` (or by a
   function handed the app there, as `teamRoutes` is), and hands the use case
   `c.var.caller`, never a workspace id from the request. Then
   `openapi:generate` rewrites `openapi.json`.
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
`0000_workspace_copy`; `0001_teams` ends with two statements written by hand,
which give the workspaces already held their first team
(`migrations.test.ts` runs it over a database migrated to `0000` only).
Postgres cuts a name at 63 characters, and drizzle's names for a composite
foreign key run past that, so such a key is named in `tables.ts`.

`openapi.json` is generated too (above, "The API's contract").
