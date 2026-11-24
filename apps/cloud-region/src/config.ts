import { z } from 'zod';
import { isRegion, REGIONS } from './domain/region.js';
import type { Region } from './domain/region.js';

/**
 * The workspace's runner and the key its sessions' passes are signed with: the POC's stand-in for
 * enrolling runners (epic 13). Neither the secret nor the key is ever logged.
 */
export type RunnerConfig = {
  /** `RUNNER_SECRET`: what the runner presents to open its socket. */
  secret: string;
  /** `RUNNER_WORKSPACE_ID`: the one workspace the runner serves. */
  workspaceId: string;
  /**
   * `PASS_PRIVATE_KEY`, the JSON object it holds. This parser checks no more than that, since it
   * may use no cryptography; `adapters/token` refuses one that is not an Ed25519 private key.
   */
  passPrivateKey: Record<string, unknown>;
};

export type CellConfig = {
  databaseUrl: string;
  /** The region this copy of the cell serves. Each region runs a copy of its own. */
  region: Region;
  port: number;
  /**
   * `cloud-global`'s origin, with no path. The cell fetches the keys that sign its tokens from
   * there (`CELL_TOKEN_KEYS_PATH`), and trusts no other.
   */
  cloudGlobalUrl: string;
  /** Null when none of the runner's settings is set: then no runner connects, nor session starts. */
  runner: RunnerConfig | null;
};

/** Beside `cloud-global`'s 3100. A second cell on the same machine sets `PORT`. */
export const DEFAULT_PORT = 3101;

/** `cloud-global`'s address in development. */
export const DEFAULT_CLOUD_GLOBAL_URL = 'http://127.0.0.1:3100';

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The configuration is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DATABASE_SCHEMES = ['postgres://', 'postgresql://', 'pglite:'];

// Plain http only on this machine: anyone on the network between the cell and `cloud-global`
// could otherwise hand the cell keys of their own, and then mint any token it would accept.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Why the cell may not fetch `cloud-global`'s keys from `value`, or null when it may. */
function cloudGlobalUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an http or https address';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must be an http or https address';
  }
  if (url.username !== '' || url.password !== '') return 'must not hold a user name or password';
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'must be an address with no path, query or fragment';
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return 'must be https unless it is on this machine (127.0.0.1, localhost or [::1])';
  }
  return null;
}

/** The runner's three settings, which go together: a runner needs the key, and the key a runner. */
const RUNNER_SETTINGS = ['RUNNER_SECRET', 'RUNNER_WORKSPACE_ID', 'PASS_PRIVATE_KEY'] as const;
type RunnerSetting = (typeof RUNNER_SETTINGS)[number];

/** As long as `BETTER_AUTH_SECRET` must be: the secret is all that admits a runner. */
const MIN_RUNNER_SECRET_LENGTH = 32;
const MAKE_A_SECRET = '`openssl rand -base64 32` makes one';
const MAKE_A_PASS_KEY = '`pnpm --filter @consola/cloud-region pass-key:generate` makes one';
/** What a header carries: printable ASCII and no space, since `Bearer <secret>` splits on one. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The JSON object `value` holds, or null. Never `JSON.parse`'s own words, which quote it. */
function jsonObjectOf(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One problem for each runner setting missing beside one that is set; none when all or none are. */
function runnerSettingProblems(values: Record<RunnerSetting, string | undefined>): string[] {
  const set = RUNNER_SETTINGS.filter((name) => values[name] !== undefined);
  if (set.length === 0 || set.length === RUNNER_SETTINGS.length) return [];
  const given = `${set.join(' and ')} ${set.length === 1 ? 'is' : 'are'} set`;
  return RUNNER_SETTINGS.filter((name) => values[name] === undefined).map(
    (name) => `${name}: is required when ${given}: a runner needs all three, or none`,
  );
}

const required = (what: string) =>
  z.string({ error: `${what} is required` }).min(1, `${what} is required`);

const rawEnv = z.object({
  DATABASE_URL: required('a database URL').refine(
    (value) => DATABASE_SCHEMES.some((scheme) => value.startsWith(scheme)),
    'must start with postgres://, postgresql:// or pglite:',
  ),
  // Empty is not a region either, so it gets the one reason, not "is required" as well.
  REGION: z
    .string({ error: 'a region is required' })
    .refine(isRegion, `must be one of ${REGIONS.join(', ')}`),
  PORT: z.coerce
    .number({ error: 'must be a whole number' })
    .int('must be a whole number')
    .min(1, 'must be between 1 and 65535')
    .max(65_535, 'must be between 1 and 65535')
    .optional(),
  CLOUD_GLOBAL_URL: z
    .string()
    .superRefine((value, context) => {
      const problem = cloudGlobalUrlProblem(value);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    })
    .transform((value) => new URL(value).origin)
    .optional(),
  // No message below quotes the value: these are a secret and a private key.
  RUNNER_SECRET: z
    .string()
    .min(MIN_RUNNER_SECRET_LENGTH, `must be at least 32 characters (${MAKE_A_SECRET})`)
    .regex(
      HEADER_SAFE,
      'must be printable ASCII with no spaces, since a runner sends it in a header',
    )
    .optional(),
  RUNNER_WORKSPACE_ID: z.string().optional(),
  PASS_PRIVATE_KEY: z
    .string()
    .transform((value, context) => {
      const key = jsonObjectOf(value);
      if (key) return key;
      context.addIssue({
        code: 'custom',
        message: `must be a JSON Web Key on one line (${MAKE_A_PASS_KEY})`,
      });
      return z.NEVER;
    })
    .optional(),
});

/** An optional variable set to nothing counts as unset. */
const unsetWhenEmpty = (value: string | undefined) => (value === '' ? undefined : value);

export function loadConfig(env: Record<string, string | undefined>): CellConfig {
  const runnerValues = {
    RUNNER_SECRET: unsetWhenEmpty(env.RUNNER_SECRET),
    RUNNER_WORKSPACE_ID: unsetWhenEmpty(env.RUNNER_WORKSPACE_ID),
    PASS_PRIVATE_KEY: unsetWhenEmpty(env.PASS_PRIVATE_KEY),
  };
  const result = rawEnv.safeParse({
    ...env,
    PORT: unsetWhenEmpty(env.PORT),
    CLOUD_GLOBAL_URL: unsetWhenEmpty(env.CLOUD_GLOBAL_URL),
    ...runnerValues,
  });
  const missing = runnerSettingProblems(runnerValues);
  if (!result.success || missing.length > 0) {
    const issues = result.success ? [] : result.error.issues;
    throw new ConfigError([
      ...issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
      ...missing,
    ]);
  }
  const parsed = result.data;
  const {
    RUNNER_SECRET: secret,
    RUNNER_WORKSPACE_ID: workspaceId,
    PASS_PRIVATE_KEY: passPrivateKey,
  } = parsed;
  return {
    databaseUrl: parsed.DATABASE_URL,
    region: parsed.REGION,
    port: parsed.PORT ?? DEFAULT_PORT,
    cloudGlobalUrl: parsed.CLOUD_GLOBAL_URL ?? DEFAULT_CLOUD_GLOBAL_URL,
    runner:
      secret !== undefined && workspaceId !== undefined && passPrivateKey !== undefined
        ? { secret, workspaceId, passPrivateKey }
        : null,
  };
}

/**
 * Why the demo seed (`src/seed.ts`) may not write to the database `databaseUrl` names, or null
 * when it may: only a PGlite folder on this machine, never Postgres (even on localhost, which may
 * be a tunnel to a shared one), and never memory, which the seed's process would take with it.
 */
export function seedRefusal(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('pglite:')) {
    return 'The demo seed writes only to a local PGlite folder (DATABASE_URL=pglite:<folder>), never to Postgres.';
  }
  const location = databaseUrl.slice('pglite:'.length);
  if (location === '' || location === 'memory') {
    return 'The demo seed needs a PGlite folder (DATABASE_URL=pglite:<folder>): a database in memory ends with the seed.';
  }
  return null;
}
