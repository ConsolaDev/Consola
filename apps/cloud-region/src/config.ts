import { z } from 'zod';
import { isRegion, REGIONS, type Region } from './domain/region.js';

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
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

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
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    return 'must be https unless it is on this machine (127.0.0.1, localhost or [::1])';
  }
  return null;
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
    .max(65535, 'must be between 1 and 65535')
    .optional(),
  CLOUD_GLOBAL_URL: z
    .string()
    .superRefine((value, context) => {
      const problem = cloudGlobalUrlProblem(value);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    })
    .transform((value) => new URL(value).origin)
    .optional(),
});

/** An optional variable set to nothing counts as unset. */
const unsetWhenEmpty = (value: string | undefined) => (value === '' ? undefined : value);

export function loadConfig(env: Record<string, string | undefined>): CellConfig {
  const result = rawEnv.safeParse({
    ...env,
    PORT: unsetWhenEmpty(env.PORT),
    CLOUD_GLOBAL_URL: unsetWhenEmpty(env.CLOUD_GLOBAL_URL),
  });
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    region: parsed.REGION as Region,
    port: parsed.PORT ?? DEFAULT_PORT,
    cloudGlobalUrl: parsed.CLOUD_GLOBAL_URL ?? DEFAULT_CLOUD_GLOBAL_URL,
  };
}
