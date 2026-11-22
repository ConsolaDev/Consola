# AGENTS.md

This file guides coding agents working in `apps/cloud-global`, the global part
of Consola Cloud's control plane: the API every region shares. `CLAUDE.md`
imports it with `@AGENTS.md`, so Claude Code reads it too. The repository's
guide is the root `AGENTS.md`, and setup is in `README.md`. Paths below are
relative to `apps/cloud-global`.

## The layers

The service is built in rings, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of: who may join
  (`mayJoin`), what a new workspace needs (`checkNewWorkspace`) and who owns it
  (`CREATOR_ROLE`), which workspace a new session opens
  (`defaultActiveWorkspace`), the regions a workspace can be in (`REGIONS` and
  `isRegion`, which `region.ts` takes from the contract), how long the outbox
  waits before it delivers a message again (`retryDelayMs`), who may connect
  another service (`mayManageConnections`) and whether a Connect's state
  finishes in this session (`checkInstallState`), what a webhook delivery's
  headers name and the installation its payload came through
  (`readDeliveryHeaders`, `installationOfEvent`, in `webhooks.ts`), and
  `Workspace`, `MyWorkspace`, `Person`, `SignedIn` and the GitHub types
  (`connections.ts`). It is plain TypeScript, with no I/O, and no package but
  the contract (below).
- `src/application/` holds the use cases (`createWorkspace`,
  `listMyWorkspaces`, `setActiveWorkspace`, `listActiveWorkspaceMembers`,
  `workspaceForNewSession`,
  `mayCreateAccount`, `mayStartSession`, `describeMe`, `mintCellToken`,
  `cellTokenKeys`, `deliverOutbox`, `listConnections`, `startGitHubInstall`,
  `finishGitHubInstall`, `disconnectGitHub`, `receiveGitHubWebhook`,
  `checkHealth`) and, in `ports.ts`, the stores, probes, signers, the cell,
  the GitHub App and its webhook signatures they need. A use case is a plain function that takes its ports first, and is
  handed the time when it needs it (`mintCellToken`'s `issuedAt`,
  `deliverOutbox`'s `now`).
- `src/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle on PGlite or Postgres: the database, the schema,
    and one store per port, which `stores.ts` builds together. Its one writer
    of what a cell must hear about is `writeWorkspaceChange` (below);
  - `auth/` is Better Auth (`betterAuth.ts`). Its hooks call use cases and run
    no query of their own;
  - `http/` is the Hono routes. `contract.ts` declares every route but
    sign-in, with what it takes and every answer it gives, in Zod
    (`@hono/zod-openapi`); `app.ts` implements them, and TypeScript checks
    each handler's answers against the route's (see "The contract"). Each
    route asks a use case and maps its answer to a status and a body;
  - `cellToken/` is `jose` (`cellTokenSigner.ts`): it signs the cell token,
    outbox messages and GitHub's events with the configured private key and
    publishes the public key (below). It is the only code that holds the
    private key;
  - `outbox/` makes the requests to a cell: the outbox's (`cellDelivery.ts`,
    with `fetch`) and the worker's loop and timers (`outboxWorker.ts`), which
    runs `deliverOutbox` (below), and the GitHub events passed on
    (`eventDelivery.ts`, "Webhooks");
  - `github/` is GitHub's REST API over `fetch`, and `node:crypto`: the app
    (`gitHubApp.ts`, which reads the app's `.pem` with `loadGitHubAppKey`),
    the signed state of a Connect (`installStateSigner.ts`) and the webhook
    signature check (`webhookSignatures.ts`). It is the only code that holds
    the GitHub App's private key, client secret and webhook secret.
- The composition ring wires them together. `src/compose.ts` is the one place
  adapters are built and handed the ports they need (`composeApi`), and the one
  place a startup step would live (there is none today). `composeApi` is
  async, because building the cell token's signer and reading the GitHub App's
  key are. A configured key that is not a key pair, or a GitHub key file that
  cannot be read or holds no RSA private key, fails there as a `ConfigError`,
  which `main.ts` reports like any other configuration problem. It builds the
  outbox's worker and wakes it from the stores, but never starts it. Adapters
  call use cases themselves; what they never do is build another adapter. The one
  exception is `src/adapters/auth/cli-config.ts`, which builds the stores and
  `createAuth` for the schema CLI: it is tooling, and never runs in the
  service.
  `src/main.ts` loads the environment, opens and migrates the database, calls
  `compose.ts` and serves; once it listens, it starts the outbox's worker, and
  it stops the worker before it closes the database. `src/startupError.ts`
  words a failure to start.
  `src/config.ts` parses the environment. It is shared configuration that any
  adapter may read, so it stays a pure parser that imports no other file and no
  I/O.

## The dependency rule

- `domain` imports only `domain`. `application` imports only `domain` and
  `application`. Neither imports a package (but the contract) or a `node:`
  builtin, and neither refers to a global that reaches the machine: `process`,
  `fetch`, `require`,
  `XMLHttpRequest`, `WebSocket`, the timers (`setTimeout`, `setInterval`,
  `setImmediate`), `globalThis` or `global`.
- An adapter imports `domain`, `application`, its own folder and
  `src/config.ts`, and never the composition ring. Beyond that:
  - `adapters/http` never imports `better-auth`, `drizzle-orm`,
    `@electric-sql/pglite`, `pg`, `jose`, `adapters/persistence`,
    `adapters/auth` or `adapters/cellToken`. Sign-in reaches it as
    `handleAuth` and `currentSession`, and signing as the `CellTokenSigner`
    port, which `compose.ts` passes in;
  - `adapters/persistence` never imports `hono`, `better-auth`, `jose` or
    another adapter;
  - `adapters/auth` never imports `hono`, `jose`, `adapters/http` or a
    database library (`drizzle-orm`, `pg`, `@electric-sql/pglite`): its hooks
    call use cases, and the stores run the queries. It may import
    `adapters/persistence`, because Better Auth's Drizzle adapter needs the
    database and its schema;
  - `adapters/cellToken` never imports `hono`, `better-auth`, a database
    library or another adapter. It is the only one that imports `jose`;
  - `adapters/outbox` never imports `hono`, `better-auth`, a database library,
    `jose` or another adapter: the store and the signer reach it as ports,
    which `compose.ts` passes in;
  - `adapters/github` never imports `hono`, `better-auth`, a database
    library, `jose` or another adapter. It signs its app token with
    `node:crypto`, and reaches the routes only as the `GitHubApp` and
    `InstallStateSigner` ports.
- No file, tests included, imports another app or a workspace package
  (`@consola/*`, or `consola`, the desktop), with one exception:
  `@consola/cloud-contract` (`packages/cloud-contract`), the contract
  `cloud-global` shares with the cells. It holds the regions, the workspace
  roles, the claims of the token `cloud-global` mints for a cell, the outbox
  messages it sends one and the GitHub events it passes on. It does no I/O,
  which its own boundary test
  proves, so any layer may import it, `domain` and `application` included.
  Only its entry point counts: a path inside it is refused. Before changing
  it, read `packages/cloud-contract/AGENTS.md`.
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

## Adding a feature

1. A rule or a type goes in `domain`.
2. A use case goes in `application`, with any port it needs in `ports.ts`.
3. An adapter implements the port. For the database, that is a store in
   `adapters/persistence`, added to `createDrizzleStores`. A store that
   changes a workspace or its members does it through `writeWorkspaceChange`,
   in its own transaction ("The outbox").
4. A route in `adapters/http`, or a hook in `adapters/auth`, calls the use
   case. A route is declared in `contract.ts` first, with every answer it
   gives, and added to `ROUTES`; `app.ts` registers it with `app.openapi`,
   never `app.get` or `app.post`, which `openapi.test.ts` refuses. Then
   `openapi:generate` rewrites `openapi.json`, and `cloud-web`'s
   `api:generate` its types, in the same change ("The contract").
5. `compose.ts` builds the adapter and hands it its ports, and nothing else
   does. A startup step, if one is ever needed, goes there too.

## Workspaces

A workspace is the top level people see, as in Notion: a company, a team, or
only you. In the database it is Better Auth's `organization` row, and a person
is in it through a `member` row; everything Consola says, its API included,
says "workspace". Anyone signed in can make one, belong to several and switch
between them.

**The routes are Consola's own, not Better Auth's** (decided in 2.1, CON-49):

- `GET /api/me`: the person, and their session's active workspace with their
  role in it (`workspace`, null when there is none);
- `PUT /api/me/workspace` `{ workspaceId }`: makes one of the person's
  workspaces active (`setActiveWorkspace`); one they are not in is 404, like
  one that does not exist;
- `GET /api/me/workspace/members`: the active workspace's members, each with
  their global id, name, email, image and role, in the order they joined
  (`listActiveWorkspaceMembers`). Every member may list them: a cell names
  people by global id only, so this is how the web app puts a name to them
  (8.2, Teams). No workspace open is 409 `no_active_workspace`; one the person
  is not in is 403 `not_a_member`;
- `GET /api/workspaces`: the person's workspaces, in the order they joined;
- `POST /api/workspaces` `{ name, slug, region }`: makes one
  (`createWorkspace`). The creator is its owner and their session opens it. A
  request `checkNewWorkspace` refuses is 400 with every problem named; a slug
  any workspace has, in any region, is 409 `slug_taken`.

Better Auth owns sign-in and sessions and nothing else. Its organisation
plugin stays for its tables (`organization`, `member`, `invitation` and the
session's `active_organization_id`), and every route it brings is closed:
`closedPaths` reads them from the plugin itself and hands them to
`disabledPaths`, so a route a Better Auth upgrade adds is closed too. Why:

- the region stays `input: false`, so nothing Better Auth accepts can ever
  carry one. Its own create route would need `input: true`, which would open
  `organization/update` to it as well, guarded only by a hook;
- the rules are domain functions a use case calls, never a hook threaded
  through Better Auth's routes, its error shapes or its role checks;
- a workspace and its first member are written in one transaction
  (`WorkspaceStore.create`), with the cell's `workspace.created` and
  `member.added` messages (6.1, "The outbox");
- one way to make, list or switch workspaces, so the web app and later
  clients never have two to choose from.

A member's role is one of the contract's `WORKSPACE_ROLES` (`owner`, `admin`,
`member`), and the stores read back only a listed one (`roleOf`). Membership
comes only from making a workspace for now, as its `owner` (`CREATOR_ROLE`):
signing in joins nothing. Invites, roles and removal (3.2) are routes of Consola's own too, on
Better Auth's `member` and `invitation` tables, and change `member` only
through `writeWorkspaceChange`, so the cell hears of each. A new session starts in the
workspace `defaultActiveWorkspace` picks (the one last active, else the first
joined, else none). `SessionStore` writes the active workspace on the
`session` row itself, which is right only while Better Auth's cookie cache
stays off: with it on, a session would keep the workspace in its cookie.

A request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) must come
from the web app's origin (`PUBLIC_URL`), or it is 403 `bad_origin`, as Better
Auth requires of its own routes: the session cookie is SameSite=Lax, which
another site on the same host, any other localhost port, would still be sent.
GitHub's webhook deliveries are the one exception: they carry no cookie and
no Origin, and their signature is what is checked ("Webhooks"), so their route
is registered before the origin check.
`src/app.test.ts` pins the route list, so a new route is added there on
purpose.

## What is always global

`cloud-global` keeps only what every region has to share. Anything not on this
list belongs in a regional cell, never here.

- **Accounts** (decided): email, name, sign-ins, sessions and API keys. They
  are `user`, `account` (the Google account a person signs in with),
  `session` and `verification` (a sign-in in progress). API keys have no table
  yet.
- **Proposed**, after Linear's published list of what it keeps global, and not
  yet confirmed:
  - the workspace list: id, name, slug and region (`organization`, with Better
    Auth's own `logo`, `created_at` and `metadata`);
  - membership: who is in which workspace, their workspace-level role, and
    pending invites (`member`, `invitation`);
  - app installs: which installation belongs to which workspace
    (`github_installation`: the installation, its workspace, the GitHub
    account it is on, who connected it and when), the GitHub App's key and the
    tokens minted from it (no table yet). The repositories an installation
    covers are not kept: they are company information, and GitHub is asked
    for them each time;
  - webhook intake (14.2, CON-70), which stores nothing: each delivery is
    checked, passed on to the cell of the workspace that holds its
    installation, and dropped. What an event says is company content, so the
    cell keeps it, and it is the cell that records a delivery once by its id.
    Only the routing it needs is read here, from what is already on this
    list (`github_installation`, `organization`);
  - the outbox (6.1, CON-52): each change a workspace's cell must hear
    about, and how its delivery went (`outbox_message`). It may live here
    because it holds nothing that is not already on this list: a workspace's
    id and region (`organization`), and a person's id and role in it
    (`member`), never an email or a name: it has no column for one, and its
    checks hold each row to the contract's shape. Its delivery columns hold
    times, a count and a status or the contract's reason, never a body.
- **Billing** joins the list if decision D6 puts it in the global part.

`src/adapters/persistence/alwaysGlobal.test.ts` pins the list. Its
`ALWAYS_GLOBAL` names each table on the list and its columns, and the test
fails on any other table or column, whether the Drizzle schema declares it or
only a migration makes it. So a new table or column is checked against this
list first: put it in a cell, or, if it is global, add it here and then to
`ALWAYS_GLOBAL`. A Better Auth upgrade that adds a column fails the test too,
on purpose.

## Regions

Every workspace (the `organization` row) has a `region`, one of `REGIONS`
(`eu`, `us`). It is picked when the workspace is made and nothing changes it
afterwards:

- `WorkspaceStore.create` writes it only when it makes the row, and every
  store reads back only a listed region (`regionOf`);
- no route changes a workspace: Consola's routes make and switch, and Better
  Auth's are closed. Its organisation plugin also declares the region with
  `input: false`, so nothing it would accept carries one;
- a new route or hook that writes `organization` must leave `region` alone, and
  `src/app.test.ts` checks that no route moves it.

Every organisation made before regions existed is in `eu`: migration `0001`
fills them. The deployment's one organisation from before workspaces carries
on as an ordinary workspace, with its members and their roles.

## The cell token

`cloud-global` checks the browser's sign-in and membership, then mints a
short-lived token a regional cell trusts. It stands in for the signed header a
future edge router will add, so a cell's check does not change when the router
arrives. The contract fixes its shape (`packages/cloud-contract/AGENTS.md`,
"The cell token"): a JWT signed with Ed25519, whose header is `alg`
(`CELL_TOKEN_ALGORITHM`, `EdDSA`) and the key's `kid`, and whose payload is
exactly what `cellTokenClaims` returns, living `CELL_TOKEN_LIFETIME_SECONDS`.
No other claim is added: a cell's reader refuses one it does not know.

**Proposed** (5.3, CON-50), not yet confirmed:

- **The mint route.** `POST /api/cell-token`, with no body, answers the token
  for the session's active workspace as
  `{ token, expiresAt, workspaceId, region }`, where `expiresAt` is the
  token's `exp` (whole seconds since the epoch), with
  `Cache-Control: no-store`. `workspaceId` and `region` say whose token it
  is and which cell takes it, so the web app never reads the token itself: it
  checks the workspace is the one it shows (another tab can switch the
  session's) and sends the token to that region's cell. It is a change, so it sits under the origin check
  (403 `bad_origin`): a token is worth as much as the session that mints it.
  Signed out is 401 `signed_out`; a session with no active workspace is 409
  `no_active_workspace`; one whose active workspace the person is not in (any
  more, or ever) is 403 `not_a_member`, and no token is minted.
- **Membership is read when the token is minted.** `mintCellToken` reads the
  membership, the role and the region through `MembershipStore.workspaceFor`,
  from the database, never from the request: whatever its body says is
  ignored. So someone removed from a workspace gets no new token, and a
  changed role is in the next one. A stored role that is not exactly one of
  the contract's (Better Auth's `admin,member`) mints nothing: `roleOf` refuses
  it, and the request fails rather than guess a role.
- **The layers.** Signing is the `CellTokenSigner` port, implemented with
  `jose` in `adapters/cellToken` (`createCellTokenSigner`). `mintCellToken`
  takes the time it mints at (`issuedAt`, whole seconds) from its route and
  reads no clock.
- **The keys.** `GET /api/cell-token/keys` (`CELL_TOKEN_KEYS_PATH`) publishes
  the public key as a JSON Web Key Set, with no sign-in:
  `{ keys: [{ kty, crv, x, kid, alg: 'EdDSA', use: 'sig' }] }`. The public key
  is derived from the private key itself, so it always checks what is signed,
  and its `kid` is its JWK thumbprint (RFC 7638). It never carries `d`.
- **The private key** is `CELL_TOKEN_PRIVATE_KEY`, an Ed25519 private JWK on
  one line, and it is required. `config.ts` refuses one that is not JSON, not
  Ed25519 or has no `d`, or whose `x` or `d` is not 32 bytes in base64url, and
  keeps only `kty`, `crv`, `x` and `d`; the signer refuses one whose `x` is
  not the public key of its `d`, as a `ConfigError`. No problem quotes the
  value, `describeStartupFailure` hides its `d`, and nothing logs it, which
  `src/app.test.ts` checks against every console call along the way.
  `pnpm --filter @consola/cloud-global cell-key:generate` prints a new one.
- **One key at a time.** Rotating it the contract's way, the new key published
  beside the old until the old one's tokens expire, needs a second setting
  that holds only public keys. It waits until a deployment needs it.

## The outbox

A workspace's cell holds no accounts and reads nothing from here, so
`cloud-global` tells it what it must know: that the workspace was made, and who
is in it with which role. The contract fixes the messages and how they are
delivered (`packages/cloud-contract/AGENTS.md`, "The outbox messages" and
"Delivering a message"). This is how `cloud-global` keeps its side.

**A change and its message commit together, or not at all.** This is the
rule. Every change a cell must hear about is written by `writeWorkspaceChange`
(`adapters/persistence/workspaceChanges.ts`), in the transaction that makes
it, with its message: making a workspace (`workspace.created`), adding a
member (`member.added`), changing a member's role (`member.role-changed`) and
removing one (`member.removed`). So the outbox holds every change that
committed, and none that did not. Nothing else writes `organization` or
`member`: a new store that changes either calls it inside its own
transaction, then tells `messageWritten` once that commits, so the worker
wakes.

**Proposed** (6.1, CON-52), not yet confirmed:

- **Where changes happen today.** Only `WorkspaceStore.create`, for a
  workspace and its owner: messages 1 and 2. Adding, changing and removing
  members have no routes yet (epic 3), and their stores will call
  `writeWorkspaceChange` too. Better Auth writes neither table: its
  organisation routes are closed, signing in joins nothing, and its
  `delete-user` route stays off (Better Auth's default). Deleting an account
  would take its `member` rows with it and past the outbox, so turning that on
  means writing each `member.removed` first.
- **Sequences.** A message's `sequence` is one more than its workspace's
  last, from 1, with no gaps, in commit order. A change to a workspace that
  exists locks its `organization` row (`for no key update`) before it writes
  anything, so a second change to it waits for the first to commit or roll
  back, then counts from it. The primary key (`organization_id`, `sequence`)
  backs it. A change that changes nothing (a member already there, or not
  there, or already in the role) writes nothing. `workspaceChanges.test.ts`
  races changes against each other, on PGlite always and on a real Postgres
  when `CLOUD_GLOBAL_TEST_POSTGRES_URL` names a server's maintenance database
  (the test makes a database there and drops it); without the lock, the
  Postgres run fails on the primary key.
- **A row** (`outbox_message`, hand-written in `outboxSchema.ts`) holds the
  message's fields and its delivery: attempts, the last attempt and its
  error, when the next is due, and when the cell confirmed it. Checks hold it
  to the contract's shape. A message is kept once delivered. There is no
  foreign key: a message outlives what it speaks of.
- **The backfill.** Migration `0002` gives every workspace already there the
  messages a new one gets: its `workspace.created`, then one `member.added`
  per member, in the order they joined, all due at once. A role the contract
  does not list (Better Auth's `admin,member`; nothing here writes one) stops
  the migration, naming the workspace's slug, rather than being guessed. Set
  the row's role, then start again.
- **Signing.** The signer that mints cell tokens signs each message
  (`signOutboxMessage`), as the contract says: its JSON as the payload of a
  compact JWS, with `alg`, the key's `kid` and `typ` in the protected header.
- **Delivering** is one pass of `deliverOutbox`. Each workspace's first
  undelivered message is read with the contract's reader, signed and posted to
  its region's cell; a 2xx confirms it, and the next goes at once. Any other
  status, a redirect (never followed), no connection and no answer within
  `DELIVERY_TIMEOUT_MS` (10 s) fail, and the message is tried again after
  `retryDelayMs`: 1 s, doubling, never more than 5 minutes. A message is
  never skipped, a workspace's next waits for its current one, and workspaces
  go side by side, so one that is stuck holds up only itself. A stored
  message the reader refuses is never sent: it fails with the reader's
  reason. A 409 is retried like any refusal; a cell that lost what it applied
  is 6.3's to reconcile (CON-57).
- **What is recorded** for each try: `attempts`, `last_attempt_at`,
  `last_error` (`status 503 (unavailable)`,
  `status 409 (outOfOrder): the cell applies sequence 3 next`,
  `no connection (ECONNREFUSED)`, `no answer within 10000 ms`: a status, the
  contract's answer and reason, never a body), `next_attempt_at` and
  `delivered_at`.
- **Where cells are.** `CELL_URL_EU` and `CELL_URL_US`, one optional origin
  per region in `REGIONS` (`cellUrlVariable`), read like `PUBLIC_URL`. A region
  with none keeps its messages untouched, and the worker says so once.
- **The worker** (`createOutboxWorker`) runs in this process: a pass when
  `main.ts` starts it (after the migrations, once the API listens and so
  publishes the keys a cell checks with), on a wake from a change that
  wrote a message, when the earliest retry is due, and otherwise every
  `OUTBOX_POLL_MS` (10 s); never two at once. `composeApi` builds it and never
  starts it, so building the service sends nothing. Stopping it abandons a
  delivery in flight without recording it, so the message goes again; the
  cell takes a message it has applied as confirmed. It logs ids and statuses
  only, never a message, its signature or the key.
- **One process.** The worker assumes it is the only one: one `cloud-global`
  process delivers the outbox, on localhost. Two would send each workspace's
  messages twice over and record over each other's tries. Running more than
  one needs a claim on each workspace's first message first (a lease, or
  `for update skip locked`).

## The contract

`src/adapters/http/contract.ts` is the API's contract, and `openapi.json` is
generated from it (`pnpm --filter @consola/cloud-global openapi:generate`;
`openapi.test.ts` fails while it is stale). The web app's types are generated
from `openapi.json`, which it reads as a file, so a change here reaches it
through that file, and CI checks the web app with every change to this app
(`.github/scripts/ci-scope.mjs`).

- **A route is added to the contract first**, then implemented in `app.ts`
  and added to `ROUTES`. Every status a route can answer is declared, with its
  body: TypeScript refuses a handler answer the route does not declare, a
  missing field or a wrong literal, but not an extra field. That one the HTTP
  suite catches: `app.test.ts` checks every answer it reads against the
  route's schema, and answers are strict objects (a private key's `d` in the
  key set fails it, for one).
- **The app serves nothing the contract does not declare.** `openapi.test.ts`
  compares what `app.routes` serves with `ROUTES`, so a route registered with
  `app.get` and the like, or with `app.openapi` but left out of `ROUTES`,
  fails it. `OUTSIDE_THE_CONTRACT` names the only exceptions, each with its
  reason: Better Auth's `/api/auth/*` and the origin check's `app.use`.
  Adding to it needs a reason as good: no client calls the route through the
  contract.
- **A request schema checks shape, never rules.** It is never stricter than
  the domain rule behind it, and a route whose rules name problems hands a
  body of the wrong shape to them in its hook (`POST /api/workspaces` calls
  `checkNewWorkspace`), so every problem is still named. Any other wrong shape
  is 400 `invalid_request` (the app's `defaultHook`), never the validator's own
  answer.
- **A body that is not JSON is refused before any route sees it**: 400
  `invalid_request` if it does not parse, 415 `unsupported_media_type` without
  a JSON content type (`onError`). A session check runs before the body is
  read (route `middleware`), so a signed-out request is 401 whatever it sends.
- **A schema used both alone and nullable is a union at the nullable use**
  (`z.union([MyWorkspace, z.null()])`): `.nullable()` on a named schema makes
  every use of the name nullable. `openapi.test.ts` checks no named schema is.

## Connections

A workspace connects GitHub by installing Consola's one GitHub App (decided
2026-11-21) on a GitHub account or organisation (14.1, CON-67). Every member
sees what is connected; owners and admins connect and disconnect
(`mayManageConnections`). The app's four settings are optional together
(`config.ts`, `readGitHubApp`): with none set, `github` is null, the routes
say so, and the service still starts. Every route below is in the contract
(`getConnections`, `postGitHubInstall`, `getGitHubCallback`,
`deleteGitHubInstallation`), the callback too: it answers only a redirect, and
`CALLBACK_RESULT` (`app.ts`) names each way a Connect ends as the contract
lists them (`GITHUB_CALLBACK_RESULTS`).

- `GET /api/connections`: the active workspace's installations, each with its
  account, when it was connected, its settings page on GitHub (`settingsUrl`)
  and its repositories as GitHub says now (`listed`, `gone` or
  `unavailable`), plus `canManage` and whether the app is `configured`. The
  repositories are company information, so they are asked of GitHub (an
  installation token for metadata read, kept in memory until five minutes
  before it expires) and never stored here. An answer is reused for a minute,
  so a member reloading the page cannot spend the installation's rate limit.
- `POST /api/connections/github/install`: the address that installs the app,
  `{ url }`, carrying a signed state (below). Members get 403 `not_allowed`;
  an unconfigured app is 503 `github_not_configured`.
- `GET /api/github/callback`: the app's callback URL, where GitHub sends the
  person back (with "Request user authorization (OAuth) during installation"
  on). It always redirects to
  `<PUBLIC_URL>/?github=<result>#/settings/connections`, where `<result>` is
  `finishGitHubInstall`'s outcome in snake case (`connected`, `taken`,
  `not_installer`, …) or `signed_out`. The web app's Settings, on its
  Connections page, reads it once and clears it. That address is the web
  app's (`CONNECTIONS_PAGE` in `app.ts`), so the two change together.
- `DELETE /api/connections/github/installations/{installationId}`: removes the
  workspace's record. The app stays installed on GitHub until someone
  uninstalls it there. One the workspace does not hold, another's included,
  is 404 `installation_not_found`.

What makes a callback connect, in the order `finishGitHubInstall` checks it,
each before anything trusts the redirect:

1. **The state is this session's own.** `startGitHubInstall` signs the
   workspace, the person and the session with HMAC-SHA256 under a key derived
   from `BETTER_AUTH_SECRET` (HKDF, for this purpose only), for
   `INSTALL_STATE_LIFETIME_SECONDS`. A state from another session, another
   person's above all, is `bad-state`, and the code is never spent: a link
   someone else made cannot connect a workspace through you.
2. **The person is still an owner or admin** of the workspace the Connect was
   for, read from the database. That workspace is the one recorded, whatever
   the session has active by then.
3. **GitHub says this person administers the installation's account.** The
   `installation_id` in the redirect can be forged, so the one-time `code` is
   exchanged for the person's GitHub token, which is revoked once read and
   never stored or logged. `GET /user/installations` must list that id, and
   that alone is not enough: it lists an installation for anyone who can read
   one of its repositories, every member of an organisation included. So
   `checkInstaller` also needs the person to own the account: an active
   `admin` of the organisation (`GET /user/memberships/orgs/{org}`, which
   needs the app's Members organisation permission, read), or, for a
   personal installation, the person it is on (`GET /user`). Otherwise it is
   `not-account-admin`.
4. **No other workspace holds it.** `github_installation` is keyed by the
   installation id, so a second workspace's claim is `taken`, even at the
   same moment.

No token, code, client secret or key is ever logged: a failed call logs what
it was and GitHub's status. `describeStartupFailure` hides the client secret.

## Webhooks

The GitHub App's webhooks reach `POST /api/github/webhooks` (14.2, CON-70;
`postGitHubWebhook` in the contract, `adapters/http/webhooks.ts`). In
development a Cloudflare tunnel brings them to this machine (decided
2026-11-22; `README.md`, "Receive GitHub's webhooks"). Nothing is deployed.

- **In the contract, not outside it.** GitHub is the only caller, and it
  calls through no generated client, but every answer the route gives is
  Consola's own, so it is declared, typed and checked like any other route,
  as the callback is. `OUTSIDE_THE_CONTRACT` stays for what Consola does not
  answer itself. The request is declared only in words (`description`): a
  body or header schema would make the library parse them before the
  signature is checked.
- **The signature comes first.** `GITHUB_WEBHOOK_SECRET` is optional, at
  least 32 characters, and never logged (`describeStartupFailure` hides it);
  with none set, every delivery is 503 `webhooks_not_configured`. A body over
  `GITHUB_PAYLOAD_MAX_BYTES` (GitHub's own cap) is 413 `too_large` before it
  is read. Then `receiveGitHubWebhook` checks `X-Hub-Signature-256`, the
  HMAC-SHA256 of the body's bytes as they arrived, compared in constant time
  (`timingSafeEqual`, `webhookSignatures.ts`), before it reads a header or
  parses the body: unsigned, mis-signed or changed is 401 `bad_signature`.
  GitHub's SHA-1 `X-Hub-Signature` is never read.
- **Then, in order:** the headers and the body (400 `invalid_delivery`: no
  `X-GitHub-Event` or `X-GitHub-Delivery`, ones GitHub does not write, or a
  body that is no JSON object); GitHub's `ping`, answered 200 `pong` and passed
  to no cell; the installation the payload names (`installationOfEvent`) and
  the workspace that holds it (`InstallationStore.holderOf`), where an event
  through none, or through one no workspace holds (installed on GitHub but
  never connected, or disconnected), is dropped and logged, 422
  `no_installation` or `unknown_installation`; and the workspace's region's
  cell (503 `cell_not_configured` without one).
- **Passed on, never kept.** The event goes to the cell signed like an outbox
  message, typed `GITHUB_EVENT_TYPE` (`signGitHubEvent`,
  `createCellEventDelivery`; `packages/cloud-contract`, "Passing on a GitHub
  event"), while GitHub waits: `EVENT_DELIVERY_TIMEOUT_MS` (8 s) of GitHub's
  10. Nothing of it is written here, so there is nothing to retry from: a cell
  that does not take it is 502 `cell_unavailable`, and GitHub's Redeliver,
  which keeps the delivery's id, sends it again.
- **A delivery is recorded once, by the cell.** It keys each event by the
  workspace and `X-GitHub-Delivery`, so a delivery it has already (GitHub's
  Redeliver after a success, or a captured delivery replayed) changes
  nothing, and the route answers 409 `duplicate_delivery`. GitHub signs the
  body only, not its headers, so a captured body replayed under a new
  delivery id would check; TLS on the tunnel is what keeps a delivery from
  being captured.
- **What is logged** is one line per delivery (`webhookLine`): ids, the
  event's name, the installation, the workspace and the cell's status. A
  delivery's id and event are logged only once its signature checks. Never
  the body, a signature or the secret.

## Tests

A test sits beside its module and is named after it (`membershipStore.ts`,
`membershipStore.test.ts`). Rules in `domain` are tested alone. Stores and use
cases are tested on a migrated `pglite:memory` database through the real
Drizzle stores: the database is never mocked. `src/app.test.ts` is the HTTP
suite, end to end. It builds the service through `compose.ts`
(`composeApi`), as `main.ts` does, so it tests the wiring that runs, and it
checks every answer against the contract.

PGlite runs one transaction at a time, so a test of what concurrent
transactions do proves something only on a real Postgres. Such a test runs
there too when `CLOUD_GLOBAL_TEST_POSTGRES_URL` is set (to a server's
maintenance database, `postgres://…/postgres`), and is skipped otherwise.

## Generated files

- `openapi.json` is the contract (above), written by
  `pnpm --filter @consola/cloud-global openapi:generate`. Never edit it by
  hand; Biome leaves it alone, since it is compared byte for byte.
- `src/adapters/persistence/outboxSchema.ts` is Consola's own table, written
  by hand, and never by `auth:generate`. `drizzle.config.ts` reads it beside
  `auth-schema.ts`, and `schema.ts` puts the two together.
- `src/adapters/persistence/auth-schema.ts` holds Better Auth's tables,
  written by `pnpm --filter @consola/cloud-global auth:generate` from
  `src/adapters/auth/cli-config.ts`. Never edit it by hand. The CLI drops the
  header comment and writes double quotes, so after it, restore the header,
  run Biome, and check that `git diff` shows only the change you meant.
- `drizzle/` holds the migrations, written by
  `pnpm --filter @consola/cloud-global db:generate` after the schema changes.
  They apply when the API starts. For a required column on a table that has
  rows, drizzle-kit writes `ADD COLUMN … NOT NULL`, which fails on those rows:
  edit the generated SQL to add the column, fill it and then require it, as
  `0001_organization_region.sql` does, and test it from a database migrated
  only that far (`database.test.ts`, `migrateUpTo`). A backfill goes in the
  same migration, after the SQL drizzle-kit wrote, as `0002_outbox_message.sql`
  does. `db:generate` should then report no schema changes.
