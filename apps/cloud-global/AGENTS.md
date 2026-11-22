# AGENTS.md

This file guides coding agents working in `apps/cloud-global`, the global part
of Consola Cloud's control plane: the API every region shares. `CLAUDE.md`
imports it with `@AGENTS.md`, so Claude Code reads it too. The repository's
guide is the root `AGENTS.md`, and setup is in `README.md`. Paths below are
relative to `apps/cloud-global`.

## The layers

The service is built in rings, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of: who may join
  (`mayJoin`), which role a new member gets (`roleForNewMember`), the regions a
  workspace can be in (`REGIONS`, `isRegion`, `DEPLOYMENT_REGION`), and
  `Organization`, `Membership` and `Person`. It is plain TypeScript, with no
  package, no `node:` builtin and no I/O.
- `src/application/` holds the use cases (`ensureOrganization`,
  `joinOrganization`, `mayCreateAccount`, `mayStartSession`, `describeMe`,
  `checkHealth`) and, in `ports.ts`, the stores and probes they need. A use
  case is a plain function that takes its ports first.
- `src/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle on PGlite or Postgres: the database, the schema,
    and one store per port, which `stores.ts` builds together;
  - `auth/` is Better Auth (`betterAuth.ts`). Its hooks call use cases and run
    no query of their own;
  - `http/` is the Hono routes (`app.ts`). Each route asks a use case and maps
    its answer to a status and a body.
- The composition ring wires them together. `src/compose.ts` is the one place
  adapters are built and handed the ports they need (`composeApi`), and the one
  place startup steps live, such as preparing the organisation
  (`prepareOrganization`). Adapters call use cases themselves; what they never
  do is build another adapter. The one exception is
  `src/adapters/auth/cli-config.ts`, which builds the stores and `createAuth`
  for the schema CLI: it is tooling, and never runs in the service.
  `src/main.ts` loads the environment, opens and migrates the database, calls
  `compose.ts` and serves, and `src/startupError.ts` words a failure to start.
  `src/config.ts` parses the environment. It is shared configuration that any
  adapter may read, so it stays a pure parser that imports no other file and no
  I/O.

## The dependency rule

- `domain` imports only `domain`. `application` imports only `domain` and
  `application`. Neither imports a package or a `node:` builtin, and neither
  refers to a global that reaches the machine: `process`, `fetch`, `require`,
  `XMLHttpRequest`, `WebSocket`, the timers (`setTimeout`, `setInterval`,
  `setImmediate`), `globalThis` or `global`.
- An adapter imports `domain`, `application`, its own folder and
  `src/config.ts`, and never the composition ring. Beyond that:
  - `adapters/http` never imports `better-auth`, `drizzle-orm`,
    `@electric-sql/pglite`, `pg`, `adapters/persistence` or `adapters/auth`.
    Sign-in reaches it as `handleAuth` and `currentPerson`, which
    `compose.ts` passes in;
  - `adapters/persistence` never imports `hono`, `better-auth` or another
    adapter;
  - `adapters/auth` never imports `hono`, `adapters/http` or a database
    library (`drizzle-orm`, `pg`, `@electric-sql/pglite`): its hooks call use
    cases, and the stores run the queries. It may import
    `adapters/persistence`, because Better Auth's Drizzle adapter needs the
    database and its schema.
- No file imports another app or a workspace package (`@consola/*`).
- Test files (`*.test.ts`) are exempt from the layer rules, because they wire
  real pieces together the way `compose.ts` does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the globals `domain` and `application` refer to. Only a
reference counts, directly or through `globalThis`, never a property or a
member that shares the name (`request.process`, `{ fetch: 1 }`). A file that
sits in no layer fails it too. The rules are data at its top (`LAYERS`), so a
new layer or folder is added there first.

## Adding a feature

1. A rule or a type goes in `domain`.
2. A use case goes in `application`, with any port it needs in `ports.ts`.
3. An adapter implements the port. For the database, that is a store in
   `adapters/persistence`, added to `createDrizzleStores`.
4. A route in `adapters/http`, or a hook in `adapters/auth`, calls the use
   case.
5. `compose.ts` builds the adapter and hands it its ports, and nothing else
   does. A new startup step goes there too, beside `prepareOrganization`.

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
  - app installs: which installation belongs to which workspace, the GitHub
    App's key and the tokens minted from it (no table yet);
  - webhook intake, with the bodies dropped (no table yet).
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

- `OrganizationStore.ensure` writes it only when it makes the row, and reads
  back only a listed region;
- Better Auth's organisation plugin declares it with `input: false`, so none of
  the plugin's own routes (`organization/update` among them) accepts it;
- a new route or hook that writes `organization` must leave `region` alone, and
  `src/app.test.ts` checks that the owner cannot move it.

The deployment's one organisation is in `DEPLOYMENT_REGION` (`eu`), as is every
organisation made before regions existed: migration `0001` fills them.

## Tests

A test sits beside its module and is named after it (`membershipStore.ts`,
`membershipStore.test.ts`). Rules in `domain` are tested alone. Stores and use
cases are tested on a migrated `pglite:memory` database through the real
Drizzle stores: the database is never mocked. `src/app.test.ts` is the HTTP
suite, end to end. It builds the service through `compose.ts`
(`prepareOrganization`, then `composeApi`), as `main.ts` does, so it tests the
wiring that runs.

## Generated files

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
  only that far (`database.test.ts`, `migrateUpTo`). `db:generate` should then
  report no schema changes.
