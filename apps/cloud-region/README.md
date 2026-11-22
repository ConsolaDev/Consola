# Consola Cloud cell

The control plane's regional part. Each region runs a copy of its own (`eu`,
`us`), with a database of its own, holding what a workspace in that region has
that is not global: its content, such as factory files and runs, and what the
cloud sessions need. Accounts are not here: they are global, in
`apps/cloud-global`, and the cell refers to a person by their global id.

Today the cell holds no tables yet. It answers a health route to anyone, and
everything else only with a cell token `cloud-global` minted.

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

## The cell token

Every other request carries `Authorization: Bearer <token>`, a cell token
`cloud-global` minted (`packages/cloud-contract`, "The cell token"). The cell
checks it with `cloud-global`'s public keys, which it fetches from
`CLOUD_GLOBAL_URL` (by default `http://127.0.0.1:3100`, `cloud-global`'s dev
address) at `/api/cell-token/keys`, and reads the person, the workspace, the
role and the region from it. `GET /api/me` answers what it read:

```json
{ "personId": "…", "workspaceId": "…", "role": "member", "region": "eu" }
```

| Answer | When |
| --- | --- |
| 401, `WWW-Authenticate: Bearer` | no token |
| 401, `WWW-Authenticate: Bearer error="invalid_token"` | a token the cell does not accept: malformed, forged, another key's, expired |
| 421 | a good token for a workspace in another region |
| 503 | `cloud-global`'s keys cannot be fetched, so no token can be checked |

`CLOUD_GLOBAL_URL` must be an origin (no path), and https unless it is on this
machine: whoever answers that address can mint any token the cell takes.

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
