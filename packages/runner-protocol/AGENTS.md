# AGENTS.md

This file guides coding agents working in `packages/runner-protocol`
(`@consola/runner-protocol`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/runner-protocol`.

## What it is

What a runner (`consola-host runner`) and a regional cell (`apps/cloud-region`)
say to each other, written once so that neither keeps its own copy:

- the messages over the runner's socket. Runner to cell: `hello`
  (`runnerId`, the `repositories` and `harnesses` it offers, the
  `runningSessionIds` it still holds, `endedSessions`, the sessions that
  ended while the socket was down, each with its real end, and `automations`,
  whether it runs automations) and `session.update` (`status`, `hostUrl`,
  `title`, `error`). Cell to runner: `session.start` and `session.stop`. Read
  with `readRunnerMessage` and `readCellMessage`. One message's JSON may be at
  most `SOCKET_FRAME_MAX_BYTES` (4 MiB): both sides refuse a larger frame;
- the messages for automation runs (`automationMessages.ts`, below, "Runs");
- the run record (`run.ts`, `RunRecord`, `readRunRecord`) and a GitHub
  event's facts (`github.ts`, `GitHubEventFacts`, `readGitHubEventFacts`);
- the session pass both sides check: `PASS_AUDIENCE`, `PASS_TYPE` (the JWS
  `typ`), `PASS_MAX_LIFETIME_SECONDS`, `PassClaims`, `passClaims` (builds the
  claims, throws on a grant the reader would refuse) and `readPassClaims`;
- the start script's own line, `StartScriptLine` (`exit` with `clone-failed`),
  read with `readStartScriptLine`. It is not one of the host's lines.

It signs nothing and verifies nothing. The cell signs a pass; the host checks
its signature, the time against now (`exp <= now` is expired, and the clock
skew applies to `iat` only) and `sid`.

The cell and the host import it, from any layer (the cell's `domain` and
`application` included). It is MIT, with its own `LICENSE`, because people who
run their own runners build against it (root `AGENTS.md`, Licensing). It must
not import from `apps/*` or any other workspace package.

## The rule

The package does no I/O, so inner layers can import it:

- a source file imports only other source files in `src/`: no package, no
  `node:` builtin, no test code. `package.json` has no `dependencies`;
- it refers to no global that reaches the machine (`MACHINE_GLOBALS` in
  `src/boundary.test.ts`): the process, the network, `crypto`, `console`, the
  clock and the timers. Globals that do no I/O (`URL`, `Number`, `JSON`) are
  fine;
- `src/index.ts` holds only `export … from`;
- `src/read.ts` is this package's own copy of the readers' helpers, since it
  may import no workspace package, `@consola/cloud-contract` included. Its
  combinators (`objectOf`, `listOf`, `mapOf`, `nullable`, `oneOf`,
  `readerOf`) build a strict structural reader whose reasons name the field's
  path (`run.steps[2].status`). A time is checked by its form alone
  (`isIsoTime`), since `Date` is the clock.

`src/boundary.test.ts` enforces it from the syntax tree, like
`cloud-contract`'s.

## Reading what the other side sent

Each reader returns `{ ok: true, value }` or `{ ok: false, reason }`, and never
throws on what it reads.

- **Strict.** A missing field, a field the protocol does not name, a `type` it
  does not know, a repository that is not `owner/name` (no `.` or `..` name, no
  name starting with `.`) and a `hostUrl` that is not an origin are refused.
  `hostUrl` is exactly what `exposePort` gives: `https:`, or `http:` for
  `127.0.0.1`, `localhost` and `[::1]` (local sandboxes), with no user info,
  path, query or fragment. `ws:` and `wss:` are refused.
- **Reasons name the field, never its contents**, so a reason can be logged.
  Branch on `ok`, never on a reason's wording.
- **Sessions that ended while the socket was down** ride in `hello`'s
  `endedSessions`. The cell applies them before it judges `runningSessionIds`,
  so a session that ended keeps its real end instead of becoming "the runner
  restarted".

## Runs

Stage 1 of the cloud's automations (CON-116): the cell hands a GitHub event
to the workspace's runner, the runner matches it against the factory's files,
records a run, waits for a person's approval, runs the steps in sandboxes and
records every change. The cell stays the store and writes no run of its own;
the runner decides.

- **Runner to cell.** `factories.request` (`requestId`, and `only`, one
  factory at one version, else every factory at its latest saved version);
  `run.record` (`run`, the whole record, every time it changes);
  `github.event.ack` (`deliveryId`: the runner recorded the event's runs, or
  found none); `github.token.request` (`requestId`, `runId`, `stepId`,
  `repository`, and `permissions`: 1 to `GITHUB_PERMISSIONS_MAX` (8) of
  GitHub's permission names, lowercase snake_case, each `read` or `write`).
- **Cell to runner.** `github.event` (`deliveryId`, and `event`, narrowed
  facts, never GitHub's payload: today only `pull_request`, with `action`,
  `repository`, `number`, `url` (https), `title`, `author`, `draft`,
  `headSha` (40 lowercase hex), `headRef`, `baseRef` and `fork`; another event
  joins `GitHubEventFacts` with a reader of its own); `factories`
  (`requestId`, and each factory's id, version and files, at most
  `FACTORIES_PER_ANSWER_MAX` factories of `FILES_PER_FACTORY_MAX` files);
  `run.answered` (`run` as the cell stores it, so a runner that restarted can
  pick it up, `decision` `approved` or `rejected`, and `personId`);
  `github.token` (`requestId`, `token`, `expiresAt`, an ISO 8601 time) or
  `github.token.refused` (`requestId`, `reason`); and `run.refused` (`runId`,
  and 1 to `RUN_PROBLEMS_MAX` problems, each a `field` and a `message`).
- **`requestId`** is 1 to 64 letters, digits, `_` or `-` (`isRequestId`). The
  runner picks it and the answer names it. `deliveryId` is GitHub's, read as
  `@consola/cloud-contract` reads it (`isDeliveryId`). Other ids are text
  with something in it, as `sessionId` and `runnerId`.
- **Every bound is exported** (`PULL_REQUEST_TITLE_MAX`, `GIT_REF_MAX`,
  `GITHUB_LOGIN_MAX`, `GITHUB_ACTION_MAX`, `GITHUB_URL_MAX`,
  `FACTORY_FILE_PATH_MAX`, `FACTORY_FILE_TEXT_MAX`, `TOKEN_REFUSAL_MAX`,
  `RUN_PROBLEM_TEXT_MAX`…), in UTF-16 code units (`String.length`), so a
  sender cuts to it before it sends: a pull request's title is the author's
  own text.
- **`github.token`'s `token` is a secret.** No reader's reason holds any of
  it, whatever is wrong with the message, and neither side logs it.
- **`RunRecord` is the one wire definition of a run**: the cell's `RunWrite`
  (`apps/cloud-region/src/domain/run.ts`), field for field, with its
  vocabularies (`RUN_STATUSES`, `RUN_TRIGGERS`, `WAITING_ON`, `STEP_KINDS`,
  `STEP_STATUSES`, `ITEM_KINDS`) mirrored here, since the package imports
  nothing. `readRunRecord` checks its shape alone: every field present and of
  its type, every word one of its vocabulary, no field the protocol does not
  name, and every list bounded (`RUN_STEPS_MAX`, `STEP_OUTPUTS_MAX`…). What a
  record means (which combinations hold, ids and times in their form,
  `OUTPUT_TAIL_MAX` and `REQUEST_TEXT_MAX_BYTES` in bytes) is the cell's
  `checkRun`, which answers a record it refuses with `run.refused`, every
  problem named. Keep the two apart: a meaning checked by the reader would be
  dropped with a log line, and the runner would never hear why.

## Changing the protocol

The cell and the runner deploy apart and every reader refuses what it does not
know, so the side that reads goes first: add a field or a message to the
reader and its handling, then to the sender. Removing one goes the other way.
`hello`'s `automations` is required, so a runner built before it is refused
by a cell built after: deploy the two together.

## Building and using it

Consumers import its build (`dist/`). `pnpm --filter @consola/runner-protocol
build` after changing it; Turborepo builds it before a dependent's tasks.

## Tests

A test sits beside its module. Each reader is tested on the value after
`JSON.stringify` and `JSON.parse`, with a case for every refusal.
