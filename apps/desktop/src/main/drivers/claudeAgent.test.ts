import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compileClaudeAgent,
  flattenedName,
  listedNames,
  mapMcpStatus,
  probeClaudeMcpServers,
} from './claudeAgent';
import { CLAUDE_SIGN_IN_HINT } from './claudeTurnReader';
import type { AgentRequirements, CheckoutKind, McpServerReport } from './HarnessDriver';

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

describe('flattenedName', () => {
  it.each([
    ['claude.ai Coralogix', 'claude_ai_Coralogix'],
    ['claude.ai Google Drive', 'claude_ai_Google_Drive'],
    ['plugin:linear:linear', 'plugin_linear_linear'],
    ['query.logs', 'query_logs'],
    ['é-accent', '_-accent'],
    ['grafana', 'grafana'],
    ['a-b_c', 'a-b_c'],
  ])('names %j as Claude does in its rules: %j', (name, flattened) => {
    expect(flattenedName(name)).toBe(flattened);
  });
});

describe('listedNames', () => {
  it('says none for an empty list', () => {
    expect(listedNames([])).toBe('none');
  });

  it('lists up to ten, then how many more', () => {
    expect(listedNames(['grafana', 'tracker'])).toBe('grafana, tracker');
    const twelve = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    expect(listedNames(twelve)).toBe('s1, s2, s3, s4, s5, s6, s7, s8, s9, s10 and 2 more');
    expect(listedNames(twelve.slice(0, 10))).toBe('s1, s2, s3, s4, s5, s6, s7, s8, s9, s10');
  });
});

describe('compileClaudeAgent', () => {
  const ACCOUNT = '/home/alice/.claude-work/.claude.json';
  const REPORT: McpServerReport[] = [
    {
      name: 'grafana',
      source: 'user',
      transport: 'stdio',
      tools: ['query_logs', 'list_dashboards'],
      status: 'connected',
      signInHint,
    },
    {
      name: 'tracker',
      source: 'user',
      transport: 'http',
      url: 'https://tracker.example/mcp',
      tools: ['create_ticket'],
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
      name: 'claude.ai Slack',
      source: 'connector',
      transport: 'claudeai-proxy',
      url: 'https://mcp.slack.example/mcp',
      status: 'needs-auth',
      signInHint,
    },
  ];
  const server = (report: Partial<McpServerReport> & { name: string }): McpServerReport => ({
    source: 'user',
    transport: 'stdio',
    tools: ['ping'],
    status: 'connected',
    signInHint,
    ...report,
  });
  const compile = (
    agent: Partial<AgentRequirements>,
    checkout: CheckoutKind = 'scope',
    servers: readonly McpServerReport[] = REPORT,
    pluginDir?: string,
  ) =>
    compileClaudeAgent({
      config: { extraArgs: [] },
      harnessName: 'Claude work',
      agent: { tools: 'read-only', mcpServers: [], skills: [], ...agent },
      checkout,
      servers,
      accountFile: ACCOUNT,
      ...(pluginDir !== undefined ? { pluginDir } : {}),
    });
  const problemOf = (...args: Parameters<typeof compile>) => {
    const compiled = compile(...args);
    return compiled.ok ? null : compiled.problem;
  };

  it('a user server, on a scope: kept by name, from the account file, strict kept', () => {
    expect(compile({ mcpServers: [{ name: 'grafana' }] })).toStrictEqual({
      ok: true,
      grants: {
        driverId: 'claude',
        servers: [{ name: 'grafana' }],
        skills: [],
        allowedMcpServers: [{ serverName: 'consola' }, { serverName: 'grafana' }],
        strict: true,
        accountFile: ACCOUNT,
        allowedTools: ['mcp__grafana__*'],
      },
      warnings: [],
    });
  });

  it('a connector, on an item: kept by URL, strict dropped, no account file', () => {
    expect(compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'item')).toStrictEqual({
      ok: true,
      grants: {
        driverId: 'claude',
        servers: [{ name: 'claude.ai Coralogix' }],
        skills: [],
        allowedMcpServers: [
          { serverName: 'consola' },
          { serverUrl: 'https://mcp.coralogix.example/mcp' },
        ],
        strict: false,
        allowedTools: ['mcp__claude_ai_Coralogix__*'],
      },
      warnings: [],
    });
  });

  it('a connector, a narrowed stdio server and a remote one: each by its form, in the agent’s order', () => {
    expect(
      compile({
        mcpServers: [
          { name: 'claude.ai Coralogix' },
          { name: 'grafana', tools: ['query_logs'] },
          { name: 'tracker' },
        ],
      }),
    ).toStrictEqual({
      ok: true,
      grants: {
        driverId: 'claude',
        servers: [
          { name: 'claude.ai Coralogix' },
          { name: 'grafana', tools: ['query_logs'] },
          { name: 'tracker' },
        ],
        skills: [],
        allowedMcpServers: [
          { serverName: 'consola' },
          { serverUrl: 'https://mcp.coralogix.example/mcp' },
          { serverName: 'grafana' },
          { serverUrl: 'https://tracker.example/mcp' },
        ],
        strict: false,
        accountFile: ACCOUNT,
        allowedTools: [
          'mcp__claude_ai_Coralogix__*',
          'mcp__grafana__query_logs',
          'mcp__tracker__*',
        ],
      },
      warnings: [],
    });
  });

  it('skills: their allow rules and the plugin dir, and no allow-list', () => {
    const skills = ['incident-triage', 'release-notes'];
    expect(compile({ skills }, 'item', REPORT, '/runs/r1/look/1/plugin')).toStrictEqual({
      ok: true,
      grants: {
        driverId: 'claude',
        servers: [],
        skills,
        strict: true,
        allowedTools: ['Skill(consola-step:incident-triage)', 'Skill(consola-step:release-notes)'],
        pluginDir: '/runs/r1/look/1/plugin',
      },
      warnings: [],
    });
    const atApply = compile({ skills });
    expect(atApply.ok && atApply.grants).not.toHaveProperty('pluginDir');
    // A plugin dir with no skills to build is not granted.
    const none = compile({ mcpServers: [{ name: 'grafana' }] }, 'scope', REPORT, '/p');
    expect(none.ok && none.grants).not.toHaveProperty('pluginDir');
  });

  it('a server and a skill: both rules, servers first', () => {
    const compiled = compile(
      { mcpServers: [{ name: 'claude.ai Coralogix' }], skills: ['incident-triage'] },
      'item',
      REPORT,
      '/p',
    );
    expect(compiled.ok && compiled.grants.allowedTools).toEqual([
      'mcp__claude_ai_Coralogix__*',
      'Skill(consola-step:incident-triage)',
    ]);
  });

  it('a narrowed tool with a dot is flattened in its rule', () => {
    const compiled = compile({ mcpServers: [{ name: 'logs', tools: ['query.logs'] }] }, 'scope', [
      server({ name: 'logs', tools: ['query.logs'] }),
    ]);
    expect(compiled.ok && compiled.grants.allowedTools).toEqual(['mcp__logs__query_logs']);
  });

  it('warns, never refuses, for a server that was not connected', () => {
    expect(compile({ mcpServers: [{ name: 'claude.ai Slack' }] })).toMatchObject({
      ok: true,
      warnings: [
        '`claude.ai Slack` needs you to sign in again in Claude work: run `claude`, then /mcp.',
      ],
    });
    expect(
      compile({ mcpServers: [{ name: 'claude.ai Slack', tools: ['post_message'] }] }),
    ).toMatchObject({
      ok: true,
      warnings: [
        '`claude.ai Slack` needs you to sign in again in Claude work: run `claude`, then /mcp.',
        '`claude.ai Slack` was not connected when Consola asked Claude work, so its tool names could not be checked; a name it does not have grants nothing.',
      ],
    });
    const failed = [server({ name: 'grafana', status: 'failed', tools: undefined })];
    expect(compile({ mcpServers: [{ name: 'grafana' }] }, 'scope', failed)).toMatchObject({
      ok: true,
      warnings: [
        '`grafana` was failed when Consola asked Claude work (run `claude`, then /mcp); a step that uses it fails until it connects.',
      ],
    });
  });

  it.each<[string, Partial<AgentRequirements>, CheckoutKind, McpServerReport[] | null, string]>([
    [
      'a plugin’s server',
      { mcpServers: [{ name: 'plugin:miro:miro' }] },
      'scope',
      null,
      "`plugin:miro:miro` comes from a plugin, which would bring its hooks and skills too. Add the server itself as a user server in Claude work; it will need its own sign-in, since a sign-in belongs to a server's name.",
    ],
    [
      'a name the report lacks',
      { mcpServers: [{ name: 'grafanna' }] },
      'scope',
      null,
      "`grafanna` isn't one of Claude work's MCP servers (it has: grafana, tracker, claude.ai Coralogix, claude.ai Slack). Add it with `claude mcp add --scope user`, or fix the name.",
    ],
    [
      'any name, against an empty report',
      { mcpServers: [{ name: 'grafana' }] },
      'scope',
      [],
      "`grafana` isn't one of Claude work's MCP servers (it has none). Add it with `claude mcp add --scope user`, or fix the name.",
    ],
    [
      'a name in another case than the CLI’s',
      { mcpServers: [{ name: 'Grafana' }] },
      'scope',
      null,
      "`Grafana` isn't one of Claude work's MCP servers (it has: grafana, tracker, claude.ai Coralogix, claude.ai Slack). Add it with `claude mcp add --scope user`, or fix the name.",
    ],
    [
      'a stdio user server on an item step',
      { mcpServers: [{ name: 'grafana' }] },
      'item',
      null,
      "`grafana` comes from Claude work's own settings, and a step on someone else's pull request or issue starts it, or a helper command it runs for its sign-in, inside the author's checkout, where `npx`, `uvx` or a relative path can run the author's code. On item steps, use a claude.ai connector; this server works in scheduled steps.",
    ],
    [
      'a remote user server on an item step',
      { mcpServers: [{ name: 'tracker' }] },
      'item',
      null,
      "`tracker` comes from Claude work's own settings, and a step on someone else's pull request or issue starts it, or a helper command it runs for its sign-in, inside the author's checkout, where `npx`, `uvx` or a relative path can run the author's code. On item steps, use a claude.ai connector; this server works in scheduled steps.",
    ],
    [
      'a source and transport it does not know',
      { mcpServers: [{ name: 'odd' }] },
      'scope',
      [server({ name: 'odd', source: 'other', transport: 'other' })],
      "Consola doesn't know how Claude work loads `odd` (source: other, transport: other), so it can't limit it.",
    ],
    [
      'a source it does not know, on a transport it does',
      { mcpServers: [{ name: 'local-srv' }] },
      'scope',
      [server({ name: 'local-srv', source: 'other' })],
      "Consola doesn't know how Claude work loads `local-srv` (source: other, transport: stdio), so it can't limit it.",
    ],
    [
      'a user server on a transport it does not know, even with a URL',
      { mcpServers: [{ name: 'ws' }] },
      'scope',
      [server({ name: 'ws', transport: 'other', url: 'wss://ws.sprocket.example/mcp' })],
      "Consola doesn't know how Claude work loads `ws` (source: user, transport: other), so it can't limit it.",
    ],
    [
      'a connector reported without a URL',
      { mcpServers: [{ name: 'claude.ai Linear' }] },
      'item',
      [server({ name: 'claude.ai Linear', source: 'connector', transport: 'claudeai-proxy' })],
      "Consola doesn't know how Claude work loads `claude.ai Linear` (source: connector, transport: claudeai-proxy), so it can't limit it.",
    ],
    [
      'a remote user server reported without a URL',
      { mcpServers: [{ name: 'tracker' }] },
      'scope',
      [server({ name: 'tracker', transport: 'http' })],
      "Consola doesn't know how Claude work loads `tracker` (source: user, transport: http), so it can't limit it.",
    ],
    [
      'a narrowed tool the server does not have',
      { mcpServers: [{ name: 'grafana', tools: ['query_log'] }] },
      'scope',
      null,
      '`grafana` has no tool `query_log` (it has: query_logs, list_dashboards).',
    ],
    [
      'a narrowed tool of a connected server with no tools',
      { mcpServers: [{ name: 'grafana', tools: ['query_logs'] }] },
      'scope',
      [server({ name: 'grafana', tools: [] })],
      '`grafana` has no tool `query_logs` (it has none).',
    ],
    [
      'a connector and a user server whose names read as one',
      { mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'claude_ai Coralogix' }] },
      'scope',
      [
        ...REPORT,
        server({
          name: 'claude_ai Coralogix',
          transport: 'http',
          url: 'https://coralogix.sprocket.example/mcp',
        }),
      ],
      '`claude.ai Coralogix` and `claude_ai Coralogix` read as one name to Claude (`mcp__claude_ai_Coralogix__`); rename one in Claude work.',
    ],
    [
      'a connector and a plain-named stdio server that read as one',
      { mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'claude_ai_Coralogix' }] },
      'scope',
      [...REPORT, server({ name: 'claude_ai_Coralogix' })],
      '`claude.ai Coralogix` and `claude_ai_Coralogix` read as one name to Claude (`mcp__claude_ai_Coralogix__`); rename one in Claude work.',
    ],
    [
      'the first refusal, in the agent’s order',
      { mcpServers: [{ name: 'plugin:miro:miro' }, { name: 'grafanna' }] },
      'scope',
      null,
      "`plugin:miro:miro` comes from a plugin, which would bring its hooks and skills too. Add the server itself as a user server in Claude work; it will need its own sign-in, since a sign-in belongs to a server's name.",
    ],
  ])('refuses %s, in words', (_case, agent, checkout, servers, words) => {
    expect(problemOf(agent, checkout, servers ?? REPORT)).toBe(words);
  });

  describe("a stdio user server whose name Claude's allow-list cannot keep (canary row 22)", () => {
    const NAME_WORDS =
      "`grafana.prod` can't be kept by name in Claude's allow-list, which takes only ASCII letters, digits, `_` and `-`, so a step could never load it; rename it in Claude work.";

    it.each([
      'grafana.prod',
      'grafana prod',
      'grafana:prod',
      'grafana+prod',
      'grafana@prod',
      'gráfana',
    ])('refuses %j at compile', (name) => {
      expect(problemOf({ mcpServers: [{ name }] }, 'scope', [server({ name })])).toBe(
        NAME_WORDS.replace('grafana.prod', name),
      );
    });

    it('keeps a name of ASCII letters, digits, `_` and `-` by name', () => {
      const compiled = compile({ mcpServers: [{ name: 'canary_srv-A1' }] }, 'scope', [
        server({ name: 'canary_srv-A1' }),
      ]);
      expect(compiled).toMatchObject({
        ok: true,
        grants: {
          allowedMcpServers: [{ serverName: 'consola' }, { serverName: 'canary_srv-A1' }],
          allowedTools: ['mcp__canary_srv-A1__*'],
        },
      });
    });

    it('is no rule for a remote user server or a connector, which are kept by URL', () => {
      const remote = server({
        name: 'tracker.v2',
        transport: 'http',
        url: 'https://t.example/mcp',
      });
      expect(compile({ mcpServers: [{ name: 'tracker.v2' }] }, 'scope', [remote])).toMatchObject({
        ok: true,
        grants: {
          allowedMcpServers: [{ serverName: 'consola' }, { serverUrl: 'https://t.example/mcp' }],
        },
      });
      expect(compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'item').ok).toBe(true);
    });

    it('comes after the item step’s refusal, whose advice is the one to follow there', () => {
      expect(
        problemOf({ mcpServers: [{ name: 'grafana.prod' }] }, 'item', [
          server({ name: 'grafana.prod' }),
        ]),
      ).toMatch(/^`grafana\.prod` comes from Claude work's own settings/);
    });

    it('comes before an unknown narrowed tool, and before a collision', () => {
      expect(
        problemOf({ mcpServers: [{ name: 'grafana.prod', tools: ['nope'] }] }, 'scope', [
          server({ name: 'grafana.prod' }),
        ]),
      ).toBe(NAME_WORDS);
      expect(
        problemOf(
          { mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'claude_ai Coralogix' }] },
          'scope',
          [...REPORT, server({ name: 'claude_ai Coralogix' })],
        ),
      ).toBe(NAME_WORDS.replace('grafana.prod', 'claude_ai Coralogix'));
    });
  });

  describe("Consola's own server's name", () => {
    const WITH_OWN = [...REPORT, server({ name: 'consola' })];

    it.each<CheckoutKind>(['scope', 'item'])(
      'refuses a granted server called consola (%s)',
      (kind) => {
        expect(problemOf({ mcpServers: [{ name: 'consola' }] }, kind, WITH_OWN)).toBe(
          "`consola` is Consola's own server's name; rename it in Claude work.",
        );
      },
    );

    it('refuses any user server while the profile has a server of its own called consola', () => {
      expect(problemOf({ mcpServers: [{ name: 'grafana' }] }, 'scope', WITH_OWN)).toBe(
        "Claude work has a server of its own named `consola`, which is Consola's own server's name, so a step can't load Claude work's own servers beside it; rename it in Claude work.",
      );
    });

    it('lets a connector through on an item, where no account file is loaded', () => {
      expect(compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'item', WITH_OWN).ok).toBe(
        true,
      );
    });
  });

  it('compiles an agent that names nothing to no grants', () => {
    expect(compile({})).toStrictEqual({
      ok: true,
      grants: { driverId: 'claude', servers: [], skills: [], strict: true, allowedTools: [] },
      warnings: [],
    });
  });
});
