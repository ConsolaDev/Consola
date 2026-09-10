# Distributing desktop updates

Consola uses `electron-updater` with public GitHub Releases in
`ConsolaDev/Consola`. Distributed macOS builds check on startup and every four
hours while running, download newer stable versions, and show an update notice.
Users can also check under **Settings → Updates**. They choose **Restart and
install**, then confirm the restart. Running agents and shell commands stop;
saved workspaces and conversations remain. Updates do not install on ordinary
quit. Offline users receive the update when a later check succeeds.

This is a pull mechanism: publishing makes a release available to all compatible
installed copies; it does not immediately restart every user's app.

## One-time setup

1. Obtain an Apple Developer **Developer ID Application** certificate and export
   it with its private key as a password-protected `.p12`.
2. Add repository Actions secrets: `CSC_LINK` (base64-encoded `.p12`),
   `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (Apple
   app-specific password), and `APPLE_TEAM_ID`.
3. Keep the release repository public so clients can download without a token.
   Never embed a GitHub token in the app. Keep this repository address and the
   app's signing identity stable across releases.

Existing ad-hoc-signed/local builds have no working update path. Users must
install the first signed distribution from its DMG once, into Applications;
subsequent signed releases can update it. Development, test, and local builds
have updates disabled. Distribution currently targets macOS Apple Silicon and
Intel; Windows and Linux packaging are not configured.

## Publish a version

1. Run `npm version patch` (or `minor` / `major`) on a clean release commit.
   This updates package.json and package-lock.json and creates a matching tag.
2. Push the release commit and its `vX.Y.Z` tag. The Desktop release workflow
   checks the version, runs checks, builds signed and notarized DMGs and ZIPs,
   and uploads them to a **draft** GitHub release.
3. Review and test the draft installers. Verify both architectures and that
   `latest-mac.yml`, both ZIPs, DMGs, and generated blockmaps are attached.
   ZIPs and metadata are required for updates; DMGs serve first-time installs.
4. Publish the draft as a normal stable release. Installed apps discover it at
   their next check. Drafts and prereleases are not offered.

The workflow builds both architectures together so one metadata file references
both ZIPs. Signing is mandatory and notarization is enabled for distribution.
`npm run package:distribution` builds the same artifacts locally without
publishing, using the same signing environment variables. `npm run release`
continues to build and install an ad-hoc-signed local copy without updates.

## Verify before first rollout

Install a signed version A on a test Mac. Publish a higher signed version B to
the release feed, then check from A. Verify download progress, canceling the
restart, installing, relaunching on B, and retained workspace/session records.
Also test a failed network request followed by Retry. Unit tests cover update
state and restart guards, but cannot validate Apple's signing and installation
services. A draft does not exercise update discovery; use a separate public
test feed/build configuration if production users already use this feed.

To recover from a bad release, publish a fixed version with a higher version
number. Automatic downgrades are disabled.

## References

- [electron-builder auto-update documentation](https://www.electron.build/docs/features/auto-update/)
- [T3code desktop update service](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/updates/DesktopUpdates.ts)
- [T3code electron-updater adapter](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/electron/ElectronUpdater.ts)
