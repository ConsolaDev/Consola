// @effect-diagnostics nodeBuiltinImport:off - A file's name decides whether it is a CLI's login.
import { basename } from 'node:path';
import type { ProviderDriver } from '@t3tools/provider-core/server/driver';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as PlatformError from 'effect/PlatformError';
import * as Stream from 'effect/Stream';

/**
 * The files a CLI keeps its login in, which the host never reads: Claude's `.credentials.json`
 * (on Linux and Windows; macOS keeps it in the keychain) and `auth.json` (OpenCode's, Codex's,
 * Pi's). t3's drivers read the first for Claude's reset credits (`claudeResetCredits.ts`) and the
 * second for OpenCode Go's usage (`usageLimits.ts`).
 */
export const isCliCredentialFile = (path: string): boolean => {
  const name = basename(path);
  return name === '.credentials.json' || name === 'auth.json';
};

/**
 * The hosts t3's drivers call with a CLI's login, which the host never calls: Anthropic's API
 * (Claude's OAuth usage and reset-credit claims), OpenCode's (Go usage), and OpenAI's API and
 * login (managed Codex). The CLIs themselves are separate processes and reach them as usual.
 */
export const CREDENTIALED_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
  'opencode.ai',
  'api.openai.com',
  'auth.openai.com',
]);

const NOT_READ = 'The Consola host never reads a CLI’s login; the CLI keeps it.';

const refuseRead = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: 'NotFound',
    module: 'FileSystem',
    method,
    pathOrDescriptor: path,
    description: NOT_READ,
  });

/** `fs`, except that a CLI's login file reads as missing. */
const guardFileSystem = (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...fs,
  readFile: (path) =>
    isCliCredentialFile(path) ? Effect.fail(refuseRead('readFile', path)) : fs.readFile(path),
  readFileString: (path, encoding) =>
    isCliCredentialFile(path)
      ? Effect.fail(refuseRead('readFileString', path))
      : fs.readFileString(path, encoding),
  open: (path, options) =>
    isCliCredentialFile(path) ? Effect.fail(refuseRead('open', path)) : fs.open(path, options),
  stream: (path, options) =>
    isCliCredentialFile(path) ? Stream.fail(refuseRead('stream', path)) : fs.stream(path, options),
  copy: (from, to, options) =>
    isCliCredentialFile(from) ? Effect.fail(refuseRead('copy', from)) : fs.copy(from, to, options),
  copyFile: (from, to) =>
    isCliCredentialFile(from) ? Effect.fail(refuseRead('copyFile', from)) : fs.copyFile(from, to),
});

/** `http`, except that a request to a credentialed host fails before it is sent. */
const guardHttpClient = (http: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    CREDENTIALED_HOSTS.has(url.hostname)
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: NOT_READ }),
          }),
        )
      : http.execute(request),
  );

/** Runs `effect` with a file system that never reads a CLI's login and an HTTP client that never sends one. */
export const withoutCliCredentials = Effect.fn('withoutCliCredentials')(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  return yield* effect.pipe(
    Effect.provideService(FileSystem.FileSystem, guardFileSystem(fs)),
    Effect.provideService(HttpClient.HttpClient, guardHttpClient(http)),
  );
});

/**
 * t3's `driver`, creating its instance with `withoutCliCredentials`: everything the instance does
 * through the file system and HTTP client it captured, its status probe included, is guarded.
 */
export const withoutCliCredentialsDriver = <Config, R, UsageR>(
  driver: ProviderDriver<Config, R, UsageR>,
): ProviderDriver<Config, R | FileSystem.FileSystem | HttpClient.HttpClient, UsageR> => ({
  ...driver,
  create: (input) => withoutCliCredentials(driver.create(input)),
});
