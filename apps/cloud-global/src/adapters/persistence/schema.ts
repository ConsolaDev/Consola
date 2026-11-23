import * as auth from './auth-schema.js';
import * as github from './githubSchema.js';
import * as outbox from './outboxSchema.js';
import * as tokenMints from './tokenMintSchema.js';

/**
 * Every table: Better Auth's, generated into `auth-schema.ts`, and Consola's own: the outbox and
 * the GitHub App's installations, and the tokens minted from it.
 */
export const schema = { ...auth, ...outbox, ...github, ...tokenMints };
