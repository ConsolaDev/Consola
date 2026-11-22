# Consola Cloud cell

The control plane's regional part. Each region runs a copy of its own (`eu`,
`us`), with a database of its own, holding what a workspace in that region has
that is not global: its content, such as factory files and runs, and what the
cloud sessions need. Accounts are not here: they are global, in
`apps/cloud-global`, and the cell refers to a person by their global id.

Today the cell is a scaffold: a health route on an empty database. Nothing
calls it yet, and it answers anyone who reaches it on `127.0.0.1`. The check of
`cloud-global`'s token comes with issue 5.4, before the cell serves anything a
workspace owns.

## Run

```bash
cp apps/cloud-region/.env.example apps/cloud-region/.env   # then check the values
pnpm dev:cloud-region
```

The cell listens on `127.0.0.1:3101` and answers
`GET /api/health` with `{"ok":true,"region":"eu"}`, or 503 with `"ok":false`
when its database does not answer. `.env.example` documents every variable.
The cell refuses to start, naming each bad variable, if one is missing or
wrong.

By default the data is PGlite (Postgres in-process) in
`apps/cloud-region/.data/cell-eu-db`. Deleting that folder resets it.

## The shared contract

The cell imports `@consola/cloud-contract` (`packages/cloud-contract`), what
`cloud-global` and the cells agree on, from its build. `pnpm dev:cloud-region`
and `pnpm test` build it first. A `pnpm --filter @consola/cloud-region …`
command does not, so build it before the first such command, and again after
changing it:

```bash
pnpm --filter @consola/cloud-contract build
```

## Two cells on one machine

Each copy needs its own region, port and database. With the variables set in
the shell instead of `.env` (a variable already set wins over the file):

```bash
REGION=eu PORT=3101 DATABASE_URL=pglite:./.data/cell-eu-db pnpm --filter @consola/cloud-region dev
REGION=us PORT=3102 DATABASE_URL=pglite:./.data/cell-us-db pnpm --filter @consola/cloud-region dev
```

## A real Postgres

A cell never shares a database with `cloud-global`, so that the global side
cannot read regional data. With the repository's `compose.yaml` running
(`docker compose up -d`), create one per cell:

```bash
docker compose exec postgres createdb -U consola consola_cell_eu
```

Then set
`DATABASE_URL=postgres://consola:consola@localhost:5432/consola_cell_eu`.

## The schema

The tables are in `src/adapters/persistence/tables.ts`. After changing them,
write the migration:

```bash
pnpm --filter @consola/cloud-region db:generate
```

Migrations apply when the cell starts.

## Tests and types

```bash
pnpm --filter @consola/cloud-region test
pnpm --filter @consola/cloud-region typecheck
```
