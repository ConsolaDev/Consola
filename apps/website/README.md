# Consola website

A Vite-built static landing page with an interactive demo of the actual desktop UI. The website entry is `index.html`, marketing styles and behavior are in `src/`, and images/fonts are in `public/assets/`.

## Interactive demo

`demo/main.tsx` installs an in-memory replacement for the Electron preload APIs, then loads `demo/render.tsx`. That entry imports the desktop `App`, stores, components, theme tokens, and CSS directly from `apps/desktop/src/renderer`. The demo is isolated in a lazy-loaded iframe, so app styles and keyboard shortcuts stay inside the product preview.

Desktop component and style changes are included automatically in the next website build and deployment; there is no separate copy of the interface to update. New or changed Electron APIs may require updates to `demo/mock.ts`, and sample content remains in `demo/fixtures.ts`. Static preview screenshots need to be regenerated with `capture:demo`.

`demo/fixtures.ts` defines fictional Work and Personal profiles, configured harnesses, GitHub PRs/issues, sessions, and sample source changes. `demo/mock.ts` handles workspace/group/session edits, custom action prompts, terminal output, file reads, staging, and sample commits. The real xterm terminal renders deterministic responses; it never launches a CLI, shell, Git, or AI request. Typed prompts and settings remain in memory. Resetting or reloading restores the fixtures. Product preferences use an isolated in-memory Storage implementation, not the host site's localStorage.

The demo starts on Acme’s Home view with grouped conversations and a sample session selected. Visitors can use the real menus, change workspace settings, edit saved action prompts and destination groups, launch sessions from PRs, organize conversation groups, type sample instructions, inspect diffs, approve files, and create a sample commit. Unsupported desktop-only operations explain their limitation. Parent-page shortcuts send origin-checked messages to explore Home, switch profiles, open the inbox, inspect changes, or reset. The selected shortcut follows navigation inside the app; resetting returns to Home.

The app keeps its desktop layout. On narrow screens, the frame scrolls horizontally; the page itself does not overflow. An “Open full demo” link is also available. There is no automatic tour advancing underneath visitors.

The root README’s clickable hero and the website’s link previews share `public/assets/consola-demo.png`, captured from the real renderer with sample data. Clicking the README preview opens the landing page’s interactive demo at `https://www.consola.dev/#workspace`; GitHub cannot embed the live iframe. The existing real desktop capture, `public/assets/consola-screenshot.png`, is available under “A look at the real app” on the website and in a collapsed section in the README. Preview metadata is static in `index.html`. Keep its absolute image URL and dimensions in sync when updating it.

To regenerate the preview, start the site and run:

```sh
PLAYWRIGHT_CHANNEL=chrome pnpm --filter @consola/website capture:demo
```

Omit the environment variable to use Playwright's installed Chromium.

Commit the regenerated `public/assets/consola-demo.png` with UI or fixture changes so the README and social preview stay aligned. The capture script opens the landing page’s embedded demo, selects “Inspect code changes,” and waits for the review panel, terminal, and fonts before taking the screenshot. It uses the same renderer and sample setup visitors can explore; no separate README mockup needs maintaining.

## Development and verification

```sh
pnpm dev:website
pnpm --filter @consola/website typecheck
PLAYWRIGHT_CHANNEL=chrome pnpm --filter @consola/website test
pnpm --filter @consola/website build
```

The tests start a preview server if needed and stub GitHub release responses. They exercise PR actions, terminal input, diff approval and commits, profile separation, editing prompts, conversation groups, reset, browser-only data handling, responsive widths, release installers/fallbacks, and the no-JavaScript screenshot and download links. To use Playwright Chromium instead of a local Chrome, install it with `pnpm --filter @consola/website exec playwright install chromium`, then omit `PLAYWRIGHT_CHANNEL`.

## Vercel deployment

Production URL: https://www.consola.dev (also available at https://consola-peach.vercel.app). The apex domain redirects to `www`.

Keep the Vercel project Root Directory at the repository root (`.`). The repository-root `vercel.json` installs workspace dependencies with lifecycle scripts disabled, builds only the website, and serves `apps/website/dist`. Electron is never built or launched. The `.vercelignore` includes the website plus the desktop renderer/shared source and package/configuration files needed to bundle the actual UI. No main-process code or native Electron API is shipped to the browser.

Not every push deploys. `vercel.json`'s `ignoreCommand` runs `tools/vercel-ignore.mjs`, which compares the pushed commit with the one Vercel last deployed on that branch (or, on a branch's first deployment, with where it left `main`), and lets Vercel skip the build (shown as canceled) when nothing that matters changed:

- **Production (`main`)** deploys when any file `.vercelignore` uploads changed, the desktop renderer and the lockfile included, so the demo never shows an older app.
- **A preview** deploys only when the website's own uploaded files (`apps/website`) or the deployment's configuration changed, so a pull request that touches only the desktop gets no preview.

A deployment from the CLI, or one the script cannot judge, always builds. A new file the site needs goes in `.vercelignore`, and then counts.

```sh
vercel link --project consola --scope javier-tarazaga-gomezs-projects
vercel deploy --prod
```

Set `VITE_POSTHOG_KEY` as a Vercel Environment Variable before deploying, or the
build ships without analytics; see [Analytics](#analytics).

`pnpm --filter @consola/website build` emits the landing page, `download/index.html`, and `demo/index.html`, along with bundled JavaScript/CSS and the static assets. Vite's `preview` command serves that production build locally. When changing the domain, update the canonical and Open Graph URLs in `index.html`.

## Analytics

The site uses [PostHog](https://posthog.com) (EU Cloud) for pageviews and a single
custom event. `src/app.js` is the shared script for `index.html` and
`download/index.html`, so one initialisation covers the whole funnel.

**The browser never contacts PostHog.** `api_host` is `/cnsl`, a path on this site's
own origin, and the `rewrites` in the repository-root `vercel.json` forward it to
`eu.i.posthog.com` (and `/cnsl/static/*`, `/cnsl/array/*` to `eu-assets.i.posthog.com`).
Keep the specific rules above the catch-all — Vercel evaluates rewrites in order. The
path is deliberately not `/analytics` or `/tracking`, which ad-blocker lists match;
routing through the first-party origin is also what keeps blockers from deleting a
slice of the numbers. Changing the region means changing both the rewrites and
`ui_host` together.

**The key is a build-time variable.** `VITE_POSTHOG_KEY` must be set as a Vercel
Environment Variable for Production (and Preview, if you want preview traffic). It is
a publishable project key and ends up in the bundle either way, but keeping it in the
environment keeps it out of git and rotatable without a commit. Vercel will refuse to
store it as a Secret — `VITE_` is a public framework prefix, and Vite inlines those
into the browser bundle, so a write-only Secret would be a promise it cannot keep.
Use the **Config** type. That is correct for this key: a PostHog *project* key only
writes events and grants no read access, unlike a personal API key. With no key Vite
tree-shakes the entire `import('posthog-js')` branch away, so an unconfigured build
ships **zero** analytics code and silently collects nothing — convenient locally,
easy to miss in production. If the dashboard is empty, check this first.

**`Enable cookieless tracking` must be on in the PostHog project** (Settings →
Project → Web analytics). With it off, PostHog discards every event this site sends
and raises an ingestion warning.

One custom event, `download`, counts installers that actually start. The thank-you
page captures it immediately after it clicks the resolved `browser_download_url`,
carrying `arch` (`arm64` or `x64`) and `version` (the release tag). The landing
page's download buttons are deliberately not counted: they only navigate to
`/download/`, which that page's own pageview already counts, and a pageview cannot
separate a started transfer from a visitor who arrived on a non-Mac or while GitHub
was unreachable — both return before an installer is ever resolved. A manual click on
the retry link is not counted either, so the number stays one per visitor rather than
one per attempt. Visitors on every other platform are sent to GitHub Releases and
leave this origin, so their downloads cannot be counted here at all; GitHub's own
per-asset `download_count` is the only source for those.

`posthog-js` is imported on demand rather than at the top of the module. It is ~123 kB
gzipped against this module's own ~1.6 kB, and none of it is needed to paint the page
or resolve a download, so Vite gives it a chunk of its own that is not modulepreloaded.
The landing page's critical script is smaller than it was before any analytics existed.

`autocapture` is off: every click on a landing page is more than this site needs and
more than it promises to collect. Pageviews, pageleaves and the `download` event are
the whole dataset. `defaults` is pinned to a dated version so a later `posthog-js`
upgrade cannot change collection behaviour underneath the site.

The interactive demo is not tracked. `demo/index.html` loads `demo/main.tsx` and
never loads `src/app.js`, so the iframe stays out of the numbers on purpose: it is
lazy-loaded and `noindex`, and counting it would add a second pageview every time a
visitor scrolls the landing page.

`cookieless_mode: 'always'` means no cookies, no `localStorage`, no `sessionStorage`
and no consent banner; visitors are counted by a hash PostHog derives server-side.
`person_profiles: 'never'` makes `identify()` a no-op, so no persistent per-person
identity can be created by accident. The price is real: cookieless events lose their
IP before enrichment, so there is **no GeoIP and no country breakdown**, and session
replay and surveys are unavailable. The "analytics reaches PostHog through this origin
and persists nothing" test asserts the storage and origin halves of this.

PostHog's free tier covers 1M events per month with no card on file; past it events are
dropped rather than billed. A landing page will not come close.

The test suite supplies a throwaway `VITE_POSTHOG_KEY` from `playwright.config.cjs`, so
it exercises the real analytics path rather than the compiled-out one. Assertions go
through `window.posthog`, which the site assigns on init the way PostHog's own snippet
install does, rather than through a stand-in for PostHog's ingestion API — that wire
format is PostHog's to change, not a contract to test against.

## GitHub release downloads

On macOS, the site queries the public `ConsolaDev/Consola` repository's latest stable
GitHub release and routes download buttons to `/download/?arch=arm64` (or `x64`). The branded
thank-you page resolves the selected installer, starts its download using
`browser_download_url`, and provides a direct retry link plus a GitHub community card.
Other platforms (including iPads using desktop browsing mode) show “View GitHub
Releases” instead and do not request macOS installers.
The navigation, hero, and final download buttons download the Apple silicon
installer; the download section also offers an Intel Mac link. If only the Intel
installer is available, the primary buttons explicitly identify it as Intel.
No token, manually updated URL, or website redeploy is needed for new releases.

The distribution configuration names DMGs `Consola-${version}-${arch}.dmg`
(`arm64` and `x64`). Keep those names in sync with asset selection in
`src/app.js`. The download page is a separate Vite HTML entry at
`download/index.html`. ZIPs and update metadata are reserved for the desktop updater.

Use the [desktop release workflow](../../.github/workflows/release.yml) to build
and publish signed installers. The release workflow creates a **draft**;
it must be published as a stable release before the website can offer downloads.
There were no published releases when this integration was added.

Before a release exists, if its installers are missing, or if GitHub's API is
unavailable or rate limited, the buttons open the GitHub releases page and the
site explains the download status. These fallback links also work without
JavaScript.

## Design

The visual direction draws on https://clerk.com for contrasting light and dark sections and https://paperclip.ing for the product-led presentation. A light hero and workspace section alternate with a dark interactive demo, native CLI section, and open-source/local-storage section. The headline is “Your agents. Your workflow. One workspace.” The embedded demo imports the actual Consola renderer components and styles; only the Electron APIs are replaced by browser mocks. The icon is reused from the app. JetBrains Mono is bundled under its included OFL license.

Keep product claims grounded in the app: Consola launches installed CLIs, so updating a CLI affects new sessions; it does not install upstream CLI updates itself. App settings, session history, and project files are local, while agents and GitHub still connect to their respective services.
