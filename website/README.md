# Consola website

A standalone static landing page for Consola. The authored website is in `dist/`, separate from the Electron app. Sites configuration is in `.openai/hosting.json`.

The workspace is an illustrative, interactive preview, not a live agent session. Its tabs support mouse and keyboard navigation. The page includes responsive layouts, visible focus states, reduced-motion support, and local font and icon assets.

## Vercel deployment

Production URL: https://www.consola.dev (also available at https://consola-peach.vercel.app). The apex domain https://consola.dev redirects to `www`.

The repository-root `vercel.json` deploys `website/dist` as static files, with no dependency installation or build step. Keep the Vercel project Root Directory at the repository root (`.`). The root `.vercelignore` limits CLI uploads to the website and deployment configuration.

From the repository root, link and deploy with:

```sh
vercel link --project consola --scope javier-tarazaga-gomezs-projects
vercel deploy --prod
```

Do not use the Electron app's `npm run build` for this site. When changing the production domain, update the canonical and Open Graph URLs in `dist/index.html`.

## Enable downloads

Set `url` in `dist/download.json` to the public HTTPS URL of a macOS installer and update `detail` to describe that build. The navigation, hero, and final download button all use this configuration. Until an installer URL exists, the page clearly shows that the download is coming soon; it does not link to a missing release.

No installer was published as part of building this website. The Electron app currently packages a local Apple silicon app directory, and GitHub had no releases at the time of creation.

## Design

The download-first structure was informed by https://t3.codes. Copy, styling, and interface preview are original to Consola. The icon is reused from the app. JetBrains Mono is bundled under its included OFL license.
