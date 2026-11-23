# AGENTS.md

This file guides coding agents working in `apps/cloud-region`, Consola Cloud's
regional cell. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads
it too. The repository's guide is the root `AGENTS.md`, and setup is in
`README.md`. Paths below are relative to `apps/cloud-region`.

## What the cell is

The control plane has a global part, `cloud-global` (`apps/cloud-global`), and
one cell per region. Each region runs a copy of this app, configured with its
region (`REGION`, `eu` or `us`) and given a database of its own, never
`cloud-global`'s, so the global side cannot read regional data.

- **The cell holds no accounts.** People, sign-in, sessions, workspaces and
  their members are `cloud-global`'s. A cell refers to a person by their global
  id (the id `cloud-global` gives them), never by an email, and keeps no copy
  of an account. No file imports Better Auth, and no table is named after one
  of its tables (`user`, `session`, `account`, `verification`, `member`,
  `invitation`). What it does keep is a copy of which workspaces are in its
  region and who their members are, ids and roles only, from `cloud-global`'s
  outbox (below, "The outbox").
- **Every table carries the workspace id**: a not-null `workspace_id`, the
  workspace's id in `cloud-global`.
- **The cell does hold the workspace's content.** Under the Warp model
  (decided 2026-11-22), Consola hosts the runners and keeps what a workspace
  makes, such as its factory files and runs, so that content lives here, in
  the workspace's region.
- **The cell trusts only `cloud-global`'s token.** Every request but
  `GET /api/health`, the outbox's deliveries (`POST /api/outbox`) and the
  GitHub events `cloud-global` passes on (`POST /api/github/events`), both
  signed with the same key, carries a cell token `cloud-global` minted, and
  the cell learns who is asking, in which workspace, from that token and
  nothing else (below, "Who is asking").

The cell listens on `127.0.0.1:3101` by default, beside `cloud-global`'s 3100.
`PORT` moves it, so two cells (`eu` and `us`) can run on one machine.
`CLOUD_GLOBAL_URL` (default `http://127.0.0.1:3100`) is where it fetches
`cloud-global`'s keys.

## Who is asking

A request names its caller with `Authorization: Bearer <cell token>`, the
token whose claims `packages/cloud-contract` defines (read its "The cell
token" first). Nothing else counts: not a query parameter, a cookie or another
header.

- **The check.** A token is accepted only if jose verifies it with
  `cloud-global`'s public keys (`CELL_TOKEN_ALGORITHM` alone,
  `CELL_TOKEN_AUDIENCE`, `CLOCK_SKEW_SECONDS`), the contract's
  `readCellTokenClaims` reads its claims, both at one moment from the
  `Clock`, and then only if its `region` is the cell's own. A token must name
  its key's `kid`, and its `typ` must not be `OUTBOX_MESSAGE_TYPE` or
  `GITHUB_EVENT_TYPE`: the same key signs the outbox's deliveries and GitHub's
  events, and a delivery is never a token, whatever its payload holds.
  `application/authenticate.ts` holds the steps, `domain/caller.ts`
  (`admitClaims`) the rule on the claims and the region, and `adapters/token`
  the signature check, behind the `TokenVerifier` port. Every constant comes
  from the contract; never retype one.
- **The answers.** No bearer credentials (no header, or another scheme) is
  401 with `WWW-Authenticate: Bearer` and `{"error":"token_required"}`. A
  token that is not accepted, malformed, forged, signed by another key, expired
  or with a claim the contract does not name, is 401 with
  `WWW-Authenticate: Bearer error="invalid_token"` and
  `{"error":"invalid_token"}`: getting a new token is the fix. A good token for
  a workspace in another region is 421 Misdirected Request with
  `{"error":"wrong_region","region":"<this cell's>"}`: no new token helps,
  sending it to the right cell does, and 403 stays free for what a role may not
  do. The region is judged only on a token that is otherwise accepted, so a
  bad one is always 401. When the keys cannot be had (`cloud-global` down, an
  answer that is no key set), every token is refused with 503 and
  `{"error":"token_check_unavailable"}`, never let through, and the cell logs
  why, never the token. No answer says more than these.
- **The keys.** `cloudGlobalKeys` is jose's `createRemoteJWKSet` on
  `CELL_TOKEN_KEYS_PATH` at `CLOUD_GLOBAL_URL`. It keeps the set ten minutes,
  fetches it again for a `kid` it has not seen at most once every 30 seconds,
  and follows no redirect. So `cloud-global` must publish a new key at least
  30 seconds before it signs with it. `CLOUD_GLOBAL_URL` is an origin, and
  plain http only on this machine, since whoever can answer that fetch can
  mint any token the cell takes.
- **The caller.** `requireCaller` (`adapters/http/caller.ts`) is the Hono
  middleware that runs the check and sets the `Caller` on the context
  (`c.var.caller`, typed by `CellEnv`): the person's global id, the
  workspace's id, the role and the region, no more. Only `admitClaims` makes a
  `Caller` (a type-only brand keeps a hand-written one from type-checking).
- **Open routes.** Three routes answer without a token: `GET /api/health`,
  for whatever probes cells, `POST /api/outbox`, where `cloud-global`
  delivers its outbox, and `POST /api/github/events`, where it passes on
  GitHub's webhook events, each delivery signed instead (below, "The outbox"
  and "GitHub's events"). `createApp` registers them before `requireCaller`,
  and every route after, so an unknown path is 401 before it is 404, and any
  other method on either delivery path needs a token. A new open route needs a
  reason as good, and the HTTP suite's "every route" test has to name it
  (`OPEN_ROUTES`).
- **A workspace's rows.** A route never takes a workspace id from the request
  (path, query, body or header). A use case that reads or writes a
  workspace's rows takes the `Caller` and scopes every query by its
  `workspaceId`; the workspace is the token's, so a token for one workspace
  cannot reach another's rows. A role check is the use case's too, from
  `caller.role`. The two delivery routes are the exception: no person calls
  them, and the workspace each writes is the one its signed message names,
  which only `cloud-global` can sign.

## The outbox

`cloud-global` tells the cell about each workspace in the cell's region, and
its members, through its outbox (`packages/cloud-contract`, "The outbox
messages" and "Delivering a message": read them first). The cell keeps a copy
from those messages and nothing else.

- **What it keeps.** Two tables, each with its `workspace_id`: `workspace`,
  one row per workspace once its `workspace.created` is applied, with
  `last_applied_sequence`; and `workspace_member`, one row per member, with
  `person_id` and `role`, keyed by both ids. Ids and roles only: never an
  email, a name or anything else of an account, which the contract's reader
  refuses anyway, and a test pins the columns (`workspaceCopies.test.ts`).
- **How a delivery is authenticated** is the contract's choice: the body is
  the message as a compact JWS signed with the cell token's key, `typ`
  `OUTBOX_MESSAGE_TYPE`. The cell checks it (`adapters/token/outboxDeliveries.ts`,
  jose's `compactVerify`) against the very key set it checks tokens with
  (`cloudGlobalKeys`, built once in `compose.ts`), with `CELL_TOKEN_ALGORITHM`
  alone, a `kid` required, and no other `typ`. Another `typ` or no `kid` is
  refused before the key set is asked. There is no secret of the cell's own,
  and nothing more to configure: `CLOUD_GLOBAL_URL` already gives the keys.
- **The order of the checks** is the contract's, and each answer is
  `OUTBOX_ANSWER`'s, by status. Before anything, the route
  (`adapters/http/outbox.ts`) refuses a body not sent as
  `OUTBOX_DELIVERY_MEDIA_TYPE` (any case, parameters ignored) and one over
  `MAX_DELIVERY_BYTES` (16 KiB), each 400, without reading it. Then
  `receiveDelivery` (`application/receiveDelivery.ts`):
  1. the signature: not `cloud-global`'s is 401 `{"error":"unsigned"}`; keys
     that cannot be had are 503 `{"error":"unavailable"}`, never 401, logged
     the way tokens log it;
  2. the message: the payload as UTF-8, `JSON.parse` and `readOutboxMessage`;
     what does not read is 400 `{"error":"unreadable"}`, and the log gets
     the contract's reason, never the body;
  3. the region: another region's message is 421
     `{"error":"otherRegion","region":"<this cell's>"}`;
  4. the sequence (`placeMessage`, `domain/workspaceCopy.ts`): at or below the
     last applied is 200 `{"applied":true}` with nothing changed; the next is
     applied, then 200; further ahead is 409 with exactly `{ nextSequence }`
     (`OutOfOrderAnswer`), the last applied plus one, or `FIRST_SEQUENCE` for
     a workspace the cell holds nothing of. A database that does not answer
     is 503 `{"error":"unavailable"}`.
  Every refusal is logged in one line, never the body.
- **Applied once, in order, in one transaction.** `WorkspaceCopies.applyAfter`
  makes the change and moves `last_applied_sequence` in one transaction, by a
  compare-and-set from the sequence the message was placed against (for a new
  workspace, an insert that does nothing on conflict). A delivery that loses
  it to another, the same message delivered twice at once, places the message
  again and finds it applied, so it changes nothing.
- **What each change does** (`copyChangeOf`) is a state to reach, not a step,
  so a copy that differs from `cloud-global`'s records converges rather than
  refusing a message `cloud-global` would send forever: `workspace.created`
  makes the row; `member.added` and `member.role-changed` both put the member
  with the message's role (an added member already there takes it, a role
  change for someone not there adds them); `member.removed` deletes the member,
  and for someone not there changes nothing. Each still moves the sequence.
- **Each change keeps the workspace's teams true to it**, in the same
  transaction (below, "Teams"): opening a workspace makes its first team, a
  person who becomes a member joins it, and one who stops being a member leaves
  every team.

## GitHub's events

`cloud-global` receives the GitHub App's webhooks, and keeps none of what they
say: it passes each event on to the cell of the workspace that holds its
installation (`packages/cloud-contract`, "Passing on a GitHub event": read it
first). What happens in a company's repositories is the company's, so it is
kept here, in the workspace's region, for its runners and triggers (epics 21
and 39), which read it later.

- **What it keeps.** One table, `github_event`, keyed by `workspace_id` and
  GitHub's `delivery_id`: the event's name, the installation, the payload as
  GitHub sent it and when the cell received it. The payload is GitHub's JSON
  as text, not `json` or `jsonb`: both refuse a `\u0000` escape, which a pull
  request's body or a comment can hold. Every event is kept for now; how long
  is for the runners and triggers to decide.
- **How a delivery is authenticated** is the outbox's way, with its own `typ`:
  a compact JWS signed with the cell token's key, checked by
  `createJoseDeliveryVerifier` built for `GITHUB_EVENT_TYPE`
  (`adapters/token/outboxDeliveries.ts`), on the same key set. The outbox's
  verifier refuses an event, this one refuses an outbox message, and the
  token check refuses both.
- **The order of the checks** is the contract's, and each answer is
  `GITHUB_EVENT_ANSWER`'s, by status. Before anything, the route
  (`adapters/http/gitHubEvents.ts`) refuses a body not sent as
  `GITHUB_EVENT_DELIVERY_MEDIA_TYPE` and one over
  `GITHUB_EVENT_DELIVERY_MAX_BYTES` (36 MiB: any payload GitHub sends, signed),
  each 400, without reading it. Then `receiveGitHubEvent`
  (`application/receiveGitHubEvent.ts`): the signature (401 `unsigned`, or 503
  when the keys cannot be had), the event (`readGitHubEventMessage`, 400
  `unreadable`), the region (421 `otherRegion`), then the record: 409
  `workspacePending` while the cell holds nothing of the workspace (its
  `workspace.created` is not applied yet), 201 when recorded now, 200 when it
  was recorded before, and 503 when the database does not answer. Every
  refusal is logged in one line, with ids and the event's name, never the
  payload.
- **Recorded once.** `GitHubEventStore.record` holds the workspace's copy row
  (`for key share`) and inserts on conflict do nothing, so a delivery sent
  again, at once or later, or a capture replayed under its delivery id, is
  recorded once and changes nothing.

## Teams

A workspace's teams live in its cell, because their names are the company's
information (decided 2026-11-21: teams own factories; a new workspace starts
with one team; no team-level roles). Better Auth's teams are not used: they
would put teams in `cloud-global`'s database. The rules are in
`domain/team.ts`, the use cases in `application/teams.ts`, the store in
`adapters/persistence/teams.ts` and the routes in `adapters/http/teams.ts`.

- **Two tables**, each with its `workspace_id`: `team` (`team_id`, which the
  cell gives it, `name`, `is_first`) and `team_member` (`team_id`,
  `person_id`, `added_at`). A team member's row points at the workspace's copy
  of the member (`workspace_member`), so only a member of the workspace can
  be in one of its teams, and a member who leaves the workspace leaves every
  team as their copy's row goes. It also points at its team through both ids,
  so a place is always in a team of its own workspace.
- **The first team.** Every workspace has exactly one (`team_first_unique`),
  called `FIRST_TEAM_NAME` until someone renames it. The cell makes it as it
  applies `workspace.created`, and every person who becomes a member of the
  workspace joins it: an added member, or a role change for someone the copy
  did not have. A member whose role changes keeps the teams they are in, so a
  person taken out of the first team is not put back by a role change. It can
  be renamed, and its members taken out, but it is never deleted (409
  `first_team`), so every factory always has a team to belong to. The
  migration that added teams (`0001_teams`) made a first team, holding every
  member, for each workspace the cell held already.
- **Names** are trimmed, 1 to `TEAM_NAME_MAX` characters with no control
  character (`checkTeamName`, every problem at once as 400 `invalid_team`),
  and unique in the workspace whatever their case (`team_name_unique`, on
  `lower(name)`; 409 `name_taken`).
- **Who may do what** (`mayManageTeams`): owners and admins make, rename and
  delete teams and choose their members, and see every team; a member sees
  only the teams they are in, and is refused any change (403 `not_allowed`).
  The list says which (`canManage`), so the web app shows controls by the
  answer, never by the role.
- **The role a caller acts with** is the lesser of their token's and their
  role in the cell's copy (`actingRole`), and none when the copy holds no such
  member. A token lives five minutes, so without the copy someone demoted or
  removed would keep managing teams until theirs ran out; the copy follows
  `cloud-global` within the outbox's delivery, so they are refused from then
  on. A promotion counts once both say so. Someone the copy does not hold sees
  no team (they are in none) and may change nothing.
- **The order of the checks** is the same in every change: the token's role
  (a member is refused without anything being read), then the name, then
  whether the cell holds the workspace yet (409 `workspace_pending` until
  `cloud-global` has delivered its `workspace.created`; asking again later
  helps), then the role in the copy, then what the store finds. The role is
  read just before the write, not in its transaction: a demotion applied in
  between is one write late, never more. A team id is looked up in the
  caller's workspace alone, so another workspace's team is 404
  `team_not_found`, never changed.
- **Members** are added by their global id, `PUT
  /api/teams/{teamId}/members/{personId}`, and only if the cell's copy has
  them (409 `not_a_workspace_member`); adding someone already in the team, or
  taking out someone not in it (`DELETE`), changes nothing. The store holds
  the member's copy row while it writes (`for key share`), so they cannot
  leave the workspace in between.
- **A team that owns a factory** is not deleted (409 `owns_factories`), below
  ("Factories").

## Factories

A workspace's factories live in its cell, with their files (decided
2026-11-22: a factory's definition is saved in Consola's backend, or pulled
from a git repo). The rules are in `domain/factory.ts`, the use cases in
`application/factories.ts`, the store in `adapters/persistence/factories.ts`
and the routes in `adapters/http/factories.ts`.

- **Three tables**, each with its `workspace_id`: `factory` (`factory_id`,
  which the cell gives it, `name`, `team_id`, `source`, `latest_version`),
  `factory_version` (`version`, `saved_by_person_id`, `saved_at`) and
  `factory_file` (`path`, `content`), a row per file of a version. A factory
  points at its team through both ids, so its team is always one of its own
  workspace, and a version points at its factory, and a file at its version,
  the same way.
- **The files** are a factory folder's, in the format `packages/factory-spec`
  defines: `factory.yml`, `automations/<name>.yaml`, `agents/<name>.md` and
  `skills/<name>/…`, each a path inside the folder and its text. Runners and
  scorers have no format there yet, so the cell takes none. A file under a
  later slice's folder (factory-spec's `LATER_FOLDERS`: `environments/`,
  `connections/`, `evals/`) is stored with factory-spec's notice that it has
  no effect yet, as the desktop's folder applies it; any other path is refused
  as the folder's reader refuses a stray. Files are text: a binary file in a
  skill cannot be saved yet.
- **A set is stored only if it keeps the schema** (`checkFactoryFiles`). The
  set is checked first: at most `FACTORY_FILES_MAX` files and
  `FACTORY_BYTES_MAX` bytes, each path inside the folder and given once, each
  file at most factory-spec's `MAX_FACTORY_TEXT_BYTES`, with no NUL (no
  Postgres text holds one) and no lone surrogate. Then factory-spec's
  `parseFactory` checks every file and the references across them. Any issue
  refuses the whole set: 400 `invalid_files`, with every issue in
  factory-spec's shape (`file`, `line`, `message`…). Never write a second
  schema here. `folderOf` sorts the files as the folder's reader would, into
  records built by `Object.fromEntries`, so a name such as `__proto__` is
  checked, never lost. A body over `SAVE_BODY_MAX` is 413 `too_large` before
  it is read.
- **Versions.** A factory is made blank: version 1, holding no files. Each
  save is the next version, never a change to one. A save names
  `baseVersion`, the version its files were edited from, and lands only while
  that is still the latest, by a compare-and-set on `latest_version` (409
  `version_moved`, with the latest, otherwise), so a save never undoes one it
  did not see. Every version stays readable (`GET
  /api/factories/{factoryId}/versions/{version}`), and `GET
  /api/factories/{factoryId}` answers the factory with its latest version's
  files.
- **Where the files come from** is `source`: `stored`, for now. A GitHub
  repository (9.4) is the second kind; saving a repo factory's files is to be
  refused then.
- **Who may do what** follows the team (decided 2026-11-21): a person sees the
  factories of the teams they see (`factoriesSeenBy`, on `teamsSeenBy` and
  `actingRole`), so owners and admins see every factory, and a member the
  factories of the teams they are in. Whoever sees a factory may save its
  files and rename it, and may make one for any team they see, or move one
  there (`judgeFactoryChange`; only who sees was decided). A factory the
  caller does not see is 404 `factory_not_found`, and a team they do not see
  404 `team_not_found`, so a member learns nothing of another team's.
- **Names** are checked as teams' are (`checkFactoryName`, 400
  `invalid_factory`) and are unique in the workspace whatever their case
  (`factory_name_unique`, on `lower(name)`; 409 `name_taken`).
- **The order of the checks**: what was sent (the name, or the files), then
  whether the cell holds the workspace (409 `workspace_pending`), then whether
  the caller sees the factory, then the team, then the base version, then what
  the store finds. What the caller sees is read just before the write, as the
  teams' role is.
- **Renaming and moving** is one route, `PATCH /api/factories/{factoryId}`,
  with a new `name`, a new `teamId`, or both. Both at once is one statement,
  made whole or not at all. Its versions, its latest version and when that
  was saved stay as they are. `source` is not changed there.
- **A team that owns a factory** is not deleted (409 `owns_factories`): the
  factory's foreign key to its team refuses it, and the team store answers
  `owns-factories`. The same key checks a move, and holds the team's row
  until the move is written, so a move and a delete of its team at once never
  leave a factory on no team: the move finds the team gone (404
  `team_not_found`), or the delete finds it owns the factory. Deleting a
  factory comes later.

## Runs

A workspace's runs live in its cell, beside its factories: what each
factory's runners ran, for the web's Runs pages (project "15 · Runs in
Consola"). The model is the orchestrator spec's (slice 6b, "A request is a
run"): a **request** is a run whose one step is its factory's orchestrator,
started by a person with text, and the automation runs it starts are its
**children**, each with a `parent` link set when it is made and never
changed; every other run is a top-level automation run. The rules are in
`domain/run.ts`, the use cases in `application/runs.ts`, the store in
`adapters/persistence/runs.ts` and the routes in `adapters/http/runs.ts`.

- **One table**, `run`, keyed by `workspace_id` and the runner's `run_id`. A
  run points at the version of its factory it ran (`run_factory_version_fk`),
  and a child at its request through the request's factory too
  (`run_parent_fk`, on `run_factory_run_unique`), so a child is always of
  its request's factory and whoever sees the child sees the request. The
  item, the steps and a request's facts are `jsonb`; a request's text, which
  only its page reads, is `request_text`. Times are `timestamptz(3)`, the
  runner's own, so a cursor holding one finds it again. Check constraints
  hold the domain's rules on the row as a backstop.
- **No route writes a run.** A runner records each through the store's
  `record` (`recordRun`), and the cell stores it only once `checkRun` finds
  nothing wrong with it: a status, trigger or step it knows, `waitingOn`
  exactly while `waiting`, an automation exactly for an automation run and a
  request's facts exactly for a request, a parent only on an automation run
  (`manual`, started by no person), an item only at an https address, times
  it can store, and no NUL or lone surrogate anywhere (`jsonb` refuses
  `\u0000` too). A record older than the one held (`updated_at`) changes
  nothing (`stale`, a compare-and-set in the upsert), and a run's factory,
  kind and parent never change (`identity-changed`). Today the tests and the
  seed call it; the runner's connection (CON-94) will.
- **Title and phase are stored**, so the list searches, filters and counts
  by them. The title (`titleOf`) is a request's item's title, else its
  text's first line; an automation run's item's title, else its
  automation's name; one line of at most `TITLE_MAX` characters. The phase
  (`phaseOf`) groups the nine statuses into five (`PHASES`). A request rolls
  its children up (`requestPhase`): while its own phase is `active` and one
  of its runs needs someone, it needs someone too; an ended request keeps
  its phase. Recording a child holds its request's row (`for update`) and
  rolls it up again in the same transaction, so two of its runs recorded at
  once roll it up one after the other. A request's child counts and an
  automation run's progress are worked out on read (`childCountsOf`,
  `progressOf`).
- **Who sees a run** follows its factory (`factoriesSeenBy`, on
  `teamsSeenBy` and `actingRole`), by the factory's team now, read by a
  join, never stored on the run: owners and admins see every run, a member
  the runs of their teams' factories. A run the caller does not see is never
  listed, counted or offered as a facet, and its id is 404 `run_not_found`.
  The use case hands the store the factories the caller sees, narrowed by
  the query's `factoryId` and `teamId`, and the store reads no other.
- **The list** (`GET /api/runs`) holds top-level runs only, newest first
  (`created_at`, then `run_id`), a page at a time: `nextCursor` is
  base64url of the last run's `[createdAt, id]` (`encodeCursor`), and a
  cursor the cell did not hand out is 400. `phase` and `trigger` may be
  given once or repeated (`several`, a `z.preprocess` to an array, since
  Hono reads a value given once as a string). `automation` keeps that
  automation's runs and the requests that started one; `q` matches the
  title or the automation's name in any case, its `%`, `_` and `\` matched
  as themselves. `counts` are under every filter but `phase`, `cursor` and
  `limit`; `facets` are what the caller sees, whatever the filters. A run's
  page (`GET /api/runs/{runId}`) adds its steps, a request's facts and text
  and its runs in the order it started them, and a run's request.
  `conversation` is null until cloud sessions (CON-91).
- **A step says what it was asked, did and produced**, as the desktop's
  trace does. What it did is what its runner records: the engine's
  `StepRun` fields (outputs, artifacts, turn, command, earlier attempts,
  reminded) and the end of what it printed (`output`: at most
  `OUTPUT_TAIL_MAX`, 16 KiB, of each of stdout and stderr, cut at whole lines
  by `tailOf`; `checkRun` refuses a longer one). What it was asked is not
  stored: `readRun` reads it from the factory version the run executed
  (`automationsOf`, then `stepDefinitionOf`), wherever the automation is
  written, so it is what that version said, never the latest. It is null for
  a request's orchestrator step, an automation the version does not define,
  and a step it does not. A step inside a loop has its own; a loop's block
  and a gate are null, since neither is an agent or a command step, the two a
  definition describes. A step stored before these fields existed reads as
  having none (`stepRecordOf`).
- **The file behind a run** (`source`, `sourceOf` in `domain/runSource.ts`)
  is read the same way: the file the automation is written in at the run's
  version, whole, with the automation's own lines (`automationLines`, from
  `@consola/factory-spec`: the whole file for `automations/<name>.yaml`, its
  entry for `factory.yml`), how it starts, its mode and what it applies to,
  and the factory's latest version beside it. Each step's definition carries
  its lines in that file (`range`). Null for a request, and when the version
  does not define the automation.
- **Approving a run** (`POST /api/runs/{runId}/approval`,
  `domain/runApproval.ts`) is the cell's first route through which a person
  writes a row about a run. A run waiting for approval (`needs-approval`)
  says why (`approvalReason`: its automation asks every time, its version
  was not approved to run on its own, or its orchestrator's was not), what
  approving lets run (`willRun`: every command and agent step, those a loop
  repeats included; a gate runs nothing) and who may answer: anyone on its
  factory's owning team, literally the team's members whatever their workspace role
  (decided 2026-11-23), so an owner who sees every run answers only those of
  the teams they are in (`mayAnswer`). The checks run in the route's order:
  the body, the workspace held, the run seen (404 `run_not_found`, so a
  member of another team learns nothing), on the team (403 `not_allowed`),
  waiting (409 `not_waiting`), the version answered being the run's (409
  `version_moved`), then the insert (409 `already_answered`: the first
  answer for a version stands). The answer is a row of `run_approval`, keyed
  by run and version, and the cell **never changes the run** for it: the
  runner is the authority on a run, and acts on the answer once runners
  exist (epic 21, CON-94). A run shows its approval while it waits and once
  its version is answered.
- **The demo seed** (`pnpm --filter @consola/cloud-region db:seed`,
  `src/seed.ts`, then `seedDemoRuns`) writes demo runs for every workspace
  the cell holds: a demo factory per team (`Demo · <team>`, each automation
  in a file of its own, saved as a new version whenever its files differ
  from `DEMO_FACTORY_FILES`), and runs in every status, a request with
  several runs, background runs and each member's own. Its steps print,
  exit, take turns, produce outputs and documents, retry and are refused a
  tool, as a runner's would. Ids are fixed (`demo-…`) and times counted back
  from now, so seeding again refreshes the same runs. It refuses any
  database but a PGlite folder (`seedRefusal`, in `config.ts`), and refuses
  while anything answers on the configuration's `PORT`, since PGlite takes
  one process per folder: stop the cell first. It is never reachable over
  HTTP.

## The API's contract

Every route is declared in `adapters/http/contract.ts` with
`@hono/zod-openapi`'s `createRoute`, and `ROUTES` lists them. `createApp`
returns an `OpenAPIHono`, registers each with `app.openapi`, and TypeScript
checks every answer a handler gives against its route's responses. It is
built the way `cloud-global`'s contract is
(`apps/cloud-global/src/adapters/http/contract.ts`), so the two read alike.

- **Answers are strict objects** (`z.strictObject`); request bodies are
  checked for their shape only (`z.object`), never for the domain's rules.
  The HTTP suite reads every teams, factories and runs answer with the
  schema its route declares for its status (`answerOf`), so an undeclared
  status or a field the contract does not name fails a test.
- **The token check's answers** (401 `token_required`/`invalid_token`, 421
  `wrong_region`, 503 `token_check_unavailable`) are declared once
  (`tokenFailures`) and spread into every route behind the check.
- **A body** of the wrong shape is 400 `invalid_request` (`defaultHook`); one
  that is not JSON is 400 too, and one without a JSON content type 415
  `unsupported_media_type` (`onError`, since the validator throws before any
  hook). A body is checked after the token.
- **The outbox's body** is declared as `OUTBOX_DELIVERY_MEDIA_TYPE`, which the
  library neither validates nor gates, so the route keeps its own checks of
  the media type and size.
- **`openapi.json`**, at the app's root, is generated from the routes by
  `adapters/http/openapi.test.ts` (`pnpm --filter @consola/cloud-region
  openapi:generate`), which fails while it is stale. The same test checks
  that the contract describes every route the app serves, and only those, and
  that no named schema may be null (a use that may be null is
  `z.union([Named, z.null()])`, never `.nullable()`). The web app generates
  its client for the cell from this file, and Biome leaves it alone.

## The layers

The service is built in rings, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of, such as the
  regions (`region.ts`, which takes them from the contract), the order a
  workspace's copy applies its messages in (`workspaceCopy.ts`), teams
  (`team.ts`), factories (`factory.ts`) and runs (`run.ts`). It is plain
  TypeScript, with no I/O, and no package but the shared ones (below).
- `src/application/` holds the use cases (`checkHealth`, `authenticate`,
  `describeMe`, `receiveDelivery`, `receiveGitHubEvent`, the teams' in
  `teams.ts`, the factories' in `factories.ts`, the runs' in `runs.ts`, and
  `seedDemoRuns`) and, in `ports.ts`, the stores, probes, the
  `TokenVerifier`, the `DeliveryVerifier`, the `WorkspaceCopies`, the
  `GitHubEventStore`, the `TeamStore`, the `FactoryStore`, the `RunStore`
  and the `Clock` they need. `signedPayload.ts` reads a signed
  delivery's JSON for both delivery use cases. A use case is a plain
  function that takes its ports first.
- `src/adapters/` implements the ports with a library, one folder each:
  - `persistence/` is Drizzle on PGlite or Postgres: the database
    (`database.ts`), the tables (`tables.ts`, re-exported as `schema` by
    `schema.ts`), and one store per port, which `stores.ts` builds together;
  - `http/` is the contract (`contract.ts`), the Hono routes (`app.ts`), the
    token check in front of them (`caller.ts`), the outbox's route
    (`outbox.ts`), GitHub's events' (`gitHubEvents.ts`), the teams'
    (`teams.ts`), the factories' (`factories.ts`) and the runs' (`runs.ts`). Each route asks a use
    case and maps its answer to a status and a body;
  - `token/` is jose: the `TokenVerifier` and where its keys come from
    (`cellTokens.ts`), and the `DeliveryVerifier`, on the same keys, for the
    outbox and for GitHub's events (`outboxDeliveries.ts`);
  - `clock/` is the machine's clock, the `Clock`.
- The composition ring wires them together. `src/compose.ts` is the one place
  adapters are built and handed the ports they need (`composeCell`), and the
  place startup steps go. Adapters call use cases themselves; what they never
  do is build another adapter. `src/main.ts` loads the environment, opens and
  migrates the database, calls `compose.ts` and serves, and
  `src/startupError.ts` words a failure to start. `src/seed.ts`, the demo
  seed's entry (above, "Runs"), is in the ring too.
- `src/config.ts` parses the environment. It is shared configuration that any
  adapter may read, so it stays a pure parser with no I/O. It may import
  `domain`, whose list of regions it checks `REGION` against (`cloud-global`'s
  config imports nothing).

## The dependency rule

- `domain` imports only `domain`. `application` imports only `domain` and
  `application`. Neither imports a package (but the shared ones) or a `node:`
  builtin, and neither refers to a global that reaches the machine: `process`,
  `fetch`, `require`,
  `XMLHttpRequest`, `WebSocket`, the timers (`setTimeout`, `setInterval`,
  `setImmediate`), `globalThis` or `global`.
- An adapter imports `domain`, `application`, its own folder and
  `src/config.ts`, and never the composition ring or another adapter. Beyond
  that:
  - `adapters/http` never imports a database library (`drizzle-orm`,
    `@electric-sql/pglite`, `pg`) or `jose`;
  - `adapters/persistence` never imports `hono` or `jose`;
  - `adapters/token` is the one place `jose` is imported, and never imports
    `hono` or a database library;
  - `adapters/clock` imports no package.
- No file, tests included, imports another app, Better Auth
  (`better-auth`, `@better-auth/*`) or a workspace package (`@consola/*`, or
  `consola`, the desktop), with two exceptions, the shared packages, which
  any layer may import, `domain` and `application` included. Only an entry
  point counts: a path inside either is refused.
  - `@consola/cloud-contract` (`packages/cloud-contract`), the contract the
    cell shares with `cloud-global`. It holds the regions, the workspace
    roles, the claims of the token `cloud-global` mints for a cell, the
    outbox messages it sends one and the GitHub events it passes on. It does
    no I/O, which its own boundary test proves. Before changing it, read `packages/cloud-contract/AGENTS.md`.
  - `@consola/factory-spec` (`packages/factory-spec`, MIT), the factory
    files' schema and parser every runner shares, with which the cell checks
    the files it stores (above, "Factories"). It parses texts it is handed and
    does no I/O.
- Test files (`*.test.ts`) are exempt from the layer rules, because they wire
  real pieces together the way `compose.ts` does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the globals `domain` and `application` refer to. Only a
reference counts, directly or through `globalThis`, never a property or a
member that shares the name (`request.process`, `{ fetch: 1 }`). A file that
sits in no layer fails it too. The rules are data at its top (`LAYERS`,
`NEVER`, `SHARED_PACKAGES`), so a new layer or folder is added there first. It
also reads every package in the workspace and checks that each one but the
shared ones is refused, so a new package is covered without being named.

`src/adapters/persistence/schema.test.ts` enforces the table rules: every table
in `schema` has a not-null `workspace_id`, and none is an account table (the
copy of a workspace's members is `workspace_member`, ids and a role, never
`member`).

## Adding a feature

1. A rule or a type goes in `domain`.
2. A use case goes in `application`, with any port it needs in `ports.ts`.
3. An adapter implements the port. For the database, that is a table in
   `tables.ts` (with its `workspace_id`) and a store in `adapters/persistence`,
   added to `createDrizzleStores`.
4. A route is declared in `adapters/http/contract.ts` (and listed in
   `ROUTES`), and a handler in `adapters/http` calls the use case. It is
   registered with `app.openapi` after `requireCaller` in `createApp` (or by a
   function handed the app there, as `teamRoutes` is), and hands the use case
   `c.var.caller`, never a workspace id from the request. Then
   `openapi:generate` rewrites `openapi.json`.
5. `compose.ts` builds the adapter and hands it its ports, and nothing else
   does. A startup step goes there too.

## Tests

A test sits beside its module and is named after it (`healthProbe.ts`,
`healthProbe.test.ts`). Rules in `domain` are tested alone. Stores and use
cases are tested on a migrated `pglite:memory` database through the real
Drizzle stores: the database is never mocked. `src/app.test.ts` is the HTTP
suite, end to end. It builds the cell through `compose.ts` (`composeCell`), as
`main.ts` does, so it tests the wiring that runs.

No test needs `cloud-global` running. A test makes an Ed25519 key pair, signs
tokens with jose's `SignJWT` over the contract's `cellTokenClaims` and outbox
deliveries with its `CompactSign` over a message's JSON, and hands the cell
the public key as a local key set (`composeCell`'s `cellTokenKeys`, which only
tests pass). The tests of the remote key set start a small `node:http` server
on port 0 and point `CLOUD_GLOBAL_URL` at it. The HTTP suite's "every route"
test asks every route the app has without a token and expects 401 from all
but the open ones it names (`OPEN_ROUTES`), so a new route is covered without
being named. That deliveries apply once is asserted on the tables, and on the
use case's answer (`now`) for deliveries made at once: PGlite runs one
transaction at a time, so the compare-and-set is also tested directly
(`workspaceCopies.test.ts`).

## Generated files

`drizzle/` holds the migrations, written by
`pnpm --filter @consola/cloud-region db:generate --name <what>` after
`tables.ts` changes. They apply when the cell starts. The first is
`0000_workspace_copy`; `0001_teams` ends with two statements written by hand,
which give the workspaces already held their first team
(`migrations.test.ts` runs it over a database migrated to `0000` only);
`0002_factories` adds the factories' tables, all generated,
`0003_github_event` GitHub's events, `0004_runs` the runs, and
`0005_run_approval` the answers to runs waiting for approval.
Postgres cuts a name at 63 characters, and drizzle's names for a composite
foreign key run past that, so such a key is named in `tables.ts`.

`openapi.json` is generated too (above, "The API's contract").
