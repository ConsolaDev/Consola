# Consola Cloud cell

The control plane's regional part. Each region runs a copy of its own (`eu`,
`us`), with a database of its own, holding what a workspace in that region has
that is not global: its content, such as factory files and runs, and what the
cloud sessions need. Accounts are not here: they are global, in
`apps/cloud-global`, and the cell refers to a person by their global id.

Today the cell keeps a copy of each workspace in its region and its members
(ids and roles only), from `cloud-global`'s outbox, the workspace's teams, its
factories with their files, versioned, the GitHub events `cloud-global` passes
on for it, and a person's cloud sessions, which a workspace's runner runs in
sandboxes. It answers a health route to anyone, takes the outbox's and the
GitHub events' signed deliveries and the runner's socket (behind the runner's
secret), and answers everything else only with a cell token `cloud-global`
minted. Every route is in `openapi.json`, generated from the routes
themselves.

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

## The outbox

`cloud-global` delivers its outbox messages (a workspace was created, a member
was added, changed role or was removed) to `POST /api/outbox`, one a request,
with no cell token: the body is the message signed with the cell token's key,
a compact JWS sent as `application/jose` (`packages/cloud-contract`,
"Delivering a message"). The cell checks it with the same keys it checks
tokens with, so it needs nothing more set up. It applies each workspace's
messages once, in order:

| Answer | When |
| --- | --- |
| 200 | applied now, or applied before (then nothing changes) |
| 400 | not `application/jose`, over 16 KiB, or no message the contract reads |
| 401 | not signed by `cloud-global` |
| 409, `{"nextSequence": n}` | an earlier message of the workspace is missing |
| 421 | a workspace in another region |
| 503 | the keys or the database cannot be had |

What the cell keeps is in the `workspace` and `workspace_member` tables.

## GitHub's events

`cloud-global` receives the GitHub App's webhooks, checks GitHub's signature,
finds the workspace that holds the event's installation and passes the event
on to that workspace's cell at `POST /api/github/events`, one a request, with
no cell token: like an outbox delivery, the body is the event signed with the
cell token's key (`packages/cloud-contract`, "Passing on a GitHub event"). The
cell records each delivery once, by GitHub's id of it, in the `github_event`
table, the payload as GitHub sent it, for the workspace's runners and triggers
to read later:

| Answer | When |
| --- | --- |
| 201 | recorded now |
| 200 | recorded before: a delivery sent again changes nothing |
| 400 | not `application/jose`, over 36 MiB, or no event the contract reads |
| 401 | not signed by `cloud-global` as an event |
| 409 | the outbox has not delivered the workspace's creation yet |
| 421 | a workspace in another region |
| 503 | the keys or the database cannot be had |

## Teams

Every workspace starts with one team, **General**, made as the cell applies
the workspace's creation; everyone who joins the workspace joins it, and
someone who leaves the workspace leaves every team. Owners and admins manage
teams; a member sees the teams they are in. All of these take a cell token for
the workspace, and act on that workspace alone:

| Route | Does |
| --- | --- |
| `GET /api/teams` | the teams the caller sees, and whether they may manage them (`canManage`) |
| `POST /api/teams` `{"name"}` | make a team, with nobody in it |
| `PATCH /api/teams/{teamId}` `{"name"}` | rename one, General included |
| `DELETE /api/teams/{teamId}` | delete one; General, and a team that owns a factory, are never deleted (409) |
| `PUT /api/teams/{teamId}/members/{personId}` | add a member of the workspace, by global id |
| `DELETE /api/teams/{teamId}/members/{personId}` | take a person out |

Names are unique in a workspace whatever their case. Until `cloud-global`'s
outbox has delivered the workspace's creation, every one of them is 409
`workspace_pending`. The tables are `team` and `team_member`.

## Factories

A factory belongs to a team, and holds the files of a factory folder in the
format `packages/factory-spec` defines (`factory.yml`, `automations/`,
`agents/`, `skills/`). Each save is a new version, and every earlier version
stays readable. Owners and admins see every factory; a member sees the
factories of the teams they are in, and a factory they do not see is 404.
Whoever sees a factory may save it and rename it, and may make one for a team
they see or move one there.

| Route | Does |
| --- | --- |
| `GET /api/factories` | the factories the caller sees |
| `POST /api/factories` `{"name","teamId"}` | make a blank factory, owned by the team: its first version holds no files |
| `GET /api/factories/{factoryId}` | the factory, and its latest version with its files |
| `PATCH /api/factories/{factoryId}` `{"name"?,"teamId"?}` | rename it, move it to another team, or both at once |
| `GET /api/factories/{factoryId}/versions/{version}` | one version, an earlier one or the latest |
| `POST /api/factories/{factoryId}/versions` `{"baseVersion","files"}` | save the files as the next version |

A save is refused with every problem the factory schema finds, each naming its
file (400 `invalid_files`), and when `baseVersion` is no longer the latest
(409 `version_moved`, with the latest). The tables are `factory`,
`factory_version` and `factory_file`.

By default the data is PGlite (Postgres in-process) in
`apps/cloud-region/.data/cell-eu-db`. Deleting that folder resets it.

## The runner and session passes

A workspace's runner (`consola-host runner`) connects out to the cell, and the
cell hands it the cloud sessions people start. For the proof of concept one
runner serves one workspace, admitted by a shared secret; enrolling runners
comes later. Three variables in `.env`, all three or none:

| Variable | What it is |
| --- | --- |
| `RUNNER_SECRET` | What the runner presents, at least 32 printable characters with no spaces: `openssl rand -base64 32`. The runner's `CONSOLA_RUNNER_SECRET` holds the same value. |
| `RUNNER_WORKSPACE_ID` | The one workspace the runner serves, by its id in `cloud-global`. |
| `PASS_PRIVATE_KEY` | The cell's own Ed25519 private key, as a JSON Web Key on one line, which signs session passes: `pnpm --filter @consola/cloud-region pass-key:generate`. Never `cloud-global`'s key. |

With none set, the cell starts as before: no runner can connect, and starting
a session answers 503 `no_runner`. With some but not all, or a key that is no
Ed25519 private key, the cell refuses to start, naming each problem. Neither
the secret nor the key is ever logged.

The runner opens a WebSocket at `GET /api/runner` with
`Authorization: Bearer <RUNNER_SECRET>`; anything else is 401 before the
upgrade. A frame may be at most 64 KiB. Each `session.start` the cell sends
carries the public half of the pass key, which the session's host checks
passes with.

A person asks for a pass to their own running session with
`POST /api/cloud-sessions/<id>/pass` and their cell token, and gets
`{ "pass": "…", "hostUrl": "https://…", "expiresAt": <seconds> }`, never
cached (`Cache-Control: no-store`). The pass lasts five minutes; the page asks
for another. Any session that is not theirs, or not running, is 404.

## The shared packages

The cell imports three of the workspace's packages from their builds:
`@consola/cloud-contract` (`packages/cloud-contract`), what `cloud-global` and
the cells agree on, `@consola/runner-protocol` (`packages/runner-protocol`),
what the cell and its runners say to each other, and `@consola/factory-spec`
(`packages/factory-spec`), the factory files' schema. `pnpm dev:cloud-region`
and `pnpm test` build them first. A `pnpm --filter @consola/cloud-region …`
command does not, so build them before the first such command, and again
after changing one:

```bash
pnpm --filter @consola/cloud-contract build
pnpm --filter @consola/runner-protocol build
pnpm --filter @consola/factory-spec build
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
