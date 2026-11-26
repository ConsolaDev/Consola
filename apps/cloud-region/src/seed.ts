// Writes demo runs for every workspace the cell holds, so the web's Runs pages have something to
// show before a runner records any: `pnpm --filter @consola/cloud-region db:seed`. Local only: it
// refuses any database but a PGlite folder (`seedRefusal`), and refuses to run while a cell
// answers on this configuration's port, since PGlite takes one process per folder. It is never
// reachable over HTTP. Seeding again refreshes the same runs (`seedDemoRuns`). It also installs
// the code review team template in each workspace's first team (`seedCodeReviewTeam`).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asc } from 'drizzle-orm';
import { migrateDatabase, openDatabase } from './adapters/persistence/database.js';
import { createDrizzleStores } from './adapters/persistence/stores.js';
import { workspaces } from './adapters/persistence/tables.js';
import { seedDemoRuns } from './application/seedDemoRuns.js';
import { seedCodeReviewTeam } from './application/seedTemplates.js';
import { ConfigError, loadConfig, seedRefusal } from './config.js';
import { CODE_REVIEW_TEAM_TEMPLATE } from './domain/factoryTemplates.js';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function refuse(why: string): never {
  console.error(`The demo seed did not run: ${why}`);
  process.exit(1);
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  refuse(error.problems.join('; '));
}

const refusal = seedRefusal(config.databaseUrl);
if (refusal !== null) refuse(refusal);

/** Whether anything answers HTTP on the cell's port: a cell with the folder open, most likely. */
async function cellAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

if (await cellAnswers(config.port)) {
  refuse(
    `a cell answers on 127.0.0.1:${config.port}. Stop it first: PGlite's folder takes one process at a time.`,
  );
}

const database = openDatabase(config.databaseUrl);
try {
  await migrateDatabase(database.db);
  const stores = createDrizzleStores(database.db);
  const held = await database.db
    .select({ id: workspaces.workspaceId })
    .from(workspaces)
    .orderBy(asc(workspaces.workspaceId));
  if (held.length === 0) {
    console.log(
      'The cell holds no workspace yet: sign in to the web app and make one, with cloud-global and this cell running, then seed again.',
    );
  }
  const now = Date.now();
  for (const { id } of held) {
    const seeded = await seedDemoRuns(stores, id, now);
    if (seeded === 'workspace-pending') continue;
    console.log(
      `${id}: ${seeded.runs} demo runs in ${seeded.factories.map((name) => `"${name}"`).join(', ')}`,
    );
  }
  for (const { id } of held) {
    const team = await seedCodeReviewTeam(stores, id);
    if (team === 'workspace-pending') continue;
    const name = `"${CODE_REVIEW_TEAM_TEMPLATE.name}"`;
    console.log(
      team.kind === 'taken'
        ? `${id}: ${name} is a factory of another team than the first; left alone.`
        : `${id}: ${name} ${team.kind === 'unchanged' ? 'already holds the template' : team.kind}, at version ${team.version}.`,
    );
  }
} finally {
  await database.close();
}
