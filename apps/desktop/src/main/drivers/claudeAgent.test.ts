import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapMcpStatus, probeClaudeMcpServers } from './claudeAgent';
import { CLAUDE_SIGN_IN_HINT } from './claudeTurnReader';

/**
 * The server probe talks to another process, so it runs against real
 * spawned children, as `claudeCapabilities.test.ts` does: each fake CLI is a
 * small Node script standing in for a `claude` that answers in one way.
 */

const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-claude-agent-'));

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

/** An executable that runs `scriptBody` under Node, passing its arguments through. */
function fakeCli(scriptBody: string): string {
  const file = path.join(scriptDir, `cli-${Math.abs(hash(scriptBody))}.cjs`);
  fs.writeFileSync(file, scriptBody, 'utf8');
  const shim = path.join(scriptDir, `shim-${Math.abs(hash(scriptBody))}.sh`);
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`, 'utf8');
  fs.chmodSync(shim, 0o755);
  return shim;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return result;
}

const signInHint = CLAUDE_SIGN_IN_HINT;

describe('mapMcpStatus', () => {
  const ANSWER = {
    mcpServers: [
      {
        name: 'grafana',
        status: 'connected',
        serverInfo: { name: 'grafana-mcp', version: '1.0.0' },
        scope: 'dynamic',
        config: { type: 'stdio', command: 'npx', args: ['-y', 'grafana-mcp'] },
        tools: [{ name: 'query_logs' }, { name: 'list_dashboards' }],
      },
      {
        name: 'claude.ai Coralogix',
        status: 'connected',
        scope: 'claudeai',
        config: { type: 'claudeai-proxy', url: 'https://mcp.coralogix.example/mcp', id: 'c1' },
        tools: [{ name: 'search_logs' }],
      },
      {
        name: 'tracker',
        status: 'needs-auth',
        scope: 'dynamic',
        config: {
          type: 'http',
          url: 'https://tracker.example/mcp',
          headers: { 'X-Team': 'sprocket' },
        },
      },
      {
        name: 'plugin:miro:miro',
        status: 'connected',
        scope: 'plugin',
        config: { type: 'http', url: 'https://mcp.miro.example/' },
      },
      { name: 'odd', status: 'failed', scope: 'local', config: { type: 'ws' } },
    ],
  };

  it('keeps name, source, transport, URL, tools, status and the sign-in hint, and nothing else', () => {
    const report = mapMcpStatus(ANSWER);
    expect(report).toStrictEqual([
      {
        name: 'grafana',
        source: 'user',
        transport: 'stdio',
        tools: ['query_logs', 'list_dashboards'],
        status: 'connected',
        signInHint,
      },
      {
        name: 'claude.ai Coralogix',
        source: 'connector',
        transport: 'claudeai-proxy',
        url: 'https://mcp.coralogix.example/mcp',
        tools: ['search_logs'],
        status: 'connected',
        signInHint,
      },
      {
        name: 'tracker',
        source: 'user',
        transport: 'http',
        url: 'https://tracker.example/mcp',
        status: 'needs-auth',
        signInHint,
      },
      {
        name: 'plugin:miro:miro',
        source: 'plugin',
        transport: 'http',
        url: 'https://mcp.miro.example/',
        status: 'connected',
        signInHint,
      },
      { name: 'odd', source: 'other', transport: 'other', status: 'failed', signInHint },
    ]);
    const kept = JSON.stringify(report);
    for (const dropped of ['npx', 'headers', 'X-Team', 'c1', 'serverInfo', 'grafana-mcp'])
      expect(kept).not.toContain(dropped);
  });

  it('reads tools given as plain strings the same way', () => {
    const [server] = mapMcpStatus({
      mcpServers: [
        {
          name: 'grafana',
          status: 'connected',
          scope: 'dynamic',
          config: { type: 'stdio' },
          tools: ['query_logs', 'list_dashboards'],
        },
      ],
    });
    expect(server.tools).toEqual(['query_logs', 'list_dashboards']);
  });

  it('keeps an empty tool list, and gives no tools when the CLI listed none', () => {
    const [listed, unlisted] = mapMcpStatus({
      mcpServers: [
        { name: 'a', status: 'connected', scope: 'dynamic', config: { type: 'sse' }, tools: [] },
        { name: 'b', status: 'pending', scope: 'dynamic', config: { type: 'stdio' } },
      ],
    });
    expect(listed).toMatchObject({ transport: 'sse', tools: [] });
    expect(unlisted).not.toHaveProperty('tools');
  });

  it('gives a server with no config, or a URL that is no string, the transport other and no URL', () => {
    const [bare, odd] = mapMcpStatus({
      mcpServers: [
        { name: 'bare', status: 'connected', scope: 'dynamic' },
        { name: 'odd', status: 'connected', scope: 'claudeai', config: { type: 'http', url: 7 } },
      ],
    });
    expect(bare).toStrictEqual({
      name: 'bare',
      source: 'user',
      transport: 'other',
      status: 'connected',
      signInHint,
    });
    expect(odd).not.toHaveProperty('url');
  });

  it.each<[string, unknown, RegExp]>([
    ['a non-object', 'nope', /other than an object/],
    ['null', null, /other than an object/],
    ['no server list', { servers: [] }, /without a server list/],
    ['an entry that is no object', { mcpServers: ['grafana'] }, /server it does not recognise/],
    [
      'an entry without a string name',
      { mcpServers: [{ status: 'connected' }] },
      /server it does not recognise/,
    ],
    [
      'an entry without a string status',
      { mcpServers: [{ name: 'grafana', status: 3 }] },
      /server it does not recognise/,
    ],
    [
      'a tool that is neither a name nor an object with one',
      { mcpServers: [{ name: 'grafana', status: 'connected', tools: [{ id: 1 }] }] },
      /a tool of `grafana` it does not recognise/,
    ],
  ])('throws on %s, rather than reporting no servers', (_case, raw, words) => {
    expect(() => mapMcpStatus(raw)).toThrow(words);
  });
});

/**
 * A CLI that answers `initialize`, then each `mcp_status` with `grafana`
 * `pending` until the `readyOn`th request (never, for 0), and logs its argv,
 * its cwd and how many `mcp_status` requests it read to `LOG` when stdin
 * ends or it is killed (it appends one line per request, so a kill loses
 * nothing).
 */
function statusCli(log: string, readyOn: number): string {
  return fakeCli(`
    const fs = require('fs');
    const log = ${JSON.stringify(log)};
    const readyOn = ${readyOn};
    fs.writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
    let asked = 0;
    const lines = require('readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      const reply = (response) => process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response },
      }) + '\\n');
      if (message.request.subtype === 'initialize') return reply({ commands: [] });
      if (message.request.subtype === 'mcp_status') {
        asked += 1;
        fs.appendFileSync(log, 'mcp_status\\n');
        const ready = readyOn > 0 && asked >= readyOn;
        return reply({ mcpServers: [
          { name: 'grafana', status: ready ? 'connected' : 'pending', scope: 'dynamic',
            config: { type: 'stdio', command: 'npx' } },
          { name: 'claude.ai Coralogix', status: 'connected', scope: 'claudeai',
            config: { type: 'claudeai-proxy', url: 'https://mcp.coralogix.example/mcp' } },
        ] });
      }
    });
    setTimeout(() => {}, 60000);
  `);
}

function readLog(log: string): { argv: string[]; cwd: string; statusRequests: number } {
  const [first, ...rest] = fs.readFileSync(log, 'utf8').trim().split('\n');
  const { argv, cwd } = JSON.parse(first) as { argv: string[]; cwd: string };
  return { argv, cwd, statusRequests: rest.filter((line) => line === 'mcp_status').length };
}

const FAST = { everyMs: 20, forMs: 3000, timeoutMs: 6000 };

describe('probeClaudeMcpServers', () => {
  it('asks mcp_status again until no server is pending, from the home folder, under the probe flags', async () => {
    const log = path.join(scriptDir, 'ready-on-3.log');
    const accountFile = path.join(scriptDir, 'account.json');
    const report = await probeClaudeMcpServers(statusCli(log, 3), process.env, accountFile, FAST);

    expect(report.map((server) => [server.name, server.status])).toEqual([
      ['grafana', 'connected'],
      ['claude.ai Coralogix', 'connected'],
    ]);
    const seen = readLog(log);
    expect(seen.statusRequests).toBe(3);
    expect(seen.argv.slice(-7)).toEqual([
      '--restricted',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read',
      '--mcp-config',
      accountFile,
    ]);
    expect(seen.argv).toContain('--no-session-persistence');
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(os.homedir()));
  });

  it('passes no --mcp-config when the harness has no account file', async () => {
    const log = path.join(scriptDir, 'no-account.log');
    await probeClaudeMcpServers(statusCli(log, 1), process.env, null, FAST);

    const { argv } = readLog(log);
    expect(argv).not.toContain('--mcp-config');
    expect(argv.slice(-5)).toEqual([
      '--restricted',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read',
    ]);
  });

  it('reports a server still pending when its wait runs out', async () => {
    const log = path.join(scriptDir, 'never-ready.log');
    const report = await probeClaudeMcpServers(statusCli(log, 0), process.env, null, {
      everyMs: 20,
      forMs: 300,
      timeoutMs: 6000,
    });

    expect(report.find((server) => server.name === 'grafana')?.status).toBe('pending');
    expect(readLog(log).statusRequests).toBeGreaterThan(1);
  });

  it('rejects with what the CLI said when it exits without answering', async () => {
    const cli = fakeCli(`process.stderr.write('unknown subtype mcp_status'); process.exit(2);`);
    await expect(probeClaudeMcpServers(cli, process.env, null, FAST)).rejects.toThrow(
      /unknown subtype mcp_status/,
    );
  });

  it('rejects rather than hanging when no answer ever comes', async () => {
    const cli = fakeCli(`setTimeout(() => {}, 60000);`);
    await expect(
      probeClaudeMcpServers(cli, process.env, null, { ...FAST, timeoutMs: 500 }),
    ).rejects.toThrow(/within 500ms/);
  });

  it('rejects an answer it does not recognise', async () => {
    const cli = fakeCli(`
      const lines = require('readline').createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        const response = message.request.subtype === 'initialize' ? { commands: [] } : { servers: [] };
        process.stdout.write(JSON.stringify({ type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response } }) + '\\n');
      });
      setTimeout(() => {}, 60000);
    `);
    await expect(probeClaudeMcpServers(cli, process.env, null, FAST)).rejects.toThrow(
      /without a server list/,
    );
  });
});
