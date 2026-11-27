// Prints a new CONNECTION_SECRETS_KEY: 32 random bytes in base64, the AES-256-GCM key the API
// seals the secrets it keeps for its connections with (a Slack app's client and signing secrets,
// its bot token). Put it in apps/cloud-api/.env, and nowhere else. A sealed secret opens only with
// the key that sealed it, so a new key means setting every factory's Slack app up again.
//
//   pnpm --filter @consola/cloud-api secrets-key:generate
import { randomBytes } from 'node:crypto';

process.stdout.write(`${randomBytes(32).toString('base64')}\n`);
