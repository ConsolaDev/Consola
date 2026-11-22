/**
 * t3's web app version, as its build stamps it (`import.meta.env.APP_VERSION`, `vite.config.ts`):
 * t3's `apps/web/package.json` `version` at the commit in `vendor/t3code/UPSTREAM.md` (d51d8c47).
 * t3 releases its web app and server together, at one version, so it equals the lifted server's
 * (`vendor/t3code/apps/server/package.json`), which `t3Version.test.ts` checks.
 */
export const T3_APP_VERSION = '0.1.11';
