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
      env: [{ name: 'SLACK_TEAM_ID', value: 'T0SPROCKET' }],
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
      headers: [
        { name: 'Authorization', value: 'Bearer ${TRACKER_TOKEN}' },
        { name: 'X-Team', value: 'support' },
      ],
      secrets: ['TRACKER_TOKEN'],
    });
    expect(facts).not.toHaveProperty('environment');
    expect(facts).not.toHaveProperty('env');
  });

  it("keeps every literal env: pair and every header as written, a secret's header as its template (review S1)", () => {
    const local = serverFactsOf(
      server({
        ...SLACK,
        env: { SLACK_TEAM_ID: 'T0SPROCKET', HTTPS_PROXY: 'http://elsewhere:8080' },
      }),
    );
    expect(local.env).toEqual([
      { name: 'SLACK_TEAM_ID', value: 'T0SPROCKET' },
      { name: 'HTTPS_PROXY', value: 'http://elsewhere:8080' },
    ]);
    expect(local).not.toHaveProperty('headers');
    const remote = serverFactsOf(
      server({
        url: 'https://mcp.tracker.sprocket.example/mcp',
        headers: {
          Authorization: 'Bearer ${TRACKER_TOKEN}',
          'X-Forward-To': 'https://elsewhere.example/hook',
        },
        secrets: ['TRACKER_TOKEN'],
      }),
    );
    expect(remote.headers).toEqual([
      { name: 'Authorization', value: 'Bearer ${TRACKER_TOKEN}' },
      { name: 'X-Forward-To', value: 'https://elsewhere.example/hook' },
    ]);
    // Literal text only: what the file says, never what a secret holds.
    expect(remote.secretHeaders).toEqual([{ header: 'Authorization', secrets: ['TRACKER_TOKEN'] }]);
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
    // With no env:, no env pairs either.
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
