# Consola Cloud: cloud-global

The global part of Consola Cloud's control plane, shared by every region:
Google sign-in, sessions, the workspaces people make, each in a region, the
short-lived token a regional cell trusts, the outbox that tells each cell of
its workspaces and their members, the GitHub App installations workspaces
connect, and the App's webhooks, which it passes on to each workspace's cell.
The web app is `apps/cloud-web`; the
browser only talks to the web app, which proxies `/api` to this service.

Sign-in is open to any Google account with a verified email, and anyone signed
in can make workspaces. It is for local use only, until a later round limits it
to the company.

An `.env` from before workspaces may still set `ORG_NAME` and `ORG_SLUG`.
Nothing reads them any more, so they can go. The organisation they made carries
on as an ordinary workspace, with its members.

## Create a Google OAuth client

1. In the Google Cloud Console, create or pick a project.
2. Configure the OAuth consent screen.
   - With a personal Google account, choose External, leave it in testing mode
     and add your own account as a test user.
   - With a Google Workspace organisation, Internal is the better choice.
3. Credentials, Create credentials, OAuth client ID, Web application.
   - Authorised JavaScript origin: `http://localhost:5175`
   - Authorised redirect URI: `http://localhost:5175/api/auth/callback/google`
4. Put the client ID and secret into `apps/cloud-global/.env` (next section).

## Run

```bash
cp apps/cloud-global/.env.example apps/cloud-global/.env   # then fill in the values
pnpm dev:cloud
```

`BETTER_AUTH_SECRET` starts empty, and the API will not start until you set
one (`openssl rand -base64 32`).

`CELL_TOKEN_PRIVATE_KEY` starts empty too, and an `.env` from before it is
needed lacks it. It is the Ed25519 key that signs the token a regional cell
trusts, written as a JSON Web Key on one line. Make one with

```bash
pnpm --filter @consola/cloud-global cell-key:generate
```

and paste the line it prints after `CELL_TOKEN_PRIVATE_KEY=`. Keep it in
`.env` only: anyone who has it can mint tokens every cell trusts. The cells
need only its public key, which the API publishes, with no sign-in, at
`/api/cell-token/keys`. The set holds only this key, so a new one cuts short
the tokens the old one signed (they live five minutes at most).

`CELL_URL_EU` is the EU cell, which the API tells of every workspace made
there and of who is in it. `.env.example` sets it to `http://127.0.0.1:3101`,
where `pnpm dev:cloud-region` runs the cell; `CELL_URL_US` names a US one. The
cell can start before or after the API: until it answers, the API keeps each
message and tries again, waiting longer each time, up to five minutes. A
region with no cell set keeps its messages, and the API says so once. An
`.env` from before the outbox lacks the variable, so add it.

Open `http://localhost:5175`. `pnpm dev:cloud` starts the API and the web app
together. The web app's proxy targets the API on port 3100, so leave `PORT`
unset or at 3100 unless you also change `apps/cloud-web/vite.config.ts`.
`.env.example` documents every variable. The API refuses to start, naming each
bad variable, if one is missing or wrong.

By default the data is PGlite (Postgres in-process) in
`apps/cloud-global/.data/cloud-db`. Deleting that folder resets the local
database.

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

## Receive GitHub's webhooks

GitHub sends the App's webhooks (a pull request opened, a push) to one public
address. In development a Cloudflare tunnel brings them to the API on this
machine; nothing is deployed. The API checks each delivery's signature, finds
the workspace that holds the event's installation and passes the event on to
that workspace's cell, which keeps it. It keeps none of it itself.

1. **Make the secret.** Once, and keep it in `apps/cloud-global/.env` only:

   ```bash
   openssl rand -hex 32
   ```

   Put the line it prints after `GITHUB_WEBHOOK_SECRET=` in `.env`, and
   restart `pnpm dev:cloud`. A secret shorter than 32 characters stops the API
   from starting; with none, every delivery is refused (503).

2. **Start the cell** the events go to, beside `pnpm dev:cloud`:
   `pnpm dev:cloud-region` runs the EU cell at `CELL_URL_EU`. An event for a
   workspace whose region has no cell set is refused (503), and so is one the
   cell has not been told of yet (502): the outbox tells it of a workspace
   within seconds of the cell starting.

3. **Start the tunnel**, in a terminal of its own:

   ```bash
   pnpm --filter @consola/cloud-global webhooks:tunnel
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

4. **Set it on the App** (GitHub, Settings, Developer settings, GitHub Apps,
   your app, General, Webhook): **Active** on, **Webhook URL** the address the
   script printed, **Secret** the same value as `GITHUB_WEBHOOK_SECRET`. Then,
   under Permissions & events, subscribe to the events you want: Pull request
   and Push to begin with. GitHub sends a `ping` at once, which the API
   answers.

5. **Try it.** Open a pull request on a repository the connected installation
   covers. The API logs `Passed GitHub delivery <id> (pull_request) on to
   workspace <id>'s cell (eu).`, and the cell keeps the event in its
   `github_event` table. The App's Advanced page lists every delivery with
   the API's answer, and Redeliver sends one again.

What the API answers GitHub:

| Answer | When |
| --- | --- |
| 200 `delivered` | the workspace's cell recorded the event |
| 200 `pong` | GitHub's ping |
| 400 | signed, but a header or the body is not what GitHub sends |
| 401 | no signature, or not one made with the secret over this body |
| 409 | the cell had this delivery already (a Redeliver after a success, or a replay) |
| 413 | over the 25 MB GitHub sends at most |
| 422 | the event came through an installation no workspace holds (installed on GitHub, but not connected from Consola), or none: dropped and logged |
| 502 | the cell did not take it: Redeliver once it is up |
| 503 | no `GITHUB_WEBHOOK_SECRET`, or no cell for the workspace's region |

## The shared contract

The API imports `@consola/cloud-contract` (`packages/cloud-contract`), what
`cloud-global` and the cells agree on, from its build. `pnpm dev:cloud` and
`pnpm test` build it first. A `pnpm --filter @consola/cloud-global …` command
does not, so build it before the first such command, and again after changing
it:

```bash
pnpm --filter @consola/cloud-contract build
```

## A real Postgres

```bash
docker compose up -d
```

Then set `DATABASE_URL=postgres://consola:consola@localhost:5432/consola_cloud`
in `apps/cloud-global/.env` (the compose file is `compose.yaml` at the repository
root).

## The schema

After changing the auth configuration, regenerate the auth tables and then the
migration:

```bash
pnpm --filter @consola/cloud-global auth:generate
pnpm --filter @consola/cloud-global db:generate
```

Migrations apply when the API starts.

## Tests and types

```bash
pnpm --filter @consola/cloud-global test
pnpm --filter @consola/cloud-global typecheck
```

The tests run on PGlite. The few that check what concurrent transactions do
also run on a real Postgres when `CLOUD_GLOBAL_TEST_POSTGRES_URL` names a
server's maintenance database; each makes a database of its own there and
drops it:

```bash
CLOUD_GLOBAL_TEST_POSTGRES_URL=postgres://consola:consola@localhost:5432/postgres \
  pnpm --filter @consola/cloud-global test
```
