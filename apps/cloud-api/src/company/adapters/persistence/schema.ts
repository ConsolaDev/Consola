import * as slackTables from './slackTables.js';
import * as tables from './tables.js';

/** Company's tables, as one schema: `tables.ts`, and Slack's (`slackTables.ts`). */
export const schema = { ...tables, ...slackTables };
