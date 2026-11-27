# AGENTS.md

This file guides coding agents working in `packages/cloud-session-e2e`
(`@consola/cloud-session-e2e`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/cloud-session-e2e`.

## What it is

One test, `src/cloudSession.test.ts`: a Consola cloud session end to end, with
no Google, no credential and no sandbox provider. Each case starts:

- the cloud app as it is built, `@consola/cloud-api`'s `dist/main.js`, on a
  PGlite folder of the test's own, with every variable it reads set by the
  test (`DATABASE_URL`, `PORT`, `PUBLIC_URL`, a `BETTER_AUTH_SECRET`, stand-in
  Google settings, `RUNNER_SECRET`, `RUNNER_WORKSPACE_ID` and a
  `PASS_PRIVATE_KEY` made for the run, and the GitHub App's settings and
  `BETTER_AUTH_SECRETS` empty): the app's `main.ts` loads
  `apps/cloud-api/.env` for any variable left unset, and in a worktree that
  file is the developer's own. A variable set empty is unset to the app but
  set to that loader, so the file cannot fill it;
- the runner command over local sandboxes (`@consola/host`'s
  `src/testing/replayRunner.ts`), whose sandboxes are processes of the host's
  session command over a replayed Claude (`localProvider.ts`), with
  `ANTHROPIC_API_KEY=test` and `GIT_TOKEN=test`.

**Signing a person in without Google.** Each case starts the app three times
on its folder, since PGlite takes one process per folder:

1. With no runner, once, so it makes and migrates the folder; then it stops.
2. With the app stopped, the test writes the person (`user`) and a session of
   theirs (`session`, a random token, no workspace active) into the folder
   with PGlite, the rows Better Auth's own sign-in writes once Google
   answered. Then the app starts again, with no runner, and the person makes
   their workspace through `POST /api/workspaces`, as the web app asks: it is
   born whole (its owner's `member` row, its first team) and becomes the
   session's active workspace. The app stops again.
3. With the runner's settings, `RUNNER_WORKSPACE_ID` naming that workspace.

Every request carries Better Auth's session cookie, `better-auth.session_token`
(no `__Secure-` prefix, as `PUBLIC_URL` is http), its value signed with the
run's `BETTER_AUTH_SECRET` as better-call's `signCookieValue` signs it, which
Better Auth's `setSessionCookie` runs: the token, a dot and the base64
HMAC-SHA256 of the token, URI-encoded. A Better Auth upgrade that changes the
scheme fails the case at `POST /api/workspaces` (401). Each request also
carries the web app's origin (`PUBLIC_URL`), as a browser would send it, and
`x-consola-workspace` naming that workspace, as the web app sends it. The app
reads who is asking from the cookie and the person's role from `member`, as
it does for anyone ("Who is asking" in `apps/cloud-api/AGENTS.md`).

Then it asks the app's API as a person would: a session starts, runs, is given
a pass, and its host (reached at the address the runner reported, with a socket
ticket for the pass, as t3's client connects) answers the `simple` fixture's
message; the host's title reaches the app; a person's stop ends the session
and its sandbox's processes. The second case stops the runner with SIGTERM
while a session runs, and the app must hold that session `stopped`, the end
the runner said before it closed its socket.

## Rules

- **No CLI of the developer's runs.** The test process takes the host's setup
  file (`vite.config.ts`, `@consola/host`'s `src/testing/setup.ts`: a temporary
  home, no CLI variable, a `PATH` of fake CLIs), and every process it starts
  runs on a machine of the test's own (`@consola/host`'s
  `src/testing/machine.ts`). After each case, every fake CLI's recorded call
  must have seen that machine's home and no config folder.
- **No real credential.** Every secret is made by the test or is a stand-in,
  and none may show in what the app (each of its three runs) or the runner
  printed: the runner's secret, the auth secret, the pass key, the session's
  token and every pass. The processes it
  starts get none of the runner's secret variables (`RUNNER_SECRET_VARIABLES`,
  which `localProvider.ts` hands on: an E2B key, a git token, an API key) and
  no `CONSOLA_` setting from the developer's shell, only the test's stand-ins.
  Fixtures use Acme, Sprocket and the `sprocket` org.
- **Nothing is left running.** A case ends its sandboxes, the runner and the
  app, and the teardown kills whatever a failed case left.
- **It uses the host's testing ring by path**, as `@consola/agent-ui`'s browser
  tests do; `packages/host/AGENTS.md` ("The rings") lists what it reaches, so a
  change there runs this test too.

## Running it

```bash
pnpm exec turbo run test typecheck --filter=@consola/cloud-session-e2e
```

Turborepo builds what the test spawns first (`^build`): its `devDependencies`
name the cloud app, the host and the packages they load from `dist/`
(`@consola/runner-protocol`, `@consola/sandbox`), and PGlite at the app's
version, which writes the person into the app's folder.
`pnpm --filter @consola/cloud-session-e2e test` alone builds nothing: on a
fresh checkout, or after changing one of those, run the line above (a case
with no `dist/main.js` fails at once, naming it). CI checks the package in a
job of its own, on Linux, as every workspace package
(`.github/scripts/ci-scope.mjs`), whenever a change reaches the cloud app, the
host or anything they load. The typecheck is the host's (`effect-tsgo`), since the
test loads the host's own modules and, through them, t3's server.
