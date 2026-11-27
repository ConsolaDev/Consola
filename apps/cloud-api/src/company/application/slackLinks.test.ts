import { describe, expect, it } from 'vitest';
import type { SlackLinkRequest } from '../domain/slack.js';
import { requestSlackLink } from './slackLinks.js';
import type { LinkTokens, SlackLinkStore } from './slackPorts.js';

/** A link store that only keeps what it is asked to create. */
function keptRequests(): { links: SlackLinkStore; kept: SlackLinkRequest[] } {
  const kept: SlackLinkRequest[] = [];
  const unused = () => {
    throw new Error('not used here');
  };
  return {
    kept,
    links: {
      createRequest: async (request) => {
        kept.push(request);
      },
      findRequest: unused,
      confirm: unused,
      personOf: unused,
      linksOf: unused,
      unlink: unused,
    },
  };
}

const tokens: LinkTokens = {
  newToken: () => 'sprocket-token_0123456789abcdefghijklmnopqrstu',
  hashOf: (token) => `hash(${token})`,
};

describe('requestSlackLink', () => {
  it('keeps only the hash of a new token, for 15 minutes, and answers its page', async () => {
    const { links, kept } = keptRequests();
    const now = 1_795_000_000;
    const answer = await requestSlackLink(
      { links, tokens, clock: { nowSeconds: () => now } },
      {
        workspaceId: 'sprocket',
        factoryId: 'factory-1',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        channelId: 'C0GENERAL',
      },
      'http://localhost:5175',
    );
    expect(answer).toEqual({
      url: 'http://localhost:5175/#/slack/link/sprocket-token_0123456789abcdefghijklmnopqrstu',
      expiresAt: new Date((now + 15 * 60) * 1000),
    });
    expect(kept).toEqual([
      {
        tokenHash: 'hash(sprocket-token_0123456789abcdefghijklmnopqrstu)',
        workspaceId: 'sprocket',
        factoryId: 'factory-1',
        slackTeamId: 'T0SPROCKET',
        slackUserId: 'U0DANA',
        channelId: 'C0GENERAL',
        createdAt: new Date(now * 1000),
        expiresAt: new Date((now + 15 * 60) * 1000),
        usedAt: null,
      },
    ]);
    expect(JSON.stringify(kept)).not.toContain('"sprocket-token_');
  });
});
