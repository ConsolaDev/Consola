import { z } from 'zod';
import { isRegion, REGIONS, type Region } from './domain/region.js';

export type CellConfig = {
  databaseUrl: string;
  /** The region this copy of the cell serves. Each region runs a copy of its own. */
  region: Region;
  port: number;
};

/** Beside `cloud-global`'s 3100. A second cell on the same machine sets `PORT`. */
export const DEFAULT_PORT = 3101;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The configuration is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DATABASE_SCHEMES = ['postgres://', 'postgresql://', 'pglite:'];

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
});

export function loadConfig(env: Record<string, string | undefined>): CellConfig {
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
    region: parsed.REGION as Region,
    port: parsed.PORT ?? DEFAULT_PORT,
  };
}
