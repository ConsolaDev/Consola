import { parseMcpServers } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { SERVER_ENV_ALLOW_LIST, serverFactsOf } from './serverFacts';

/** One server as `factory.yml`'s `mcpServers:` parses it (a parse table: nothing here starts it). */
function server(raw: Record<string, unknown>) {
  const issues: string[] = [];
  const parsed = parseMcpServers({ it: raw }, (message) => issues.push(message));
  expect(issues).toEqual([]);
  return parsed.servers.it;
}

const SLACK = {
  description: "Posts to Sprocket's Slack as the support bot.",
  command: 'npx',
  args: ['-y', '@sprocket/slack-mcp@1.4.2'],
  env: { SLACK_TEAM_ID: 'T0SPROCKET' },
  secrets: ['SLACK_BOT_TOKEN'],
};

describe('serverFactsOf', () => {
  it("says what the spec's slack starts, with what, and that a launcher fetches it", () => {
    expect(serverFactsOf(server(SLACK))).toEqual({
      name: 'it',
      transport: 'stdio',
      description: "Posts to Sprocket's Slack as the support bot.",
      target: 'npx -y @sprocket/slack-mcp@1.4.2',
      environment: [
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'PATH',
        'TERM',
        'LANG',
        'LC_*',
        'TMPDIR',
        'SLACK_TEAM_ID',
        'SLACK_BOT_TOKEN',
      ],
      launcher: true,
      secrets: ['SLACK_BOT_TOKEN'],
    });
  });

  it('warns of a package with no exact version', () => {
    expect(serverFactsOf(server({ ...SLACK, args: ['-y', '@sprocket/slack-mcp'] }))).toMatchObject({
      launcher: true,
      unpinned: true,
    });
  });

  it("names a remote server's URL and the headers its secrets make", () => {
    const facts = serverFactsOf(
      server({
        url: 'https://mcp.tracker.sprocket.example/mcp',
        headers: { Authorization: 'Bearer ${TRACKER_TOKEN}', 'X-Team': 'support' },
        secrets: ['TRACKER_TOKEN'],
      }),
    );
    expect(facts).toEqual({
      name: 'it',
      transport: 'http',
      target: 'https://mcp.tracker.sprocket.example/mcp',
      secretHeaders: [{ header: 'Authorization', secrets: ['TRACKER_TOKEN'] }],
      secrets: ['TRACKER_TOKEN'],
    });
    expect(facts).not.toHaveProperty('environment');
  });

  it("names only the server's own secrets in a header, whatever a hand-built one holds", () => {
    expect(
      serverFactsOf({
        name: 'it',
        transport: 'http',
        url: 'https://mcp.tracker.sprocket.example/mcp',
        headers: { Authorization: 'Bearer ${TRACKER_TOKEN}', 'X-Other': '${PAGER_TOKEN}' },
        secrets: ['TRACKER_TOKEN'],
      }).secretHeaders,
    ).toEqual([{ header: 'Authorization', secrets: ['TRACKER_TOKEN'] }]);
  });

  it('says nothing of a launcher for an installed program, nor of pnpm without dlx', () => {
    expect(serverFactsOf(server({ command: '/opt/sprocket/bin/slack-mcp' }))).toEqual({
      name: 'it',
      transport: 'stdio',
      target: '/opt/sprocket/bin/slack-mcp',
      environment: [...SERVER_ENV_ALLOW_LIST],
    });
    expect(
      serverFactsOf(server({ command: 'pnpm', args: ['exec', 'slack-mcp'] })),
    ).not.toHaveProperty('launcher');
    expect(
      serverFactsOf(server({ command: 'pnpm', args: ['dlx', '@sprocket/slack-mcp@1.4.2'] })),
    ).toMatchObject({ launcher: true });
  });
});
