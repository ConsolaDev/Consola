# AGENTS.md

This file guides coding agents working in `apps/cloud-web`, Consola Cloud's web
app. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `AGENTS.md`, and setup is in
`apps/cloud-global/README.md`. Paths below are relative to `apps/cloud-web`.

## The layers

The app is built in layers, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of: `Me` and
  `MeState` (`me.ts`); workspaces (`workspace.ts`: `MyWorkspace`, `REGIONS`
  and `regionName`, `roleName`, `checkNewWorkspace`, `suggestSlug`, the create
  form's `WorkspaceDraft` with `withName` and `withSlug`, and the API's
  answers `WorkspacesState`, `CreateWorkspaceAnswer` and
  `SwitchWorkspaceAnswer`); the sentences (`messages.ts`) for a failed
  sign-in or sign-out, for each problem with a new workspace, a taken slug, a
  failed switch and the create form's hints; where the running source is
  (`source.ts`); and how the address names a dashboard section
  (`sections.ts`: `sectionIdOfHash`, `hashOfSection`, `chooseSection`); and
  teams (`teams.ts`: `Team`, `WorkspaceMember`, `checkTeamName`, `memberOf`,
  `addableTo`, `TeamsState`, `TeamChange`; their sentences in
  `teamMessages.ts`). It is plain TypeScript, with no package and no browser
  I/O. `apiContract.ts` and `cellApiContract.ts` hold the APIs' types,
  generated from `apps/cloud-global/openapi.json` and
  `apps/cloud-region/openapi.json` (see "The API's contract").
- `src/services/` is everything that talks to something outside the page: the
  API (`api.ts`: `loadMe`, `loadWorkspaces`, `createWorkspace`,
  `switchWorkspace`, through `createApi`, an `openapi-fetch` client typed by
  the contract), the workspace's cell (`teams.ts`: `teamsService`, built by
  `createTeamsService` on `createCellApi`), Better Auth's client
  (`authClient.ts`: `signInWithGoogle`,
  `signOut`) and the address bar (`signInRedirect.ts`:
  `takeSignInErrorCode`; `address.ts`: `currentSectionId`, `openSection`,
  `onSectionChange`). A service answers in domain types and sentences, never
  in a library's own.
- `src/ui/` holds the React screens (`App.tsx` and the cards beside it:
  `SignInCard`, `ProfileCard`, `CreateWorkspaceCard`, and the topbar's
  `WorkspaceSwitcher` and `SignOutButton`), the dashboard (`Dashboard.tsx`,
  its list of sections `sections.tsx`, and each section's page:
  `OverviewPage.tsx`, and `TeamsPage.tsx` with `TeamCard.tsx` and
  `TeamNameForm.tsx`) and `styles.css`. A screen asks a service and shows
  what comes back. It does not fetch, touch the address or know Better Auth.
- The entry wires the page. `src/main.tsx` mounts `ui/App` inside Radix's
  `Theme` and follows the system's colour scheme, and `src/env.d.ts` declares
  the build constants (`__CONSOLA_COMMIT__`, `__CONSOLA_VERSION__`) that
  `vite.config.ts` defines.

## The dependency rule

- `domain` imports only `domain`. It imports no package and refers to no
  browser global: `window`, `document`, `fetch`, `history`, `location`,
  `localStorage`, `sessionStorage`, `navigator`, `XMLHttpRequest`,
  `WebSocket`, `globalThis` or `self`.
- `services` imports `domain` and `services`, and packages, but never `ui`,
  `react`, `react-dom`, `@radix-ui/*` or a `node:` builtin.
  `better-auth/react` is allowed there: it is Better Auth's client for the
  browser, and `authClient.ts` is the one file that uses it.
- `ui` imports `domain`, `services`, `ui`, `react` and `@radix-ui/themes`,
  never `better-auth`. It refers to no `fetch`, `history`, `location`,
  `localStorage`, `sessionStorage`, `XMLHttpRequest` or `WebSocket`, directly
  or through `window`. The build constants are compile-time values, not I/O,
  so `Footer.tsx` may read them.
- Services are called from `ui`. A screen calls the service behind what it
  shows or does: `App.tsx` loads the page's state, and a card calls the
  service behind its own button (`SignInCard.tsx`, `SignOutButton.tsx`,
  `CreateWorkspaceCard.tsx`, `WorkspaceSwitcher.tsx`).
  `domain` and `main.tsx` call none.
- No file imports another app or a workspace package (`@consola/*`).
- Test files (`*.test.ts`) are exempt from the layer rules (the never-import
  list still applies), because they wire real pieces together the way the
  entry does.

`src/boundary.test.ts` enforces the rule. It reads every file's imports from
the TypeScript syntax tree (`import`, `import type`, `export … from`, dynamic
`import()`), and the browser globals the layers refuse. Only a reference
counts, directly or through `window`, never a property or a prop that shares
the name (`props.location`, `{ location: '/' }`). A file that sits in no layer
fails it too. The rules are data at its top (`LAYERS`), so a new layer or
folder is added there first.

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

The Teams section (`ui/TeamsPage.tsx`, a card per team in `ui/TeamCard.tsx`)
shows the workspace's teams, which live in its regional cell
(`apps/cloud-region/AGENTS.md`, "Teams"). The cell is the authority on every
rule; `domain/teams.ts` keeps a copy of the name rule (`checkTeamName`) to
check a name before sending it, and `domain/teamMessages.ts` says every
answer.

- **The page reaches a cell through its own origin**: `/cell/<region>/…`,
  which the dev server proxies to that region's cell (`vite.config.ts`, from
  `CELL_URL_EU` and `CELL_URL_US`, defaulting to 3101 and 3102). So the cell
  needs no CORS, and the page holds no cell address.
- **Every call to a cell carries a cell token**, as `Authorization: Bearer`,
  never a cookie. `services/teams.ts` mints it from `cloud-global`
  (`POST /api/cell-token`), keeps it until 30 seconds before it expires, and
  mints it again once when the cell refuses it (401). The answer names the
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

## Workspaces

The API is `cloud-global`'s (its `AGENTS.md`, "Workspaces"), and it is the
authority on every rule. The web app imports no package, so `workspace.ts`
keeps its own copy of the name, slug and region rules: to check a request
before sending it and to suggest a slug. Whatever the server answers is what
the page shows, so a copy that drifts costs a round trip, never a wrong
workspace. Keep both in step: the contract's types catch a region or a
problem out of step, but not a rule such as a length.

- Only a 401 means signed out. A failed fetch, a status or error code a call
  does not expect, or a body that is not JSON is `unavailable`, so a service
  that is down never looks like a signed-out person.
- After a create or a switch the page loads `/api/me` and `/api/workspaces`
  again (`App.tsx`'s `load`); no reload. Only the latest load's answer is
  shown.
- A person with no workspace open sees the create form under their profile.
  One with a workspace reaches the switcher, and the form, from the topbar.
- No region is picked for the person: it can never change, and the form says
  so (`REGION_HINT`). The slug follows the name until the person types their
  own.

## The dashboard

A person with a workspace open sees its dashboard: the topbar (the switcher
and Sign out) across the page, then a nav of the workspace's sections beside
the one open. Sign-in, the create form and the notices stay in the narrow
column (`.main`; the dashboard widens it with `.main.wide`).

- **One list of sections.** `ui/sections.tsx` holds `SECTIONS`, in the nav's
  order. A section is `{ id, label, View }`, and its `View` gets
  `SectionProps`: the person (`Me`) and the workspace open, never null. A new
  page is one entry there and files of its own; nothing else in the shell
  changes. The first entry, Overview, is what an address naming no section
  opens.
- **The address picks the section.** A section is `#/<id>` (`hashOfSection`),
  so a reload, a shared link and the browser's back and forward land where
  they point. The nav is plain links, and `Dashboard` follows the hash
  (`onSectionChange`). An id never changes once a link may hold it: cloud-global
  sends a person back to `#/connections`. Whatever follows an id in the hash
  (`/…` or `?…`) is the section's own, and an id this build does not list
  opens the first section (`chooseSection`).
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
- **Styles.** `styles.css` holds the shell's classes (`.dashboard`,
  `.nav-link`, `.section-header`, `.section-title`, `.facts`) beside the shared
  ones (`.card`, `.heading`, `.muted`, `.error`, `.button`). A page's own
  styles go in a stylesheet beside it (`ui/TeamsPage.css`), imported by the
  page.

## Adding a feature

1. A rule, a sentence or a type goes in `domain`.
2. A call to the API, to Better Auth or to the page's address goes in
   `services`, and answers in domain types.
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
`signInRedirect.test.ts` stands in for `window` just for the test. Screens are checked by running the app
(`pnpm dev:cloud`).
