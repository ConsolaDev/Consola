// @effect-diagnostics nodeBuiltinImport:off - The test writes a fake home with a CLI's login.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as HostProcess from '@t3tools/shared/HostProcess';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import type * as Path from 'effect/Path';
import * as Result from 'effect/Result';
import * as ClaudeResetCredits from 't3/provider/claudeResetCredits.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { withoutCliCredentials } from './credentials.ts';
import { HOST_DRIVERS, T3_HOST_DRIVERS } from './drivers.ts';

const DUMMY_TOKEN = 'sprocket-dummy-oauth-token';

/** Every request made through `fetch`, which t3's HTTP client uses; each one is refused. */
const fetched: Array<{ url: string; authorization: string | null }> = [];
beforeAll(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    fetched.push({ url: request.url, authorization: request.headers.get('authorization') });
    return Promise.resolve(new Response('{}', { status: 500 }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  fetched.splice(0);
});

/**
 * A fake home with a signed-in Claude on Linux: `.credentials.json` holding an OAuth token, and
 * `.claude.json` naming the account's organization.
 */
const withClaudeLogin = <A>(use: (configDir: string) => Promise<A>) => {
  const home = mkdtempSync(join(tmpdir(), 'consola-host-login-'));
  const configDir = join(home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: DUMMY_TOKEN } }),
  );
  writeFileSync(
    join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationUuid: '00000000-0000-4000-8000-000000000001' } }),
  );
  return use(configDir).finally(() => rmSync(home, { recursive: true, force: true }));
};

/**
 * What t3's Claude driver runs with the login: its status probe's reset-credit read and its
 * reset-credit claim (`ClaudeDriver.ts`), on a platform that keeps the login in a file.
 */
const claudeResetCredits = (configDir: string) =>
  Effect.all({
    read: ClaudeResetCredits.readClaudeResetCredits(configDir, '2.1.0'),
    claim: ClaudeResetCredits.consumeClaudeResetCredit({
      configDir,
      accountConfigPath: join(configDir, '.claude.json'),
      version: '2.1.0',
      grantId: 'grant_a',
      requestId: 'r-1',
    }).pipe(Effect.result),
  }).pipe(Effect.provideService(HostProcess.Platform, 'linux'));

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );

describe('withoutCliCredentials', () => {
  it('t3 reads the login and calls Anthropic with it when nothing guards it (the control)', () =>
    withClaudeLogin(async (configDir) => {
      await run(claudeResetCredits(configDir));
      expect(fetched.map((request) => new URL(request.url).hostname)).toContain(
        'api.anthropic.com',
      );
      expect(fetched.map((request) => request.authorization)).toContain(`Bearer ${DUMMY_TOKEN}`);
    }));

  it('reads no .credentials.json and calls no api.anthropic.com on a non-darwin platform', () =>
    withClaudeLogin(async (configDir) => {
      const { read, claim } = await run(withoutCliCredentials(claudeResetCredits(configDir)));

      expect(read).toBeUndefined();
      // `signedOut` is t3's answer when it found no token: the file read as missing. With the
      // file read, the token is found and the claim is sent.
      expect(Result.isFailure(claim) && claim.failure).toMatchObject({ reason: 'signedOut' });
      expect(fetched).toEqual([]);
    }));

  it('refuses every credentialed host and every login file, whatever reads it', () =>
    withClaudeLogin(async (configDir) => {
      const outcome = await run(
        withoutCliCredentials(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const http = yield* HttpClient.HttpClient;
            const login = yield* fs
              .readFileString(join(configDir, '.credentials.json'))
              .pipe(Effect.result);
            const account = yield* fs.readFileString(join(configDir, '.claude.json'));
            const requests = yield* Effect.forEach(
              [
                'https://api.anthropic.com/api/oauth/usage',
                'https://opencode.ai/zen/go/v1/usage',
                'https://api.openai.com/v1/models',
              ],
              (url) => http.get(url).pipe(Effect.result),
            );
            return { login, account, requests };
          }),
        ),
      );

      expect(Result.isFailure(outcome.login)).toBe(true);
      // Account metadata is not a credential, and stays readable.
      expect(outcome.account).toContain('organizationUuid');
      expect(outcome.requests.every(Result.isFailure)).toBe(true);
      expect(fetched).toEqual([]);
    }));
});

describe('HOST_DRIVERS', () => {
  it('create every instance under the guard', () => {
    expect(HOST_DRIVERS.map((driver) => driver.driverKind)).toEqual(
      T3_HOST_DRIVERS.map((driver) => driver.driverKind),
    );
    for (const [index, driver] of HOST_DRIVERS.entries()) {
      expect(driver.create).not.toBe(T3_HOST_DRIVERS[index]?.create);
    }
  });

  it('include an OpenCode driver that never reads OpenCode Go usage (Consola’s local change)', () => {
    // The read opens OpenCode's own credential database with node:sqlite, which no guard sees;
    // Consola's copy of the driver turns it off (vendor/t3code/UPSTREAM.md, "Local changes").
    const driver = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../vendor/t3code/packages/provider-opencode/src/server/driver.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(driver).toMatch(/readOpenCodeGoUsageLimits\(\{\s*enabled: false,/);
  });
});
