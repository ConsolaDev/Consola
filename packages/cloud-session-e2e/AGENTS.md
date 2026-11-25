# AGENTS.md

This file guides coding agents working in `packages/cloud-session-e2e`
(`@consola/cloud-session-e2e`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/cloud-session-e2e`.

## What it is

Two tests, with no credential and no sandbox provider, and what they share
(`src/processes.ts`: starting node, waiting, free ports, a runner's sandboxes).

`src/cloudSession.test.ts` is a Consola cloud session end to end. Each case
starts:

- a stand-in for `cloud-global`'s key route (`CELL_TOKEN_KEYS_PATH`) on a port
  of its own, publishing a key the test signs cell tokens with, as
  `cloud-global` signs them (`cellTokenClaims`, EdDSA, the key's thumbprint as
  `kid`);
- the cell as it is built, `node apps/cloud-region/dist/main.js`, with every
  variable it reads set by the test (`DATABASE_URL=pglite:memory`, `REGION`,
  `PORT`, `CLOUD_GLOBAL_URL`, `RUNNER_SECRET`, `RUNNER_WORKSPACE_ID` and a
  `PASS_PRIVATE_KEY` made for the run): the cell's `main.ts` loads
  `apps/cloud-region/.env` for any variable left unset, and in a worktree that
  file is the developer's own;
- the runner command over local sandboxes (`@consola/host`'s
  `src/testing/replayRunner.ts`), whose sandboxes are processes of the host's
  session command over a replayed Claude (`localProvider.ts`), with
  `ANTHROPIC_API_KEY=test` and `GIT_TOKEN=test`.

Then it asks the cell's API as a person would: a session starts, runs, is given
a pass, and its host (reached at the address the runner reported, with a socket
ticket for the pass, as t3's client connects) answers the `simple` fixture's
message; the host's title reaches the cell; a person's stop ends the session
and its sandbox's processes. The second case stops the runner with SIGTERM
while a session runs, and the cell must hold that session `stopped`, the end
the runner said before it closed its socket.

`src/triggeredRun.test.ts` is a pull request's triggered run end to end
(stage 1 of the cloud's automations, CON-116 and CON-127). Each case starts:

- a stand-in for `cloud-global`: its key route, as above, and
  `POST /api/github/tokens`, which mints a token (a stand-in, `ghs_e2e…`) only
  for a request signed with the cell's own key (`CELL_PRIVATE_KEY`, made for
  the run, its public half held as `cloud-global` holds
  `CELL_PUBLIC_KEY_EU`), of `GITHUB_TOKEN_REQUEST_TYPE`, read by the
  contract's `readGitHubTokenRequest`, for the workspace's installation and
  repository, and answers with the purpose's permissions, as `cloud-global`'s
  contract declares;
- the cell as it is built, as above, with `CELL_PRIVATE_KEY` too;
- the runner over local sandboxes with `CONSOLA_TEST_STEPS`
  (`replayRunner.ts`): the agent step's host replays `simple` as a stand-in
  that takes the engine's prompt and t3's default model as the fixture's own
  (`anyPrompt`), after the real step tools' server took the reviewer's calls
  (`verdict` `APPROVE`, a handover); the command step runs a real `bash`
  with a stub `gh` first on its `PATH`, which posts nothing, records its
  arguments and its `GH_TOKEN`, copies the body file it is handed and prints
  the token, which the runner must mask.

Then it does what the web app and `cloud-global` would: the outbox makes the
workspace and the person a member of its first team; the person saves
factory-spec's Review pull requests files as a factory's version 2; a signed
`pull_request` `opened` event is delivered, then the same delivery again (one
run); the run waits for approval with the pull request as its item, head
commit and base branch included; the person approves it through the cell's
API; and the run completes, both steps completed, `verdict` set, the handover
listed, `gh` called once with the review's body, the head commit and
`event=COMMENT` (never `APPROVE`), with the token the cell got for the step
(`review-run`; both checkouts got `run-read`), which appears in no record and
nothing printed. A second case approves while no runner is connected and
starts another runner, whose hello is passed the answer with the stored
record; a third dismisses the run, which ends `rejected` with no token asked
for, no sandbox and no `gh`.

What it does not reach: the real Claude Code (the agent's turn is a replay,
its tool calls made for it), a real sandbox (E2B), GitHub and the real
`cloud-global` (its GitHub App, webhook intake and mint). A run handed again
across a runner's restart (a lost acknowledgement) is not staged here: the
cell's store and the runner's ring test it ("A run never moves backwards" in
`apps/cloud-region/AGENTS.md` and `packages/host/AGENTS.md`).

## Rules

- **No CLI of the developer's runs.** The test process takes the host's setup
  file (`vite.config.ts`, `@consola/host`'s `src/testing/setup.ts`: a temporary
  home, no CLI variable, a `PATH` of fake CLIs), and every process it starts
  runs on a machine of the test's own (`@consola/host`'s
  `src/testing/machine.ts`). After each case, every fake CLI's recorded call
  must have seen that machine's home and no config folder.
- **No real credential.** Every secret is made by the test or is a stand-in,
  and none may show in what the cell or the runner printed. The processes it
  starts get none of the runner's secret variables (`RUNNER_SECRET_VARIABLES`,
  which `localProvider.ts` hands on: an E2B key, a git token, an API key) and
  no `CONSOLA_` setting from the developer's shell, only the test's stand-ins.
  Fixtures use Acme, Sprocket and the `sprocket` org. No case calls GitHub, a
  model or E2B.
- **Nothing is left running.** A case ends its sandboxes, the runner and the
  cell, and the teardown kills whatever a failed case left.
- **It uses the host's testing ring by path**, as `@consola/agent-ui`'s browser
  tests do; `packages/host/AGENTS.md` ("The rings") lists what it reaches, so a
  change there runs this test too.

## Running it

```bash
pnpm exec turbo run test typecheck --filter=@consola/cloud-session-e2e
```

Turborepo builds what the test spawns first (`^build`): its `devDependencies`
name the cell, the host and the packages they load from `dist/`
(`@consola/cloud-contract`, `@consola/runner-protocol`, `@consola/sandbox`),
and `@consola/factory-spec`, whose Review pull requests files the triggered
run saves.
`pnpm --filter @consola/cloud-session-e2e test` alone builds nothing: on a
fresh checkout, or after changing one of those, run the line above (a case
with no `dist/main.js` fails at once, naming it). CI checks the package in a
job of its own, on Linux, as every workspace package
(`.github/scripts/ci-scope.mjs`), whenever a change reaches the cell, the host
or anything they load. The typecheck is the host's (`effect-tsgo`), since the
test loads the host's own modules and, through them, t3's server.
