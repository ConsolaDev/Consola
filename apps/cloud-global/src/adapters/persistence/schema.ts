import * as auth from './auth-schema.js';
import * as github from './githubSchema.js';
import * as outbox from './outboxSchema.js';

/**
 * Every table: Better Auth's, generated into `auth-schema.ts`, and Consola's own: the outbox and
 * the GitHub App's installations.
 */
export const schema = { ...auth, ...outbox, ...github };
