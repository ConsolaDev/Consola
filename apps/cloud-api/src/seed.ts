// Writes demo runs for every workspace there is, so the web's Runs pages have something to show
// before a runner records any: `pnpm --filter @consola/cloud-api db:seed`. Local only: it refuses
// any database but a PGlite folder (`seedRefusal`), and refuses to run while anything answers on
// this configuration's port, since PGlite takes one process per folder. It is never reachable over
// HTTP. Seeding again refreshes the same runs (`seedDemoRuns`). It also installs the code review
// team template in each workspace's first team, with a finished agent run of it
// (`seedEveryWorkspace`). The workspaces and their members are read from accounts' `organization`
// and `member` (`createMembershipReader`), by id alone.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMembershipReader } from './accounts/adapters/persistence/membershipReader.js';
import { createDrizzleStores } from './company/adapters/persistence/stores.js';
import { seedEveryWorkspace } from './company/application/seedDemoRuns.js';
import { CODE_REVIEW_TEAM_TEMPLATE } from './company/domain/factoryTemplates.js';
import { ConfigError, loadConfig, seedRefusal } from './config.js';
import type { CloudConfig } from './config.js';
import { migrateDatabase, openDatabase } from './persistence/database.js';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function refuse(why: string): never {
  console.error(`The demo seed did not run: ${why}`);
  process.exit(1);
}

let config: CloudConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  refuse(error.problems.join('; '));
}

const refusal = seedRefusal(config.databaseUrl);
if (refusal !== null) refuse(refusal);

/** Whether anything answers HTTP on the API's port: the API with the folder open, most likely. */
async function apiAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

if (await apiAnswers(config.port)) {
  refuse(
    `something answers on 127.0.0.1:${config.port}, the API most likely. Stop it first: PGlite's folder takes one process at a time.`,
  );
}

const database = openDatabase(config.databaseUrl);
try {
  await migrateDatabase(database);
  const stores = createDrizzleStores(database.company);
  const seeded = await seedEveryWorkspace(
    {
      teams: stores.teams,
      factories: stores.factories,
      runs: stores.runs,
      sessions: stores.cloudSessions,
      membership: createMembershipReader(database.accounts),
    },
    Date.now(),
  );
  if (seeded.length === 0) {
    console.log(
      'There is no workspace yet: sign in to the web app and make one, with the API running, then stop it and seed again.',
    );
  }
  const template = `"${CODE_REVIEW_TEAM_TEMPLATE.name}"`;
  for (const { workspaceId, runs, template: team, agentRun } of seeded) {
    const factories = runs.factories.map((name) => `"${name}"`).join(', ');
    console.log(`${workspaceId}: ${runs.runs} demo runs in ${factories}`);
    console.log(
      team.kind === 'taken'
        ? `${workspaceId}: ${template} is a factory of another team than the first; left alone.`
        : `${workspaceId}: ${template} ${team.kind === 'unchanged' ? 'already holds the template' : team.kind}, at version ${team.version}.`,
    );
    if (agentRun !== null) {
      console.log(
        `${workspaceId}: the demo agent run ${agentRun === 'created' ? 'recorded' : 'was already there'}, in Runs.`,
      );
    }
  }
} finally {
  await database.close();
}
