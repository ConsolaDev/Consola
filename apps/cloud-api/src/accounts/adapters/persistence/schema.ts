import * as auth from './auth-schema.js';

/**
 * Every table accounts holds: Better Auth's, generated into `auth-schema.ts` (people, their
 * sessions, workspaces and memberships). The company part's tables are its own, and accounts'
 * stores never read them.
 */
export const schema = { ...auth };
