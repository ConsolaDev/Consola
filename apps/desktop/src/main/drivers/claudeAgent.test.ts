import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skillHash } from '@consola/factory-spec';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildStepPlugin,
  compileClaudeAgent,
  flattenedName,
  listedNames,
  mapMcpStatus,
  probeClaudeMcpServers,
  STEP_PLUGIN_MANIFEST,
  skillDenyRules,
  stepPluginProblem,
} from './claudeAgent';
import { CLAUDE_SIGN_IN_HINT } from './claudeTurnReader';
import type {
  AgentRequirements,
  CheckoutKind,
  CompileHost,
  McpServerReport,
} from './HarnessDriver';

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

/** A folder's regular files, by `/`-separated relative path: what `skillHash` covers. */
function filesOf(dir: string, relative = ''): Array<{ path: string; bytes: Uint8Array }> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of fs.readdirSync(path.join(dir, relative)).sort()) {
    const inside = relative === '' ? entry : `${relative}/${entry}`;
    if (fs.lstatSync(path.join(dir, inside)).isDirectory()) files.push(...filesOf(dir, inside));
    else
      files.push({ path: inside, bytes: new Uint8Array(fs.readFileSync(path.join(dir, inside))) });
  }
  return files;
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
    skillHashes?: Record<string, string>,
  ) =>
    compileClaudeAgent({
      config: { extraArgs: [] },
      harnessName: 'Claude work',
      agent: { tools: 'read-only', mcpServers: [], skills: [], ...agent },
      checkout,
      servers,
      accountFile: ACCOUNT,
      ...(pluginDir !== undefined ? { pluginDir } : {}),
      ...(skillHashes !== undefined ? { skillHashes } : {}),
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

  it("a connector on a run-owned step is offered, as on an item's (slice 3-B)", () => {
    expect(compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'run-owned')).toStrictEqual(
      compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'item'),
    );
    expect(compile({ mcpServers: [{ name: 'claude.ai Coralogix' }] }, 'run-owned').ok).toBe(true);
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
    // With the run's hashes, the grants keep each granted skill's, to check every launch against (review M1).
    const hashes = { 'incident-triage': 'a'.repeat(64), 'release-notes': 'b'.repeat(64) };
    const launched = compile({ skills }, 'item', REPORT, '/runs/r1/look/1/plugin', {
      ...hashes,
      'not-granted': 'c'.repeat(64),
    });
    expect(launched.ok && launched.grants.skillHashes).toStrictEqual(hashes);
    const atApply = compile({ skills });
    expect(atApply.ok && atApply.grants).not.toHaveProperty('pluginDir');
    expect(atApply.ok && atApply.grants).not.toHaveProperty('skillHashes');
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
    // Slice 3-B: a run's own checkout holds what earlier steps wrote.
    [
      'a stdio user server on a run-owned step',
      { mcpServers: [{ name: 'grafana' }] },
      'run-owned',
      null,
      "`grafana` comes from Claude work's own settings, and a step in a run's own checkout starts it, or a helper command it runs for its sign-in, inside that checkout, where `npx`, `uvx` or a relative path can run what is there. A run's checkout holds what earlier steps wrote, and a server started there could run it; use a claude.ai connector.",
    ],
    [
      'a remote user server on a run-owned step',
      { mcpServers: [{ name: 'tracker' }] },
      'run-owned',
      null,
      "`tracker` comes from Claude work's own settings, and a step in a run's own checkout starts it, or a helper command it runs for its sign-in, inside that checkout, where `npx`, `uvx` or a relative path can run what is there. A run's checkout holds what earlier steps wrote, and a server started there could run it; use a claude.ai connector.",
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

describe('skillDenyRules', () => {
  it('denies every skill and command the answer lists but the granted ones', () => {
    expect(
      skillDenyRules(
        {
          commands: [{ name: 'dataviz' }, { name: 'consola-step:incident-triage' }],
          skills: ['simplify'],
        },
        ['incident-triage'],
      ),
    ).toEqual(['Skill(dataviz)', 'Skill(simplify)']);
  });

  it('reads a top-level skills list of objects too, and names each once', () => {
    expect(
      skillDenyRules(
        {
          commands: [{ name: 'clear' }, { name: 'dataviz' }, { name: 'consola-step:a' }],
          skills: [{ name: 'dataviz' }, 'simplify', { name: 'consola-step:a' }],
        },
        ['a'],
      ),
    ).toEqual(['Skill(clear)', 'Skill(dataviz)', 'Skill(simplify)']);
  });

  it('throws when the answer does not list a granted skill: its plugin did not load', () => {
    expect(() => skillDenyRules({ commands: [{ name: 'dataviz' }] }, ['incident-triage'])).toThrow(
      'its answer does not list consola-step:incident-triage.',
    );
  });

  it.each<[string, unknown, string]>([
    ['no command list', { skills: [] }, 'its answer has no command list.'],
    ['no object', 'nope', 'its answer is not an object.'],
    [
      'a command it cannot name',
      { commands: [{ name: 'dataviz' }, { id: 'x' }] },
      'its answer lists a skill or command it does not name.',
    ],
    [
      'a skill it cannot name',
      { commands: [], skills: [{ id: 'x' }] },
      'its answer lists a skill or command it does not name.',
    ],
  ])('throws on %s, rather than denying nothing', (_case, answer, words) => {
    expect(() => skillDenyRules(answer, [])).toThrow(words);
  });
});

describe('buildStepPlugin', () => {
  const make = () => {
    const dir = fs.mkdtempSync(path.join(scriptDir, 'plugin-'));
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'incident-triage', 'refs'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), '# Incident triage\n');
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'queries.md'), 'level:error\n');
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'refs', 'a.md'), 'a\n');
    fs.mkdirSync(path.join(skillsDir, 'release-notes'));
    fs.writeFileSync(path.join(skillsDir, 'release-notes', 'SKILL.md'), '# Release notes\n');
    return { skillsDir, pluginDir: path.join(dir, 'look', '1', 'plugin') };
  };
  const read = (file: string) => fs.readFileSync(file);
  /** Each skill's hash as the run copy holds it: what the definition records. */
  const hashesOf = (skillsDir: string, names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, skillHash(filesOf(path.join(skillsDir, name)))]));

  it('writes the manifest and copies only the asked-for skills, byte for byte', async () => {
    const { skillsDir, pluginDir } = make();
    await buildStepPlugin(
      skillsDir,
      pluginDir,
      ['incident-triage'],
      hashesOf(skillsDir, ['incident-triage']),
    );

    expect(
      JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')),
    ).toEqual(STEP_PLUGIN_MANIFEST);
    expect(STEP_PLUGIN_MANIFEST).toEqual({
      name: 'consola-step',
      description: 'The skills of one automation step, built by Consola.',
      version: '1.0.0',
    });
    for (const file of ['SKILL.md', 'queries.md', path.join('refs', 'a.md')])
      expect(read(path.join(pluginDir, 'skills', 'incident-triage', file))).toEqual(
        read(path.join(skillsDir, 'incident-triage', file)),
      );
    expect(fs.existsSync(path.join(pluginDir, 'skills', 'release-notes'))).toBe(false);
    expect(fs.readdirSync(pluginDir).sort()).toEqual(['.claude-plugin', 'skills']);
  });

  it('builds it fresh: what an earlier build left is gone', async () => {
    const { skillsDir, pluginDir } = make();
    const both = ['incident-triage', 'release-notes'];
    await buildStepPlugin(skillsDir, pluginDir, both, hashesOf(skillsDir, both));
    fs.writeFileSync(path.join(pluginDir, 'skills', 'incident-triage', 'left.md'), 'old\n');
    await buildStepPlugin(
      skillsDir,
      pluginDir,
      ['incident-triage'],
      hashesOf(skillsDir, ['incident-triage']),
    );

    expect(fs.existsSync(path.join(pluginDir, 'skills', 'incident-triage', 'left.md'))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'skills', 'release-notes'))).toBe(false);
  });

  it('rejects a link in the run copy, and leaves no plugin behind', async () => {
    const { skillsDir, pluginDir } = make();
    fs.symlinkSync('/etc/hosts', path.join(skillsDir, 'incident-triage', 'hosts.md'));
    await expect(
      buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], { 'incident-triage': 'x' }),
    ).rejects.toThrow(/not a regular file/);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it('rejects a skill folder that is itself a link', async () => {
    const { skillsDir, pluginDir } = make();
    fs.symlinkSync(path.join(skillsDir, 'release-notes'), path.join(skillsDir, 'linked'));
    await expect(
      buildStepPlugin(skillsDir, pluginDir, ['linked'], { linked: 'x' }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects a skill the run copy does not hold, and a name that is no skill name', async () => {
    const { skillsDir, pluginDir } = make();
    await expect(
      buildStepPlugin(skillsDir, pluginDir, ['missing'], { missing: 'x' }),
    ).rejects.toThrow(/missing/);
    await expect(
      buildStepPlugin(skillsDir, pluginDir, ['../release-notes'], { '../release-notes': 'x' }),
    ).rejects.toThrow(/not a skill name/);
  });

  it('leaves alone a folder at its path that Consola did not build', async () => {
    const { skillsDir, pluginDir } = make();
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'notes.md'), 'mine\n');
    await expect(
      buildStepPlugin(
        skillsDir,
        pluginDir,
        ['incident-triage'],
        hashesOf(skillsDir, ['incident-triage']),
      ),
    ).rejects.toThrow(/did not build/);
    expect(fs.readFileSync(path.join(pluginDir, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses a copy that does not hash to what the run holds, and leaves no plugin behind (review M1)', async () => {
    const { skillsDir, pluginDir } = make();
    const hashes = hashesOf(skillsDir, ['incident-triage']);
    // Written after the engine hashed the run's copy, before the host copied it.
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'queries.md'), 'level:any\n');
    await expect(
      buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], hashes),
    ).rejects.toThrow(
      "skills/incident-triage in the run folder is not the one its run holds, so the step's plugin was not built.",
    );
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(fs.readdirSync(path.dirname(pluginDir))).toEqual([]);
  });

  it('refuses a skill it has no hash for', async () => {
    const { skillsDir, pluginDir } = make();
    await expect(buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], {})).rejects.toThrow(
      /skills\/incident-triage in the run folder is not the one its run holds/,
    );
    expect(fs.existsSync(pluginDir)).toBe(false);
  });
});

describe('stepPluginProblem (review M1)', () => {
  const built = async () => {
    const dir = fs.mkdtempSync(path.join(scriptDir, 'checked-'));
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'incident-triage', 'refs'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), '# Incident triage\n');
    fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'refs', 'a.md'), 'a\n');
    const hashes = {
      'incident-triage': skillHash(filesOf(path.join(skillsDir, 'incident-triage'))),
    };
    const pluginDir = path.join(dir, 'plugin');
    await buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], hashes);
    return { dir, pluginDir, hashes };
  };
  const at = (pluginDir: string, ...parts: string[]) => path.join(pluginDir, ...parts);

  it('is null for the plugin as it was built', async () => {
    const { pluginDir, hashes } = await built();
    expect(stepPluginProblem(pluginDir, ['incident-triage'], hashes)).toBeNull();
  });

  it.each<[string, (pluginDir: string, dir: string) => void]>([
    [
      'a byte changed in a skill',
      (p) => fs.writeFileSync(at(p, 'skills', 'incident-triage', 'SKILL.md'), '# Changed\n'),
    ],
    [
      'a file added to a skill',
      (p) => fs.writeFileSync(at(p, 'skills', 'incident-triage', 'b.md'), 'b\n'),
    ],
    ['a skill added', (p) => fs.mkdirSync(at(p, 'skills', 'stowaway'))],
    [
      'the manifest changed',
      (p) =>
        fs.writeFileSync(
          at(p, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ ...STEP_PLUGIN_MANIFEST, hooks: './hooks.json' }),
        ),
    ],
    [
      'a file beside the manifest',
      (p) => fs.writeFileSync(at(p, '.claude-plugin', 'hooks.json'), '{}'),
    ],
    ['a folder beside skills', (p) => fs.mkdirSync(at(p, 'hooks'))],
    [
      'a skill file swapped for a link to an identical copy',
      (p, dir) => {
        const file = at(p, 'skills', 'incident-triage', 'refs', 'a.md');
        fs.copyFileSync(file, path.join(dir, 'copy.md'));
        fs.rmSync(file);
        fs.symlinkSync(path.join(dir, 'copy.md'), file);
      },
    ],
    [
      'the plugin dir swapped for a link to an identical copy',
      (p, dir) => {
        fs.cpSync(p, path.join(dir, 'copy'), { recursive: true });
        fs.rmSync(p, { recursive: true });
        fs.symlinkSync(path.join(dir, 'copy'), p);
      },
    ],
    ['the plugin dir gone', (p) => fs.rmSync(p, { recursive: true })],
  ])('names %s', async (_label, change) => {
    const { dir, pluginDir, hashes } = await built();
    change(pluginDir, dir);
    expect(stepPluginProblem(pluginDir, ['incident-triage'], hashes)).toEqual(expect.any(String));
  });

  it('names a skill it has no hash for', async () => {
    const { pluginDir } = await built();
    expect(stepPluginProblem(pluginDir, ['incident-triage'], {})).toEqual(expect.any(String));
  });
});

describe('compileClaudeAgent, for a write agent (slice 3-B Task 17)', () => {
  const HOST: CompileHost = {
    platform: 'darwin',
    denyRead: ['/h/Library/Keychains', '/h/.claude-work'],
    cliVersion: '2.1.330',
    settingsFiles: [],
  };
  const CHECKOUT = '/w/catalog-portal-run-3f2a91c0';
  const WRITE_INPUT = {
    config: { extraArgs: [] },
    harnessName: 'Claude work',
    agent: {
      tools: 'write' as const,
      mcpServers: [],
      skills: [],
      environment: {
        name: 'sandboxed',
        isolation: 'sandbox' as const,
        network: ['registry.npmjs.org'],
        env: ['CI'],
      },
    },
    checkout: 'run-owned' as CheckoutKind,
    servers: [] as McpServerReport[],
    accountFile: '/h/.claude-work/.claude.json',
    host: HOST as CompileHost | undefined,
    checkoutPath: CHECKOUT,
  };

  it.each([
    [
      { checkout: 'scope' },
      'A write agent changes code only on a branch the run cuts from one of `repos:` (invariant 9).',
    ],
    [
      { checkout: 'item' },
      'A write agent changes code only on a branch the run cuts from one of `repos:` (invariant 9).',
    ],
    [
      { host: { ...HOST, platform: 'linux' } },
      '`isolation: sandbox` is verified on macOS only so far; this machine runs Linux.',
    ],
    [
      { host: { ...HOST, platform: 'win32' } },
      '`isolation: sandbox` is verified on macOS only so far; this machine runs Windows.',
    ],
    [{ host: undefined }, "can't hold a write agent to its environment"],
  ] as const)('refuses a sandboxed write agent where %j', (over, words) => {
    expect(compileClaudeAgent({ ...WRITE_INPUT, ...over })).toEqual({
      ok: false,
      problem: expect.stringContaining(words),
      about: 'agent',
    });
  });

  it('an edit agent is refused off its run-owned checkout too, read-only ones never are', () => {
    const edit = { ...WRITE_INPUT.agent, tools: 'edit' as const };
    expect(compileClaudeAgent({ ...WRITE_INPUT, agent: edit, checkout: 'scope' })).toMatchObject({
      ok: false,
    });
    expect(
      compileClaudeAgent({
        ...WRITE_INPUT,
        agent: { tools: 'read-only', mcpServers: [], skills: [] },
        checkout: 'scope',
        host: undefined,
      }),
    ).toMatchObject({ ok: true });
  });

  it('a write agent on host compiles off macOS: only `sandbox` is verified on macOS alone', () => {
    const onHost = {
      ...WRITE_INPUT.agent,
      environment: { ...WRITE_INPUT.agent.environment, isolation: 'host' as const },
    };
    expect(
      compileClaudeAgent({ ...WRITE_INPUT, agent: onHost, host: { ...HOST, platform: 'linux' } }),
    ).toMatchObject({ ok: true });
  });

  it('compiles the grants with the CLI version it was compiled for, its sandbox and its file rules', () => {
    expect(compileClaudeAgent(WRITE_INPUT)).toMatchObject({
      ok: true,
      grants: {
        tools: 'write',
        environment: { name: 'sandboxed', isolation: 'sandbox', envNames: ['CI'] },
        sandbox: {
          cliVersion: '2.1.330',
          settings: {
            network: { allowedDomains: ['registry.npmjs.org'] },
            filesystem: { denyRead: HOST.denyRead, denyWrite: [`${CHECKOUT}/.git`] },
          },
        },
        fileDeny: [`Edit(/${CHECKOUT}/.git)`, `Write(/${CHECKOUT}/.git)`],
      },
    });
  });

  it('a write agent on host has no sandbox; at apply, with no checkout yet, no sandbox or file rules either', () => {
    const onHost = {
      ...WRITE_INPUT.agent,
      environment: { ...WRITE_INPUT.agent.environment, isolation: 'host' as const },
    };
    const host = compileClaudeAgent({ ...WRITE_INPUT, agent: onHost });
    expect(host.ok && host.grants.sandbox).toBeUndefined();
    expect(host.ok && host.grants.fileDeny).toEqual([
      `Edit(/${CHECKOUT}/.git)`,
      `Write(/${CHECKOUT}/.git)`,
    ]);
    const { checkoutPath: _, ...atApply } = WRITE_INPUT;
    const applied = compileClaudeAgent(atApply);
    expect(applied).toMatchObject({ ok: true, grants: { tools: 'write' } });
    expect(applied.ok && [applied.grants.sandbox, applied.grants.fileDeny]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("refuses `sandbox` when the harness's own settings set `sandbox`, in Call 24's words (review NS6)", () => {
    expect(
      compileClaudeAgent({
        ...WRITE_INPUT,
        host: {
          ...HOST,
          settingsFiles: [{ path: '/h/.claude-work/settings.json', text: '{"sandbox":{}}' }],
        },
      }),
    ).toEqual({
      ok: false,
      problem:
        "/h/.claude-work/settings.json sets `sandbox`, which Claude may add to this agent's sandbox, and Consola can't check what it changes. Remove it there, or give write agents a harness of their own.",
      about: 'agent',
    });
  });

  it("a read-only agent's grants are what they were: no tools, environment, sandbox or file rules", () => {
    const compiled = compileClaudeAgent({
      ...WRITE_INPUT,
      agent: { tools: 'read-only', mcpServers: [], skills: [] },
    });
    expect(compiled.ok && Object.keys(compiled.grants).sort()).toEqual(
      ['allowedTools', 'driverId', 'servers', 'skills', 'strict'].sort(),
    );
  });
});
