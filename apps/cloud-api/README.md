# Consola Cloud API

Google sign-in, sessions and the deployment's one organisation. The web app is
`apps/cloud-web`; the browser only talks to the web app, which proxies `/api`
to this service.

Sign-in is open to any Google account with a verified email. It is for local
use only, until a later round limits it to the company.

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
together. The web app's proxy targets the API on port 3100, so leave `PORT`
unset or at 3100 unless you also change `apps/cloud-web/vite.config.ts`.
`.env.example` documents every variable. The API refuses to start, naming each
bad variable, if one is missing or wrong.

By default the data is PGlite (Postgres in-process) in
`apps/cloud-api/.data/cloud-db`. Deleting that folder resets the local
database.

## A real Postgres

```bash
docker compose up -d
```

Then set `DATABASE_URL=postgres://consola:consola@localhost:5432/consola_cloud`
in `apps/cloud-api/.env` (the compose file is `compose.yaml` at the repository
root).

## The schema

After changing the auth configuration, regenerate the auth tables and then the
migration:

```bash
pnpm --filter @consola/cloud-api auth:generate
pnpm --filter @consola/cloud-api db:generate
```

Migrations apply when the API starts.

## Tests and types

```bash
pnpm --filter @consola/cloud-api test
pnpm --filter @consola/cloud-api typecheck
```
