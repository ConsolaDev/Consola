import type { HealthProbe } from './ports.js';

/** Whether the service can do its work: today, whether the database answers. */
export function checkHealth(probe: HealthProbe): Promise<boolean> {
  return probe.databaseAnswers();
}
