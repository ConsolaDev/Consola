import { z } from 'zod';
import { isRegion, REGIONS } from './shared/region.js';
import type { Region } from './shared/region.js';

/**
 * Consola's GitHub App: its client ID (which also names the app in the tokens it signs, as
 * GitHub recommends), its client secret, the slug in its public address, and where its private
 * key's `.pem` file is. The key itself is read when the service is built.
 */
export type GitHubAppConfig = {
  clientId: string;
  clientSecret: string;
  slug: string;
  privateKeyPath: string;
};

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
   * may use no cryptography; `company/adapters/token` refuses one that is not an Ed25519 private
   * key.
   */
  passPrivateKey: Record<string, unknown>;
};

/**
 * Which session host addresses the app calls itself (a follow-up): the host names a session's host
 * may be under, and whether its runner's sandboxes run on this machine. The rule that reads them is
 * company's `hostAddressAllowed`.
 */
export type SandboxHostsConfig = {
  /** `SANDBOX_HOST_SUFFIXES`, lowercase: `e2b.app` when unset. */
  suffixes: string[];
  /** `LOCAL_SANDBOXES`: whether `http:` on loopback is a session's host. False when unset. */
  local: boolean;
};

export type CloudConfig = {
  databaseUrl: string;
  authSecret: string;
  publicUrl: string;
  port: number;
  /** The deployment's region (`REGION`), which every new workspace is made in. */
  region: Region;
  google: { clientId: string; clientSecret: string };
  /** Null when none of its settings is set: then nothing can be connected to GitHub. */
  github: GitHubAppConfig | null;
  /**
   * The secret GitHub signs the app's webhook deliveries with (`X-Hub-Signature-256`), the same
   * value as in the app's webhook settings. Null when unset: then every delivery is refused. It
   * is never logged.
   */
  githubWebhookSecret: string | null;
  /** Null when none of the runner's settings is set: then no runner connects, nor session starts. */
  runner: RunnerConfig | null;
  /** Where the app may call a session's host itself. */
  sandboxHosts: SandboxHostsConfig;
};

/** Where the web app's dev proxy, the runner and the webhook tunnel expect the API. */
export const DEFAULT_PORT = 3100;

/** The region of a deployment that names none. */
export const DEFAULT_REGION: Region = 'eu';

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The configuration is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DATABASE_SCHEMES = ['postgres://', 'postgresql://', 'pglite:'];

/** An http(s) address with no path, query or hash beyond a single `/`, returned without it. */
function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

const required = (what: string, hint?: string) => {
  const message = hint ? `${what} is required (${hint})` : `${what} is required`;
  return z.string({ error: message }).min(1, message);
};

/** The runner's three settings, which go together: a runner needs the key, and the key a runner. */
const RUNNER_SETTINGS = ['RUNNER_SECRET', 'RUNNER_WORKSPACE_ID', 'PASS_PRIVATE_KEY'] as const;
type RunnerSetting = (typeof RUNNER_SETTINGS)[number];

/** As long as `BETTER_AUTH_SECRET` must be: the secret is all that admits a runner. */
const MIN_RUNNER_SECRET_LENGTH = 32;
const MAKE_A_SECRET = '`openssl rand -base64 32` makes one';
const MAKE_A_PASS_KEY = '`pnpm --filter @consola/cloud-api pass-key:generate` makes one';
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

const rawEnv = z.object({
  DATABASE_URL: required('a database URL').refine(
    (value) => DATABASE_SCHEMES.some((scheme) => value.startsWith(scheme)),
    'must start with postgres://, postgresql:// or pglite:',
  ),
  BETTER_AUTH_SECRET: required('a secret').min(32, 'must be at least 32 characters'),
  PUBLIC_URL: required('the public address')
    .refine(
      (value) => originOf(value) !== null,
      'must be an http or https address with no path, query or fragment',
    )
    .transform((value) => originOf(value) as string),
  GOOGLE_CLIENT_ID: required('a Google client ID'),
  GOOGLE_CLIENT_SECRET: required('a Google client secret'),
  REGION: z
    .string()
    .refine(isRegion, `must be one of ${REGIONS.join(', ')}`)
    .optional(),
  PORT: z.coerce
    .number({ error: 'must be a whole number' })
    .int('must be a whole number')
    .min(1, 'must be between 1 and 65535')
    .max(65_535, 'must be between 1 and 65535')
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

/** An optional variable set to nothing is unset, as `.env.example` leaves one. */
const unsetWhenEmpty = (value: string | undefined) => (value === '' ? undefined : value);

/** The variables that are optional one by one, each unset when empty. */
const OPTIONAL = ['REGION', 'PORT', ...RUNNER_SETTINGS] as const;

/** The GitHub App's settings: all of them or none, so a half-made app never starts. */
const GITHUB_SETTINGS = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY_PATH',
] as const;

/** The shortest webhook secret taken: `openssl rand -hex 32` makes one of 64 characters. */
const WEBHOOK_SECRET_MIN = 32;

/**
 * The webhook secret, null when unset or empty, or what is wrong with it, never quoting it. It
 * is taken exactly as written, since GitHub signs with it byte for byte.
 */
function readWebhookSecret(
  value: string | undefined,
): { ok: true; secret: string | null } | { ok: false; problem: string } {
  if (value === undefined || value === '') return { ok: true, secret: null };
  if (value.length < WEBHOOK_SECRET_MIN) {
    return {
      ok: false,
      problem: `GITHUB_WEBHOOK_SECRET: must be at least ${WEBHOOK_SECRET_MIN} characters (make one with \`openssl rand -hex 32\`, and set the same value in the GitHub App's webhook settings)`,
    };
  }
  return { ok: true, secret: value };
}

/** E2B's exposed ports, `https://<port>-<sandbox>.e2b.app`: the suffix a deployment expects. */
const DEFAULT_SANDBOX_HOST_SUFFIXES = ['e2b.app'];

/** A host name of two labels or more, whose last is no number: never an IP address or a URL. */
const HOST_SUFFIX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `SANDBOX_HOST_SUFFIXES` (a comma list of host names, lowercased; `e2b.app` when unset or empty)
 * and `LOCAL_SANDBOXES` (`true` or `false`; false when unset or empty), or what is wrong with them.
 */
function readSandboxHosts(
  env: Record<string, string | undefined>,
): { ok: true; hosts: SandboxHostsConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const listed = (env.SANDBOX_HOST_SUFFIXES ?? '')
    .split(',')
    .map((each) => each.trim().toLowerCase())
    .filter((each) => each !== '');
  if (listed.some((each) => !HOST_SUFFIX.test(each))) {
    problems.push(
      'SANDBOX_HOST_SUFFIXES: must be host names separated by commas, such as e2b.app, with no scheme, port or leading dot',
    );
  }
  const local = (env.LOCAL_SANDBOXES ?? '').trim();
  if (local !== '' && local !== 'true' && local !== 'false') {
    problems.push('LOCAL_SANDBOXES: must be true or false');
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    hosts: {
      suffixes: listed.length > 0 ? listed : [...DEFAULT_SANDBOX_HOST_SUFFIXES],
      local: local === 'true',
    },
  };
}

/** Lowercase letters and digits, with single dashes between: how GitHub spells an app's slug. */
const GITHUB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The GitHub App's settings, null when none is set, or what is wrong with them. An empty value
 * counts as unset, since the example `.env` lists each one empty.
 */
function readGitHubApp(
  env: Record<string, string | undefined>,
): { ok: true; app: GitHubAppConfig | null } | { ok: false; problems: string[] } {
  const value = (name: (typeof GITHUB_SETTINGS)[number]) => env[name]?.trim() ?? '';
  const missing = GITHUB_SETTINGS.filter((name) => value(name) === '');
  if (missing.length === GITHUB_SETTINGS.length) return { ok: true, app: null };

  const problems = missing.map(
    (name) =>
      `${name}: is required once any of the GitHub App's settings is set (set all of ${GITHUB_SETTINGS.join(', ')}, or none)`,
  );
  const slug = value('GITHUB_APP_SLUG');
  if (slug !== '' && !GITHUB_SLUG.test(slug)) {
    problems.push(
      "GITHUB_APP_SLUG: must be the name in the app's address, github.com/apps/<slug> (lowercase letters, digits and dashes)",
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    app: {
      clientId: value('GITHUB_APP_CLIENT_ID'),
      clientSecret: value('GITHUB_APP_CLIENT_SECRET'),
      slug,
      privateKeyPath: value('GITHUB_APP_PRIVATE_KEY_PATH'),
    },
  };
}

/**
 * The configuration, from the environment, or a `ConfigError` naming every problem at once. It
 * is a pure parser: it reads no file and touches nothing, and no problem it names quotes a
 * secret, a key or `JSON.parse`'s own words.
 */
export function loadConfig(env: Record<string, string | undefined>): CloudConfig {
  const input = {
    ...env,
    ...Object.fromEntries(OPTIONAL.map((name) => [name, unsetWhenEmpty(env[name])])),
  };
  const result = rawEnv.safeParse(input);
  const runnerMissing = runnerSettingProblems({
    RUNNER_SECRET: input.RUNNER_SECRET,
    RUNNER_WORKSPACE_ID: input.RUNNER_WORKSPACE_ID,
    PASS_PRIVATE_KEY: input.PASS_PRIVATE_KEY,
  });
  const github = readGitHubApp(env);
  const webhookSecret = readWebhookSecret(env.GITHUB_WEBHOOK_SECRET);
  const sandboxHosts = readSandboxHosts(env);
  if (
    !result.success ||
    runnerMissing.length > 0 ||
    !github.ok ||
    !webhookSecret.ok ||
    !sandboxHosts.ok
  ) {
    const issues = result.success ? [] : result.error.issues;
    throw new ConfigError([
      ...issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
      ...runnerMissing,
      ...(github.ok ? [] : github.problems),
      ...(webhookSecret.ok ? [] : [webhookSecret.problem]),
      ...(sandboxHosts.ok ? [] : sandboxHosts.problems),
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
    authSecret: parsed.BETTER_AUTH_SECRET,
    publicUrl: parsed.PUBLIC_URL,
    port: parsed.PORT ?? DEFAULT_PORT,
    region: parsed.REGION ?? DEFAULT_REGION,
    google: { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET },
    github: github.app,
    githubWebhookSecret: webhookSecret.secret,
    runner:
      secret !== undefined && workspaceId !== undefined && passPrivateKey !== undefined
        ? { secret, workspaceId, passPrivateKey }
        : null,
    sandboxHosts: sandboxHosts.hosts,
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
