# AGENTS.md

This file guides coding agents working in `apps/cloud-web`, Consola Cloud's web
app. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `AGENTS.md`, and setup is in
`apps/cloud-global/README.md`. Paths below are relative to `apps/cloud-web`.

## The layers

The app is built in layers, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of: `Me`, `MeState`
  and `initialsOf` (`me.ts`); workspaces (`workspace.ts`: `MyWorkspace`,
  `REGIONS` with `regionName` and `regionPlace`, `roleName`,
  `checkNewWorkspace`, `suggestSlug`, the create form's `WorkspaceDraft` with
  `withName` and `withSlug`, and the API's answers `WorkspacesState`,
  `CreateWorkspaceAnswer` and `SwitchWorkspaceAnswer`); the icons a workspace
  can wear (`workspaceIcons.ts`: `WORKSPACE_SYMBOLS` and `WORKSPACE_EMOJIS`,
  the desktop's, with `emojiOf`, `iconLabel`, `iconsMatching`,
  `workspaceInitial` and `SetIconAnswer`); the sentences (`messages.ts`) for a
  failed sign-in or sign-out, for each problem with a new workspace, a taken
  slug, a failed switch, an icon not set and the create form's hints;
  connections (`connections.ts`: the answers of `/api/connections`, a
  Connect's results, the services that come later) and their sentences
  (`connectionMessages.ts`); why a cell could not be read, and its sentence
  (`cell.ts`: `CellRefusal`, `messageForCellRefusal`); teams (`teams.ts`:
  `Team`, `WorkspaceMember`, `checkTeamName`, `memberOf`, `addableTo`,
  `TeamsState`, `TeamChange`) and their sentences (`teamMessages.ts`);
  factories (`factories.ts`: `Factory`, `checkFactoryName`, `checkNewFactory`,
  `newFactoryDraft`, `owningTeam`, `isMove`, `SOURCE_OPTIONS`,
  `FactoriesState`, `FactoryChange`, `FactoryRead`, `FactorySave`,
  `fileGroups`, `listedFiles` and `firstFile`), what is wrong with a
  factory's files (`factoryProblems.ts`: `FactoryProblem`, `problemOf`,
  `problemPath`, `problemCounts`, `ownProblems`, `sortedProblems`,
  `messageParts`) and the check that finds it as the person edits
  (`factoryCheck.ts`, factory-spec's parser: see "Factories"), a person's
  changes over a version (`factoryDraft.ts`: `FactoryDraft`, `draftOf`,
  `withEdit`, `withFileAdded`, `withFiles` (a template's files),
  `withRenamed`, `withSkillRenamed`, `withRemoved`, `withSkillRemoved`, `withRestored`, `discarded`, `filesOf`,
  `fileMarks`, `changeSummary`, `pathMoves`, `broughtIn`, `afterSave`), the
  kinds of file a factory holds, their names and skeletons
  (`factoryKinds.ts`: `NAME_RULE`, `pathFor`, `skeletonFor`, `checkNaming`,
  `NamingTarget`) and the files open as tabs (`factoryTabs.ts`), how
  the sidebar and the address name them (`factoryNav.ts`:
  `FACTORY_PAGES`, `factoryRouteOfHash`, `hashOfFactoryPage`,
  `factoryLanding`, the fold rules `isUnfolded` and `withFold`, and a tile's
  colour, `factoryHue`) and their sentences (`factoryMessages.ts`); runs
  (`runs.ts`: the contract's run types, `PHASES`, `mergeRefresh`, the poll
  delays, `starterOf`, `safeItemUrl`, `RunsAnswer`, `RunAnswer`), the list's
  filters (`runFilters.ts`), where the section is (`runsRoute.ts`), how a run
  is said (`runWords.ts`), how a step is traced (`stepTrace.ts`), the file
  behind a run (`runFile.ts`, shaded by the desktop's YAML tokenizer,
  `yamlTokens.ts`), approving one (`runApproval.ts`) and the pages'
  sentences (`runMessages.ts`; see "Runs"); cloud sessions
  (`cloudSession.ts`: the contract's session types, `sessionLabel`,
  `pollIntervalMs`, `listPollIntervalMs`, `chatMounted`, `shouldRenewPass`,
  `keepsShownOn`, `sessionScreen`, an agent run's reading, `isAgentRun`,
  `agentRunPhase`, `pullRequestLabel`, `pullRequestUrl`, `shortSha`, and the
  answers), where the section is
  (`sessionsRoute.ts`) and their sentences (`cloudSessionMessages.ts`; see
  "Sessions"); where the
  running source is (`source.ts`); and how the address names a dashboard
  section (`sections.ts`: `sectionIdOfHash`, `hashOfSection`, `chooseSection`)
  and a settings page
  (`settings.ts`: `settingsPageIdOfHash`, `hashOfSettingsPage`). It is plain
  TypeScript, with no browser I/O and no package but `@consola/factory-spec`
  (`factoryCheck.ts` alone). `apiContract.ts` and
  `cellApiContract.ts` hold the APIs' types, generated from
  `apps/cloud-global/openapi.json` and `apps/cloud-region/openapi.json` (see
  "The API's contract").
- `src/services/` is everything that talks to something outside the page: the
  API (`api.ts`: `loadMe`, `loadWorkspaces`, `createWorkspace`,
  `switchWorkspace`, `setWorkspaceIcon`, `loadConnections`,
  `startGitHubConnect`, `disconnectGitHub`, through `createApi`, an
  `openapi-fetch` client typed by the contract), the workspace's cell
  (`cell.ts`: `createCellSession`, the token and the address every service
  of the cell shares, on `createCellApi`; `teams.ts`: `teamsService`;
  `factories.ts`: `factoriesService`, a factory's files saved included; `runs.ts`: `runsService`;
  `cloudSessions.ts`: `cloudSessionsService`), Better
  Auth's client (`authClient.ts`: `signInWithGoogle`, `signOut`), the
  clipboard (`clipboard.ts`: `copyText`) and the address bar
  (`signInRedirect.ts`: `takeSignInErrorCode`; `address.ts`: `currentHash`,
  `openHash`, `replaceHash`, `onHashChange`; `settingsAddress.ts`:
  `currentSettingsPageId`, `openSettingsPage`, `onSettingsPageChange`;
  `gitHubRedirect.ts`: `takeGitHubResult`, `goToGitHub`; `runsAddress.ts`:
  `currentRunsHash`, `onRunsAddressChange`, `showRunsFilters`,
  `showRunPlace`), whether the
  page is in view (`pageVisibility.ts`), and the browser's storage, for a
  convenience only (`foldStore.ts`: `readUnfolded`, `writeUnfolded`;
  `runPagePrefs.ts`, what this browser keeps of a run's page;
  `definitionBanner.ts`, whether the definition's banner was hidden). A service
  answers in domain types and sentences, never in a library's own.
- `src/ui/` holds the React screens (`App.tsx` and the cards beside it:
  `SignInCard`, `ProfileCard`, `CreateWorkspaceCard`, and the narrow page's
  topbar with `SignOutButton`), the dashboard (`Dashboard.tsx` with its
  sidebar's workspace menu, `WorkspaceSwitcher`, and `AccountMenu`, its list
  of sections `sections.tsx` with each section's page, such as
  `OverviewPage.tsx` with `RegionMap` and `CopySlug`, `RunsSection.tsx`
  with the list and a run's page (see "Runs"), and `SessionsSection.tsx` with
  `SessionsList`, `NewSessionPage` and `SessionPage`, which holds its session
  through `useCloudSession` and shows it with `SessionConversation`, whose
  chat, `SessionChat`, loads only for a running session, and whose agent run
  shows `AgentRunReport` (see "Sessions"; a run's Conversation tab holds an
  agent run's session the same way), and its
  Factories group
  `FactoriesNav.tsx` with `FactoryTile`, `useFactories`, `NewFactoryDialog`
  and a factory's pages, `FactoryView.tsx` with `FactoryDefinitionPage` (its
  `FactoryFileTree`, `EditorTabs`, `CodeEditor`, `ProblemsPanel` and the
  edits it keeps while the person is away, `factoryDrafts.ts`),
  `FactorySettingsPage` and `SourceChoice`), Settings
  (`SettingsDialog.tsx`, its pages in `settingsPages.tsx`: `GeneralPage.tsx`
  with `WorkspaceIconPicker`, `ConnectionsPage.tsx`, and `TeamsPage.tsx` with
  `TeamCard.tsx` and `TeamNameForm.tsx`), the pieces they share (`Avatar`,
  `WorkspaceIcon`, `BrandMark` on the sign-in card) and `styles.css`. A hook
  goes beside them (`usePoll.ts`: `usePoll`, `useNow`). A screen asks a
  service and shows what comes back. It does not fetch, touch the address or
  know Better Auth.
- The entry wires the page. `src/main.tsx` mounts `ui/App` inside Radix's
  `Theme` and follows the system's colour scheme, and `src/env.d.ts` declares
  the build constants (`__CONSOLA_COMMIT__`, `__CONSOLA_VERSION__`) that
  `vite.config.ts` defines.

## The dependency rule

- `domain` imports only `domain` and `@consola/factory-spec`, the factory
  files' schema and parser (MIT, no I/O, no Node builtin), so the page checks
  files with the rules the cell saves them by. It imports no other package and
  refers to no browser global: `window`, `document`, `fetch`, `history`, `location`,
  `localStorage`, `sessionStorage`, `navigator`, `XMLHttpRequest`,
  `WebSocket`, `globalThis` or `self`.
- `services` imports `domain` and `services`, and packages, but never `ui`,
  `react`, `react-dom`, `@radix-ui/*` or a `node:` builtin.
  `better-auth/react` is allowed there: it is Better Auth's client for the
  browser, and `authClient.ts` is the one file that uses it. It refers to no
  `fetch` or `XMLHttpRequest`: the API is reached only through `createApi`'s
  client, typed by the contract, so a call with types written by hand fails
  the boundary test.
- `ui` imports `domain`, `services`, `ui`, `react`, `@radix-ui/themes`,
  CodeMirror (`@codemirror/*` and `@lezer/*`, the definition's editor, in
  `CodeEditor.tsx`) and `@consola/agent-ui` with its stylesheet (the chat, in
  `SessionChat.tsx`), never `better-auth`. It refers to no `fetch`, `history`, `location`,
  `localStorage`, `sessionStorage`, `XMLHttpRequest` or `WebSocket`, directly
  or through `window`. The build constants are compile-time values, not I/O,
  so `Footer.tsx` may read them.
- Services are called from `ui`. A screen calls the service behind what it
  shows or does: `App.tsx` loads the page's state, and a card calls the
  service behind its own button (`SignInCard.tsx`, `SignOutButton.tsx`,
  `AccountMenu.tsx`, `CopySlug.tsx`, `CreateWorkspaceCard.tsx`,
  `WorkspaceSwitcher.tsx`).
  `domain` and `main.tsx` call none.
- No file imports another app or a workspace package (`@consola/*`), but
  `ui`, which imports `@consola/agent-ui` (the chat, MIT, which imports
  nothing of an app's), and `domain`, which imports `@consola/factory-spec`.
  No other layer imports either, and no test does.
- Test files (`*.test.ts`) are exempt from the layer rules (the never-import
  list still applies), because they wire real pieces together the way the
  entry does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the browser globals the layers refuse. Only a reference
counts, directly or through `window`, never a property or a prop that shares
the name (`props.location`, `{ location: '/' }`). A file that sits in no layer
fails it too. The rules are data at its top (`LAYERS`), so a new layer or
folder is added there first, and a workspace package a layer may import all
the same is in that layer's `allows`.

## The API's contract

`src/domain/apiContract.ts` is `cloud-global`'s API as types, generated from
its `openapi.json`, which the app reads as a file and never imports
(`pnpm --filter @consola/cloud-web api:generate`; `apiContract.test.ts` fails
while it is stale). It is types only, with no import and no I/O, so it sits in
`domain`; Biome leaves it alone, since it is compared byte for byte.

- **A type the API answers in comes from the contract**, never written by
  hand: `Me`, `MyWorkspace`. Services call the API through `createApi`, so a
  path, a body or a status the API does not have fails the typecheck.
- **The page's own copies are checked against it.** `REGIONS`, the problems
  and `ROLE_NAMES` must hold exactly what the contract does
  (`workspace.test.ts`'s type checks, `satisfies`): a region, a role or a
  problem the API gains fails the typecheck until the page names it.
- **The types do not check what arrives.** An answer from something that is
  not the API (a proxy's error page) or from a newer API is still read
  defensively, so a service keeps its checks of the status and the body's
  shape.

The regional cell has a contract of its own: `src/domain/cellApiContract.ts`
holds its types, generated the same way from `apps/cloud-region/openapi.json`
(`cellApiContract.test.ts`). `api:generate` rewrites both. Every region's cell
runs the same code, so one contract serves them all.

CI checks this app with every change to `cloud-global` or `cloud-region`
(`.github/scripts/ci-scope.mjs`), since the package graph cannot see a file
read across apps.

## Teams

Settings → Teams (`#/settings/teams`, an entry of `SETTINGS_PAGES` after
Connections: `ui/TeamsPage.tsx`, a card per team in `ui/TeamCard.tsx`) shows
the workspace's teams, which live in its regional cell
(`apps/cloud-region/AGENTS.md`, "Teams"). The cell is the authority on every
rule; `domain/teams.ts` keeps a copy of the name rule (`checkTeamName`) to
check a name before sending it, and `domain/teamMessages.ts` says every
answer. The page is built from Settings' shared classes (the title,
descriptions, `.settings-button`, `.settings-chip`) and its own, all `teams-*`
in `ui/TeamsPage.css`.

- **A team's menus open inside Settings' dialog** (`useSettingsMenuHost`;
  see "Settings"), or they would take no click.

- **The page reaches a cell through its own origin**: `/cell/<region>/…`,
  which the dev server proxies to that region's cell (`vite.config.ts`, from
  `CELL_URL_EU` and `CELL_URL_US`, defaulting to 3101 and 3102). So the cell
  needs no CORS, and the page holds no cell address.
- **Every call to a cell carries a cell token**, as `Authorization: Bearer`,
  never a cookie. `services/cell.ts` mints it from `cloud-global`
  (`POST /api/cell-token`), keeps it until 30 seconds before it expires, and
  mints it again once when the cell refuses it (401). Calls made at once
  share one mint, and the page's services of the cell (teams, factories)
  share one token (`pageCellSession`). The answer names the
  token's workspace and region: a token for another workspace than the page
  shows (another tab switched the session's) is never sent (`switched`), and
  the region picks the cell.
- **A team names its members by global id.** Their names come from
  `cloud-global` (`GET /api/me/workspace/members`), loaded beside the teams;
  an id it no longer lists shows as someone who left (`memberOf`).
- **Controls follow the cell's answer**: `canManage` shows New team, the ⋯
  menu (Rename, and Delete for any team but the first), Add member and each
  member's ×. A member sees the teams they are in and no control.
- **Every change loads the teams again** (`onChanged`), so the page shows what
  the cell holds, whoever else changed it. A change refused because the team
  is gone, the person may no longer manage teams, or someone left the
  workspace reloads too, and says why.
- **States the cell answers**: `pending` (the cell does not hold the workspace
  yet: `cloud-global`'s outbox has not delivered it, so check `CELL_URL_EU` and
  that the cell runs), `unavailable` (the cell or `cloud-global` does not
  answer), `switched` and `signed-out`, each with its sentence and, where it
  can help, Try again.

The section needs the workspace's cell running (`pnpm dev:cloud-region`) and
`cloud-global` delivering its outbox there (`CELL_URL_EU` in its `.env`).

## Factories

The workspace's factories live in its regional cell with their files
(`apps/cloud-region/AGENTS.md`, "Factories"), and the dashboard reaches them
as Teams does (above: the token, `/cell/<region>`, the states a cell
answers). They are no section: the sidebar lists them in a group of their
own, each with its pages under it, as Warp lists its factories, drawn as the
desktop app draws its sidebar.

- **Read once, for the sidebar and the page alike.** `useFactories`
  (`Dashboard`) reads `GET /api/factories` and `GET /api/teams` together, so
  the sidebar's names and the factory page open always agree, and reads them
  again after any create, rename or move.
- **The cell decides who sees which factory**: owners and admins every
  factory, a member the factories of the teams they are in. The page shows
  the list exactly as it comes and never filters it; nothing on the page
  reads the person's role.
- **The teams beside it are the cell's list for the person.** They name
  each factory's team, and they are the only teams offered to own one, when
  it is made and when it moves: exactly the teams the cell lets the person
  make a factory for, or move one to. A team the list does not hold (read
  between a change and the next load) is "Another team", never an id.
- **The sidebar's group** (`FactoriesNav`): the heading Factories, with +
  for New factory; under it every factory, a row of its tile (its initial on
  a square its id colours, `factoryHue`, so it keeps it when renamed), its
  name and a chevron. The row opens the factory's first page and unfolds it;
  the chevron folds or unfolds any factory, the open one included, labelled
  "Show/Hide <name>'s sections". Arriving at a factory (its row, a link, the
  address) unfolds it; folded, the factory open marks its own row. Which
  factories are unfolded is kept per workspace in the browser's storage
  (`foldStore.ts`), read defensively and only a convenience. What could not
  be listed is one quiet line under the heading (loading, still being set
  up, the region not answering, another workspace open, signed out), with
  Try again where it helps; no factory is "No factories yet", with + still
  there.
- **A factory has two pages, and only those**, at
  `#/factories/<id>/<page>` (`factoryRouteOfHash`, `hashOfFactoryPage`):
  Factory definition and Settings (`FACTORY_PAGES`). A page comes with its
  own epic; never list one that does nothing. A factory with no page named,
  or one this build does not have, opens its definition. `#/factories` alone
  lands, in place of itself (`replaceHash`), on the first factory's
  definition, or Overview when there is none (`factoryLanding`).
- **A factory's page** (`FactoryView`) sets its tile and name over a row of
  its facts (its team, where its files come from), then the page. A factory
  the list no longer holds is gone, or now another team's, and the page says
  so.
- **Factory definition** (`FactoryDefinitionPage`, CON-74, CON-133) is where
  a factory's files are made and kept, in the browser, with no clone: files
  are added, renamed, removed and edited here, all a draft until Save. It
  stays at the level of files; forms over a file come later, on pages beside
  it. It takes the whole width beside the sidebar
  (`factoryLayout`) and loads only when it opens (`React.lazy`), since it
  carries the editor. A bar (the factory, "Version N, saved <when>", "by
  you" when it was the person, `savedWords`; what Save will do,
  `changeLine`; Add a template, Discard and Save), the banner until it is
  hidden for good in this browser, then the files beside the editor:
  - **The files** (`FactoryFileTree`) as the folder holds them
    (`fileGroups`): `factory.yml`, then `automations/`, `agents/` and
    `skills/`, which always show, empty or not, a skill's files under the
    skill. A filter by path (`/` puts the keyboard there) hides the folders
    with no match. A file the person changed has a dot, one the saved
    version lacks "new", one renamed "renamed" with its old path in the
    title; its own problems a red count. A file in a folder of its folder
    (`foreman/agent.md` under `agents`, an agent team's layout) sets that
    inner folder quieter, and it gives way first when the row is narrow. A
    factory with no files shows its empty folders, and offers New automation, New agent, `factory.yml` and
    Add a template where the editor would be.
  - **New by kind, never by path** (`factoryKinds.ts`). The + at the tree's
    top offers New automation, New agent, New skill, and `factory.yml` while
    there is none; each format folder's + makes its kind, a skill's + a file
    inside it. The person types a name in a field with the path's fixed
    parts around it (`agents/ [reviewer] .md`), checked as it is typed
    (`checkNaming`: the name rule, a path the draft holds or holds under
    Removed, an automation `factory.yml` defines as the latest check read
    it, a skill's file path as a factory path), with one sentence under it
    (`nameSentence`). Enter makes the file from its kind's skeleton, which
    passes the checker (an automation's is `on: manual`, so it never starts
    a run by itself), and opens it in front with the caret in its body. The
    name rule is a copy of factory-spec's, pinned by `factoryKinds.test.ts`
    through the checker, so the page's bundle never loads factory-spec
    early. Environments are not offered: a stored factory refuses them.
  - **Rename and delete** from each file's ⋯, also on a right-click, and F2
    and Delete on the row (`factory.yml` deletes only; a skill's `SKILL.md`
    neither, its skill's ⋯ acting on the folder). A rename keeps the file's
    text and its tab's place, and renaming it back leaves no change;
    renaming a skill moves its folder and its `SKILL.md`'s `name:`, nothing
    else (a reference elsewhere shows as a problem). A delete asks nothing:
    the file, or the whole skill as one entry, waits under "Removed on save"
    with the person's text, and Restore brings it back as it was (off, and
    saying why, while a file holds a path it would take).
  - **The editor** (`CodeEditor`, CodeMirror 6) shows the files open as tabs
    (`EditorTabs`, `factoryTabs.ts`; closing one keeps its edits), each file
    keeping its own undo history and place, which follow it when it is
    renamed (`pathMoves`); a change is always the shown file's, at the path
    it has now. YAML, and Markdown with YAML
    front matter (from `@lezer/markdown` itself: CodeMirror's Markdown
    package brings HTML, CSS and JavaScript along), shaded in the run page's
    colours; its look is an `EditorView.theme` on the app's tokens.
  - **Problems as the person types.** `factoryCheck.ts` runs factory-spec's
    `parseFactory` over the set as the cell reads it (`storedFactoryFiles`),
    shortly after typing stops. A set holding an agent team (`hasAgentTeam`)
    is checked as the cell's `checkFactoryFiles` checks it, a rule kept in
    step by hand: the team's trees (`agents/<n>/…`, `automations/<n>/…`) are
    left out of that parse, and `parseAgentTeam`'s issues, each on its file,
    join the problems. It is loaded with `import()` once the page
    opens: it carries YAML and zod. factory-spec is built as CommonJS, so
    `vite.config.ts` has the dev server pre-bundle it and the build convert
    it (`COMMONJS_LINKED`). A problem shows in the panel under the
    editor (`ProblemsPanel`), as a wavy line and a red line number, and in
    the counts; one that only shows another file's (`cause`) is quieter and
    counted at its cause. A problem opens its file at its line and lights
    the line once. Save stays off while any problem of the files' own
    stands; ⌘S then lights the panel's head and says why.
  - **Save** sends every file as the next version, from the version they
    were read from (`POST /api/factories/{factoryId}/versions`), adds,
    renames and removals being only a different set: no service, cell or
    contract knows of them. The cell checks again and is the authority:
    what it finds that the page did not (its limits on the set) shows in the
    same panel, "nothing was saved". Someone else's save in between
    (`version_moved`, or a newer version the sidebar's list read) is said in
    a strip with "Bring in version N" (`broughtIn`), by one rule: what the
    person did stands, and every file where it meets a change of theirs is
    named. A file they did not touch takes the newer version (added and
    removed files included); one both changed keeps the person's text; one
    the person removed stays removed; one they only renamed takes the newer
    text at its new name; a skill's folder renamed or removed takes the
    newer version's files inside it along. What the person does while a
    save is on its way is kept (`afterSave`), and what it removed leaves
    "Removed on save". Discard returns to the saved version: new files go,
    removed ones come back, renames are undone.
  - **Add a template**, in the bar (and in a factory with no files), reads
    `GET /api/factory-templates` as it opens and lists each template (the
    code review team, an agent team) with Add, which merges its files into
    the draft (`withFiles`): a file at the same path takes the template's
    text, a path the draft lacks is a new file, and one the person removed
    stays under "Removed on save". A strip says how many were added,
    replaced and left alone (`templateAddedLine`). Nothing is saved until
    Save; Discard drops them with every other change.
  - **Unsaved edits** stay in the page's memory per workspace and factory
    while the person moves around the dashboard (`factoryDrafts.ts`), with a
    dot on the sidebar's Factory definition row; closing or reloading the tab
    asks first. Nothing is written to storage. Discard asks first, in place.
  - **Moments, once each**: Save turns green and its check draws itself as
    the version number rolls over; the last problem fixed draws a green
    check in the panel's head. None plays under `prefers-reduced-motion`.
- **Settings** (`FactorySettingsPage`): Name, renamed in place; Team, moved
  to another of the person's teams by Move, which asks first, in place,
  since it changes who sees the factory; and Files, the source shown and not
  changeable yet (`SourceChoice`). Whoever sees a factory may rename and move
  it, so there is no `canManage` to read; each sends
  `PATCH /api/factories/{factoryId}` with its one field. There is no delete.
- **New factory** is a dialog over the dashboard (`NewFactoryDialog`, a
  native modal `<dialog>` drawn as the desktop's dialogs): a name
  (`checkFactoryName`, the cell's rule), the team that owns it (chosen for
  the person when they are in one only) and where its files come from:
  stored by Consola, with a GitHub repository shown as coming later and never
  chosen. Every problem is said under its field (`messagesForFactoryChange`).
  Someone the cell lists in no team is told to ask an owner or admin to add
  them to one. Once made, it closes, the list is read again, and the new
  factory's definition opens.

## Runs

The Runs section (`#/runs`, `ui/RunsSection.tsx`, a `wide` entry of
`SECTIONS` after Overview) shows the workspace's runs, which live in its
regional cell (`apps/cloud-region/AGENTS.md`, "Runs"), through `runsService`
(`services/runs.ts`) on the page's cell session (`pageCellSession`), as Teams and
Factories are. The cell decides
everything: which runs a person sees (a member, those of their teams'
factories), each run's phase (a request rolls up to `needs-you` while one of
its automations does), the chips' counts and what the menus offer
(`facets`). The page never derives a phase. A request is a run whose step is
the factory's orchestrator; the automations it starts are its children.

- **The address holds the place.** The list is `#/runs`, its filters after
  `?` (`runFilters.ts`: `filtersOfQuery`, `queryOfFilters`, one order for one
  set, `background=1` for the three background triggers, an unknown value
  dropped); a run is `#/runs/<id>` (`runsRoute.ts`), and where on its page
  after `?`: the view (`view=file` for an automation run's file,
  `view=automations` for a request's automations; none is the page's first,
  its steps or its conversation), the step chosen (`step=<id>`) and the
  automation opened (`run=<id>`, `placeOfQuery`). A run opens as a new history entry
  (its row is a link); a filter, a view or a step chosen replaces the entry
  (`showRunsFilters`, `showRunPlace`, which tell their listeners, since
  `replaceState` fires no `hashchange`). The run's page leads back to the
  list as the section last showed it.
- **Filters**: the factory picker (every factory, a team's, or one, under
  their teams: `factoriesByTeam`), My runs, a chip per phase with the cell's
  count (Running, Complete, Failed, Blocked for `needs-you`, Cancelled for
  `stopped`; several at once are any of them), Background runs, the Filter
  menu (an automation, how runs were started) and search, which the list
  follows once typing settles (`/` puts the keyboard there). My runs and
  Background runs exclude each other; an automation is sent with its factory,
  since the cell matches its name in every factory otherwise.
- **The list reads itself again** (`usePoll`): every 5 s while a run shown,
  the opened requests' automations included, can change, every 30 s once none
  can, never while the tab is hidden (`pageVisibility.ts`), and at once when
  it shows again. One read at a time; a new filter starts again, and a read
  for the old one is never shown. A refresh asks for the newest runs, as many
  as are shown (`refreshLimit`, up to 100), and `mergeRefresh` lays them over
  the rows, keeping any pushed past its end, so Load more goes on after them.
  A refresh that fails keeps the rows and says when they were read.
- **A row** is Warp's: the status (a request's with a badge counting the
  automations it started, coloured by the one most worth a look), the title,
  the item and factory as tags, who started it (a member's picture, someone
  who left, or a schedule, event or poll's mark: `starterOf`) and when. A
  request's chevron opens its automations under it, read from its run's
  answer and again with the list while they can change.
- **A run's page** is the desktop's session: its header ("Runs / request /
  name", the name in the accent, a status chip, the item's link and the info
  panel's toggle), the main pane, and the info panel (`ui/InfoPanel.tsx`, the
  desktop's sections, rows and folds, redrawn; `ui/RunInfoPanel.tsx`). A
  request's sections are Request, Automations (each live; a row opens that
  automation in the request's Automations tab, scrolled to, and a
  modifier-click its own page) and Budget; an automation run's is Run,
  linking its request. It
  reads the run again every 3 s while it or an automation it started works,
  every 15 s while it waits on someone, and not at all once nothing can change.
  Whether the panel shows and which sections are folded are kept in this
  browser (`runPagePrefs.ts`).
- **An automation run's steps are the desktop's trace** (`ui/StepTrace.tsx`,
  its words in `domain/stepTrace.ts`, after the desktop's `StepsRunView`,
  `StepDetailView` and `stepDetail.ts`): the steps in the file's order, each a
  row of its status, id, kind, a line of what it did (`stepSummary`: what it
  set or wrote, what it printed, its error, why it did not run, a running
  command's last line) and its time and facts (`rowFacts`), opening in place.
  A step that failed, runs or waits opens by itself and stays open; the
  person's choice wins, and Expand all and Collapse all set every step. Open,
  a step shows what it was asked (the prompt or action, or the command and its
  env, as written in the factory version the run executed, and the file it is
  in), what it is doing or did (turns against the cap, model, denied tools,
  the attempts line; a command's result and the end of its output, kept
  scrolled to its end while the person has not scrolled up) and what it
  produced (the error, outputs, artifacts by name and size). A failed run's
  note says where it broke, and the step's name opens it, scrolls to it and
  lights it once. What a command printed is cleaned of the terminal's codes
  (`cleanOutput`: every escape sequence, every control character but a
  newline and a tab, and the characters that reorder text; a carriage return
  redraws its line). Nothing opens a session or an artifact's content yet,
  and an agent step says its conversation comes later.
- **The file behind a run** (`ui/RunFileView.tsx`, the design mock's File
  view, with no lines drawn between steps): when the cell holds it
  (`RunDetail.source`), Steps and File are a tablist at the trace's head.
  File shows the automation's file at the version the run executed, shaded
  (`yamlTokens`), numbered, with its path, `v<n> · latest` or `latest is
  v<m>`, and Copy; in a `factory.yml` that holds others, the automation's own
  lines are whole and the rest quieter. The steps it holds are named above
  it, the keyboard's way to them. The chosen step's lines are lit; a click on
  a step's lines chooses it and offers Show in steps; an open step offers
  "View in file · lines a–b", which shows and lights its lines once. An
  address naming a step arrives at it once, in either view.
- **Definition** (the info panel, after Run, only for a run with a `source`):
  the file (a link to File), the version against the latest, the trigger,
  the mode and what it applies to (`runFile.ts`).
- **Approving a run** (`ui/ApprovalCard.tsx`, at the top of either pane while
  `RunDetail.approval` is set): the cell's reason, what approving lets run
  (each command, each agent with its prompt's first line; a request has
  none), and "Anyone on <team> can approve this." Anyone on the factory's
  owning team (the cell's `mayAnswer`) gets Approve and Dismiss, which asks
  once, in place; everyone else reads the card alone. `approveRun` sends
  `POST /api/runs/{runId}/approval` for the version asked about; the cell
  records the first answer for that version and the run's runner acts on
  it, so the card becomes a one-line receipt ("Approved by you · 2m ago. It
  starts when its runner picks it up.") and the page reads the run again.
  Every refusal (not on the team, the run gone, not waiting, answered first,
  the version moved, the cell's own states) has its own sentence
  (`messageForApproveAnswer`) and reads the run again. This is the one thing
  on the pages that writes.
- **A request's pane is two tabs** (`RequestPane`, under the approval card):
  Conversation, first and shown unless the address says otherwise, and
  Automations with their count. Choosing one, or opening an automation,
  replaces the address's entry (`showRunPlace`).
- **A request's conversation is its cloud session's, once it has one.** An
  agent run is a request whose `conversation` names its session (see
  "Sessions", "Agent runs"): its Conversation tab holds that session as the
  session's page does (`useCloudSession` and `SessionConversation`, shared by
  both), the chat, `AgentChat` (`@consola/agent-ui`), in a frame of its own
  while the session runs (`.run-session[data-running]`), the chat holding the
  request as its first message, and the runner's report of the agents it
  dispatched above it; once the session has ended, the request as it was
  sent, the session's words and that report. A request no person started
  says who handed it over by its trigger ("Event"). Any other request
  (`conversation === null`) shows the request as the person gave it and says
  what will join it. An open question's words are not in the cell, so the
  page says when it was asked and its deadline.
- **The automations a request started** (`ui/RequestAutomations.tsx`, the
  Automations tab): `RunDetail.children` in the order the orchestrator
  started them, numbered so, each a row of its status, its automation, where
  it is (`childStateWords`: the step it is on, what it waits for, or how it
  ended) and when it started, how long it worked and what it cost
  (`childFactsWords`), live with the page's reads. A row opens in place onto
  that run's own step trace (`StepTrace`, its Steps and File its own, never
  the address's), read from `GET /api/runs/{id}` as it opens and again while
  it can change, with "Open run" to its page; one that waits for approval
  says to answer it there. An automation that failed, works or waits opens
  by itself; the person's choice wins. The info panel's rows and an address
  naming one open it, scroll to it and light it once (`reveal.ts`). No line
  is drawn from one automation to another: no flow graph, by decision.
- **Text a run carries is untrusted** (a request may be a pasted ticket): it
  is shown as text, never markup, and an item's address is a link only on
  `https:` (`safeItemUrl`), which the cell also holds it to.
- **Type is the scale's** (`--font-size-xs` to `--font-size-xl`, the weights
  and line heights in `styles.css`), never pixels: 14px for titles, names,
  fields, buttons and chips, 12px for what supports them (meta lines, the
  info panel's rows), 11px only for tags, the steps' model and a status's
  count badge.
- **States** are the cell's, as Teams has them (`messageForCellRefusal`),
  with `invalid` (filters the cell could not read: Clear filters) and a run
  not found (none, or one of another team's factories: the cell says the
  same of both). An empty list says what fills it; one empty for its filters
  offers to clear them.

The section needs the workspace's cell running (`pnpm dev:cloud-region`);
`pnpm --filter @consola/cloud-region db:seed` writes demo runs into a local
cell's database.

## Sessions

The Sessions section (`#/sessions`, `ui/SessionsSection.tsx`, a `wide` entry
of `SECTIONS` after Runs) shows the person's own cloud sessions: each a
sandbox the workspace's runner runs, with an agent CLI working in one of the
runner's repositories (`apps/cloud-region/AGENTS.md`, "Cloud sessions"). It
reaches the cell through `cloudSessionsService` (`services/cloudSessions.ts`)
on the page's cell session, as Runs does, and the cell decides everything: the
list holds a person's own sessions, every member opens an agent run's by its
id, and every status is the cell's.

- **The address holds the place** (`sessionsRoute.ts`): the list is
  `#/sessions`, the form `#/sessions/new`, a session `#/sessions/<id>` (the
  cell's UUID, never `new`). A session started takes the form's entry in the
  history (`replaceHash`), so back leads to the list.
- **The list** (`SessionsList`), newest first as the cell answers: each row
  its status (a dot, hollow while it starts, the accent while it runs, quiet
  once stopped, red once failed, and its word), its name (`sessionLabel`: the
  title, or "Session" and the id's first eight characters), its repository and
  harness as tags, and when it started. It reads again as often as its
  liveliest session asks (`listPollIntervalMs`), every 30 s once none can
  change, never while the tab is hidden; a refresh that fails while the cell
  or `cloud-global` is out keeps the rows.
- **New session** (`NewSessionPage`): a repository and a harness, each from
  what the runner offers (`GET /api/cloud-sessions/options`; a harness this
  build cannot name is left out), and `START_NOTE` above Start, since a
  session runs the repository's own settings and hooks. With no runner
  connected (`no_runner`), its sentence stands in the form's place, as it does
  when a start comes back with it. A repository or harness the runner does not
  offer, or a body the cell could not read, is said under the form.
- **A session** (`SessionPage`): the run page's header (Sessions / name, a
  status chip, and Stop while it starts or runs, which asks first, in place),
  a line of its facts, then what `sessionScreen` says. Starting: its words,
  read again every 2 s. Running: the chat under the warning that changes not
  pushed to a branch are lost, read again every 10 s. Stopped or failed: the
  words, with no chat and so no composer, and no more reads. A failure says
  the runner's message as it came, or the sentence for the cell's code
  (`runner_restarted`, `runner_unreachable`, `runner_failed`, and an agent
  run's four: see "Agent runs"), never a code.
- **The chat** (`ui/SessionChat.tsx`) is `AgentChat` with its stylesheet,
  which styles nothing outside it (`packages/agent-ui/AGENTS.md`). It fills
  `.session-chat-frame`, the rest of the window under the warning, and scrolls
  its conversation inside it; it shows no header of its own, since the page's
  names the session. agent-ui's `AgentChat.layout.browser.test.tsx` mounts it
  in this page's elements and CSS (`ui/Sessions.css` too). It is most
  of the app's weight, so `SessionPage` loads it only for a running session
  (`React.lazy`), and a chunk that cannot load says so in its place. The page
  asks the cell for a pass (`POST /api/cloud-sessions/{sessionId}/pass`) once
  it reads the session running, and the chat connects straight to the host
  the pass names (an `http(s)` origin, or the pass is not used). Its
  `onPassExpired` asks the cell again only while the session runs
  (`shouldRenewPass`); a 404 rejects it, and the page reads the session at once.
- **A session that ends while its page is open**: the read that finds it
  stopped or failed unmounts the chat (`chatMounted`), which drops its
  connection and its pass; no pass is asked for again, and nothing reconnects.
- **A read that fails keeps the page only for a while** (`keepsShownOn`):
  while the cell or `cloud-global` is out (`unavailable`, `pending`) the list
  and a session stay as last read, saying when. Signed out, with another
  workspace open, or with the session gone, the page says so instead, and a
  running chat unmounts: nobody goes on using a session the page can no
  longer vouch for. Runs keeps its read-only page through all of these; a
  session's page holds a chat with an agent that has a shell.
- **States** are the cell's (`messageForCellRefusal`), with a session not found
  (none, or another person's: the cell says the same of both) and `no_runner`.

### Agent runs

An agent run is a cloud session an automation of a factory's agent team
started on a pull request (`origin` set), which nobody types into: its first
agent (the foreman) dispatches others and posts on the pull request. Every
member opens and may stop one.

- **It is in Runs, not in Sessions.** The cell lists each agent run as a run,
  a request whose `conversation` is its session
  (`apps/cloud-region/AGENTS.md`, "Agent runs"), so it shows in the Runs list
  with every other run, and its run's Conversation tab holds the session (see
  "Runs"). The Sessions list never holds one.
- **Its session** is shown as a person's is (`useCloudSession`,
  `SessionConversation`): `AgentRunReport` shows the runner's last report,
  the foreman's result (`agentRun.summary`, as text with its line breaks
  kept: no Markdown renderer) and each dispatched agent, folded, opening on
  its report. While it runs that sits above the chat (at most two fifths of
  its frame) and it is read every 5 s (`sessionPollIntervalMs`); once ended
  it stays, alone. Opened by its own address (`#/sessions/<id>`), its session
  page also says what it is (the automation in its factory, linking the
  factory's definition; the pull request; the head commit's first seven
  characters) and its phase beside its status.
- The service reads `origin` strictly (the page links what it names) and the
  report leniently: one it cannot read is none, and the session still shows.
- **The chat's notices ship with the build.** Vite bundles agent-ui's built
  `dist/` (`turbo` builds it before any of this app's tasks, `dev` included),
  and `vite.config.ts` writes its `THIRD-PARTY-NOTICES` and `LICENSE` to
  `agent-ui/` in this app's `dist/`, as that package asks of an embedder.

The section needs the workspace's cell running with a runner connected
(`pnpm dev:cloud-region`, and `apps/cloud-region/AGENTS.md`, "The runner's
socket").

## Workspaces

The API is `cloud-global`'s (its `AGENTS.md`, "Workspaces"), and it is the
authority on every rule. The web app imports none of its code, so
`workspace.ts` keeps its own copy of the name, slug and region rules: to
check a request before sending it and to suggest a slug. Whatever the server
answers is what the page shows, so a copy that drifts costs a round trip,
never a wrong workspace. Keep both in step: the contract's types catch a
region or a problem out of step, but not a rule such as a length.

- Only a 401 means signed out. A failed fetch, a status or error code a call
  does not expect, or a body that is not JSON is `unavailable`, so a service
  that is down never looks like a signed-out person.
- After a create or a switch the page loads `/api/me` and `/api/workspaces`
  again (`App.tsx`'s `load`); no reload. Only the latest load's answer is
  shown.
- A person with no workspace open sees the create form under their profile.
  One with a workspace reaches the switcher, and the form, from the sidebar.
- No region is picked for the person: it can never change, and the form says
  so (`REGION_HINT`). The slug follows the name until the person types their
  own.

## The dashboard

A person with a workspace open sees its dashboard, which has the whole window
(`.shell`): a sidebar, laid out as the desktop app's, beside the page open.
At its top is the workspace's menu, as the desktop's (`Layout/WorkspaceMenu`):
its trigger is the workspace's icon and name, and it opens on who the
workspace is, Workspace settings… (Settings' General page), the person's
workspaces to switch to and Create workspace…. Under it, the nav: the
workspace's sections (Overview), the Factories group (see "Factories") and
Settings at its foot; then the person's account, which signs them out. On a
narrow screen the sidebar becomes a bar above the page, its nav a list that
scrolls in a third of the screen. Sign-in, the
create form and the notices stay in the narrow column (`.page`, `.main`),
under a topbar of their own.

- **One list of sections.** `ui/sections.tsx` holds `SECTIONS`, in the nav's
  order. A section is `{ id, label, icon, View }` (the icon from the
  desktop's set, `lucide-react`), with `layout: 'wide'` for a page that
  takes the whole space beside the sidebar and lays itself out (Runs,
  Sessions, and a factory's definition, `factoryLayout`), where any other
  sits in the 880px reading column; its `View`
  gets `SectionProps`: the person (`Me`), the workspace open (never null)
  and `onWorkspaceChanged`, which a page calls once it has changed the
  workspace, so the page loads again and the sidebar and the menu catch up.
  A new
  page is one entry there and files of its own; nothing else in the shell
  changes. The first entry, Overview, is what an address naming no section
  opens.
- **The address picks the page.** A section is `#/<id>` (`hashOfSection`),
  and a factory's page `#/factories/<id>/<page>`, so a reload, a shared link
  and the browser's back and forward land where they point. The nav is plain
  links, and `Dashboard` follows the hash (`onHashChange`). An id never
  changes once a link may hold it: cloud-global sends a person back to
  `#/settings/connections`. Whatever follows an id in the hash (`/…` or
  `?…`) is the section's own, and an id this build does not list opens the
  first section (`chooseSection`).
- **The query string is not the dashboard's.** `address.ts` reads and writes
  the hash only. A page sent back with a result before the hash (sign-in's
  `?error=`, GitHub's `?github=`) reads and clears it in its own service, with
  `history.replaceState` of `pathname + search + hash`, which keeps the
  section.
- **Every member sees every section.** What a person may do on a page is the
  page's to show or hide, and the server says: an answer carries whether the
  person may manage what it lists (`canManage`), and a page shows its controls
  by that, never by reading the role itself.
- **A section starts again for another workspace.** `Dashboard` keys the open
  section by workspace and section, so a switch never shows what a page
  loaded for the last workspace.
- **A workspace wears an icon** (`WorkspaceIcon`): one of the desktop's
  symbols or emoji (`MyWorkspace.icon`), or, with none, its initial on a
  tile, drawn as the desktop draws it. It is changed in Settings → General,
  and shown in the sidebar, the menu and the Overview.
- **The Overview** sets the workspace's icon and name over a monospace row of
  its facts, its slug copying itself (`CopySlug`, through `copyText`, saying
  so when the browser refuses); then its region on a map of dots
  (`RegionMap`, from the hand-editable mask in `ui/worldDots.ts`), the
  region's own lit in the accent; then the person, with their role.
- **The sidebar is the desktop's** (`Sidebar/styles.css`), measure for
  measure, in `.sidebar`'s own variables: rows 28px tall (`.nav-row`), the
  rows you start from 30px (`.nav-row-front`, as the desktop's Automations
  row), 4px by 8px inside, 13px text (14px and medium for Overview), group
  headings 11px medium in the secondary colour with 20px icon buttons
  (`.sidebar-group-*`), 14px icons in the secondary colour, 3px corners
  (Settings' 6px, as the desktop's settings button), the hover fill at 10%
  and the open row's at 15%, focus drawn 1px inside the row, and the fold a
  12px chevron that turns 90° in 200ms. A factory's pages sit under its name,
  past its 18px tile, with the desktop tree's line down the tile's middle.
  Nothing slides between rows: the open row is told by its fill alone.
- **Styles are the desktop app's.** `styles.css` declares its tokens on
  `:root` for both schemes, with the desktop themes' own values (`--bg`
  #050505, `--bg-sidebar` #111111, `--bg-pop` #1e1e1e for menus, `--hover`
  and `--active` at 10% and 15%, `--text` at 90/60/40%, `--line`, `--cyan`,
  and the status colours `--success`, `--warning` and `--danger`, yellow
  only for what waits on a person),
  and points Radix's surfaces and fonts at them, so its menus and Settings
  match. Its type is the desktop's scale (`styles/themes/tokens.css`), by
  the same names (`--font-size-xs` to `--font-size-xl`, the weights and
  line heights), and every stylesheet sizes text by them, never in pixels:
  14px (`md`) for what a page says and for every field, button and menu
  (Radix's root and menus included), 12px (`sm`) for what supports it, 16px
  or 18px for a page's title, and 11px (`xs`) only for the sidebar's
  uppercase group labels and the smallest metadata (a monospace fact row, a
  chip, the footer). Nothing is smaller. The sidebar's rows, and Settings'
  list of pages, run at the desktop sidebar's 13px (`--sidebar-font-size`).
  The one size outside the scale is the Overview's region code, 24px. Its
  shapes too: 3px rows, 6px controls, 12px groups drawn as
  Connections draws them (`.group`, `.group-label`, `.group-box`). A
  sidebar icon is never coloured, the open row's included: it is marked by
  `--active` alone. A factory's tile is the one colour in the sidebar, as
  its initial's square (`.factory-tile`). Type is Geist for the interface
  and JetBrains Mono (the desktop's) for what a person would type, both
  bundled (`@fontsource-variable/*`), so every system shows the same type.
  The shell's classes (`.shell`, `.sidebar`, `.nav-row`, `.sidebar-group`,
  `.factory-row`, `.switcher-trigger`, `.workspace-menu`) sit beside the
  shared ones (`.card`, `.heading`, `.muted`, `.error`, `.button`, `.avatar`,
  `.workspace-icon`). A page's own styles go in a stylesheet beside it
  (`ui/OverviewPage.css`, `ui/FactoryView.css`, `ui/FactoryDefinition.css`,
  `ui/NewFactoryDialog.css`,
  `ui/SourceChoice.css`, `ui/GeneralPage.css`, `ui/ConnectionsPage.css`,
  `ui/TeamsPage.css`, `ui/RunsList.css`, `ui/RunFileView.css`,
  `ui/ApprovalCard.css`, `ui/RequestAutomations.css`, `ui/Sessions.css`),
  imported by the page.
- **Motion plays once, or answers the person.** The map's region ripples on as
  the page opens, a factory's chevron turns as it folds, a new icon pops
  into its tile, the slug's icon
  turns to a check when copied, and the sign-in card's C blinks a cursor when
  pointed at. A run's status moves only as the run does (its pie fills to
  where it is now, its check draws itself as it ends, a run that arrives
  washes in), and nothing loops: a run at work is a pie, not a spinner.
  None of it plays under `prefers-reduced-motion`.

## Settings

Settings looks and works as the desktop app's (its `Dialogs/SettingsModal.tsx`
and its styles): a dialog over the dashboard, with a list of its pages on the
left under a group that names the workspace ("Workspace · Acme"), each with
an icon from the same set (`lucide-react`), and the page beside it: a title,
then options, each a label and a description over its control
(`ui/SettingsDialog.tsx` and `SettingsDialog.css`, whose `.settings-section`,
`.settings-option`, `.settings-button` and `.settings-chip` every page uses).
Its layout and spacing are the desktop's, its type a step larger, on the
scale above (a page's title 16px, its labels and buttons 14px, its
descriptions 12px); colours are this app's Radix tokens.

- **It is no section.** The dashboard nav's last link opens it
  (`#/settings`), as does the workspace menu's Workspace settings…
  (`#/settings/general`, through `openSettingsPage`), and `Dashboard` shows
  it over the section that was open, or the first section when the address
  opened Settings directly (cloud-global's GitHub callback). Escape and its
  close button go back to that section. It is
  a native modal `<dialog>`, so the dashboard behind it is inert, and the
  keyboard starts on the open page's entry in the list.
- **The address picks the page.** A page is `#/settings/<id>`
  (`hashOfSettingsPage`, `settingsPageIdOfHash` in `domain/settings.ts`), and
  `#/settings` alone, or an id this build does not list, opens the first
  (`chooseSection`). `services/settingsAddress.ts` reads the hash only, as
  `address.ts` does. A page's id never changes once a link may hold it.
- **Its pages are one list,** `SETTINGS_PAGES` (`ui/settingsPages.tsx`):
  `{ id, label, icon, View }`, each shown with `SectionProps`. A new settings
  page (the workspace's details, its members, billing) is one entry there and
  files of its own. They are all the workspace's for now; a group of the
  person's own settings would sit above, as the desktop's App group does.
- **A Radix overlay inside a page renders into the dialog (`container`), or
  it is inert.** Radix puts a DropdownMenu's, Popover's, Select's or
  Tooltip's content at the end of the page's body, which the modal dialog
  makes inert: it shows, and takes no click. `useSettingsMenuHost()`
  (`SettingsDialog.tsx`) gives a page the dialog to hand as the content's
  `container`, from a `ref` on any element of the page (`TeamCard` uses it).
- On a narrow screen it fills the window and its list becomes a row above
  the page.

### General

Settings' first page (`ui/GeneralPage.tsx`, with its own `GeneralPage.css`,
at `#/settings/general`) is the workspace itself, as the desktop's General
page shows one (its `WorkspaceSettings/ManifestHeader.tsx`): its icon in a
tile beside its name, over a monospace row of its slug, region and the
person's role, then what cannot change. An owner or admin (the server's
`canManage`) changes the icon from the tile (`WorkspaceIconPicker`, the
desktop's picker: a search over Emojis and Icons, and Reset to default, which
takes the icon off). A pick is set at once (`setWorkspaceIcon`), then the page
loads again (`onWorkspaceChanged`); anyone else sees the tile and no picker,
and the server refuses them whatever the page shows. An uploaded image, which
the desktop also offers, is not offered: it would put a person's file in
`cloud-global`.

### Connections

Settings' Connections page (`ui/ConnectionsPage.tsx`, with its own
`ConnectionsPage.css`, at `#/settings/connections`) shows what the active
workspace is connected to: GitHub, and the services that come later
(`LATER_SERVICES`), listed as not connected. The API is `cloud-global`'s (its
`AGENTS.md`, "Connections"), and it decides everything: the page shows Connect
and Disconnect only when the server says `canManage`, and the server refuses
anyone else whatever the page shows.

- **Connect** asks the server for the install address and sends the person
  there (`goToGitHub`), only if it is on `https://github.com`. GitHub sends
  them back through `cloud-global`'s callback to
  `/?github=<result>#/settings/connections`, an address the two keep in step
  (`CONNECTIONS_PAGE` in `cloud-global`). The page reads the result once as it
  mounts (`takeGitHubResult`), clears it from the address and says it
  (`messageForGitHubResult`). A result it does not know is `unknown`, never
  shown raw.
- **Disconnect** asks first, in place, never with a browser dialog, and says
  that the app stays installed on GitHub. Each installation links to its
  settings there (`settingsUrl`).
- The repositories are GitHub's answer of the moment: an installation GitHub
  no longer has is `gone`, and one whose list GitHub did not give is
  `unavailable`. Both still show, so they can be disconnected. The page
  counts an installation's repositories and never lists them: their names
  are GitHub's to show, behind "Choose repositories".
- **Its look is Notion's and the like.** A connected service sits in the
  Connected group, a rounded list with each account indented under it; GitHub
  before anything is connected sits in Available with Connect; the services
  that come later are a grid of tiles. A service is known by its mark
  (`ui/serviceMarks.tsx`: each owner's trademark, shown only to name the
  service; GitHub's in the text colour), and an account by GitHub's picture of
  it (`avatarUrl`), round for a person and square-cornered for an
  organisation, with an icon under it if it never loads.
- A Connect that GitHub sends back as `connected` marks the account it added
  ("Just connected", `justConnectedId`): the newest installation, only if it
  is minutes old. An installation says when it was connected in words for the
  last few days (`connectedSentence`).
- Motion plays once, as a row arrives or an answer lands (a staggered rise,
  the success check drawing itself, the connected dot's ping), and none plays
  under `prefers-reduced-motion`. Escape inside Disconnect's question answers
  Keep instead of closing Settings.

## Adding a feature

1. A rule, a sentence or a type goes in `domain`.
2. A call to the API, to Better Auth or to the page's address goes in
   `services`, and answers in domain types. A call to the API goes through
   `createApi`'s client, never `fetch`. A route the API has just gained
   reaches the client once `pnpm --filter @consola/cloud-web api:generate`
   rewrites `domain/apiContract.ts`; a type it answers in is taken from
   there, never written by hand. Another API (a cell's, say) gets its own
   generated file and its own client the same way.
3. A new screen is a component in `ui`, mounted from `ui/App.tsx`; a new page
   of the workspace is a section (`ui/sections.tsx`, above). It calls the
   services it needs and passes what they return down as props. A React hook
   goes in `ui` too, beside the screen that uses it, because `services` refuse
   `react`.
4. Only `main.tsx` mounts the app. Nothing else does.

## Tests

A test sits beside its module and is named after it (`api.ts`, `api.test.ts`).
They run in Node, so no test touches a DOM: a service takes the API's client
as an argument (`loadMe(createApi({ fetch, baseUrl }))`, with an absolute
`baseUrl`, since Node has no page to resolve `/api` against), and
`signInRedirect.test.ts` stands in for `window` just for the test. Screens are
checked by running the app (`pnpm dev:cloud`).
