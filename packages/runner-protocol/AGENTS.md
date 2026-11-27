# AGENTS.md

This file guides coding agents working in `packages/runner-protocol`
(`@consola/runner-protocol`). `CLAUDE.md` imports it with `@AGENTS.md`, so
Claude Code reads it too. The repository's guide is the root `AGENTS.md`.
Paths below are relative to `packages/runner-protocol`.

## What it is

What a runner (`consola-host runner`) and its cell, the cloud app
(`apps/cloud-api`), say to each other, written once so that neither keeps its
own copy:

- the messages over the runner's socket. Runner to cell: `hello`
  (`runnerId`, the `repositories` and `harnesses` it offers, the
  `runningSessionIds` it still holds, and `endedSessions`, the sessions that
  ended while the socket was down, each with its real end) and
  `session.update` (`status`, `hostUrl`, `title`, `error`, `agentRun`). Cell
  to runner: `session.start` (with `agentRun` for an agent run, below) and
  `session.stop`. Read with `readRunnerMessage` and `readCellMessage`;
- the session pass both sides check: `PASS_AUDIENCE`, `PASS_TYPE` (the JWS
  `typ`), `PASS_MAX_LIFETIME_SECONDS`, `PassClaims`, `passClaims` (builds the
  claims, throws on a grant the reader would refuse) and `readPassClaims`;
- the start script's own line, `StartScriptLine` (`exit` with `clone-failed`),
  read with `readStartScriptLine`. It is not one of the host's lines;
- a follow-up, what the cell sends an agent run's host for its orchestrator
  (`FollowUp`, `readFollowUp`, `readFollowUpReceipt`; "Follow-ups", below).
  It goes from the cell to the host directly, never over the runner's socket.

It signs nothing and verifies nothing. The cell signs a pass; the host checks
its signature, the time against now (`exp <= now` is expired, and the clock
skew applies to `iat` only) and `sid`.

The cloud app's `company` part and the host import it, from any layer
(`company`'s `domain` and `application` included); the app's `accounts` part
never does. It is MIT, with its own `LICENSE`, because people who
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
- `src/read.ts` holds the readers' helpers, since the package may import no
  workspace package.

`src/boundary.test.ts` enforces it from the syntax tree.

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

## Agent runs

A session can start as an agent run (`src/agentRun.ts`): an automation's
orchestrator agent takes the first turn and dispatches the others, with no
one typing its first message or approving its commands.

- `session.start` may carry `agentRun` (`AgentRun`): the orchestrator's
  `agent` name, the whole first `prompt`, an optional `model`, an optional
  `checkout` (a `refs/pull/<n>/head` or `refs/heads/…` ref and the 40-hex
  commit it must be), the `agents` it may dispatch (16 at most, each with its
  whole `instructions`) and the factory `files` (128 at most, relative paths),
  which the runner writes under `AGENT_RUN_FACTORY_DIR`. The repository is
  cloned in `SESSION_REPOSITORY_DIR`.
- `session.update` may carry `agentRun` (`AgentRunReport`): the run's `state`,
  the orchestrator's last message as `summary`, and the `agents` it dispatched.
- Read with `readAgentRun` and `readAgentRunReport`; a bad one refuses the
  whole message, naming `agentRun`. Caps: `AGENT_RUN_PROMPT_MAX`,
  `AGENT_RUN_FILES_MAX_BYTES` (characters) and `AGENT_RUN_SUMMARY_MAX`.
- `prompt` and each agent's `instructions` are composed by the cell; the
  runner passes them on as they are and never interprets them.
- Both sides cap the socket's frames at `RUNNER_SOCKET_FRAME_LIMIT_BYTES`
  (4 MiB), so an agent run fits in one `session.start`.

## Follow-ups

A person's message for a running agent run's orchestrator (`src/followUp.ts`),
such as a reply in the Slack thread that started it. The cell sends it to the
session's host straight away, at the `hostUrl` the runner reported:
`POST <hostUrl>` + `FOLLOW_UP_PATH` with `Authorization: Bearer <pass>`, a
pass for the person who wrote it (`sub`), and a JSON body of at most
`FOLLOW_UP_BODY_MAX_BYTES`.

- **The body** (`FollowUp`, read with `readFollowUp`) is exactly `key` (the
  sender's idempotency key, `[A-Za-z0-9._:-]`, 128 at most), `text` (what the
  person wrote, whole, not blank, `FOLLOW_UP_TEXT_MAX` characters at most) and
  `authorLabel` (who wrote it in the sender's words, such as `a teammate in
  Slack`: one line, no control character, `FOLLOW_UP_AUTHOR_LABEL_MAX` at
  most). No name or email: the person is the pass's `sub`.
- **The answer.** `200` with a `FollowUpReceipt` (`readFollowUpReceipt`):
  `delivered`, or `already-delivered` when a follow-up with that key was
  delivered before. The host decides and words everything else: the fence,
  who wrote it, and where it goes (`packages/host/AGENTS.md`, "Agent runs").
- The text is untrusted. The host fences it, and nothing puts it in a command
  line or an environment variable.

## Changing the protocol

The cell and the runner deploy apart and every reader refuses what it does not
know, so the side that reads goes first: add a field or a message to the
reader and its handling, then to the sender. Removing one goes the other way.

## Building and using it

Consumers import its build (`dist/`). `pnpm --filter @consola/runner-protocol
build` after changing it; Turborepo builds it before a dependent's tasks.

## Tests

A test sits beside its module. Each reader is tested on the value after
`JSON.stringify` and `JSON.parse`, with a case for every refusal.
