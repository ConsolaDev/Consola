// @effect-diagnostics nodeBuiltinImport:off - The test reads the lifted server's package.json.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';
import { T3_APP_VERSION } from './t3Version.ts';

const serverPackage = new URL('../../../vendor/t3code/apps/server/package.json', import.meta.url);

it("stamps the chat with t3's version, the lifted server's", () => {
  const { version } = JSON.parse(readFileSync(serverPackage, 'utf8')) as { version: string };
  expect(T3_APP_VERSION).toBe(version);
});
