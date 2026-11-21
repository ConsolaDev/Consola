import { z } from 'zod';

export type CloudConfig = {
  databaseUrl: string;
  authSecret: string;
  publicUrl: string;
  port: number;
  google: { clientId: string; clientSecret: string };
  organization: { name: string; slug: string };
};

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

const required = (what: string) =>
  z.string({ error: `${what} is required` }).min(1, `${what} is required`);

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
  ORG_NAME: required('an organisation name'),
  ORG_SLUG: required('an organisation slug').regex(
    /^[a-z0-9-]+$/,
    'must be lowercase letters, digits and dashes',
  ),
  PORT: z.coerce
    .number()
    .int('must be a whole number')
    .min(1, 'must be between 1 and 65535')
    .max(65535, 'must be between 1 and 65535')
    .optional(),
});

export function loadConfig(env: Record<string, string | undefined>): CloudConfig {
  const result = rawEnv.safeParse({
    ...env,
    PORT: env.PORT === undefined || env.PORT === '' ? undefined : env.PORT,
  });
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    authSecret: parsed.BETTER_AUTH_SECRET,
    publicUrl: parsed.PUBLIC_URL,
    port: parsed.PORT ?? 3100,
    google: { clientId: parsed.GOOGLE_CLIENT_ID, clientSecret: parsed.GOOGLE_CLIENT_SECRET },
    organization: { name: parsed.ORG_NAME, slug: parsed.ORG_SLUG },
  };
}
