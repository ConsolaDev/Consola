# AGENTS.md

This file guides coding agents working in `packages/agent-ui` (`@consola/agent-ui`).
`CLAUDE.md` imports it with `@AGENTS.md`, so Claude Code reads it too. The repository's guide is
the root `CLAUDE.md`. Paths below are relative to `packages/agent-ui`.

The package is t3code's chat view, copied unchanged, behind one component:

```tsx
import { AgentChat } from '@consola/agent-ui';
import '@consola/agent-ui/styles.css';

<AgentChat hostUrl="http://127.0.0.1:7420" pass={pass} sessionId={sessionId}
  onPassExpired={async () => fetchNewPass()} />;
```

It connects to one `@consola/host` session (`packages/host`) and renders t3's chat for it.

## Copied code and Consola's code

- **`src/t3/` is t3's**, byte for byte from t3's `apps/web/src/` at the commit in
  `vendor/t3code/UPSTREAM.md`, at the same relative paths: everything `ChatView.tsx` imports, the
  i18n provider and runtime `AgentChat` mounts, their translations, `index.css` (t3's Tailwind
  entry and theme) and `vite-env.d.ts`. `src/gt.config.json` and `src/t3-root/` are t3 files that
  copied files import from outside `apps/web/src`. Never edit them; Biome does not lint them.
  "The chat view" in `UPSTREAM.md` lists every file and how the set was computed, and what was
  not copied (Apple's device models, which have no redistribution licence: `vite.config.ts`
  resolves their imports to an empty URL).
- **A file `AgentChat.tsx` imports from `~/` is part of the copy.** When it needs another t3
  module, copy that module and what it imports (the closure), record it in `UPSTREAM.md`, never
  stub it or write a Consola version. `~/` is t3's alias for `src/t3/` (`tsconfig.json` paths and
  the alias in `vite.config.ts`).
- **Consola's code** is the rest: `src/AgentChat.tsx`, `src/t3Document.ts`, `src/index.ts`,
  `src/styles.css`, `build/` (the CSS scope, the built-CSS check and the typecheck), the configs
  and the tests. Biome lints it.
- **Types.** `pnpm typecheck` (`build/typecheck.ts`) runs t3's checker (`effect-tsgo`) over the
  browser program (`tsconfig.json`, t3's web settings) and the Node one (`tsconfig.node.json`).
  Four errors in copied files are expected and listed there: callbacks typed by t3's router
  registration, which names t3's whole app. Any other error, or one of the four going away,
  fails it.

## The licence boundary

`@consola/agent-ui` is MIT, with t3's notice (`LICENSE`); `@consola/host` and the apps are
AGPL. So nothing the package ships imports `@consola/host` or a path under `apps/`:
`@consola/host` is a devDependency only, for the browser tests' replay host (`src/testing/`).
`src/boundary.test.ts` fails on any such import outside the tests and `src/testing/`, on an
import of `src/testing/` from anything but a test or `src/testing/` itself (it imports
`@consola/host`, so shipped code importing it would carry the host in), and on
`@consola/host` in any non-dev dependency field.

## How the connection is set up

t3's web app keeps its connection in a module-level runtime (`src/t3/connection/runtime.ts`)
whose environments come from its platform. `AgentChat` uses it as t3 uses it, through t3's own
pieces:

- **The build is t3's hosted static app** (`VITE_HOSTED_APP_CHANNEL` in `vite.config.ts`, t3's
  `hostedPairing.ts`): it discovers no environment at the page's origin, so its platform
  registers nothing.
- **The host is registered as a bearer backend**, as t3 registers a desktop's secondary backend
  (`connection/platform.ts`): `AgentChat` calls t3's `EnvironmentRegistry.reconcilePlatform`
  with a `BearerConnectionRegistration` whose credential is the pass. That call replaces every
  platform registration, so it is always handed the registrations of every mounted chat (one
  per session), and a chat that unmounts drops its own. t3 stores the pass in its IndexedDB
  catalog while the host is registered and deletes it when the registration is removed, which
  is what unmounting does (asynchronously). A window that closes or reloads without unmounting
  removes nothing; see "What t3 keeps in the browser" for how such passes are found.
- **t3's client does the rest**, unchanged: it reads the host's descriptor, asks for a socket
  ticket with the pass as bearer token, opens `ws(s)://<host>/ws?wsTicket=…`, and reads the
  session's scopes. The host answers those calls as t3's server does (`packages/host`'s
  `AGENTS.md`, "Before the socket"); the pass is the only credential. No t3 sign-in, pairing or
  environment picker is mounted.
- **The environment and the thread are the session**: both ids are `sessionId`.
- **Pass expiry.** A refused pass is t3's `401`, on which t3's connection stops (blocked,
  `authentication`). `AgentChat` watches the registry's state for that and calls
  `onPassExpired`, then registers the pass it answers, which reconnects. A pass the host refuses
  before t3 has tried it does not count (the state reported first can be the old pass's), and a
  pass `onPassExpired` answered that is refused before it ever connects is not asked about again.
- **What the chat says when it cannot show the conversation.** t3 shows a host that goes away
  under a loaded thread (its offline banner) and reconnects by itself. What t3 has no state for,
  `AgentChat` shows itself, as a notice over t3's view (`ChatProblemNotice`, `role="alert"`,
  styled in `styles.css` with t3's variables, so in Consola's tokens):
  - the host refused the pass and no new one is coming: no `onPassExpired`, or the pass it
    answered was refused too ("The host refused this chat's pass");
  - `onPassExpired` failed ("A new pass could not be fetched");
  - the connection could not be set up: a host address that is not a URL, t3's runtime not
    starting, t3 refusing the registration, or the environment not appearing in t3's registry
    within ten seconds (`REGISTRATION_WAIT`) ("The chat could not connect to its host").

  The notice goes once the host connects. Every failure of the chat's own is also logged
  (`console.error`, `@consola/agent-ui: …`), with the passes the page holds taken out of the
  detail: the page sees nothing else of it.
- **What else is mounted**: t3's `I18nProvider` (started once per page), its atom registry, and a
  memory router whose root route renders `ChatView` for the session, as t3's own tests render
  without routes. No route, sidebar, terminal drawer, in-app browser or PR view is mounted;
  their code is copied but idle.
- **What t3 keeps in the browser**, under the page's origin (Consola's windows share one):
  - IndexedDB `t3code:connection-runtime`: its catalog (each registered host's pass, under
    `consola-host:<session>`, and its profile) and its cache per environment (the thread and
    shell snapshots it shows before a connection is back, server config, queries).
  - `localStorage`: the person's unsent composer drafts (`t3code:composer-drafts:v1`, per
    thread), its client settings (`t3code:client-settings:v1`) and UI state (`t3code:ui-state:v1`,
    panel widths, …), the theme keys (`t3code:theme`, `t3code:theme-appearance-mode`, which
    `AgentChat` sets to the chat's light or dark, `t3code:theme-halves:v1`, `t3code:themes:v1`),
    and the analytics device id (`t3code:analytics-device-id`, a random id t3's platform
    creates when asked for one; this build names no relay or telemetry address,
    `vite.config.ts`).
  - Consola's own record of the sessions a page registered (`consola-agent-ui:session:<id>`, the
    id only; `src/storedSessions.ts`).

  What is removed, and when:
  - **On unmount**: t3 deletes the host's pass, its cached environment data and the data other
    modules keep for it (`removePlatformEnvironment`).
  - **At the first registration in a page**: the same, for every recorded session no page holds.
    A page holds each session it shows with a Web Lock, from before it registers it until t3 has
    removed it, and a lock goes with its page however the page ends; so this finds what a window
    that closed without unmounting left, and never touches what another open window shows
    (`AgentChat.storedSessions.browser.test.tsx`). Without Web Locks (an insecure context)
    nothing is removed this way.
  - **Never**: composer drafts, client settings and UI state, the theme keys, the analytics id
    and t3's favicon cache (`t3code:project-favicons`). They hold no credential. The pass never
    reaches `localStorage`, a URL or the history.

## How the styles are scoped

`src/styles.css` imports t3's `index.css` (Tailwind 4 and t3's theme). `vite.config.ts` compiles
it with `@tailwindcss/postcss`, then `build/scopeCss.ts` rewrites every selector of the result:

- t3's document selectors (`:root`, `:host`, `html`, `body`) name `.consola-agent-ui-theme`, the
  element inside the root that stands in for t3's document (theme variables, preflight's `html`
  and `body` rules, `@variant dark` blocks);
- every other selector applies only inside `.consola-agent-ui` (preflight's `*`, utilities,
  components), wrapped in `:where()` so t3's specificities are unchanged;
- t3's popups are Base UI portals at the end of `<body>`. `AgentChat` marks each with
  `.consola-agent-ui-portal` (and `dark`) while mounted, and the scope includes them. A page
  that uses Base UI itself would see its own portals marked too.

Nothing else on the page is styled; `AgentChat.browser.test.tsx` checks a paragraph beside the
chat keeps its font, margin, line height and colour.

**What is page-global.** A few at-rules have no selector to scope, so they apply to the whole
page. None styles anything by itself, and `build/checkBuiltCss.ts` fails the build's check on any
other kind:

- 17 `@keyframes` (Tailwind's `spin` and `pulse`, t3's `skeleton`, `status-pulse`,
  `live-tool-shine` and the rest; the check prints the list). A keyframe only runs where a rule
  names it. Harmless today: Consola's own `spin` (`GitReviewPanel`, `Views`) is the same full turn,
  and no Consola page names `pulse` or any of t3's. A page that defines one of these names
  differently gets whichever definition comes last.
- 105 `@property` registrations: Tailwind's `--tw-*` and t3's
  `--assistant-citation-highlight-opacity`. They give those custom properties a type and initial
  value page-wide, which matters only where something reads them; no Consola page does.
- `@font-face` for KaTeX's fonts (`KaTeX_Main`, …), used only by a rule naming them.
- The `@layer` names `properties, theme, base, clerk, components, utilities`. A page with layers
  of the same names would have t3's rules merged into them; Consola's pages use no layers. The root has `contain: layout`, so t3's
fixed-position controls are placed inside the chat, not on the page's viewport.

**Theme.** Where the page carries Consola's colour tokens (the desktop sets them on
`html[data-theme]`), `styles.css` reads them there under `--consola-agent-ui-*` names and maps
t3's variables (`--background`, `--foreground`, `--primary`, `--border`, …) to them. Without the
tokens, t3's own palette applies. Dark mode is the nearest `[data-theme]`'s, in both
directions, and the system's only on a page without one:

- **t3's CSS.** `AgentChat` puts `dark` on the theme element and its popups. t3's dark variant
  matches `dark` on any ancestor (`:is(.dark, .dark *)`), so `scopeCss` rewrites every `.dark`
  to the chat's own (`OWN_DARK`: `:where(.consola-agent-ui-theme, .consola-agent-ui-portal).dark`,
  nested rules included). A `dark` on the page's `<html>` or anywhere above the chat changes
  nothing in it, and the built stylesheet has no `prefers-color-scheme` query
  (`check:css` fails on either).
- **t3's code.** What t3 reads in JavaScript (code highlighting, diffs) comes from its theme
  module, which follows the system by default. `AgentChat` sets t3's appearance (its stored
  `t3code:theme-appearance-mode`) to the chat's, light or dark, whenever that changes, so t3
  never follows the system. t3 has one appearance per page: two chats in differently themed
  parts of one page share the last one's.

### t3 does not write the page's document

t3's web app owns its document, so its theme module (`src/t3/hooks/useTheme.ts`) writes it at
import and on every theme change: `dark` on `<html>`, its palette's variables and
`data-theme-id` on `<html>`, an inline background on `<html>` and `<body>` (which would freeze
the page's background), and a `<meta name="theme-color">`. `src/t3Document.ts` stops all of it,
without editing t3: t3's `applyTheme` writes nothing while `<html data-theme-id>` names t3's
theme preview (its own early return, for when a draft theme owns the document), so that mark
is set only while t3 could write, and the page's value put back:

- **At import.** `t3Document.ts` is the first module `AgentChat.tsx` imports, and
  `AgentChat.tsx`'s body releases it once every t3 module has run. A bundle keeps that order
  only with `strictExecutionOrder` (`vite.config.ts`): without it t3's theme module, in a
  shared chunk, runs before the entry's own modules and writes the page.
  `AgentChat.dist.test.tsx` checks the built library.
- **When `AgentChat` sets t3's appearance** (`sparingThePage`). Since t3's appearance is never
  "system", the system's appearance changing never reaches `applyTheme`.
- **When another window changes t3's stored theme**, which t3 applies from its `storage`
  listener: a capturing listener sets the mark for that task (the attribute is there until the
  next task; it styles nothing).

`AgentChat.browser.test.tsx` reads `<html>`, `<body>` (every attribute, computed background
and colour scheme) and `<head>`'s `<meta>` elements before the package is imported, on a dark
system and a page with a background of its own, and finds them unchanged after the import and
after the chat shows its thread.

**What still touches the page**, and why it is left:

- `<body>` gains children t3 puts there while the chat is used: Base UI's popup portals (marked
  as the chat's, above), the hidden sprite of file icons (`pierre-icons.ts`, when an icon
  renders), an `aria-live` region for t3's announcements (`lib/announce.ts`), and a probe span
  that measures fonts and is removed at once (`appearanceFonts.ts`). Each styles nothing
  outside itself.
- `<html lang>` would become t3's language if t3 activated one other than English
  (`i18n/runtime.ts` `activateLocale`). t3 takes its language from its saved setting, whose
  default is `"en"` whatever the system's language, and nothing `AgentChat` mounts changes it
  (t3's settings and language picker are not mounted), so it does not happen. If Consola ever
  lets the person pick t3's language, keep `<html lang>` as the theme is kept.
- t3's composer reads `<html>`'s `dark` class to pick its code-block highlighting
  (`ComposerPromptEditorTiptap.tsx`). It reads only; on a page without that class (Consola's)
  code typed in the composer is highlighted with the light palette in a dark chat.
- `localStorage` and IndexedDB, below.

## Build

`pnpm --filter @consola/agent-ui build` is a library build: `dist/agent-ui.js` (ES module,
`react` and `react-dom` external, so the page's React renders it) and `dist/agent-ui.css`, which
`package.json` exports as `@consola/agent-ui` and `@consola/agent-ui/styles.css` (types from
`src/index.ts`). React reaches the library only as imports: `esmExternalRequirePlugin` turns the
`require('react')` of CommonJS dependencies (`use-sync-external-store`'s shim) into imports, as
left in an ES module it throws at import in a browser. Modules run in source order across the
chunks (`strictExecutionOrder`; see "t3 does not write the page's document"). Build before a
page imports it. `src/index.ts` imports `src/styles.css`, because
a library build writes only the CSS its entry imports: without it `dist/agent-ui.css` holds just
what t3's modules import (KaTeX, the PDF viewer) and the chat is unstyled. `pnpm --filter
@consola/agent-ui check:css` (`build/checkBuiltCss.ts`, run by CI after the build) checks the
built file: t3's theme, a Tailwind utility and Consola's token mapping are in it, every rule is
scoped to the chat, and nothing page-global is there beyond the at-rules listed in "What is
page-global" below. The output must contain no `@cursor/sdk` and no
`@anthropic-ai/claude-agent-sdk` (CI greps `dist/` for both); either would mean server code
reached the browser bundle. `dist/` is large (t3's lazy office, PDF, HEIC and syntax-highlighting
workers and its translations), loaded only when used.

## Tests

```bash
pnpm --filter @consola/agent-ui test        # the unit tests (Node: boundary, CSS scope) and the browser tests
pnpm --filter @consola/agent-ui typecheck   # build/typecheck.ts
pnpm --filter @consola/agent-ui build
pnpm --filter @consola/agent-ui check:css   # the built stylesheet (build first)
pnpm --filter @consola/agent-ui test:dist   # the built library in a page (build first)
```

The browser tests run in Vitest's browser mode (Playwright, Chromium; `pnpm --filter
@consola/agent-ui exec playwright install chromium` once). A global setup
(`src/testing/hostSession.ts`) starts `@consola/host`'s replay entry
(`src/testing/replaySession.ts`, t3's recorded Claude `simple` fixture) and sends the fixture's
message through t3's RPC client, on a machine of its own: a temporary home, no CLI or API-key
variable, fake CLIs on the `PATH`; teardown fails the run if any CLI call saw another home or a
config folder. Each browser test file deletes t3's IndexedDB first, so what it shows comes from
the host. Files run one at a time.
