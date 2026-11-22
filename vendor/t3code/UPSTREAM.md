# t3code, vendored

This folder holds packages copied from t3code, unchanged except where listed
under "Local changes". They keep t3's names, layout and toolchain (Effect 4,
`effect-tsgo`, Vite+), so a later re-sync is a diff rather than a port.

- Upstream: https://github.com/pingdotgg/t3code
- Commit: `d51d8c4766f6c8760d5db9428596b98c4f81eab1` (`d51d8c47`, 2026-11-21)
- Copied: 2026-11-22
- Licence: MIT. `LICENSE` is t3's, verbatim ("Copyright (c) 2026 T3 Tools Inc.").
  Every copied package is MIT; t3 leaves the `license` field unset, so each
  copied `package.json` gains `"license": "MIT"` (below).

## Copied packages

The closure of t3's packaged libraries: the sixteen below, plus every package
they name with a `workspace:` value in `dependencies` or `devDependencies`,
followed until no new package appeared (computed in the clone at `d51d8c47`).
Each directory is copied whole, at the same path it has in t3.

Asked for:

| Package | Path |
|---|---|
| `@t3tools/contracts` | `packages/contracts` |
| `@t3tools/shared` | `packages/shared` |
| `@t3tools/provider-core` | `packages/provider-core` |
| `@t3tools/client-runtime` | `packages/client-runtime` |
| `effect-acp` | `packages/effect-acp` |
| `effect-codex-app-server` | `packages/effect-codex-app-server` |
| `@t3tools/provider-acp` | `packages/provider-acp` |
| `@t3tools/provider-acp-registry` | `packages/provider-acp-registry` |
| `@t3tools/provider-opencode` | `packages/provider-opencode` |
| `@t3tools/provider-pi` | `packages/provider-pi` |
| `@t3tools/provider-cursor` | `packages/provider-cursor` |
| `@t3tools/provider-grok` | `packages/provider-grok` |
| `@t3tools/provider-kiro` | `packages/provider-kiro` |
| `@t3tools/provider-fx` | `packages/provider-fx` |
| `@t3tools/provider-muse` | `packages/provider-muse` |
| `@t3tools/provider-testing` | `packages/provider-testing` |

Pulled in by those (`workspace:` dependencies, transitively):

| Package | Path | First reached from |
|---|---|---|
| `@t3tools/issue-tracker-linear` | `packages/issue-tracker-linear` | `client-runtime` |
| `@t3tools/secret-provider-definitions` | `packages/secret-provider-definitions` | `client-runtime` |
| `@t3tools/secret-provider-core` | `packages/secret-provider-core` | `secret-provider-definitions` |
| `@t3tools/secret-provider-onepassword` | `packages/secret-provider-onepassword` | `secret-provider-definitions` |
| `@t3tools/source-control-core` | `packages/source-control-core` | `client-runtime` |
| `@t3tools/source-control-definitions` | `packages/source-control-definitions` | `client-runtime` |
| `@t3tools/source-control-azure-devops` | `packages/source-control-azure-devops` | `source-control-definitions` |
| `@t3tools/source-control-bitbucket` | `packages/source-control-bitbucket` | `source-control-definitions` |
| `@t3tools/source-control-cursor-origin` | `packages/source-control-cursor-origin` | `source-control-definitions` |
| `@t3tools/source-control-forgejo` | `packages/source-control-forgejo` | `source-control-definitions` |
| `@t3tools/source-control-gitcafe` | `packages/source-control-gitcafe` | `source-control-definitions` |
| `@t3tools/source-control-github` | `packages/source-control-github` | `source-control-definitions` |
| `@t3tools/source-control-gitlab` | `packages/source-control-gitlab` | `source-control-definitions` |
| `@t3tools/source-control-tanstack-source` | `packages/source-control-tanstack-source` | `source-control-definitions` |
| `@t3tools/source-control-testing` | `packages/source-control-testing` | `source-control-azure-devops` (devDependency) |

31 packages, 1497 files. No source file in them imports a t3 file outside this
set by a relative path.

## Copied root files

At the same relative paths, so `../../vite.config.ts` and
`../../tsconfig.base.json` resolve from each package exactly as in t3:

- `LICENSE`
- `tsconfig.base.json`, `tsconfig.effect.json`
- `vite.config.ts`, the test config most packages borrow
  (`vp test run --config ../../vite.config.ts --dir .`)
- `infra/task-cache/src/remoteCache.ts` and `scripts/lib/cached-tests.ts`,
  which `vite.config.ts` imports. Both import only Node built-ins. Neither
  needs a network service when the config loads: `remoteCacheUrl` reads
  `VP_REMOTE_CACHE_URL`, `.task-cache.json` and a credentials file under
  `~/.config/t3-task-cache`, and returns nothing when they are missing, so
  `vite.config.ts` is copied unchanged. `cachedTestTasks` returns nothing
  unless `T3_CACHED_TESTS` is set.

Not copied: t3's `.task-cache.json` (the endpoint of t3's own remote task
cache; without it Vite+ caches locally only), and the rest of `infra/` and
`scripts/`. `vite.config.ts` also names `./oxlint-plugin-t3code/index.ts`,
`@shadcn/lint` and `./apps/web/src` as strings, for `vp lint` and the web
app; nothing here loads them.

## Local changes to copied files

| File | Change | Why |
|---|---|---|
| `packages/*/package.json` (all 31) | Adds the line `"license": "MIT",` after `"private": true,` | t3 leaves `license` unset. Consola's rule is that every `package.json` names its licence, and a copied package keeps t3's MIT. Nothing else in the files changes. |

No other copied file differs from `d51d8c47`.

## Consola's side

Files Consola writes for this folder (not copied):

- `vendor/t3code/package.json`: `@consola/t3code-vendor`, private. It stands
  in for t3's root `package.json` and holds what the copied packages' scripts
  expect at the root: `@effect/tsgo` 0.67.1, `vite-plus` and `@types/node`
  (catalog).
- This file.

In the repository root:

- `patches/`: t3's patch files, byte for byte, for each patched package the
  copied packages install: `@cursor__sdk@1.4.2.patch`,
  `@effect__platform-node-shared@4.1.5.patch`, `@effect__vitest@4.1.5.patch`,
  `@muse-code__sdk@1.4.6.patch`, `@pierre__diffs@1.7.0-beta.4.patch`,
  `mdast-util-math@3.0.0.patch`, `mdast-util-to-hast@13.2.1.patch`,
  `micromark-extension-gfm-table@2.1.1.patch`,
  `micromark-extension-llm-math@3.1.0.patch`, `micromark@4.0.2.patch`.
  pnpm applies a patch to every copy of that version in the workspace, so
  Consola's own `micromark@4.0.2`, `mdast-util-to-hast@13.2.1` and
  `micromark-extension-gfm-table@2.1.1` (the desktop's and the website's
  markdown) get t3's patches too. They cache work (`micromark`,
  `mdast-util-to-hast`) and teach the table tokenizer about math
  (`micromark-extension-gfm-table`), which changes nothing without a math
  extension.
- `pnpm-workspace.yaml`, translating what the copied packages need from t3's
  pnpm 12 settings into pnpm 10's:
  - `packages`: `vendor/t3code` and `vendor/t3code/packages/*`.
  - `catalog`: every entry of t3's catalog a copied `package.json` names with
    `catalog:`, at t3's version.
  - `patchedDependencies`: the ten patches above.
  - `overrides`, each scoped to the edge t3 needs:
    `'@effect/vitest>vitest': '-'` (t3's patch makes `@effect/vitest` import
    `vite-plus/test`); `@opencode/client`, `@opencode/protocol` and
    `@opencode/schema` `>effect: 4.1.5` (OpenCode 2 pins an exact Effect and
    its schemas fail to decode under a second copy; t3 overrides `effect`
    everywhere); and
    `remark-math>micromark-extension-math: npm:micromark-extension-llm-math@3.1.0`
    (t3's math tokenizer).
  - `packageExtensions`: `@effect/vitest` depends on `vite-plus` 1.4.0, as in
    t3, because of the same patch.
  - `peerDependencyRules.allowedVersions`: `vite` is allowed for
    `vitest@5` and `@vitest/mocker@5`. Vite+ runs its Vitest on its own Vite
    build, `@voidzero-dev/vite-plus-core`, whose version (1.4.0) is outside
    Vitest's range. t3 allows any `vite` for every package.
  - `publicHoistPattern: ['@effect/tsgo']`. t3 runs `effect-tsgo` from its
    repository root's `node_modules/.bin`, which pnpm puts on every package
    script's PATH. Here the root is Consola's, so `@effect/tsgo` (held by
    `vendor/t3code/package.json`) is hoisted to put its bin there.
- `biome.jsonc` ignores `vendor`, so Consola's formatter never rewrites the
  copy.
- `.github/workflows/ci.yml`, job `vendor`: installs, then runs every copied
  package's own `typecheck` and `test` scripts, on Linux like t3's CI.

### t3 settings not carried over

- `allowBuilds` (pnpm 11+): no package the copy installs needs an install
  script approved; pnpm 10 reports no new ignored build.
- The global `overrides` t3 uses to pin every patched package, `vite`,
  `@types/node`, `effect` and others for lockfile-free installs. Consola
  installs from its lockfile, and a global pin would move Consola's own
  packages (`vite`, `@types/node`, `yaml`). Where a copied package needed one
  edge, that edge is overridden alone (above).
- `publicHoistPattern: ['@cursor/sdk-*']`, which lets the Cursor SDK find its
  platform binary at runtime. The copied tests do not need it, and nothing
  here runs the Cursor SDK (it is never bundled into anything Consola builds).
- t3's other patches, which are for packages the copy does not install (its
  mobile, desktop and infrastructure). `electron-updater@6.8.9` is installed
  here, but as Consola's desktop's own dependency, so t3's patch for it
  stays out.
- `strictPeerDependencies`, `minimumReleaseAgeExclude`, `permissions`,
  `.pnpmfile.cjs`: install policy for t3's own repository and mobile app.

### Resolved differently from t3's lockfile

pnpm resolves the copied packages' ranges itself here. Direct dependencies
that landed on another version than t3's lockfile has:

- `@opencode-ai/sdk` 1.19.6 (t3: 1.15.13), `provider-opencode`, range `^1.3.15`
- `unbash` 5.1.0 (t3: 5.0.0), `client-runtime`, range `^5.0.0`
- `yaml` 2.9.1 (t3: 2.9.0), catalog range `^2.9.0`

## Tests

Every copied package's `typecheck` passes. Its `test` passes on Linux (CI).
On macOS three of t3's tests fail, as they would in t3 (t3 tests on Linux):

- `shared` `src/shell.test.ts`, "captures values when the profile replaces
  PATH and a DEBUG trap echoes commands": it copies `/usr/bin/printenv` into a
  temporary folder and runs the copy, which macOS kills as it starts
  (SIGKILL; the copy is an Apple platform binary).
- `provider-fx` `src/server/skills.test.ts`, two tests: they compare paths
  under the temporary folder, which macOS reaches through the `/var` →
  `/private/var` symlink. They pass with `TMPDIR` set to its real path.
- `source-control-github` `src/server/GitHubRest.test.ts`, "reports a gh
  timeout as a timeout and does not cache it", fails when `GH_TOKEN` is set in
  the environment, on any OS.

## Re-syncing

Copy the same paths from a newer commit over these, compute the closure again
(new `workspace:` dependencies join it), re-apply the changes listed under
"Local changes", and compare t3's catalog, `patchedDependencies` and the
overrides above with `pnpm-workspace.yaml`.
