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

```sh
vercel link --project consola --scope javier-tarazaga-gomezs-projects
vercel deploy --prod
```

`pnpm --filter @consola/website build` emits the landing page, `download/index.html`, and `demo/index.html`, along with bundled JavaScript/CSS and the static assets. Vite's `preview` command serves that production build locally. When changing the domain, update the canonical and Open Graph URLs in `index.html`.

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
