# Consola website

A standalone static landing page for Consola. The authored website is in `public/`, separate from the Electron app. The website is deployed using the repository-root Vercel configuration.

The workspace is an illustrative, interactive preview, not a live agent session. Its tabs support mouse and keyboard navigation. The page includes responsive layouts, visible focus states, reduced-motion support, and local font and icon assets.

## Vercel deployment

Production URL: https://www.consola.dev (also available at https://consola-peach.vercel.app). The apex domain https://consola.dev redirects to `www`.

The repository-root `vercel.json` deploys `apps/website/public` as static files, with no dependency installation or build step. Keep the Vercel project Root Directory at the repository root (`.`). The root `.vercelignore` limits CLI uploads to the website and deployment configuration.

From the repository root, link and deploy with:

```sh
vercel link --project consola --scope javier-tarazaga-gomezs-projects
vercel deploy --prod
```

Run `pnpm dev:website` from the repository root for a local preview.
`pnpm --filter @consola/website build` copies the authored files to `dist/`;
`pnpm build` builds both workspaces. Vercel serves `public/` directly to keep
static deployment independent of Electron dependencies. When changing the production domain, update the canonical and Open Graph URLs in `public/index.html`.

## GitHub release downloads

The site queries the public `ConsolaDev/Consola` repository's latest stable
GitHub release and links directly to its DMG assets using `browser_download_url`.
The navigation, hero, and final download buttons download the Apple silicon
installer; the download section also offers an Intel Mac link. If only the Intel
installer is available, the primary buttons explicitly identify it as Intel.
No token, manually updated URL, or website redeploy is needed for new releases.

The distribution configuration names DMGs `Consola-${version}-${arch}.dmg`
(`arm64` and `x64`). Keep those names in sync with asset selection in
`public/app.js`. ZIPs and update metadata are reserved for the desktop updater.

Follow the [desktop release guide](../../docs/desktop-updates.md) to build,
test, and publish signed installers. The release workflow creates a **draft**;
it must be published as a stable release before the website can offer downloads.
There were no published releases when this integration was added.

Before a release exists, if its installers are missing, or if GitHub's API is
unavailable or rate limited, the buttons open the GitHub releases page and the
site explains the download status. These fallback links also work without
JavaScript.

## Design

The visual direction is inspired by https://clerk.com: pale surfaces, fine structural borders, restrained violet accents, generous typography, and detailed product demonstrations. Copy and interface preview are original to Consola. The icon is reused from the app. JetBrains Mono is bundled under its included OFL license.
