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
  failed switch and the create form's hints; and where the running source is
  (`source.ts`). It is plain TypeScript, with no package and no browser I/O.
  `apiContract.ts` holds the API's types, generated from
  `apps/cloud-global/openapi.json` (see "The API's contract").
- `src/services/` is everything that talks to something outside the page: the
  API (`api.ts`: `loadMe`, `loadWorkspaces`, `createWorkspace`,
  `switchWorkspace`, through `createApi`, an `openapi-fetch` client typed by
  the contract), Better Auth's client (`authClient.ts`: `signInWithGoogle`,
  `signOut`) and the address bar (`signInRedirect.ts`:
  `takeSignInErrorCode`). A service answers in domain types and sentences,
  never in a library's own.
- `src/ui/` holds the React screens (`App.tsx` and the cards beside it:
  `SignInCard`, `ProfileCard`, `CreateWorkspaceCard`, and the topbar's
  `WorkspaceSwitcher` and `SignOutButton`) and `styles.css`. A screen asks a
  service and shows what comes back. It does not fetch, touch the address or
  know Better Auth.
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

CI checks this app with every change to `cloud-global`
(`.github/scripts/ci-scope.mjs`), since the package graph cannot see a file
read across apps.

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

## Adding a feature

1. A rule, a sentence or a type goes in `domain`.
2. A call to the API, to Better Auth or to the page's address goes in
   `services`, and answers in domain types.
3. A new screen is a component in `ui`, mounted from `ui/App.tsx`. It calls
   the services it needs and passes what they return down as props. A React
   hook goes in `ui` too, beside the screen that uses it, because `services`
   refuse `react`.
4. Only `main.tsx` mounts the app. Nothing else does.

## Tests

A test sits beside its module and is named after it (`api.ts`, `api.test.ts`).
They run in Node, so no test touches a DOM: a service takes the API's client
as an argument (`loadMe(createApi({ fetch, baseUrl }))`, with an absolute
`baseUrl`, since Node has no page to resolve `/api` against), and
`signInRedirect.test.ts` stands in for `window` just for the test. Screens are checked by running the app
(`pnpm dev:cloud`).
