import { createHash, randomBytes } from 'node:crypto';
import type { LinkTokens } from '../../application/slackPorts.js';
import { SLACK_LINK_TOKEN_BYTES } from '../../domain/slack.js';

/**
 * One-time links' tokens: `SLACK_LINK_TOKEN_BYTES` (32) random bytes in base64url, kept only as
 * their SHA-256 in hex. A token is never logged.
 */
export const linkTokens: LinkTokens = {
  newToken: () => randomBytes(SLACK_LINK_TOKEN_BYTES).toString('base64url'),
  hashOf: (token) => createHash('sha256').update(token, 'utf8').digest('hex'),
};
