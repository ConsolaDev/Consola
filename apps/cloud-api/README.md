# Consola Cloud: cloud-api

Consola Cloud's API: one app, with one database. It holds the accounts
(Google sign-in, sessions, the workspaces people make and who is in each) and
what each workspace holds: its teams, its factories with their files,
versioned, the runs of those factories, the GitHub App installations it
connects and the events GitHub sends for them, and the cloud sessions its
runner runs in sandboxes. The web app is `apps/cloud-web`; the browser only
talks to the web app, which proxies `/api` to this service.

Sign-in is open to any Google account with a verified email, and anyone signed
in can make workspaces. It is for local use only, until a later round limits it
to the company.

Every route is in `openapi.json`, generated from the routes themselves, but
Better Auth's own (`/api/auth/*`) and the runner's socket, a WebSocket
upgrade. `AGENTS.md` holds the rules.

## Start fresh

Until 2026-11-26 Consola Cloud was two apps, `apps/cloud-global` and the
regional cell `apps/cloud-region`, each with its own `.env` and database. This
app replaces both, and its migrations start again at `0000`, so a database
either of them made is not migrated. Start fresh:

1. Delete `apps/cloud-api/.data` if it is there (and the old apps' `.data`
   folders, which nothing reads any more).
2. Make `apps/cloud-api/.env` from `.env.example` (next sections). Values
   from the old `apps/cloud-global/.env` carry over (`BETTER_AUTH_SECRET`,
   Google, the GitHub App, the webhook secret, the tunnel), and so do the
   runner's from `apps/cloud-region/.env` (`RUNNER_SECRET`, `PASS_PRIVATE_KEY`).
   `CELL_TOKEN_PRIVATE_KEY`, `CELL_URL_EU`, `CELL_URL_US`,
   `CELL_PUBLIC_KEY_EU`, `CELL_PUBLIC_KEY_US` and `CLOUD_GLOBAL_URL` are gone.
3. Sign in again and make your workspaces again: the old ids are gone, so
   `RUNNER_WORKSPACE_ID` changes too.

## Create a Google OAuth client

1. In the Google Cloud Console, create or pick a project.
2. Configure the OAuth consent screen.
   - With a personal Google account, choose External, leave it in testing mode
     and add your own account as a test user.
   - With a Google Workspace organisation, Internal is the better choice.
3. Credentials, Create credentials, OAuth client ID, Web application.
   - Authorised JavaScript origin: `http://localhost:5175`
   - Authorised redirect URI: `http://localhost:5175/api/auth/callback/google`
4. Put the client ID and secret into `apps/cloud-api/.env` (next section).

## Run

```bash
cp apps/cloud-api/.env.example apps/cloud-api/.env   # then fill in the values
pnpm dev:cloud
```

`BETTER_AUTH_SECRET` starts empty, and the API will not start until you set
one (`openssl rand -base64 32`).

Open `http://localhost:5175`. `pnpm dev:cloud` starts the API and the web app
together. The API listens on `127.0.0.1:3100`, where the web app's proxy and
the runner expect it, so leave `PORT` unset or at 3100 unless you also change
`apps/cloud-web/vite.config.ts` and the runner's `--cell-url`. `.env.example`
documents every variable. The API refuses to start, naming each bad variable,
if one is missing or wrong.

`GET /api/health` answers 200 when the API reaches its database, and 503 when
it does not.

By default the data is PGlite (Postgres in-process) in a folder under
`apps/cloud-api/.data/` (`DATABASE_URL` in `.env.example`). Deleting
`.data` resets the local database.

Every workspace is made in the deployment's region: `REGION`, `eu` when
unset. No route moves a workspace to another.

## Connect GitHub

A workspace connects GitHub by installing Consola's GitHub App from the web
app's Settings, on its Connections page. The API starts without it: with none of the app's
settings set, the page says GitHub is not configured here. Set all four or
none, or the API refuses to start.

Register a development app of your own (GitHub, Settings, Developer settings,
GitHub Apps, New GitHub App), separate from the one a deployment uses: an app
has one webhook address, so each environment needs its own.

- **Callback URL:** `http://localhost:5175/api/github/callback`, the web app's
  address, so the redirect back carries your session cookie.
- **Request user authorization (OAuth) during installation:** on. The
  `installation_id` in GitHub's redirect can be forged, so Consola exchanges
  the redirect's one-time code for your GitHub token, checks with GitHub that
  you own the account the installation is on, then revokes the token. GitHub
  greys out the Setup URL once this is on; the callback replaces it.
- **Webhook:** Active, its URL your Cloudflare tunnel's address plus
  `/api/github/webhooks`, and a secret: see "Receive GitHub's webhooks"
  below.
- **Repository permissions:** Metadata read, Contents read and write, Pull
  requests read and write. Each token Consola mints is narrowed below these.
- **Organization permissions:** Members read. It is how Consola tells an
  organisation's owners, who may connect its installation, from its members,
  who can reach it but may not. Without it, connecting an organisation fails
  with "GitHub isn't answering", and the API logs which permission is missing.
- **Where it can be installed:** only on this account, for development.

Then, on the app's General page, note the client ID and the slug (the name in
`github.com/apps/<slug>`), generate a client secret and a private key, and set
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG` and
`GITHUB_APP_PRIVATE_KEY_PATH` (the full path to the downloaded `.pem`, outside
the repository: `.gitignore` covers `.env` files, not keys).

Connect only from Consola. An installation made on GitHub directly is never
recorded for a workspace: Connect sends GitHub a state only your session can
finish with. If the app is already installed on an account, Connect takes you
to its settings on GitHub, and saving them there brings you back connected.
Disconnecting removes Consola's record only; the app stays installed on GitHub
until you uninstall it there, which the page links to.

Every token the API mints for a workspace's work is recorded
(`github_token_mint`), never the token itself. Minting needs the app's
Contents read and write and Pull requests read and write (above); a purpose
the app lacks a permission for is refused by GitHub.

## Receive GitHub's webhooks

GitHub sends the App's webhooks (a pull request opened, a push) to one public
address. In development a Cloudflare tunnel brings them to the API on this
machine; nothing is deployed. The API checks each delivery's signature, finds
the workspace that holds the event's installation and records the event once
for that workspace, in its `github_event` table. A `pull_request` event
recorded for the first time starts the agent runs the workspace's factories'
teams fire (`AGENTS.md`, "Agent runs").

1. **Make the secret.** Once, and keep it in `apps/cloud-api/.env` only:

   ```bash
   openssl rand -hex 32
   ```

   Put the line it prints after `GITHUB_WEBHOOK_SECRET=` in `.env`, and
   restart `pnpm dev:cloud`. A secret shorter than 32 characters stops the API
   from starting; with none, every delivery is refused (503).

2. **Start the tunnel**, in a terminal of its own:

   ```bash
   pnpm --filter @consola/cloud-api webhooks:tunnel
   ```

   It runs `cloudflared` (`brew install cloudflared`) to the API's port and
   prints the webhook URL to set: the tunnel's address plus
   `/api/github/webhooks`. By default it is a quick tunnel, which needs no
   Cloudflare account and gets a new `*.trycloudflare.com` address each time
   it starts, so the URL is set again after every start. For an address that
   stays put, make a named tunnel on a domain of yours (`cloudflared tunnel
   login`, `cloudflared tunnel create <name>`, `cloudflared tunnel route dns
   <name> <hostname>`) and set `CLOUDFLARE_TUNNEL_NAME=<name>` and
   `CLOUDFLARE_TUNNEL_HOSTNAME=<hostname>` in `.env`: the script then runs it
   and prints `https://<hostname>/api/github/webhooks`. Ctrl+C stops it.

3. **Set it on the App** (GitHub, Settings, Developer settings, GitHub Apps,
   your app, General, Webhook): **Active** on, **Webhook URL** the address the
   script printed, **Secret** the same value as `GITHUB_WEBHOOK_SECRET`. Then,
   under Permissions & events, subscribe to the events you want: Pull request
   and Push to begin with. GitHub sends a `ping` at once, which the API
   answers.

4. **Try it.** Open a pull request on a repository the connected installation
   covers. The API logs one line for the delivery and keeps the event in
   `github_event`. The App's Advanced page lists every delivery with the
   API's answer, and Redeliver sends one again.

What the API answers GitHub:

| Answer | When |
| --- | --- |
| 201 | the event was recorded for the workspace that holds its installation |
| 200 `pong` | GitHub's ping |
| 400 | signed, but a header or the body is not what GitHub sends |
| 401 | no signature, or not one made with the secret over this body |
| 409 | the workspace had this delivery already (a Redeliver after a success, or a replay) |
| 413 | over the 25 MB GitHub sends at most |
| 422 | the event came through an installation no workspace holds (installed on GitHub, but not connected from Consola), or none: dropped and logged |
| 503 | no `GITHUB_WEBHOOK_SECRET`, or the database did not answer: Redeliver once it does |

To send a real pull request's event without GitHub, from a connected
installation's repository:

```bash
node apps/cloud-api/scripts/deliver-pull-request-event.mjs --repository <owner/name> --number <n>
```

It reads the pull request with your `gh`, signs GitHub's `pull_request` body
with `GITHUB_WEBHOOK_SECRET` as GitHub does, posts it to
`/api/github/webhooks` with a fresh delivery id and prints the answer.

## Teams, factories and runs

Every route below takes the session cookie, as the web app sends it, and
`x-consola-workspace`, the workspace the page shows. It acts in the session's
active workspace alone, with the person's role read from the workspace's
members on every request: signed out is 401, a header that is missing is 400,
one that names another workspace than the session's active one is 409 (another
tab switched it), and someone not in the workspace is 403.

Every workspace starts with one team, **General**, made with the workspace
itself, with its owner in it. Owners and admins manage teams; a member sees
the teams they are in.

| Route | Does |
| --- | --- |
| `GET /api/teams` | the teams the caller sees, and whether they may manage them (`canManage`) |
| `POST /api/teams` `{"name"}` | make a team, with nobody in it |
| `PATCH /api/teams/{teamId}` `{"name"}` | rename one, General included |
| `DELETE /api/teams/{teamId}` | delete one; General, and a team that owns a factory, are never deleted (409) |
| `PUT /api/teams/{teamId}/members/{personId}` | add a member of the workspace, by id |
| `DELETE /api/teams/{teamId}/members/{personId}` | take a person out |

Names are unique in a workspace whatever their case. The tables are `team`
and `team_member`.

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

Runs are what each factory's runners ran. No route writes a run (a runner
will record them; until then, the demo seed below does): a person only answers
one that waits for approval. A **request** is a run a person starts with text,
whose orchestrator starts automation runs of its own; those are listed under
it, not on their own. Who sees a run follows its factory, as factories do.

| Route | Does |
| --- | --- |
| `GET /api/runs` | the top-level runs the caller sees, newest first, with the counts per phase and what the filters offer; filters `phase` and `trigger` (repeatable), `factoryId`, `teamId`, `automation`, `mine`, `q`; pages by `cursor` and `limit` |
| `GET /api/runs/{runId}` | one run: its steps, the file behind it, its approval, a request's text and facts and the runs it started, a run's request |
| `POST /api/runs/{runId}/approval` `{"decision","version"}` | approve or dismiss a run waiting for approval: anyone on its factory's team; the first answer stands, and the run is left to its runner |

The tables are `run` and `run_approval`.

## Demo data

To see the pages with something in them, seed demo runs into every workspace
there is, with the API stopped (PGlite takes one process per folder):

```bash
pnpm --filter @consola/cloud-api db:seed
```

It writes only to a local PGlite folder (`DATABASE_URL=pglite:<folder>`) and
refuses while the API answers on `PORT`. Each team gets a demo factory
(`Demo · <team>`), and its runs cover every status, a request with several
runs, background runs and each member's own. Each workspace's first team also
gets the code review team's factory, with one finished agent run. Seeding
again refreshes the same runs.

## The runner and session passes

A workspace's runner (`consola-host runner`) connects out to the API, and the
API hands it the cloud sessions people start. For the proof of concept one
runner serves one workspace, admitted by a shared secret; enrolling runners
comes later. Three variables in `.env`, all three or none:

| Variable | What it is |
| --- | --- |
| `RUNNER_SECRET` | What the runner presents, at least 32 printable characters with no spaces: `openssl rand -base64 32`. The runner's `CONSOLA_RUNNER_SECRET` (`packages/host/.env`) holds the same value. |
| `RUNNER_WORKSPACE_ID` | The one workspace the runner serves, by its id. Find it signed in, at `http://localhost:5175/api/workspaces` (each workspace's `id`). |
| `PASS_PRIVATE_KEY` | The API's own Ed25519 private key, as a JSON Web Key on one line, which signs session passes: `pnpm --filter @consola/cloud-api pass-key:generate`. Keep it in `.env` only: anyone who has it can sign passes every session host accepts. |

With none set, the API still starts: no runner can connect, and starting a
session answers 503 `no_runner`. With some but not all, or a key that is no
Ed25519 private key, the API refuses to start, naming each problem. Neither
the secret nor the key is ever logged. After setting them, start
`pnpm dev:cloud` again.

The runner opens a WebSocket at `GET /api/runner` with
`Authorization: Bearer <RUNNER_SECRET>`; anything else is 401 before the
upgrade. On this machine that is `ws://127.0.0.1:3100/api/runner`, the
runner's `--cell-url` (`packages/host/AGENTS.md`, "Local cloud session
demo"). A frame may be at most 4 MiB (the protocol's
`RUNNER_SOCKET_FRAME_LIMIT_BYTES`). Each `session.start` the API sends carries
the public half of the pass key, which the session's host checks passes with.

A person asks for a pass to their own running session with
`POST /api/cloud-sessions/<id>/pass`, signed in, and gets
`{ "pass": "…", "hostUrl": "https://…", "expiresAt": <seconds> }`, never
cached (`Cache-Control: no-store`). The pass lasts five minutes; the page asks
for another. Any session that is not theirs, or not running, is 404.

## The shared packages

The API imports two of the workspace's packages from their builds:
`@consola/runner-protocol` (`packages/runner-protocol`), what the API and its
runners say to each other, and `@consola/factory-spec`
(`packages/factory-spec`), the factory files' schema. `pnpm dev:cloud` and
`pnpm test` build them first. A `pnpm --filter @consola/cloud-api …` command
does not, so build them before the first such command, and again after
changing one:

```bash
pnpm --filter @consola/runner-protocol build
pnpm --filter @consola/factory-spec build
```

## A real Postgres

```bash
docker compose up -d
```

Then set `DATABASE_URL=postgres://consola:consola@localhost:5432/consola_cloud`
in `apps/cloud-api/.env` (the compose file is `compose.yaml` at the repository
root).

## The schema

Accounts' tables are Better Auth's, generated; company's are in
`src/company/adapters/persistence/tables.ts` and `gitHubTables.ts`. After
changing the auth configuration, regenerate the auth tables; after any schema
change, write the migration:

```bash
pnpm --filter @consola/cloud-api auth:generate
pnpm --filter @consola/cloud-api db:generate --name <what>
```

Migrations apply when the API starts. `src/rules.test.ts` checks every table
against the two rules (`AGENTS.md`, "The two rules").

## Tests and types

```bash
pnpm --filter @consola/cloud-api test
pnpm --filter @consola/cloud-api typecheck
```

The tests run on PGlite, and sign people in without Google.
