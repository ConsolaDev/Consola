import { sql } from 'drizzle-orm';
import type { HealthProbe } from '../../application/ports.js';
import type { Database } from './database.js';

/** Asks the database for `select 1`; a closed or unreachable one answers false. */
export function createHealthProbe(db: Database): HealthProbe {
  return {
    async databaseAnswers() {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
