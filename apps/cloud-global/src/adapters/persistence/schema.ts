import * as auth from './auth-schema.js';
import * as outbox from './outboxSchema.js';

/** Every table: Better Auth's, generated into `auth-schema.ts`, and Consola's own outbox. */
export const schema = { ...auth, ...outbox };
