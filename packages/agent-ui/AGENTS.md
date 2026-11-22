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

It connects to one `@consola/host` session (`packages/host`) and renders t3's chat for it. `hostUrl` is the host's
`http(s)://` address; its socket's `ws(s)://` address is read as the same host (`src/hostAddress.ts`).

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
  `src/styles.css`, `src/publishedTypes.ts`, `types/` (the published declarations),
  `test-consumer/` (an embedder's program), `build/` (the CSS scope, the built-CSS check and the
  typecheck), the configs and the tests. Biome lints it.
- **Types.** `pnpm typecheck` (`build/typecheck.ts`) runs t3's checker (`effect-tsgo`) over the
  browser program (`tsconfig.json`, t3's web settings) and the Node one (`tsconfig.node.json`).
  Four errors in copied files are expected and listed there: callbacks typed by t3's router
  registration, which names t3's whole app. Any other error, or one of the four going away,
  fails it. It also checks an embedder's program against the published types ("Types" below).

## Types

An embedder typechecks against `types/`, never the source: `package.json`'s `exports` give
`types/index.d.ts` for `@consola/agent-ui` and `types/styles.css.d.ts` for
`@consola/agent-ui/styles.css`. The source cannot be the published types. `src/index.ts`
reaches `AgentChat.tsx` and through it t3's copy, whose `~/` imports resolve only under this
package's `tsconfig.json`, and an embedder's checker would then read t3's source and the
`@t3tools/*` packages under its own settings: 570 errors in `test-consumer/`'s program when
`exports` named `src/index.ts`.

- **Written by hand.** The surface is one component and its props: three strings and a
  function. Emitting it from the source would take either t3's whole program (its `~/` paths, its
  four errors, a declaration for every copied file) or an isolated-declarations step in the
  build, after which an embedder could not typecheck before building the package; and the
  output would carry whatever `AgentChat.tsx`'s exports come to name, the leak this prevents.
  `types/` needs no build and imports only `react`'s types.
- **Kept equal to the source.** `src/publishedTypes.ts` (types only, imported by nothing) fails
  `pnpm typecheck` when `AgentChatProps` or `AgentChat` differ from `src/index.ts`'s
  (`readonly` and optional modifiers included), or when `src/index.ts` exports a value
  `types/index.d.ts` does not. A change to the props is made in both.
- **The stylesheet has a declaration** (`export {}`), so an embedder that checks side-effect
  imports (`noUncheckedSideEffectImports`) resolves `@consola/agent-ui/styles.css` without
  declaring every `*.css` module. Bundlers do not read the `types` condition; they get
  `dist/agent-ui.css`.
- **An embedder's program** (`test-consumer/`): its own `tsconfig.json` (cloud-web's settings,
  stricter where a looser one would hide something: no ambient types, side-effect imports
  checked, the package's declarations checked rather than skipped) and one screen that imports
  `AgentChat`, its props type and the stylesheet by name, renders the chat, and expects an error
  for each wrong prop. It has no `package.json`, so the name resolves as the package's own (a
  self-reference, through the same `exports` a workspace link gives cloud-web), and needs no
  workspace entry. `build/typecheck.ts` checks it with TypeScript's `tsc`, as the apps check
  theirs, and fails on any error, and on any file the program reads other than its own,
  `types/` and libraries' declarations (TypeScript's, React's): a published type that reached
  `src/`, t3's copy or another workspace package shows there. It runs wherever `pnpm typecheck`
  does, CI's `Agent UI` job included, which runs whenever this package or what it depends on
  changes.

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
- **Pass expiry.** The host closes a connection with `4401` at its pass's `exp`, and refuses
  the expired pass at the next ticket call. A refused pass is t3's `401`, on which t3's
  connection stops (blocked, `authentication`). `AgentChat` watches the registry's state for
  that and calls `onPassExpired`, then registers the pass it answers, which reconnects
  (`AgentChat.passExpiry.browser.test.tsx`). A pass the host refuses
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

  The notice goes once the host connects: the chat keeps watching t3's state after the ten
  seconds, so a registration that lands later (its hold waiting on another window removing the
  session's pass) takes the notice back (`AgentChat.lateRegistration.browser.test.tsx`). t3's
  registry shows nothing of an environment until it is registered (it never fails for one it
  does not know), so the ten seconds are a deadline on its first state. Every failure of the chat's own is also logged
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
    thread), the prompts they stash from the composer (`t3code:prompt-stash:v2`,
    `promptStashStore.ts`), its client settings (`t3code:client-settings:v1`) and UI state (`t3code:ui-state:v1`,
    panel widths, …), the theme keys (`t3code:theme`, `t3code:theme-appearance-mode`, which
    `AgentChat` sets to the chat's light or dark, `t3code:theme-halves:v1`, `t3code:themes:v1`),
    and the analytics device id (`t3code:analytics-device-id`, a random id t3's platform
    creates when asked for one; this build names no relay or telemetry address,
    `vite.config.ts`).
  - Consola's own record of the sessions a page registered (`consola-agent-ui:session:<id>`, the
    id only; `src/storedSessions.ts`). Storage that refuses it (full, or turned off) costs only
    the record, logged once (`console.warn`): the chat still shows, and the session is not found
    by a later page.

  What is removed, and when:
  - **On unmount**: t3 deletes the host's pass, its cached environment data and the data other
    modules keep for it (`removePlatformEnvironment`).
  - **At the first registration in a page**: the same, for every recorded session no page holds.
    A page holds each session it shows with a Web Lock, from before it registers it until t3 has
    removed it, and a lock goes with its page however the page ends; so this finds what a window
    that closed without unmounting left, and never touches what another open window shows
    (`AgentChat.storedSessions.browser.test.tsx`). Without Web Locks (an insecure context)
    nothing is removed this way.
  - **Never**: composer drafts, stashed prompts, client settings and UI state, the theme keys, the analytics id
    and t3's favicon cache (`t3code:project-favicons`). They hold no credential.

- **Where the pass travels.** `AgentChat` holds it in React state and hands it to t3, which:
  - keeps it in IndexedDB (its catalog, above) while the host is registered;
  - sends it as `Authorization: Bearer <pass>` on the HTTP calls before the socket (the ticket
    and the session);
  - opens the socket at `ws(s)://<host>/ws?wsTicket=<pass>`: the host issues the pass itself as
    t3's ticket, so the pass is in the socket's URL, which the browser's developer tools show
    (the host redacts it from its own logs and traces). A ticket distinct from the pass is a
    Track B decision (`packages/host`'s `AGENTS.md`, "Before the socket").

  It never reaches `localStorage` or the page's history from `AgentChat`. The dev page reads it
  from its address (`?pass=`) and takes it out at once (`dev/DevPage.tsx`, `history.replaceState`),
  so it is not left in the address bar or the history.

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

Then `scopeCss` puts the whole stylesheet in one cascade layer, under one unlayered rule, the
guard, so the page's own CSS does not reach in either ("The page's CSS" below).

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
- The `@layer` name `consola-agent-ui`, the chat's layer ("The page's CSS"). t3's layers are
  its sublayers, so a page's own layers of the same names (`theme`, `base`, `utilities`) stay
  apart from t3's. The dev page has one layer of its own, `consola-dev-page` (`dev/index.html`,
  html, body and `#root` only), declared before the chat's stylesheet loads, so it is below the
  chat's.
- The guard, the one unlayered rule: it styles nothing, and rolls back only inside the chat.

The root has `contain: layout`, so t3's fixed-position controls are placed inside the chat, not
on the page's viewport.

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

### The page's CSS

A page's CSS reaches the chat's elements too, and the cascade favours it. The desktop's
`global.css` has unlayered rules for every element (`* { margin: 0; padding: 0; box-sizing:
border-box }`, `button { font-size: inherit }`, `a { color }`, `:focus-visible { outline }`,
scrollbars); a page with Tailwind 3 has Tailwind's preflight unlayered and sets the `--tw-*`
properties t3's utilities read on every element. A rule in no cascade layer outranks every
layered one, whatever their weights, and t3's Tailwind is layered: the desktop's reset took away
every padding and margin utility of t3's (`AgentChat.pageCss.browser.test.tsx` found about 385
properties of the chat's elements changed by the desktop's CSS and 650 by Tailwind's resets;
cloud-web's Radix Themes, whose rules name its own classes, changed none).

So the stylesheet is in one layer, under a guard:

- **One layer.** `scopeCss` moves every rule into `@layer consola-agent-ui` (`CHAT_LAYER`),
  where it stood. t3's layers become its sublayers (`consola-agent-ui.base`, …), and the rules
  that were in none (t3's own, KaTeX's, the PDF viewer's, `styles.css`'s) are the layer's own,
  which outrank its sublayers as unlayered rules outrank layers. t3's cascade is the same inside
  it, `!important` included, and a page's own `base` or `utilities` layer stays apart from t3's.
  `@keyframes`, `@property` and `@font-face` stay where they were.
- **The guard** (`styles.css`, completed by `scopeCss`) is the stylesheet's only unlayered rule.
  It matches every element inside the chat's root and in its popups, with an ID's weight
  (`GUARDED`: `:not(#consola-agent-ui-guard)` names an id no element has), and sets
  `all: revert-layer`, on the pseudo-elements a reset reaches too (`GUARDED_PSEUDO_ELEMENTS`),
  and `revert-layer` on every custom property the stylesheet registers (`all` leaves custom
  properties alone; a Tailwind 3 page's `--tw-shadow: 0 0 #0000` would take t3's shadows away).
  A page rule without an ID that matches inside the chat loses to the guard, and the guard
  sends each property back to the layers: to t3's stylesheet, or where t3 sets none to the
  browser's default, as on a page of t3's own. So a property t3 never sets (the desktop's focus
  outline, `a:hover`'s underline) comes out as on a bare page as well. Only `GUARDED` and
  `GUARDED_PSEUDO_ELEMENTS` are unlayered, and only to roll back: `check:css` fails on any other
  unlayered rule, a guard that sets a value, a pseudo-element or registered property it leaves
  out, and a layer of any other name.
- **Why not the alternatives.**
  - *Raising the scope's weight* (`.consola-agent-ui` instead of `:where(…)`) keeps t3's order,
    but does nothing against an unlayered page rule while t3's rules are layered.
  - *t3's rules unlayered*, with that weight, would outrank the page's rules only for the
    properties t3 sets: where it sets none, the page's still apply (the desktop's
    `:focus-visible` outline on t3's elements that have no focus style). It also turns t3's six
    layers into specificity, which reorders t3's own cascade wherever a lower layer's rule
    weighs more than a utility (`button:not(:disabled)`'s cursor over `cursor-default`) and
    inverts `!important` between layers, unless each layer gets a band of weight of its own.
  - *A shadow root* would keep every page rule out, but t3's popups are Base UI portals to
    `document.body`, outside it, and t3 gives them no container, so it would take editing t3's
    files. Chromium also ignores `@property` and `@font-face` inside a shadow root (Tailwind 4's
    `--tw-*` initial values, KaTeX's fonts), and t3 reads the page's `document` (its root font
    size, `<html>`'s `dark`).
- **What still reaches the chat.**
  - The root font size, by design: t3 sizes in `rem` and measures `document.documentElement`
    (`ComposerCommandMenuLayer.tsx`, `useTallEnoughToFold.ts`), so it follows the page's. The
    desktop's 14px root makes the chat 7/8 of its size in t3's own window. The test reads both
    pages at the page's root size.
  - What the chat's container inherits, where t3's document sets nothing: t3 sets the font
    family, line height, colour and background on the theme element, so Radix's `.radix-themes`
    passes on only its `-webkit-font-smoothing`, `overflow-wrap` and the like.
  - A page rule with an ID, or with `!important`, outweighs the guard.
  - A page's own layers: the guard sends properties back to every layer, the page's included,
    so a page layer that outranks `consola-agent-ui` reaches in. A layer outranks it when the
    page names it after the chat's stylesheet has loaded (a page's global CSS usually loads
    first, below it).
  - `::selection`: Chromium's highlight pseudo-elements inherit from the parent element's, so
    where t3 sets none the page's selection colour shows in the chat (the desktop's accent).
  - A custom property t3 uses but does not register, if the page sets it on every element
    (`* { --x }`). t3 defines its variables on the theme element, so a page's own on an
    ancestor (`:root`, `.radix-themes`) do not reach in.
  - The chat's root, `.consola-agent-ui`, is the page's to place, and is not guarded.
- **Cost.** The guard puts `all` (and the registered properties) into every element's cascade,
  and `revert-layer` looks each property up again in the layers below. In Chromium a style
  recalculation of 20,000 elements styled by this stylesheet took 1.6 to 1.9 times as long with
  the guard as without it, almost all of it `all` (measured on a loaded machine, so only the
  ratio means much). The chat itself is a few hundred elements to a few thousand (t3 virtualises
  its message list). The guard adds about 7 KB to the stylesheet, most of it the registered
  properties.

`AgentChat.pageCss.browser.test.tsx` mounts the chat inside each embedder's element, with its
real stylesheets (`src/testing/embeddingPages.ts`): the desktop's tokens and `global.css`,
cloud-web's Radix Themes (from cloud-web's `node_modules`) and `ui/styles.css`, and Tailwind's
`preflight.css` unlayered with Tailwind 3's per-element defaults. It reads every element of the
chat and of a popup (spacing, borders, sizes, fonts, colours, decoration, shadows, outlines,
scrollbars, `::before`, `::after` and `::placeholder`), at rest, with a link hovered and with the
composer and a button focused from the keyboard, with the page's rules and without, and expects
no difference. The page's root font size is held in both (above), and a reading with the page's
rules counts only between two without them that agree: t3 goes on loading the thread's details
for a while after the answer shows, which changes what it renders. The popup is a
`data-base-ui-portal` element the test adds, which `AgentChat` marks as the chat's, standing in
for one of t3's.

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
- While t3's model picker is open (`components/chat/ProviderModelPicker.tsx:38-83`), it sets
  `overflow: hidden` on `<body>` (and a `padding-right` the width of the page's scrollbar) and
  `overscroll-behavior: contain` on `<html>`, inline, and listens for `wheel` and `touchmove`
  on the document to stop the page behind it scrolling; it puts the earlier inline values back
  when it closes.
- While a panel edge is dragged (`hooks/useResizeDrag.ts:108-109`), `<body>` gets an inline
  `cursor: col-resize` and `user-select: none`; at the end both are removed (`:60-61`), not put
  back, so an inline `cursor` or `user-select` the page had set on `<body>` is lost.
- `localStorage` and IndexedDB, below.

## Build

`pnpm --filter @consola/agent-ui build` is a library build: `dist/agent-ui.js` (ES module,
`react` and `react-dom` external, so the page's React renders it) and `dist/agent-ui.css`, which
`package.json` exports as `@consola/agent-ui` and `@consola/agent-ui/styles.css` (types from
`types/`, "Types" above). React reaches the library only as imports: `esmExternalRequirePlugin`
turns the `require('react')` of CommonJS dependencies (`use-sync-external-store`'s shim) into imports, as
left in an ES module it throws at import in a browser. Modules run in source order across the
chunks (`strictExecutionOrder`; see "t3 does not write the page's document"). Build before a
page imports it. `src/index.ts` imports `src/styles.css`, because
a library build writes only the CSS its entry imports: without it `dist/agent-ui.css` holds just
what t3's modules import (KaTeX, the PDF viewer) and the chat is unstyled. `pnpm --filter
@consola/agent-ui check:css` (`build/checkBuiltCss.ts`, run by CI after the build) checks the
built file: t3's theme, a Tailwind utility and Consola's token mapping are in it, every rule is
scoped to the chat (a `+` or `~` straight after the scope styles the chat's siblings, so it
fails) and in its layer but the guard's, the guard is whole, and nothing page-global is there
beyond what "What is page-global" lists. The output must contain no `@cursor/sdk` and no
`@anthropic-ai/claude-agent-sdk` (CI greps `dist/` for both); either would mean server code
reached the browser bundle. `dist/` is large (t3's lazy office, PDF, HEIC and syntax-highlighting
workers and its translations), loaded only when used.

## The dev page

`pnpm --filter @consola/agent-ui dev` serves `dev/` (`index.html`, `main.tsx`, `DevPage.tsx`) at
`http://localhost:5176`: `AgentChat` full-window against a host on this machine (`packages/host`'s
`AGENTS.md`, "Running it with the chat"). The script is `vp dev dev --config vite.config.ts --port
5176`. `dev` is the dev server's root, and Vite looks for its config file in the root
(`loadConfigFromFile(…, config.root)`), where it would find none and serve the page without the
package's config: no Tailwind or CSS scope, no `~/` alias, none of t3's `import.meta.env`
values, and the device models not withheld. `--config vite.config.ts` names the package's own,
resolved from the package's folder.

## Tests

```bash
pnpm --filter @consola/agent-ui test        # the unit tests (Node: boundary, CSS scope) and the browser tests
pnpm --filter @consola/agent-ui typecheck   # build/typecheck.ts: t3's programs and an embedder's (test-consumer/)
pnpm --filter @consola/agent-ui build
pnpm --filter @consola/agent-ui check:css   # the built stylesheet (build first)
pnpm --filter @consola/agent-ui test:dist   # the built library in a page (build first)
```

The browser tests run in Vitest's browser mode (Playwright, Chromium; `pnpm --filter
@consola/agent-ui exec playwright install chromium` once). A global setup
(`src/testing/hostSession.ts`) starts `@consola/host`'s replay entry
(`src/testing/replaySession.ts`, t3's recorded Claude `simple` fixture) trusting a key pair made
for the run (`src/testing/passKeys.ts`, so a test can ask for a pass of any lifetime with the
`signHostPass` command; `watchSockets` and `openedSockets` record the sockets the page opens),
and sends the fixture's message through t3's RPC client, on a machine of its own: a temporary
home, no CLI or API-key variable, fake CLIs on the `PATH`; teardown fails the run if any CLI
call saw another home or a config folder. Each browser test file deletes t3's IndexedDB first,
so what it shows comes from the host. Files run one at a time.
