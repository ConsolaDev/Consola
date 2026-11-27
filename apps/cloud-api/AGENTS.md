# AGENTS.md

This file guides coding agents working in `apps/cloud-api`
(`@consola/cloud-api`), Consola Cloud's API. `CLAUDE.md` imports it with
`@AGENTS.md`, so Claude Code reads it too. The repository's guide is the root
`AGENTS.md`, and setup is in `README.md`. Paths below are relative to
`apps/cloud-api`.

## What the app is

One app, with one database and one migration chain, hosted in one region
(the deployment's `REGION`). It listens on `127.0.0.1:3100` (`PORT`). The web
app (`apps/cloud-web`) reaches it through the web app's own origin, since Vite
proxies `/api` here; a workspace's runner reaches it over the runner's socket;
GitHub reaches it with the App's webhooks.

It holds two kinds of data, in two parts of the app (below):

- **accounts**: people, their Google sign-ins and sessions, the workspaces
  they make, and who is in each with which role, in Better Auth's tables;
- **company content**: what a workspace makes and keeps, under the Warp model
  (decided 2026-11-22: Consola hosts the runners and keeps what a workspace
  makes): its teams, factories with their files, runs and the answers to
  them, cloud sessions, GitHub installations, the tokens minted for them and
  GitHub's events.

Until 2026-11-26 these were two apps, `cloud-global` and a regional cell,
joined by an outbox, a cell token and an event relay. They were merged
("Cloud · Design: One cloud app, one database (40.1)",
https://linear.app/consola/document/cloud-design-one-cloud-app-one-database-401-bfb98a2a64db).
A later split must stay a data move, not a rewrite. The two parts, the
boundary between them and the two rules are what keep it so.

## The two parts

```
src/
  shared/       the regions and the workspace roles: plain TypeScript, no I/O
  accounts/     domain/ application/ adapters/{auth,persistence,http}
  company/      domain/ application/ adapters/{persistence,http,github,token,runner,clock}
  compose.ts  main.ts  config.ts  startupError.ts  seed.ts    the composition ring
  http/         the ring's front door (frontDoor.ts) and health check (health.ts)
  persistence/  the ring's one database and its migrations (database.ts)
  testing/      the HTTP suites' helpers (harness.ts), for the ring's tests alone
```

- `accounts` holds people, sign-in, sessions, workspaces and membership. Its
  code came from `cloud-global`.
- `company` holds what a workspace holds, GitHub included. Its code came from
  the cell, with `cloud-global`'s GitHub code.
- `shared` holds the regions (`REGIONS`, `isRegion`, `Region`) and the
  workspace roles (`WORKSPACE_ROLES`, `isWorkspaceRole`, `WorkspaceRole`). It
  imports nothing outside itself and does no I/O, and any file may import it.

**The boundary**, which `src/boundary.test.ts` enforces:

- `company/**` never imports `accounts/**`, `better-auth` or `@better-auth/*`;
- `accounts/**` never imports `company/**`;
- both may import `shared/`;
- only the composition ring imports both parts. It is where they meet: it
  builds the one HTTP app and hands it to each part, wires the membership port
  (`MembershipReader`, which `company` declares and `accounts` implements) and
  the session reader (`whoIsAsking`, from accounts' `currentSession`), and
  hands accounts' workspace store the hook that makes a workspace's first team
  (`openWorkspace`, below, "A workspace is born whole");
- inside each part, the layer rules hold (below, "The layers");
- of the workspace's packages, only `@consola/runner-protocol` and
  `@consola/factory-spec` may be imported, and only from `company` and from
  the ring's own tests, which drive `company` as a runner would;
- test files keep their exemption from the layer rules, except that a part's
  file, test or not, leaves its part only for `shared/` and `src/config.ts`
  (`PART_MAY_REACH`, each with its reason): never for the other part, and
  never for the ring (`compose.ts`, `persistence/`, `http/`, `testing/`,
  `main.ts`…), which brings the other part and Better Auth in. So a company
  test uses a fake `MembershipReader`, and never imports Better Auth. Only
  the ring's tests wire both parts, and only a test imports `src/testing/`.

## The two rules

Two rules keep the data splittable, and each is a test in `src/rules.test.ts`.
It reads the one Drizzle schema and every migration (`drizzle/*.sql`), so a
table or column that only a migration makes is checked too, and company's
code, for the second rule (below, "No reaching across"). It also proves, on
a fixture schema, a fixture migration and fixture sources, that each of its
checks fails when the rule is broken.

### Every company table carries its workspace id

Every table has `workspace_id text not null`, except the accounts tables.
`ACCOUNT_TABLES` names each, with its reason:

| Table | Why it has no `workspace_id` |
| --- | --- |
| `user`, `account`, `session`, `verification` | accounts: a person, the Google account they sign in with, their sessions, a sign-in in progress |
| `organization` | the workspace registry: its id is the workspace id |
| `member`, `invitation` | Better Auth's membership, keyed by `organization_id` |

Any other table without the column fails the test. So a new table is either
a company table, and carries `workspace_id`, or an accounts table, added to
`ACCOUNT_TABLES` with its reason.

### Company data refers to people only by id

- **No foreign key out.** No table outside `ACCOUNT_TABLES` has a foreign key
  into one of them: not into `user`, `account`, `session` or `verification`,
  and not into `organization`, `member` or `invitation` either. A company row
  names a person or a workspace by its id alone, so
  `github_installation.connected_by` holds the person's id with no foreign
  key.
- **No names or emails.** No company column's name contains `email`. A column
  named `name`, or ending in `_name`, fails unless the allow-list in the test
  names it with what it holds: today `team.name` (the team's name) and
  `factory.name` (the factory's). So `person_name`, `author_email` and
  `display_name` fail.
- **No reaching across.** Company code never imports accounts' files or Better
  Auth (`src/boundary.test.ts`), and the accounts tables live only in
  `accounts/adapters/persistence`. Company shares the one database client, so
  it could still read an accounts table without an import, and
  `src/rules.test.ts` reads every file in `company/`, tests included, for
  that too: no Drizzle builder there declares a table or a view named after an
  accounts table (`pgTable`, `pgView`, `pgMaterializedView`, any case; a name
  it cannot read fails, and so do `pgTableCreator` and `pgSchema`, which it
  cannot judge), and no string or template literal names one as SQL does:
  quoted (`"user"`, exactly, since a quoted name keeps its case) or bare after
  `from`, `join`, `into`, `update`, `references` or `table` (any case), or
  through `sql.identifier`. Company's own tables (`team_member`,
  `cloud_session`) and comments do not count.
- **Names come from accounts.** A person's name or email reaches a page only
  through accounts' own use case, `GET /api/me/workspace/members`, as the web
  app's Teams page does.

**Whom the rule covers.** Consola's accounts: the people in `user`. What
GitHub says about its own users is the company's content, as it was in the
cell: a push's commit authors in `github_event.payload`, and
`github_installation.account_login` on a personal account. It stays in
company tables.

Company code that reads an accounts table "just this once" (a join for a
person's name, say) is what the rule exists to stop. Ask the
`MembershipReader`, or leave the name to the page.

## The layers

Each part is built in rings, and imports point inward only.

### accounts

- `accounts/domain/` holds the rules and the types they speak of: who may join
  (`mayJoin`), what a new workspace needs (`checkNewWorkspace`) and who owns it
  (`CREATOR_ROLE`), which workspace a new session opens
  (`defaultActiveWorkspace`), who may change how a workspace looks
  (`mayManageWorkspace`) and the icons it may wear (`WORKSPACE_ICONS`,
  `checkWorkspaceIcon` in `workspaceIcon.ts`), and `Workspace`, `MyWorkspace`,
  `Person` and `SignedIn`. It is plain TypeScript, with no I/O and no package.
- `accounts/application/` holds the use cases (`createWorkspace`,
  `listMyWorkspaces`, `setActiveWorkspace`, `setWorkspaceIcon`,
  `listActiveWorkspaceMembers`, `workspaceForNewSession`, `mayCreateAccount`,
  `mayStartSession`, `describeMe`, `checkHealth`) and, in `ports.ts`, the
  stores and probes they need. A use case is a plain function that takes its
  ports first, and is handed what it cannot read itself: `createWorkspace` is
  handed the deployment's region.
- `accounts/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle: Better Auth's tables (`auth-schema.ts`,
    generated), one store per port, which `stores.ts` builds together, and
    `createMembershipReader` (`membershipReader.ts`), which is structurally
    `company`'s `MembershipReader` and imports nothing from `company`;
  - `auth/` is Better Auth (`betterAuth.ts`). Its hooks call use cases and run
    no query of their own;
  - `http/` is accounts' routes: `contract.ts` declares them, and `app.ts`
    registers them (`ACCOUNT_ROUTES`, `registerAccountRoutes`). Each route asks
    a use case and maps its answer to a status and a body.

### company

- `company/domain/` holds the rules and the types they speak of: who is asking
  (`caller.ts`: `admitCaller`, `Caller`), teams (`team.ts`), factories
  (`factory.ts`) and their templates (`factoryTemplates.ts`), runs (`run.ts`,
  `runApproval.ts`, `runSource.ts`), cloud sessions (`cloudSession.ts`),
  agent runs (`agentRun.ts`) and their follow-ups (`followUp.ts`:
  `followUpBody`, `followUpReach`; `hostAddress.ts`: `hostAddressAllowed`,
  the session host addresses the app calls), and GitHub: who may connect it and whether a
  Connect's state finishes in this session (`connections.ts`:
  `mayManageConnections`, `checkInstallState`), what a webhook delivery's
  headers name and the installation its payload came through (`webhooks.ts`:
  `readDeliveryHeaders`, `installationOfEvent`), and what each GitHub token's
  purpose may have and whether GitHub granted it (`gitHubTokens.ts`:
  `TOKEN_PURPOSES`, `scopeFor`, `grantedAsAsked`). It is plain TypeScript,
  with no I/O, and no package but the two shared ones (below).
- `company/application/` holds the use cases: `checkHealth`; the teams' in
  `teams.ts`; the factories' in `factories.ts` (`factoryTemplates` too); the
  runs' in `runs.ts`; `seedDemoRuns` and `seedCodeReviewTeam`; the agent runs'
  `startAgentRunsFor` and `startAgentRun` in `agentRuns.ts`; the cloud
  sessions' `sessionOptions`, `startSession`, `listSessions`, `getSession`,
  `stopSession`, `applyRunnerUpdate` and `issuePass`; an agent run's
  `sendFollowUp`, in `followUps.ts`; a runner's `runnerConnected`, in
  `runners.ts`; and GitHub's `listConnections`,
  `startGitHubInstall`, `finishGitHubInstall`, `disconnectGitHub`,
  `receiveGitHubWebhook` and `mintGitHubToken`. `ports.ts` holds the stores,
  the probes, the `MembershipReader`, the `TeamStore`, the `FactoryStore`, the
  `RunStore`, the `CloudSessionStore`, the `RunnerChannel`, the `PassSigner`,
  the `HostChannel`, `Ids`, the `Clock`, the `AgentRunPorts` and the
  `FollowUpPorts`; `gitHubPorts.ts` holds GitHub's:
  the GitHub App, the Connect state's signer, the webhook signatures, the
  installation and token-mint stores, and the `GitHubEventStore`. A use case
  is a plain function that takes its ports first.
- `company/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle: the tables (`tables.ts`, and GitHub's
    `github_installation`, `github_token_mint` and `github_event` in
    `gitHubTables.ts`), one store per port, which `stores.ts` and
    `gitHubStores.ts` (`createGitHubStores`) build, and `openWorkspace`
    (`teams.ts`);
  - `http/` is company's contract (`contract.ts`, and GitHub's routes in
    `gitHubContract.ts`), the routes (`app.ts`: `COMPANY_ROUTES` and
    `registerCompanyRoutes`; `gitHub.ts`: `GITHUB_ROUTES` and
    `registerGitHubRoutes`; and each area's own file: `teams.ts`,
    `factories.ts`, `runs.ts`, `cloudSessions.ts`, `webhooks.ts`), and the
    caller check in front of them (`caller.ts`, below, "Who is asking"). Each
    route asks a use case and maps its answer to a status and a body;
  - `github/` is GitHub's REST API over `fetch`, and `node:crypto`: the app
    (`gitHubApp.ts`, which reads the app's `.pem` with `loadGitHubAppKey`),
    the signed state of a Connect (`installStateSigner.ts`) and the webhook
    signature check (`webhookSignatures.ts`). It is the only code that holds
    the GitHub App's private key, client secret and webhook secret;
  - `token/` is jose: the `PassSigner`, on the app's pass key, with the public
    half it derives (`passSigner.ts`);
  - `clock/` is the machine's clock, the `Clock`;
  - `runner/` is the `RunnerChannel`, how the app reaches a workspace's
    runner: the runner's socket, a route of its own on `@hono/node-ws`
    (`runnerSocket.ts`), which calls `runnerConnected` and
    `applyRunnerUpdate` itself. With no runner configured, its channel is
    `noRunner`, which answers that none is connected;
  - `host/` is the `HostChannel`, how the app reaches a running session's
    host, over `fetch`, at the address its runner reported
    (`hostChannel.ts`), to an address the deployment calls
    (`SANDBOX_HOST_SUFFIXES`, `LOCAL_SANDBOXES`; below, "Agent runs").

### The composition ring

- `src/compose.ts` is the one place adapters are built and handed the ports
  they need (`composeApi`), and the one place a startup step would live. It
  builds the one `OpenAPIHono`: the front door first (`createFrontDoor`,
  `src/http/frontDoor.ts`: the origin check, the body-error answers and
  `defaultHook`), then accounts' routes (`registerAccountRoutes`), company's
  (`registerCompanyRoutes`) and GitHub's (`registerGitHubRoutes`), then the
  health check, then the runner's socket. `ROUTES` holds every route the app
  serves through the contract: `ACCOUNT_ROUTES`, `COMPANY_ROUTES`,
  `GITHUB_ROUTES` and `RING_ROUTES`. `ORIGIN_EXEMPT` is what the front door's
  origin check leaves alone (below, "Workspaces"). `composeApi` is async,
  because reading the GitHub App's key
  and importing the pass key are. A GitHub key file that cannot be read or
  holds no RSA private key, or a pass key that is no Ed25519 private key,
  fails there as a `ConfigError`, which `main.ts` reports like any other
  configuration problem. Adapters call use cases themselves; what they never
  do is build another adapter. The one exception is
  `src/accounts/adapters/auth/cli-config.ts`, which builds the stores and
  `createAuth` for Better Auth's schema CLI: it is tooling, and never runs in
  the service.
- `src/http/health.ts` is the ring's one route of its own, `GET /api/health`
  (`RING_ROUTES`, `registerHealthRoute`): 200 `{ ok: true }` when each part's
  `checkHealth` says it can work, else 503 `{ ok: false }`, a check that
  throws counting as one that cannot. It needs no session and no
  `x-consola-workspace`. Like the front door, it knows neither part: it is
  handed their checks.
- `src/persistence/database.ts` opens the one database (`openDatabase`:
  `pglite:memory`, `pglite:<folder>`, or `postgres://` through a pool) and
  migrates the one chain (`migrateDatabase`). Each part gets its Drizzle
  instance on the same client (`AppDatabase`: `accounts`, `company`), and
  types its stores over its own tables alone. The one schema (`SCHEMA`) is put
  together only here, where both parts' tables are visible, and this is where
  the creation transaction is handed from accounts to company:
  `workspaceOpening`, which `compose.ts` hands accounts' stores, is the
  `onCreated` hook that runs `company`'s `openWorkspace` on accounts'
  transaction, with the one cast of the transaction, commented there.
- `src/main.ts` loads the environment (`.env`, for any variable the shell
  leaves unset), opens and migrates the database, calls `composeApi` and
  serves. It calls `injectWebSocket(server)` for the runner's socket, and on
  the way out closes every runner's socket (`closeRunnerSockets`, 1001) before
  the server, which would otherwise wait on them, and the database last.
- `src/startupError.ts` words a failure to start, with every secret the
  configuration holds hidden: `BETTER_AUTH_SECRET`, the Google and GitHub
  client secrets, the webhook secret, the database's address and any password
  in it, `RUNNER_SECRET` and `PASS_PRIVATE_KEY`.
- `src/config.ts` parses the environment, `REGION` included (one of
  `REGIONS`, `eu` when unset). It is shared configuration that any adapter may
  read, so it stays a pure parser with no I/O, and imports only `shared/`,
  whose regions it checks `REGION` against.
- `src/seed.ts` is the demo seed's entry (below, "Runs").

## The dependency rule

- `domain` imports only its own part's `domain` and `shared/`. `application`
  imports only its own part's `domain` and `application`, and `shared/`.
  Neither imports a package (in `company`, but the two shared packages below)
  or a `node:` builtin, and neither refers to a global that reaches the
  machine: `process`, `fetch`, `require`, `XMLHttpRequest`, `WebSocket`, the
  timers (`setTimeout`, `setInterval`, `setImmediate`), `globalThis` or
  `global`.
- An adapter imports its own part's `domain` and `application`, `shared/`,
  its own folder and `src/config.ts`. It never imports the composition ring,
  the other part or another adapter, except that accounts' `auth` may import
  accounts' `persistence`. Beyond that:
  - in `accounts`:
    - `adapters/http` never imports `better-auth`, a database library
      (`drizzle-orm`, `@electric-sql/pglite`, `pg`), `jose`,
      `adapters/persistence` or `adapters/auth`. Sign-in reaches it as
      `handleAuth` and `currentSession`, which `compose.ts` passes in;
    - `adapters/persistence` never imports `hono`, `better-auth` or `jose`;
    - `adapters/auth` never imports `hono`, `jose`, `adapters/http` or a
      database library: its hooks call use cases, and the stores run the
      queries. It may import `adapters/persistence`, because Better Auth's
      Drizzle adapter needs the database and its schema;
  - in `company`:
    - `adapters/http` never imports a database library or `jose`;
    - `adapters/persistence` never imports `hono` or `jose`;
    - `adapters/token` is the one place in the app that imports `jose`, and
      never imports `hono` or a database library;
    - `adapters/github` never imports `hono`, a database library or `jose`. It
      signs its app token with `node:crypto`, and reaches the routes only as
      the `GitHubApp` and `InstallStateSigner` ports;
    - `adapters/clock` imports no package;
    - `adapters/runner` may import `hono` and `@hono/*` (`@hono/node-ws`),
      since the runner's socket is a route, and never a database library or
      `jose`: it is handed the pass key's public half as a string, and never
      signs;
    - `adapters/host` never imports `hono`, a database library or `jose`: it
      is handed a signed pass, and calls the host with `fetch`.
- The ring's folders have rules of their own. `http/` imports neither part,
  only `shared/`, and no database, auth or token library: the front door and
  the health check are handed what they need. `persistence/` imports only
  the two parts' `adapters/persistence` and `shared/`, and no HTTP, auth or
  token library. `testing/` is imported only by tests.
- No file, tests included, imports another app or a workspace package
  (`@consola/*`, or `consola`, the desktop), with two exceptions, the shared
  packages, which `company` alone may import, from any layer, `domain` and
  `application` included, and the ring's own tests too. Only an entry point
  counts: a path inside one is refused.
  - `@consola/runner-protocol` (`packages/runner-protocol`, MIT), what the app
    and its runners say to each other: the messages over a runner's socket,
    the readers of a repository and a harness, the session pass's claims, and
    a follow-up for an agent run's host.
    The protocol calls the app's side of the socket the cell. It does no I/O,
    which its own boundary test proves. Before changing it, read
    `packages/runner-protocol/AGENTS.md`.
  - `@consola/factory-spec` (`packages/factory-spec`, MIT), the factory files'
    schema and parser every runner shares, with which `company` checks the
    files it stores (below, "Factories"). It parses texts it is handed and
    does no I/O.
- Test code is exempt from the layer rules, because it wires real pieces
  together the way `compose.ts` does. Test code is a test (`*.test.ts`) or a
  test's helpers (`*.test-helpers.ts`, beside the module they help test, such
  as `database.test-helpers.ts`), held alike. A part's test code still leaves
  its part only for `shared/` and `config.ts`, never for the other part or
  the ring, and company's never imports Better Auth.
- `tsconfig.build.json` leaves test code and `testing/` out of `dist`, so
  nothing else imports them, and nothing else imports a development
  dependency (`drizzle-kit`, `vitest`, `ws`…), which `dist` does not have. A
  helper a test needs is named `*.test-helpers.ts`, or it ships.

`src/boundary.test.ts` enforces the rule and the boundary. It reads every
file's imports from the TypeScript syntax tree (`import`, `import type`,
`export … from`, dynamic `import()`), and the globals `domain` and
`application` refer to. Only a reference counts, directly or through
`globalThis`, never a property or a member that shares the name
(`request.process`, `{ fetch: 1 }`). A file that sits in no layer fails it
too. The rules are data at its top (`LAYERS`, which holds both parts and
`shared`, and `NEVER`), so a new layer or folder is added there first. It also
reads every package in the workspace and checks that each one but the two
shared ones is refused, so a new package is covered without being named.

## Who is asking

A company route learns who is asking from the request's Better Auth session
cookie, and from nothing else: not a query parameter, a body or another
header. The workspace is the session's active one, and the role is read from
`member` for that request.

- **The pieces.** `requireCaller` (`company/adapters/http/caller.ts`) is the
  Hono middleware every company route takes as its route `middleware`, never
  through `app.use`. It asks `whoIsAsking` (`WhoIsAsking`, which the ring
  builds from accounts' `currentSession`) for the person, the session and its
  active workspace (`SignedInPerson`: `personId`, `sessionId`,
  `activeWorkspaceId`), reads `x-consola-workspace` (`WORKSPACE_HEADER`),
  reads the person's role in the session's active workspace, and only that
  one, through the `MembershipReader` (`roleOf`), once the header names it,
  and hands the three to `admitCaller` (`company/domain/caller.ts`). The
  `Caller` it admits (the person's id, the session's id, the workspace's id
  and the role, no more) is set on the context (`c.var.caller`). The
  session's id is there for GitHub: a Connect's signed state names the
  session it began in, so only that session can finish it ("Connections").
  Only `admitCaller` makes a `Caller`: a type-only brand keeps a hand-written
  one from type-checking.
- **The order, and the answers.** `admitCaller` refuses, in this order:
  1. no session: 401 `signed_out`;
  2. no `x-consola-workspace`: 400 `invalid_request`;
  3. a session with no active workspace: 409 `no_active_workspace`;
  4. a header that names another workspace than the session's active one:
     409 `workspace_switched`, which the web app reads as `switched`;
  5. no role in `member` for the person in that workspace (never a member, or
     removed): 403 `not_a_member`.

  Each body is exactly `{ error }`, and the contract declares them once
  (`callerFailures`). `caller.test.ts` tests each refusal, and the order when
  two apply.
- **The header is only a guard.** Another tab can switch the session's active
  workspace while a page still shows the first one. Every company request
  carries the workspace its page shows, and a mismatch is refused before
  anything is read or written, so a page never acts in a workspace it does not
  show. The workspace still comes from the session, never from the request,
  and route paths carry none.
- **The role is live.** It is read from `member` on every request, so someone
  removed from a workspace is refused on their very next request, and a
  changed role counts on the next one. There is no token to outlive a change,
  and no grace period.
- **A workspace's rows.** A route never takes the workspace it acts in from
  the request (path, query, body or header). A use case that reads or writes a
  workspace's rows takes the `Caller` and scopes every query by its
  `workspaceId`, so a person in one workspace cannot reach another's rows. A
  role check is the use case's too, from `caller.role`.
- **Routes without a session.** `GET /api/health`, GitHub's webhooks
  (`POST /api/github/webhooks`, signed instead, below), the GitHub callback
  (`GET /api/github/callback`, a redirect, which reads the session itself
  through `whoIsAsking`) and the runner's socket (`GET /api/runner`, behind
  the runner's secret) take no `requireCaller` and no `x-consola-workspace`,
  since no page calls them through the client. A new one needs a reason as
  good, and the company suite's "every route" test has to name it
  (`OPEN_ROUTES`).
- **Changes are behind the origin check.** Company changes are authorised by
  the cookie, so they sit behind the front door's origin check (403
  `bad_origin`, below, "Workspaces"), like accounts' changes.

## Workspaces

A workspace is the top level people see, as in Notion: a company, a team, or
only you. In the database it is Better Auth's `organization` row, whose id is
the workspace id every company table carries, and a person is in it through a
`member` row; everything Consola says, its API included, says "workspace".
Anyone signed in can make one, belong to several and switch between them.

**The routes are Consola's own, not Better Auth's** (decided in 2.1, CON-49),
and they are accounts':

- `GET /api/me`: the person, and their session's active workspace with their
  role in it (`workspace`, null when there is none);
- `PUT /api/me/workspace` `{ workspaceId }`: makes one of the person's
  workspaces active (`setActiveWorkspace`); one they are not in is 404, like
  one that does not exist;
- `PUT /api/me/workspace/icon` `{ icon }`: sets the active workspace's icon,
  or takes it off (null) (`setWorkspaceIcon`). Only an owner or an admin may
  (`mayManageWorkspace`; anyone else is 403 `not_allowed`), read from the
  database, never the request. An icon is one of `WORKSPACE_ICONS`, the
  desktop app's own ids (`workspaceIcon.test.ts` reads its
  `shared/workspaceIcons.ts` and fails when the two differ), so a workspace
  known to both wears the same icon; anything else is 400 `icon_unknown`.
  It writes the icon alone, into Better Auth's `organization.logo`, which
  reads back as no icon when it holds anything else (`iconOf`);
- `GET /api/me/workspace/members`: the active workspace's members, each with
  their id, name, email, image and role, in the order they joined
  (`listActiveWorkspaceMembers`). Every member may list them: company data
  names people by id only (rule 2, above), so this is how the web app puts a
  name to them (8.2, Teams). No workspace open is 409 `no_active_workspace`;
  one the person is not in is 403 `not_a_member`;
- `GET /api/workspaces`: the person's workspaces, in the order they joined.
  Every workspace an answer names carries its `icon` and `canManage`, whether
  the person may change it (`mayManageWorkspace`), so the web app shows its
  controls by what the server says, never by reading the role;
- `POST /api/workspaces` `{ name, slug }`: makes one (`createWorkspace`), in
  the deployment's region (below, "Regions"). The creator is its owner and
  their session opens it. A request `checkNewWorkspace` refuses is 400 with
  every problem named; a slug any workspace has is 409 `slug_taken`. The
  workspace is born whole (below).

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
- a workspace, its first member and its first team are written in one
  transaction (`WorkspaceStore.create`, below);
- one way to make, list or switch workspaces, so the web app and later
  clients never have two to choose from.

A member's role is one of `WORKSPACE_ROLES` (`owner`, `admin`, `member`, in
`shared/`), and the stores read back only a listed one (`roleOf`). Membership
comes only from making a workspace for now, as its `owner` (`CREATOR_ROLE`):
signing in joins nothing. Invites, roles and removal (project 3) are routes of
Consola's own too, on Better Auth's `member` and `invitation` tables, and keep
the workspace's teams true to `member` in the same transaction (below). Better
Auth's `delete-user` route stays off (its default): deleting an account would
take its `member` rows with it, past that hook, so turning it on means taking
the person out of every team first. A new session starts in the workspace
`defaultActiveWorkspace` picks (the one last active, else the first joined,
else none). `SessionStore` writes the active workspace on the `session` row
itself, which is right only while Better Auth's cookie cache stays off: with
it on, a session would keep the workspace in its cookie, and "Who is asking"
would read a stale one.

A request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) must come
from the web app's origin (`PUBLIC_URL`), or it is 403 `bad_origin`, as Better
Auth requires of its own routes: the session cookie is SameSite=Lax, which
another site on the same host, any other localhost port, would still be sent.
The check is the front door's (`createFrontDoor`), for every route of both
parts. Two kinds of path are exempt (`ORIGIN_EXEMPT` in `compose.ts`, handed
to the front door as `originExempt`, where an entry ending in `/` names every
path under it and any other one exact path): everything under `/api/auth/`,
Better Auth's own routes, which check their own trusted origins
(`PUBLIC_URL`); and GitHub's webhook deliveries,
`POST /api/github/webhooks`, which carry no cookie and no Origin, and whose
signature is what is checked ("Webhooks"). `src/accountsApp.test.ts` pins
accounts' route list, so a new route is added there on purpose.

## A workspace is born whole

- **One transaction.** `POST /api/workspaces` writes the `organization` row,
  its owner's `member` row, the workspace's first team and the owner's place
  in that team, in one transaction. Accounts' `WorkspaceStore.create`
  (`createWorkspaceStore(db, { onCreated })`) writes the first two and calls
  its `onCreated` hook inside the same transaction, with the new workspace's
  id and its owner's. The ring sets the hook to `company`'s `openWorkspace`
  (`company/adapters/persistence/teams.ts`), which makes the first team and
  puts the owner in it, and changes nothing when it runs twice. A hook that
  throws rolls the whole workspace back, so no `organization` row is ever left
  without its owner, its first team and the owner's place in it.
- **Nothing waits for a workspace.** Company content is in the same database,
  so there is no copy of the workspace to wait for, and no route answers that
  a workspace is pending.
- **Team membership is kept honest in code**, since no foreign key reaches
  `member` (rule 2): adding a person to a team first asks the
  `MembershipReader` whether they are in the workspace (409
  `not_a_workspace_member` if not). `team_member` keeps its foreign key to
  `team`.
- **Adding and removing members** have no routes yet. When project 3 adds
  them, each uses the same kind of hook, in the same transaction as its change
  to `member`: adding a member puts them in the workspace's first team, and
  removing one takes them out of every team. A role change keeps the teams a
  member is in, so a person taken out of the first team is not put back by
  one.

## Regions

Every workspace (the `organization` row) has a `region`, one of `REGIONS`
(`eu`, `us`, in `shared/`). The app runs in one region, the deployment's
`REGION` (`eu` when unset), and every new workspace takes it: the composition
hands `config.region` to `createWorkspace`, and `POST /api/workspaces` takes
no region. Nothing changes it afterwards:

- `WorkspaceStore.create` writes it only when it makes the row, and every
  store reads back only a listed region (`regionOf`);
- no route moves a workspace: Consola's routes make and switch, and set an
  icon, which writes `logo` alone; Better Auth's are closed. Its organisation
  plugin also declares the region with `input: false`, so nothing it would
  accept carries one;
- a new route or hook that writes `organization` must leave `region` alone,
  and `src/accountsApp.test.ts` checks that no route moves it.

The region stays on the record so that a workspace can later move to a
deployment in its own region as a data move. Moving data between regions, a
second region and an edge router are not built.

## The contract

`openapi.json`, at the app's root, is the API's contract. It is generated from
the composed app by `src/openapi.test.ts`
(`pnpm --filter @consola/cloud-api openapi:generate`), which fails while it is
stale. The web app's types are generated from it (`cloud-web`'s
`api:generate`), which reads it as a file, so a change here reaches the web
app through that file, and CI checks the web app with every change to this app
(`.github/scripts/ci-scope.mjs`).

- **Each part declares its own routes**, in its `adapters/http/contract.ts`
  (GitHub's in `company/adapters/http/gitHubContract.ts`), with
  `@hono/zod-openapi`'s `createRoute`, and registers them with `app.openapi`
  on the app it is handed (`registerAccountRoutes`, `registerCompanyRoutes`,
  `registerGitHubRoutes`), never with `app.get` or `app.post`. Each lists its
  routes (`ACCOUNT_ROUTES`, `COMPANY_ROUTES`, `GITHUB_ROUTES`), and `ROUTES`
  joins them, with the ring's health route. A route is added to its part's
  contract first, then implemented and listed.
- **Every status a route can answer is declared, with its body.** TypeScript
  refuses a handler answer the route does not declare, a missing field or a
  wrong literal, but not an extra field. That one the HTTP suites catch: they
  read every answer with the schema its route declares for its status
  (`answerOf`), and answers are strict objects (`z.strictObject`).
- **The app serves nothing the contract does not declare.**
  `openapi.test.ts` compares what the composed app serves with `ROUTES`, so a
  route registered with `app.get` and the like, or with `app.openapi` but left
  out of its part's list, fails it. `OUTSIDE_THE_CONTRACT` names the only
  exceptions, each with its reason: Better Auth's `/api/auth/*`, the origin
  check's middleware, and the runner's socket, `GET /api/runner`, a WebSocket
  upgrade OpenAPI does not describe, behind the runner's secret, which no
  client calls through the contract (its messages are
  `@consola/runner-protocol`'s). Adding to it needs a reason as good.
- **A request schema checks shape, never rules.** It is never stricter than
  the domain rule behind it (`z.object`), and a route whose rules name
  problems hands a body of the wrong shape to them in its hook
  (`POST /api/workspaces` calls `checkNewWorkspace`), so every problem is
  still named. The one strict request body is a cloud session's start
  (`NewCloudSession`), because its rule is exactly `{ repository, harness }`
  (`readStartRequest`), so the schema is no stricter than the rule. Any other
  wrong shape is 400 `invalid_request` (the front door's `defaultHook`), never
  the validator's own answer.
- **A body that is not JSON is refused before any route sees it**: 400
  `invalid_request` if it does not parse, 415 `unsupported_media_type` without
  a JSON content type (the front door's `onError`, since the validator throws
  before any hook). A session check runs before the body is read (route
  `middleware`), so a signed-out request is 401 whatever it sends.
- **The caller check's answers** (401 `signed_out`, 400 `invalid_request`,
  409 `no_active_workspace` and `workspace_switched`, 403 `not_a_member`) are
  declared once (`callerFailures`) and spread into every route behind
  `requireCaller`. A route of company's that changes something (POST, PUT,
  PATCH, DELETE) spreads `changeFailures` instead: the same, with the front
  door's 403 `bad_origin` in one union with `not_a_member`; a read never
  declares `bad_origin`. A route that answers one of those statuses itself (a
  409 `name_taken`, a 403 `not_allowed`) declares it after the spread, as one
  union with the caller's, since a status holds one answer.
- **A schema used both alone and nullable is a union at the nullable use**
  (`z.union([Named, z.null()])`): `.nullable()` on a named schema makes every
  use of the name nullable. `openapi.test.ts` checks no named schema is.

## Connections

A workspace connects GitHub by installing Consola's one GitHub App (decided
2026-11-21) on a GitHub account or organisation (14.1, CON-67). Every member
sees what is connected; owners and admins connect and disconnect
(`mayManageConnections`, on `caller.role`). The app's four settings are
optional together (`config.ts`, `readGitHubApp`): with none set, `github` is
null, the routes say so, and the service still starts. Every route below is in
the contract (`gitHubContract.ts`: `getConnections`, `postGitHubInstall`,
`getGitHubCallback`, `deleteGitHubInstallation`), the callback too: it answers
only a redirect, and `CALLBACK_RESULT` (`gitHub.ts`) names each way a Connect
ends as the contract lists them (`GITHUB_CALLBACK_RESULTS`). Connections,
Install and Disconnect take `requireCaller` and `callerFailures`; the callback
takes neither, and reads the person and the active workspace through
`whoIsAsking`.

- `GET /api/connections`: the active workspace's installations, each with its
  account, when it was connected, its settings page on GitHub (`settingsUrl`)
  and its repositories as GitHub says now (`listed`, `gone` or
  `unavailable`), plus `canManage` and whether the app is `configured`. The
  repositories are asked of GitHub (an installation token for metadata read,
  kept in memory until five minutes before it expires) and never stored. An
  answer is reused for a minute, so a member reloading the page cannot spend
  the installation's rate limit.
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
  app's (`CONNECTIONS_PAGE` in `gitHub.ts`), so the two change together.
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
   for, read through the `MembershipReader`. That workspace is the one
   recorded, whatever the session has active by then.
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

A connected installation is a row of `github_installation`: its
`workspace_id`, the installation, the GitHub account it is on, who connected
it (`connected_by`, the person's id, with no foreign key) and when. The
repositories it covers are not kept: GitHub is asked for them each time. No
token, code, client secret or key is ever logged: a failed call logs what it
was and GitHub's status.

## Webhooks

The GitHub App's webhooks reach `POST /api/github/webhooks` (14.2, CON-70;
`postGitHubWebhook` in `gitHubContract.ts`, `adapters/http/webhooks.ts`). In
development a Cloudflare tunnel brings them to this machine (decided
2026-11-22; `README.md`, "Receive GitHub's webhooks"). Nothing is deployed.

- **In the contract, not outside it.** GitHub is the only caller, and it
  calls through no generated client, but every answer the route gives is
  Consola's own, so it is declared, typed and checked like any other route,
  as the callback is. The request is declared only in words (`description`):
  a body or header schema would make the library parse them before the
  signature is checked.
- **The signature comes first.** `GITHUB_WEBHOOK_SECRET` is optional, at
  least 32 characters, and never logged; with none set, every delivery is 503
  `webhooks_not_configured`. A body over `GITHUB_PAYLOAD_MAX_BYTES` (GitHub's
  own cap) is 413 `too_large` before it is read. Then `receiveGitHubWebhook`
  checks `X-Hub-Signature-256`, the HMAC-SHA256 of the body's bytes as they
  arrived, compared in constant time (`timingSafeEqual`,
  `webhookSignatures.ts`), before it reads a header or parses the body:
  unsigned, mis-signed or changed is 401 `bad_signature`. GitHub's SHA-1
  `X-Hub-Signature` is never read.
- **Then, in order:** the headers and the body (400 `invalid_delivery`: no
  `X-GitHub-Event` or `X-GitHub-Delivery`, ones GitHub does not write, or a
  body that is no JSON object); GitHub's `ping`, answered 200
  `{ result: 'pong' }` and recorded nowhere; the installation the payload names (`installationOfEvent`)
  and the workspace that holds it (`InstallationStore.holderOf`), where an
  event through none, or through one no workspace holds (installed on GitHub
  but never connected, or disconnected), is dropped and logged, 422
  `no_installation` or `unknown_installation`; then the record.
- **Recorded once.** `GitHubEventStore.record` keys each event by its
  workspace and `X-GitHub-Delivery`, and inserts on conflict doing nothing. An
  event recorded now is 201 `{ result: 'recorded' }`. A delivery recorded
  before (GitHub's Redeliver
  after a success, or a captured delivery replayed) changes nothing and is 409
  `duplicate_delivery`. A database that does not answer is 503 `unavailable`,
  and GitHub's Redeliver, which keeps the delivery's id, sends it again.
  GitHub signs the body only, not its headers, so a captured body replayed
  under a new delivery id would check; TLS on the tunnel is what keeps a
  delivery from being captured.
- **What is kept.** `github_event`, keyed by `workspace_id` and GitHub's
  `delivery_id`: the event's name, the installation, the payload as GitHub
  sent it and when it was received. The payload is GitHub's JSON as text, not
  `json` or `jsonb`: both refuse a `\u0000` escape, which a pull request's body
  or a comment can hold. What an event says is the company's content, kept for
  the workspace's runners and triggers (epics 21 and 39). Every event is kept
  for now; how long is for them to decide.
- **A first recording starts agent runs.** For an event recorded now, and only
  then, the use case calls `startAgentRunsFor` (below, "Agent runs"). Whatever
  happens there never changes the answer.
- **What is logged** is one line per delivery (`webhookLine`): ids, the
  event's name, the installation, the workspace and the outcome. A delivery's
  id and event are logged only once its signature checks. Never the body, a
  signature or the secret.

## GitHub tokens

The app holds the GitHub App's key, so it alone mints installation tokens,
and each one is narrowed to the repositories and permissions it is needed for
(decided 2026-11-21; 14.3, CON-71). The work a token is for (a factory pulled
from a repository (9.4) or saved to one (37.2), or a run (epic 21)) asks
through an in-app use case, `mintGitHubToken(ports, { workspaceId,
installationId, purpose, repositoryIds })`, where `installationId` is the
installation the workspace holds, by its id on GitHub, and `ports` the
token-mint store, the GitHub App, the clock and, optionally, a log. No route mints a token, and
nothing calls the use case yet.

**Proposed** (14.3, CON-71), not yet confirmed:

- **The purposes fix the permissions** (`TOKEN_PURPOSES`): `review-run`,
  contents read and pull requests write, for at most 10 repositories;
  `factory-pull`, contents read, and `factory-save`, contents write, each for
  exactly one. A request names a purpose, never permissions. Pulling a
  factory gets a read-only token: only saving writes.
- **What is checked, in order, before anything is minted:** the purpose's
  rules: at least one repository, never a whole installation, no more than it
  allows, none twice (`invalid`, every problem named); the installation is one
  the workspace holds, read from `github_installation`, so one workspace never
  gets a token for another's installation (`installation-not-found`); this
  server has the app (`not-configured`); GitHub still has the installation
  (`installation-gone`); and the installation covers every repository, as
  GitHub lists it (the list `GET /api/connections` reads, reused for a
  minute) (`not-covered`, naming each by id).
- **GitHub's answer is checked too.** The mint asks for `repository_ids` and
  `permissions` (`mintToken`), and a token is handed out only when GitHub
  says it carries exactly those repositories and permissions, plus metadata
  read (`grantedAsAsked`). Anything else is revoked (`DELETE
  /installation/token`), logged in one line by its ids alone (the workspace,
  the installation and the purpose; never the token or a repository's name),
  and refused (`not-as-asked`). GitHub refusing the
  scope (422: a permission the app lacks, or a repository it stopped
  covering) is `refused`. Each token is a new one: never kept, never reused,
  never the one the repositories are listed with.
- **Every token handed out is recorded first** (`github_token_mint`): its
  `workspace_id`, the installation, the purpose, the repositories by their
  GitHub ids, the permissions, and when it was minted and expires; never the
  token, and never a repository's name. One that cannot be recorded is
  revoked, and the request fails. There is no foreign key: a record outlives
  the installation and the workspace it speaks of.
- **Checked against GitHub** on 2026-11-22 with the development app: a token
  narrowed to one repository read it (200) and got 404 for another private
  repository of the same installation, listed one repository, could not write
  with read (403), and was 401 once revoked; a repository of another
  installation was 422. `src/gitHubApp.test.ts` replays those answers,
  through the use case.
- **What this does not do yet.** The use case says nothing of who or what
  asked (a person, a factory, a run): that stays with the work that asks.

## Teams

A workspace's teams are company content, because their names are the
company's information (decided 2026-11-21: teams own factories; a new
workspace starts with one team; no team-level roles). Better Auth's teams are
not used: they would put company content in accounts' tables. The rules are in
`domain/team.ts`, the use cases in `application/teams.ts`, the store in
`adapters/persistence/teams.ts` and the routes in `adapters/http/teams.ts`,
all under `company/`.

- **Two tables**, each with its `workspace_id`: `team` (`team_id`, which the
  app gives it, `name`, `is_first`) and `team_member` (`team_id`,
  `person_id`, `added_at`). A team member's row points at its team through
  both ids, so a place is always in a team of its own workspace. `person_id`
  is the person's id, with no foreign key (rule 2): only a member of the
  workspace is put in one of its teams (below), and once project 3 adds
  removal, a member who leaves the workspace leaves every team in the same
  transaction ("A workspace is born whole").
- **The first team.** Every workspace has exactly one (`team_first_unique`),
  called `FIRST_TEAM_NAME` (`General`) until someone renames it. It is made
  with the workspace, in the same transaction, by `openWorkspace`, with the
  owner in it. It can be renamed, and its members taken out, but it is never
  deleted (409 `first_team`), so every factory always has a team to belong
  to.
- **Names** are trimmed, 1 to `TEAM_NAME_MAX` characters with no control
  character (`checkTeamName`, every problem at once as 400 `invalid_team`),
  and unique in the workspace whatever their case (`team_name_unique`, on
  `lower(name)`; 409 `name_taken`).
- **Who may do what** (`mayManageTeams`): owners and admins make, rename and
  delete teams and choose their members, and see every team; a member sees
  only the teams they are in, and is refused any change (403 `not_allowed`).
  The list says which (`canManage`), so the web app shows controls by the
  answer, never by the role.
- **The role a caller acts with** is `caller.role`, read from `member` for
  this request (`mayManageTeams`, `teamsSeenBy`), so someone demoted or
  removed is refused from their next request on.
- **A team lists only the workspace's members now.** A place outlives a person
  who leaves the workspace until something takes them out of every team, so
  every answer drops the places of people the `MembershipReader` no longer
  lists (`memberIds`, `withCurrentMembers`), in the order they joined.
- **The order of the checks** is the same in every change: the caller's role
  (a member is refused without anything being read), then the name, then what
  the store finds. A team id is looked up in the caller's workspace alone, so
  another workspace's team is 404 `team_not_found`, never changed.
- **Members** are added by their id, `PUT
  /api/teams/{teamId}/members/{personId}`, and only if the
  `MembershipReader` says they are in the workspace (409
  `not_a_workspace_member`); adding someone already in the team, or taking out
  someone not in it (`DELETE`), changes nothing.
- **A team that owns a factory** is not deleted (409 `owns_factories`), below
  ("Factories").

## Factories

A workspace's factories are company content, with their files (decided
2026-11-22: a factory's definition is saved in Consola's backend, or pulled
from a git repo). The rules are in `domain/factory.ts`, the use cases in
`application/factories.ts`, the store in `adapters/persistence/factories.ts`
and the routes in `adapters/http/factories.ts`, all under `company/`.

- **Three tables**, each with its `workspace_id`: `factory` (`factory_id`,
  which the app gives it, `name`, `team_id`, `source`, `latest_version`),
  `factory_version` (`version`, `saved_by_person_id`, `saved_at`) and
  `factory_file` (`path`, `content`), a row per file of a version. A factory
  points at its team through both ids, so its team is always one of its own
  workspace, and a version points at its factory, and a file at its version,
  the same way.
- **The files** are a factory folder's, in the format `packages/factory-spec`
  defines: `factory.yml`, `automations/<name>.yaml`, `agents/<name>.md` and
  `skills/<name>/…`, each a path inside the folder and its text. A factory may
  also hold an agent team, in a layout of its own (`agents/<name>/agent.md`,
  `automations/<name>/automation.md`, `skills/<name>/…`; below, "Agent
  runs"). Runners and scorers have no format there yet, so the app takes
  none. A file under a later slice's folder (factory-spec's `LATER_FOLDERS`:
  `environments/`, `connections/`, `evals/`) is stored with factory-spec's
  notice that it has no effect yet, as the desktop's folder applies it; any
  other path is refused as the folder's reader refuses a stray. Files are
  text: a binary file in a skill cannot be saved yet.
- **A set is stored only if it keeps the schema** (`checkFactoryFiles`). The
  set is checked first: at most `FACTORY_FILES_MAX` files and
  `FACTORY_BYTES_MAX` bytes, each path inside the folder and given once, each
  file at most factory-spec's `MAX_FACTORY_TEXT_BYTES`, with no NUL (no
  Postgres text holds one) and no lone surrogate. Then factory-spec's
  `parseFactory` checks every file and the references across them; for a set
  that holds a team (`hasAgentTeam`), the files in the team's own trees
  (`agents/<name>/…`, `automations/<name>/…`) are left out of that parse, and
  `parseAgentTeam` adds its issues, each naming its file. Any issue refuses
  the whole set: 400 `invalid_files`, with every issue in factory-spec's shape
  (`file`, `line`, `message`…). Never write a second schema here.
  factory-spec's `storedFactoryFiles` sorts the files as the folder's reader
  would (the web app checks a set being edited with it too), into records
  built by `Object.fromEntries`, so a name such as `__proto__` is checked,
  never lost. A body over `SAVE_BODY_MAX` is 413 `too_large` before it is
  read.
- **Versions.** A factory is made blank: version 1, holding no files. Each
  save is the next version, never a change to one. A save names
  `baseVersion`, the version its files were edited from, and lands only while
  that is still the latest, by a compare-and-set on `latest_version` (409
  `version_moved`, with the latest, otherwise), so a save never undoes one it
  did not see. Every version stays readable (`GET
  /api/factories/{factoryId}/versions/{version}`), and `GET
  /api/factories/{factoryId}` answers the factory with its latest version's
  files.
- **Where the files come from** is `source`: `stored`, for now. A GitHub
  repository (9.4) is the second kind; saving a repo factory's files is to be
  refused then.
- **Who may do what** follows the team (decided 2026-11-21): a person sees the
  factories of the teams they see (`factoriesSeenBy`, on `teamsSeenBy` and
  `caller.role`), so owners and admins see every factory, and a member the
  factories of the teams they are in. Whoever sees a factory may save its
  files and rename it, and may make one for any team they see, or move one
  there (`judgeFactoryChange`; only who sees was decided). A factory the
  caller does not see is 404 `factory_not_found`, and a team they do not see
  404 `team_not_found`, so a member learns nothing of another team's.
- **Names** are checked as teams' are (`checkFactoryName`, 400
  `invalid_factory`) and are unique in the workspace whatever their case
  (`factory_name_unique`, on `lower(name)`; 409 `name_taken`).
- **The order of the checks**: what was sent (the name, or the files), then
  whether the caller sees the factory, then the team, then the base version,
  then what the store finds. What the caller sees is read just before the
  write.
- **Renaming and moving** is one route, `PATCH /api/factories/{factoryId}`,
  with a new `name`, a new `teamId`, or both. Both at once is one statement,
  made whole or not at all. Its versions, its latest version and when that
  was saved stay as they are. `source` is not changed there.
- **A team that owns a factory** is not deleted (409 `owns_factories`): the
  factory's foreign key to its team refuses it, and the team store answers
  `owns-factories`. The same key checks a move, and holds the team's row
  until the move is written, so a move and a delete of its team at once never
  leave a factory on no team: the move finds the team gone (404
  `team_not_found`), or the delete finds it owns the factory. Deleting a
  factory comes later.

## Runs

A workspace's runs are company content, beside its factories: what each
factory's runners ran, for the web's Runs pages (project "15 · Runs in
Consola"). The model is the orchestrator spec's (slice 6b, "A request is a
run"): a **request** is a run whose one step is its factory's orchestrator,
started by a person with text, and the automation runs it starts are its
**children**, each with a `parent` link set when it is made and never
changed; every other run is a top-level automation run. The rules are in
`domain/run.ts`, the use cases in `application/runs.ts`, the store in
`adapters/persistence/runs.ts` and the routes in `adapters/http/runs.ts`, all
under `company/`.

- **One table**, `run`, keyed by `workspace_id` and the runner's `run_id`. A
  run points at the version of its factory it ran (`run_factory_version_fk`),
  and a child at its request through the request's factory too
  (`run_parent_fk`, on `run_factory_run_unique`), so a child is always of
  its request's factory and whoever sees the child sees the request. The
  item, the steps and a request's facts are `jsonb`; a request's text, which
  only its page reads, is `request_text`. Times are `timestamptz(3)`, the
  runner's own, so a cursor holding one finds it again. Check constraints
  hold the domain's rules on the row as a backstop.
- **No route writes a run.** A runner records each through the store's
  `record` (`recordRun`), and the app stores it only once `checkRun` finds
  nothing wrong with it: a status, trigger or step it knows, `waitingOn`
  exactly while `waiting`, an automation exactly for an automation run and a
  request's facts exactly for a request, a parent only on an automation run
  (`manual`, started by no person), an item only at an https address, times
  it can store, and no NUL or lone surrogate anywhere (`jsonb` refuses
  `\u0000` too). A record older than the one held (`updated_at`) changes
  nothing (`stale`, a compare-and-set in the upsert), and a run's factory,
  kind and parent never change (`identity-changed`). Today the tests, the
  seed and the app's own agent runs call it (below, "Agent runs": the one run
  the app writes itself); the runner's connection (CON-94) will.
- **Title and phase are stored**, so the list searches, filters and counts
  by them. The title (`titleOf`) is a request's item's title, else its
  text's first line; an automation run's item's title, else its
  automation's name; one line of at most `TITLE_MAX` characters. The phase
  (`phaseOf`) groups the nine statuses into five (`PHASES`). A request rolls
  its children up (`requestPhase`): while its own phase is `active` and one
  of its runs needs someone, it needs someone too; an ended request keeps
  its phase. Recording a child holds its request's row (`for update`) and
  rolls it up again in the same transaction, so two of its runs recorded at
  once roll it up one after the other. A request's child counts and an
  automation run's progress are worked out on read (`childCountsOf`,
  `progressOf`).
- **Who sees a run** follows its factory (`factoriesSeenBy`, on
  `teamsSeenBy` and `caller.role`), by the factory's team now, read by a
  join, never stored on the run: owners and admins see every run, a member
  the runs of their teams' factories. A run the caller does not see is never
  listed, counted or offered as a facet, and its id is 404 `run_not_found`.
  The use case hands the store the factories the caller sees, narrowed by
  the query's `factoryId` and `teamId`, and the store reads no other.
- **The list** (`GET /api/runs`) holds top-level runs only, newest first
  (`created_at`, then `run_id`), a page at a time: `nextCursor` is
  base64url of the last run's `[createdAt, id]` (`encodeCursor`), and a
  cursor the app did not hand out is 400. `phase` and `trigger` may be
  given once or repeated (`several`, a `z.preprocess` to an array, since
  Hono reads a value given once as a string). `automation` keeps that
  automation's runs and the requests that started one; `q` matches the
  title or the automation's name in any case, its `%`, `_` and `\` matched
  as themselves. `counts` are under every filter but `phase`, `cursor` and
  `limit`; `facets` are what the caller sees, whatever the filters. A run's
  page (`GET /api/runs/{runId}`) adds its steps, a request's facts and text
  and its runs in the order it started them, and a run's request.
  `conversation` names the cloud session holding a request's conversation
  with its orchestrator (`conversation_session_id`, only on a request): an
  agent run's session (below, "Agent runs"), else null.
- **A step says what it was asked, did and produced**, as the desktop's
  trace does. What it did is what its runner records: the engine's
  `StepRun` fields (outputs, artifacts, turn, command, earlier attempts,
  reminded) and the end of what it printed (`output`: at most
  `OUTPUT_TAIL_MAX`, 16 KiB, of each of stdout and stderr, cut at whole lines
  by `tailOf`; `checkRun` refuses a longer one). What it was asked is not
  stored: `readRun` reads it from the factory version the run executed
  (`automationsOf`, then `stepDefinitionOf`), wherever the automation is
  written, so it is what that version said, never the latest. It is null for
  a request's orchestrator step, an automation the version does not define,
  and a step it does not. A step inside a loop has its own; a loop's block
  and a gate are null, since neither is an agent or a command step, the two a
  definition describes. A step stored before these fields existed reads as
  having none (`stepRecordOf`).
- **The file behind a run** (`source`, `sourceOf` in `domain/runSource.ts`)
  is read the same way: the file the automation is written in at the run's
  version, whole, with the automation's own lines (`automationLines`, from
  `@consola/factory-spec`: the whole file for `automations/<name>.yaml`, its
  entry for `factory.yml`), how it starts, its mode and what it applies to,
  and the factory's latest version beside it. Each step's definition carries
  its lines in that file (`range`). Null for a request, and when the version
  does not define the automation.
- **Approving a run** (`POST /api/runs/{runId}/approval`,
  `domain/runApproval.ts`) is the first route through which a person writes a
  row about a run. A run waiting for approval (`needs-approval`) says why
  (`approvalReason`: its automation asks every time, its version was not
  approved to run on its own, or its orchestrator's was not), what approving
  lets run (`willRun`: every command and agent step, those a loop repeats
  included; a gate runs nothing) and who may answer: anyone on its factory's
  owning team, literally the team's members whatever their workspace role
  (decided 2026-11-23), so an owner who sees every run answers only those of
  the teams they are in (`mayAnswer`). The checks run in the route's order:
  the body, the run seen (404 `run_not_found`, so a member of another team
  learns nothing), on the team (403 `not_allowed`), waiting (409
  `not_waiting`), the version answered being the run's (409
  `version_moved`), then the insert (409 `already_answered`: the first
  answer for a version stands). The answer is a row of `run_approval`, keyed
  by run and version, and the app **never changes the run** for it: the
  runner is the authority on a run, and acts on the answer once runners
  exist (epic 21, CON-94). A run shows its approval while it waits and once
  its version is answered.
- **The demo seed** (`pnpm --filter @consola/cloud-api db:seed`,
  `src/seed.ts`, then `seedEveryWorkspace`, which runs `seedDemoRuns` for
  each) writes demo runs for every workspace in `organization`, with its
  members, both read through the `MembershipReader` (`workspaceIds`,
  `memberIds`): a demo factory per team (`Demo · <team>`,
  each automation in a file of its own, saved as a new version whenever its
  files differ from `DEMO_FACTORY_FILES`), and runs in every status, a request
  with several runs, background runs and each member's own. Its steps print,
  exit, take turns, produce outputs and documents, retry and are refused a
  tool, as a runner's would. Ids are fixed (`demo-…`) and times counted back
  from now, so seeding again refreshes the same runs. It also installs the
  code review team (`seedCodeReviewTeam`, `application/seedTemplates.ts`): a
  factory `Code review team` on each workspace's first team whose latest
  files are exactly `CODE_REVIEW_TEAM_FILES`, made when missing and saved
  again only when they differ, after `checkFactoryFiles`, with a finished
  agent run of it (`seedDemoAgentRun`: a stopped session holding the
  orchestrator's report, and its run, once per workspace,
  `demo-agent-run-<workspace>`). It refuses any database but a PGlite folder
  (`seedRefusal`, in `config.ts`), and refuses while anything answers on the
  configuration's `PORT`, since PGlite takes one process per folder: stop the
  API first. It is never reachable over HTTP.

## Cloud sessions

A cloud session (`cloud_session`, `domain/cloudSession.ts`) is a sandbox a
workspace's runner runs for a person, or an agent run an automation started
(below, "Agent runs"). The app records it, checks that the connected runner
offers the repository and the harness, and hands the start or stop to the
runner through the `RunnerChannel` port.

- **Routes** (declared in `company/adapters/http/contract.ts`, registered by
  `cloudSessionRoutes` in `adapters/http/cloudSessions.ts`, behind
  `requireCaller`): `GET /api/cloud-sessions/options`
  (`getCloudSessionOptions`), `POST /api/cloud-sessions` (`postCloudSession`,
  201), `GET /api/cloud-sessions` (`listCloudSessions`, an array: the
  caller's own sessions, newest first; an agent run is a run, listed with
  the runs, below "Agent runs"),
  `GET /api/cloud-sessions/{sessionId}` (`getCloudSession`),
  `POST /api/cloud-sessions/{sessionId}/stop` (`postCloudSessionStop`, 202)
  and `POST /api/cloud-sessions/{sessionId}/pass` (`postCloudSessionPass`,
  below, "Passes"). They answer codes: `no_runner` (503),
  `repository_not_offered`, `harness_not_offered` and `invalid_request`
  (400), `not_found` (404), and a start's body not sent as JSON 415
  `unsupported_media_type`, as every route that takes JSON. The body is
  exactly `{ repository, harness }`: the contract's strict schema checks its
  shape, and `readStartRequest` the repository's form. The options are
  registered before the session by id, so `options` is never read as an id.
- **Whose.** A person's session is visible only to the person who started
  it, in the workspace of their session; an agent run, to every member of its
  workspace, by its id (`isSeenBy`, the store's `findSeen`), though the list
  holds a person's own alone (`listOwn`). Another person's session, or
  another workspace's, is `not_found`, never 403.
- **No runner, nothing recorded.** A person's start is checked against the
  runner's offer before any row is written, and before anything is sent. With
  no runner configured, or none connected, every start is 503. An agent run is
  recorded either way, ended `failed` with the reason's code.
- **Statuses** (`nextStatus`): `starting` goes to `running` or `failed`, and
  `running` to `stopped` or `failed`. An ended session never moves again, and
  an ended row ignores every update. A person's stop is the one other way to
  end: it takes a `starting` or `running` row to `stopped`. So does an end a
  runner's `hello` reports for a session that ended while its socket was down
  (`endReported`), `starting` included, since the `running` before it may have
  been lost with the socket.
- **A failure's two sources, kept apart.** `error` is the message a runner
  reported (the provider's or the start script's), shown as it came.
  `errorCode` is a code the app decided itself (`CELL_FAILURE_CODES`:
  `runner_restarted`, `runner_unreachable`, `runner_failed` for a failure a
  runner reported without a message, `runnerFailure`, and an agent run's
  four, below), which `cloud-web` words. A failed row has exactly one of them,
  so a runner can never forge a code by naming one in its message, and the web
  never shows a code as text.
- **Stop never waits for the runner.** A person can always end a session
  they see: the row becomes `stopped` at once, and the runner is told only
  when it is the session's own runner and connected. A runner that is away or
  cannot be told still holds the sandbox, but the row is ended, so its
  `hello` finds the session ended and gets a `session.stop` for it. The
  runner therefore never keeps a sandbox for a session the app considers
  ended.
- **Updates from a runner** (`applyRunnerUpdate`) count only from the runner
  the row names, in the workspace that runner serves (`belongsToRunner`:
  runners name themselves, so an id alone could be another workspace's
  runner's), and are compare-and-set on the row's status, so a late update
  never overwrites an end. One that loses to another change reads the row
  again, up to three looks (a status moves at most twice), so a title or a
  host address is never lost to a status that moved meanwhile, and is dropped
  only once the row has ended.
- **Passes** (`POST /api/cloud-sessions/{sessionId}/pass`, `issuePass`)
  answer `{ pass, hostUrl, expiresAt }` for a `running` session the caller
  sees (their own, or an agent run) whose host has reported its address;
  anything else is 404 `not_found`, and an app with no pass key is 503
  `no_runner`. Every answer the route gives is `Cache-Control: no-store` (the
  contract declares the header); the caller check's answers come before it.
  The pass is a compact JWS, EdDSA, `typ` `PASS_TYPE`, over the protocol's
  `passClaims` (`aud` `PASS_AUDIENCE`, `sub` the person, `ws`, `sid`, `iat`,
  `exp`), for `PASS_LIFETIME_SECONDS` (the protocol's cap, 300 s);
  `expiresAt` is its `exp`, in whole seconds. It is signed with
  `PASS_PRIVATE_KEY`, the app's own Ed25519 key, and each session's host is
  handed the public half, as an SPKI PEM derived from it
  (`company/adapters/token/passSigner.ts`), in `session.start`.

## Agent runs

An experiment beside the steps design, which it leaves untouched: a software
factory led by one agent. A factory may hold an agent team
(`agents/<name>/agent.md`, `automations/<name>/automation.md`,
`skills/<name>/…`), which factory-spec reads (`parseAgentTeam`). The rules are
in `company/domain/agentRun.ts`, the use cases in
`company/application/agentRuns.ts`.

- **What starts one.** A GitHub event the app records for the first time, and
  only then (the webhook's use case calls `startAgentRunsFor`, above,
  "Webhooks"). For a `pull_request` event (`pullRequestEventOf`), each of the
  workspace's factories whose latest files hold a team with no issues starts
  one run per automation `matchPullRequestAutomations` finds. A team with
  issues starts nothing; any other event starts nothing. Whatever fails there
  is logged, ids and names only, never the payload, and the event's answer
  stays.
- **The row** is a `cloud_session` with no `person_id`, its `origin`
  (`{ kind: 'automation', factoryId, factoryName, automation, agent, item:
  { kind: 'pull_request', repository, number, url, title, headSha } }`) and
  `agent_run`, the runner's last `AgentRunReport` (null until one), both JSON
  as text. Every member of the workspace reads, gets a pass for and stops
  it by its id; a person's own sessions stay theirs, and the Sessions list
  holds those alone.
- **It is a run.** Each agent run is a **request** of the Runs pages
  (`agentRunRecord`, "Runs" above), since its automation hands its event to
  an agent instead of running steps: its one step is that agent
  (`orchestrator`, the agent's name on it), its trigger `event`
  (`pull_request`), its item the pull request, its text what the agent was
  sent, its conversation the session, and its id the session's. Where it
  stands follows the session and the runner's last report: `starting` is
  `queued`; running, the report's `working`, `waiting` (on a person, so
  `needs-you`), `done` (`completed`, its summary the orchestrator's first line)
  or `failed`; stopped, `completed` or `failed` by the report, else
  `cancelled`; failed, `failed`, with the runner's message or the app's
  sentence for its own code. The app writes this run itself, the one run no
  runner records, since here the app decides that a run starts:
  `startAgentRun` records it with the session, and `keepingRunsInStep`, the
  session store every writer of a session gets (`compose.ts`), records it
  again after every change to the session that lands, from what the run
  holds (its version, its text, when it was made). A run that cannot be
  recorded is logged and never stops the session.
- **The title** is the app's, `<automation> · <owner/name>#<number> <title>`
  on one line, at most `AGENT_RUN_TITLE_MAX` (200) characters
  (`agentRunTitle`); a runner's `title` never replaces it. A report is kept
  whole under the same compare-and-set as every update (`applyRunnerUpdate`).
- **The start** is factory-spec's `planAgentRun` with `AGENT_RUN_FACTORY_DIR`,
  `SESSION_REPOSITORY_DIR` and the row's id, plus `checkout`
  (`refs/pull/<n>/head` at the event's head), read back with `readAgentRun`
  (`agentRunStart`), and sent as `session.start`'s `agentRun`. The harness is
  the first agent's, or `claude`.
- **Failure codes.** The row is recorded `failed`, with no runner and nothing
  sent, when no runner is connected (`runner_unavailable`), it does not offer
  the repository (`repository_not_offered`, compared in any case) or the
  harness (`harness_not_offered`), or the plan throws or the reader refuses it
  (`agent_run_invalid`, the reason logged). A start the socket cannot send is
  `runner_unreachable`, as a person's is.
- **Follow-ups** (`sendFollowUp(ports, { workspaceId, sessionId }, { key,
  text, author: { personId, label } })`, `application/followUps.ts`). The app
  hands a running agent run's orchestrator a person's message, such as a reply
  in the Slack thread it answers in (CON-144's E2 calls it; no route does).
  `followUpBody` checks it with the protocol's `readFollowUp` first (`invalid`,
  naming the field), and `followUpReach` the session: an agent run of that
  workspace, `running`, with a host address. A row still `starting`, or
  running with no address yet, is `starting`; an ended row, a person's
  session, another workspace's or none is `not_running`, and nothing is sent.
  Whether the author may talk to the run is the caller's to decide first. Then
  the app signs a pass for the author (`sub`) in the session's workspace for
  `FOLLOW_UP_PASS_SECONDS` (60) and sends it with the follow-up straight to the
  session's host (`HostChannel`, `adapters/host/hostChannel.ts`): `POST
  <hostUrl>/agent-run/follow-ups`, the pass as bearer, the label as
  `authorLabel` (a label such as `a teammate in Slack`, never a name). No
  runner relays it: the app calls the address the runner reported, which the
  protocol checked only as an origin, so before anything is sent the adapter
  asks `hostAddressAllowed` (`domain/hostAddress.ts`) whether the deployment
  calls it: `https:` under one of `SANDBOX_HOST_SUFFIXES` (`e2b.app`, E2B's
  exposed ports, when unset) on the default port, never an IP address; or
  `http:` on `127.0.0.1`, `localhost` or `[::1]` only with
  `LOCAL_SANDBOXES=true` (sandboxes on this machine). Another address is
  `host_not_allowed`, logged with the session's id alone. The name is not
  resolved again, so one under an allowed suffix that points at a private
  address is not caught: a known limit of the POC. The host fences the text, says who
  wrote it, and queues it after the orchestrator's turn once, keyed by `key`
  and the message it becomes (`packages/host/AGENTS.md`, "Agent runs"), so
  other words or another author under a used key are a follow-up of their own.
  Answers: `delivered`; `already_delivered` (the same follow-up, its key,
  author and text, reached it before, and this changed nothing);
  `starting` (the host has not sent the run's first message yet, `503`);
  `not_running` (the host there refused the pass or runs no agent run, `401`
  or `404`); and `host_unreachable` (no answer within `HOST_CALL_TIMEOUT_MS`,
  15 s, a redirect, which is never followed, any other status or receipt, or
  no pass key); and `host_not_allowed` (above: nothing was sent). Sending the same follow-up again after `starting` or
  `host_unreachable` is safe: its key and content keep it once. A run whose sandbox stopped is `not_running`; what
  picks it up again is CON-39's and 41.8's. The adapter logs nothing, neither
  the pass nor the text.
- **Templates.** `GET /api/factory-templates` (`listFactoryTemplates`)
  answers `FACTORY_TEMPLATES` (`domain/factoryTemplates.ts`): today one,
  `code-review-team`, factory-spec's `CODE_REVIEW_TEAM_FILES`. The web app
  merges its files into a factory through the ordinary save; the demo seed
  installs it too (above, "Runs").
- **Firing a real pull request locally.**
  `scripts/deliver-pull-request-event.mjs` sends the API the delivery GitHub
  would, with no GitHub and no tunnel. It reads the pull request with your
  `gh`, builds GitHub's `pull_request` body, signs it with
  `GITHUB_WEBHOOK_SECRET` as GitHub does (`X-Hub-Signature-256:
  sha256=<hmac>` over the body's bytes), POSTs it to `/api/github/webhooks`
  with `X-GitHub-Event: pull_request` and a fresh `X-GitHub-Delivery`, and
  prints the status and the answer, never the secret. It reads this app's
  `.env` as the API does, a variable the shell sets winning. Its flags:
  - `--repository <owner/name>` and `--number <n>`: the pull request `gh`
    reads (`gh api repos/<owner/name>/pulls/<n>`);
  - `--pull-request-json <file>`: read it from a file instead, either what
    that command prints or a whole `pull_request` payload as GitHub sent it
    (the App's Advanced page shows each delivery's), whose `installation.id`
    and `action` stand unless a flag names others;
  - `--installation <id>`: the installation the event comes through, by its
    id on GitHub, which a workspace must hold (else 422
    `unknown_installation`); required unless the payload names one;
  - `--action <action>`: the event's action, `opened` by default;
  - `--api-url <url>`: where the API is, `http://127.0.0.1:<PORT>` by
    default (3100);
  - `--env <file>`: the env file to read, `apps/cloud-api/.env` by default.

## The runner's socket

A workspace's runner (`consola-host runner`) connects out to the app, so the
app never has to reach it (`company/adapters/runner/runnerSocket.ts`). Read
`packages/runner-protocol/AGENTS.md` first: the messages are its, and it
calls this side of the socket the cell.

- **Configuration.** `RUNNER_SECRET`, `RUNNER_WORKSPACE_ID` and
  `PASS_PRIVATE_KEY` go together: all three, or none, or the app refuses to
  start, naming each one missing. With none, every runner is refused and the
  session routes answer 503 `no_runner`. `config.ts` checks that the secret is
  at least 32 printable characters with no space, and that the key is a JSON
  object; `createPassSigner` refuses one that is not an Ed25519 private key,
  as a `ConfigError`, when `composeApi` imports it. No problem quotes either
  value, and `describeStartupFailure` hides both.
- **The secret.** `GET /api/runner` with `Authorization: Bearer
  <RUNNER_SECRET>`. It is compared as SHA-256 hashes with `timingSafeEqual`,
  so neither its contents nor its length shows in how long a refusal takes.
  Anything else (no header, another scheme, a wrong secret, or none
  configured) is 401 `{"error":"runner_refused"}` before the upgrade, and a
  request with the secret that is no upgrade is 426. The secret is never
  logged, nor what a refused request presented. It admits a runner, never a
  person.
- **The upgrade.** `@hono/node-ws`'s `createNodeWebSocket` is built on the
  socket's own routes, so every upgrade the server sees goes to them and
  only them; `main.ts` calls `injectWebSocket(server)`, and closes every
  runner's socket (`closeRunnerSockets`, 1001) before the server, which
  would otherwise wait on them.
- **Frames.** A runner's frame may be at most `RUNNER_FRAME_LIMIT_BYTES`
  (the protocol's `RUNNER_SOCKET_FRAME_LIMIT_BYTES`, 4 MiB, ws's
  `maxPayload`); a larger one closes the socket with 1009 before it is read. A
  frame that is not text, not JSON or not a message `readRunnerMessage` reads
  is logged with the reader's reason alone, never the frame, and dropped, and
  the socket stays open.
- **One runner per workspace.** The runner serves `RUNNER_WORKSPACE_ID`,
  whatever its `hello` calls it. Every socket's messages are handled one at a
  time, in one queue, in the order the app read them, whichever socket they
  came on, so a later socket's `hello` is judged only once all an earlier
  socket sent is applied or dropped. A second socket's `hello` replaces the
  first, which is closed with `RUNNER_SOCKET_CLOSE.replaced` (4000). An update
  the replaced socket sent after that `hello`, an update on a socket whose own
  `hello` was never said or never judged, and a second `hello` on one socket,
  are logged and dropped. An update a socket sent before it closed applies,
  even after the close: the runner says each session's end as it stops, then
  closes, and counts an end heard once the app has read it (a ping's pong),
  not once it is applied, so that end has to stand before the runner's next
  `hello` is judged, which would otherwise take the session, no longer listed,
  for one lost in a restart. `connected` names a socket's offer only once its
  `hello` is judged, so no person's start lands among the sessions it judges,
  and `null` again once it closes. A `hello` that cannot be judged (the
  database down) closes the socket with 1011, and the runner's next `hello` is
  judged instead.
- **`hello`** (`runnerConnected`, `application/runners.ts`), in this order
  (ended wins, then restarted, then stops): each `endedSessions` entry keeps
  its real end; every other `starting` or `running` row of that runner, in its
  workspace, that `runningSessionIds` does not list becomes `failed` with
  `runner_restarted`; and every listed id the app holds as ended, does not
  know, or holds as another runner's, gets a `session.stop`. An id in both
  lists is ended, and so is stopped (ended wins); an id listed twice counts
  once. Rows of another runner or workspace are never changed.
- **The channel.** `startSession` sends `session.start` with the pass key's
  public half, and `stopSession` a `session.stop`, only on the open socket of
  the runner named, for its workspace; otherwise each rejects, and the use
  cases already answer that.

## Adding a feature

1. Pick the part. What a workspace holds is `company`; people, sign-in,
   sessions, workspaces and who is in them are `accounts`. A company feature
   that needs to know who is in a workspace asks the `MembershipReader`; one
   that needs a person's name leaves it to the page, which asks
   `GET /api/me/workspace/members`.
2. A rule or a type goes in that part's `domain`.
3. A use case goes in its `application`, with any port it needs in `ports.ts`
   (GitHub's in `company/application/gitHubPorts.ts`).
4. An adapter implements the port. For the database, that is a table in the
   part's `adapters/persistence` (a company table with its `workspace_id`) and
   a store, added to that part's stores. `src/rules.test.ts` checks the table
   against the two rules.
5. A route is declared in the part's contract first, with every answer it
   gives, and added to its routes list; its `register…Routes` registers it
   with `app.openapi`. A company route takes `requireCaller` as its route
   `middleware`, spreads `callerFailures` into its answers, and hands the use
   case `c.var.caller`, never a workspace id from the request. Then
   `openapi:generate` rewrites `openapi.json`, and `cloud-web`'s
   `api:generate` its types, in the same change ("The contract").
6. `compose.ts` builds the adapter and hands it its ports, and nothing else
   does. A startup step, if one is ever needed, goes there too.

## Tests

A test sits beside its module and is named after it (`healthProbe.ts`,
`healthProbe.test.ts`), and so do its helpers, if several tests share them
(`database.test-helpers.ts`), which the build leaves out of `dist` ("The
dependency rule"). Rules in `domain` are tested alone. Stores and use
cases are tested through the real Drizzle stores on a fresh in-memory PGlite
database: the database is never mocked. Its tables are made straight from
the part's own tables, by drizzle-kit's migration from nothing to them
(`generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))`,
in each part's `database.test-helpers.ts`, and for GitHub's tables in their
tests), not by the chain, so a part's tests stand on its tables alone. The
service migrates the chain instead, so `src/persistence/database.test.ts`
keeps the two the same: the latest snapshot in `drizzle/meta` against the
one schema leaves `db:generate` nothing to write, and a fresh database
migrated by the chain holds exactly the columns, constraints, indexes and
enums of one made from the schema, as Postgres's catalog describes them. A
schema change without `db:generate`, or a migration edited into another
shape, fails there and nowhere else. Company's tests make each
`Caller` with `admitCaller` and use a fake `MembershipReader`
(`company/application/membership.test-helpers.ts`: `fakeMembership`,
`callerAs`); they never import an accounts file.

The ring's tests check the whole app: `src/rules.test.ts` (the two rules),
`src/boundary.test.ts` (the parts and the layers) and `src/openapi.test.ts`
(the contract). The HTTP suites build the app through `composeApi`, as
`main.ts` does, so they test the wiring that runs, and check every answer
against the contract:

- `src/accountsApp.test.ts`: accounts' routes and the front door;
- `src/gitHubApp.test.ts`: Connections, the callback, webhooks, and tokens
  through the use case;
- `src/companyApp.test.ts`: teams, factories, runs, approvals and cloud
  sessions. Its "every route" test asks every route the app has without a
  session and expects 401 from all but the ones that need none
  (`OPEN_ROUTES`), so a new route is covered without being named.

They share `src/testing/harness.ts`, which signs people in without Google,
through Better Auth's `testUtils`: `startApi()` builds the app; `signIn(email,
name)` makes a person with a verified email, signs them in and returns
`{ personId, cookie }`; `member(role, { workspace? })` makes a
person and a workspace through `POST /api/workspaces` (or a membership in
another person's workspace), sets it active, and returns
`{ personId, workspaceId, headers }`, where `headers` holds the cookie, the
web app's origin, JSON and `x-consola-workspace`; `removeMember` and
`setRole` write `member` directly, so a suite can show a change counting on
the very next request.

The runner's socket is tested on a real server on port 0 (`@hono/node-server`
and `injectWebSocket`), with `ws` as the runner (a dev dependency: Node's own
`WebSocket` sends no `Authorization`), and the company suite connects one the
way `main.ts` wires it. Every one of those tests checks that nothing logged
holds the runner's secret or the pass key.

PGlite runs one transaction at a time, so a test of what concurrent
transactions do proves something only on a real Postgres. A compare-and-set
is therefore also tested directly, on the store.

## Generated files

- `openapi.json` is the contract (above), written by
  `pnpm --filter @consola/cloud-api openapi:generate`. Never edit it by hand;
  Biome leaves it alone, since it is compared byte for byte.
- `src/accounts/adapters/persistence/auth-schema.ts` holds Better Auth's
  tables, written by `pnpm --filter @consola/cloud-api auth:generate` from
  `src/accounts/adapters/auth/cli-config.ts`. Never edit it by hand. The CLI
  drops the header comment and writes double quotes, so after it, restore the
  header, run Biome, and check that `git diff` shows only the change you
  meant.
- `drizzle/` holds the one migration chain, for both parts, written by
  `pnpm --filter @consola/cloud-api db:generate --name <what>` after a schema
  changes. `drizzle.config.ts` reads accounts' `auth-schema.ts` and company's
  `tables.ts` and `gitHubTables.ts`. The migrations apply when the API starts,
  and `db:generate` should then report no schema changes, which
  `src/persistence/database.test.ts` checks (above, "Tests"). The chain started
  again at `0000_init` when the apps merged, so a database from before it is
  not migrated: delete `.data` and start fresh (`README.md`).
- For a required column on a table that has rows, drizzle-kit writes
  `ADD COLUMN … NOT NULL`, which fails on those rows: edit the generated SQL to
  add the column, fill it and then require it, and test it from a database
  migrated only as far as the one before. A backfill goes in the same
  migration, after the SQL drizzle-kit wrote.
- Postgres cuts a name at 63 characters, and drizzle's names for a composite
  foreign key run past that, so such a key is named in `tables.ts`.
