import { REGIONS, type Region } from '@consola/cloud-contract';
import { z } from 'zod';

/**
 * An Ed25519 private key as a JSON Web Key (RFC 8037): `x` is its public key and `d` its private
 * key, each 32 bytes in base64url.
 */
export type Ed25519PrivateJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; d: string };

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

export type CloudConfig = {
  databaseUrl: string;
  authSecret: string;
  publicUrl: string;
  port: number;
  google: { clientId: string; clientSecret: string };
  /**
   * The key cell tokens and outbox messages are signed with. It is never logged, and never sent
   * anywhere.
   */
  cellTokenPrivateKey: Ed25519PrivateJwk;
  /**
   * Each region's cell, as an origin, from `CELL_URL_<REGION>`. A region with none keeps its
   * outbox messages until one is set.
   */
  cellUrls: Partial<Record<Region, string>>;
  /** Null when none of its settings is set: then nothing can be connected to GitHub. */
  github: GitHubAppConfig | null;
  /**
   * The secret GitHub signs the app's webhook deliveries with (`X-Hub-Signature-256`), the same
   * value as in the app's webhook settings. Null when unset: then every delivery is refused. It
   * is never logged.
   */
  githubWebhookSecret: string | null;
};

/** The variable that names a region's cell: `CELL_URL_EU` for `eu`. */
export function cellUrlVariable(region: Region): string {
  return `CELL_URL_${region.toUpperCase()}`;
}

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

const MAKE_A_KEY = 'make one with `pnpm --filter @consola/cloud-global cell-key:generate`';

/** 32 bytes in unpadded base64url. */
const KEY_BYTES = /^[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The configured private key, as a JWK of exactly `kty`, `crv`, `x` and `d`, or what is wrong
 * with it. Other members (`kid`, `alg`) are dropped: the contract fixes both. Whether `x` really
 * is the public key of `d` takes cryptography, so the signer checks that when it is built. No
 * problem quotes the value, `JSON.parse`'s own words included, since they can.
 */
function readPrivateJwk(
  value: string,
): { ok: true; key: Ed25519PrivateJwk } | { ok: false; problem: string } {
  let jwk: unknown;
  try {
    jwk = JSON.parse(value);
  } catch {
    jwk = undefined;
  }
  if (!isRecord(jwk)) {
    return { ok: false, problem: `must be a JSON Web Key on one line (${MAKE_A_KEY})` };
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    return { ok: false, problem: 'must be an Ed25519 key (`kty` OKP, `crv` Ed25519)' };
  }
  if (jwk.d === undefined) {
    return {
      ok: false,
      problem: `must be a private key, and this one has no \`d\` (${MAKE_A_KEY})`,
    };
  }
  const { x, d } = jwk;
  if (typeof x !== 'string' || !KEY_BYTES.test(x) || typeof d !== 'string' || !KEY_BYTES.test(d)) {
    return { ok: false, problem: '`x` and `d` must each be 32 bytes in base64url' };
  }
  return { ok: true, key: { kty: 'OKP', crv: 'Ed25519', x, d } };
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
  CELL_TOKEN_PRIVATE_KEY: required("the cell token's private key", MAKE_A_KEY).transform(
    (value, ctx) => {
      const read = readPrivateJwk(value);
      if (read.ok) return read.key;
      ctx.addIssue({ code: 'custom', message: read.problem });
      return z.NEVER;
    },
  ),
  PORT: z.coerce
    .number()
    .int('must be a whole number')
    .min(1, 'must be between 1 and 65535')
    .max(65535, 'must be between 1 and 65535')
    .optional(),
});

/** A region's cell, optional, as an origin like `PUBLIC_URL`. */
const cellUrl = z
  .string()
  .refine(
    (value) => originOf(value) !== null,
    'must be an http or https address with no path, query or fragment',
  )
  .transform((value) => originOf(value) as string)
  .optional();

/** One cell variable per region the contract lists, so a new region gets its own. */
const cellEnv: z.ZodType<Record<string, string | undefined>> = z.object(
  Object.fromEntries(REGIONS.map((region) => [cellUrlVariable(region), cellUrl])),
);

/** An optional variable set to nothing is unset, as `.env.example` leaves one. */
const unsetWhenEmpty = (value: string | undefined) => (value === '' ? undefined : value);
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

export function loadConfig(env: Record<string, string | undefined>): CloudConfig {
  const optional = ['PORT', ...REGIONS.map(cellUrlVariable)];
  const input = {
    ...env,
    ...Object.fromEntries(optional.map((name) => [name, unsetWhenEmpty(env[name])])),
  };
  const result = rawEnv.safeParse(input);
  const cellResult = cellEnv.safeParse(input);
  const github = readGitHubApp(env);
  const webhookSecret = readWebhookSecret(env.GITHUB_WEBHOOK_SECRET);
  if (!result.success || !cellResult.success || !github.ok || !webhookSecret.ok) {
    const issues = [
      ...(result.success ? [] : result.error.issues),
      ...(cellResult.success ? [] : cellResult.error.issues),
    ];
    throw new ConfigError([
      ...issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
      ...(github.ok ? [] : github.problems),
      ...(webhookSecret.ok ? [] : [webhookSecret.problem]),
    ]);
  }
  const parsed = result.data;
  const cells: Partial<Record<Region, string>> = {};
  for (const region of REGIONS) {
    const url = cellResult.data[cellUrlVariable(region)];
    if (url !== undefined) cells[region] = url;
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    authSecret: parsed.BETTER_AUTH_SECRET,
    publicUrl: parsed.PUBLIC_URL,
    port: parsed.PORT ?? 3100,
    google: { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET },
    cellTokenPrivateKey: parsed.CELL_TOKEN_PRIVATE_KEY,
    cellUrls: cells,
    github: github.app,
    githubWebhookSecret: webhookSecret.secret,
  };
}
