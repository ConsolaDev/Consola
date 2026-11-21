# AGENTS.md

This file guides coding agents working in `apps/cloud-web`, Consola Cloud's web
app. `CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The
repository's guide is the root `AGENTS.md`, and setup is in
`apps/cloud-api/README.md`. Paths below are relative to `apps/cloud-web`.

## The layers

The app is built in layers, and imports point inward only.

- `src/domain/` holds the rules and the types they speak of: `Me`, `MeState`
  and `Org` (`me.ts`), the sentences for a failed sign-in or sign-out
  (`messages.ts`) and where the running source is (`source.ts`). It is plain
  TypeScript, with no package and no browser I/O.
- `src/services/` is everything that talks to something outside the page: the
  API (`api.ts`: `loadMe`, `loadOrg`), Better Auth's client (`authClient.ts`:
  `signInWithGoogle`, `signOut`) and the address bar (`signInRedirect.ts`:
  `takeSignInErrorCode`). A service answers in domain types and sentences,
  never in a library's own.
- `src/ui/` holds the React screens (`App.tsx` and the cards beside it) and
  `styles.css`. A screen asks a service and shows what comes back. It does not
  fetch, touch the address or know Better Auth.
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
  service behind its own button (`SignInCard.tsx`, `SignOutButton.tsx`).
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
They run in Node, so no test touches a DOM: a service takes `fetch` as an
argument (`loadMe(fetchFn)`), and `signInRedirect.test.ts` stands in for
`window` just for the test. Screens are checked by running the app
(`pnpm dev:cloud`).
