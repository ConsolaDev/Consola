import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  askSkillDenyRules,
  MCP_STATUS,
  mapMcpStatus,
  probeClaudeMcpServers,
} from '../drivers/claudeAgent';
import { INITIALIZE, requestControl } from '../drivers/claudeCapabilities';
import { claudeSettings } from '../drivers/claudeHooks';
import { CLAUDE_SIGN_IN_HINT } from '../drivers/claudeTurnReader';

/*
 * The stub `claude` the end-to-end specs drive (`tests/fixtures/claude-steps.cjs`),
 * in print mode with `--output-format stream-json`: what a step's reporting turn
 * reads, and that a turn without that flag is exactly what it was.
 */

const STUB = path.resolve(__dirname, '../../../tests/fixtures/claude-steps.cjs');
const REPORT = ['--output-format', 'stream-json', '--verbose'];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steps-stub-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const turn = (env: Record<string, string>, extra: string[] = REPORT) => {
  const config = scratch();
  return spawnSync(process.execPath, [STUB, '-p', '--session-id', 's1', ...extra, '--', 'hi'], {
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, ...env },
    encoding: 'utf8',
  });
};

const jsonLines = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const readLog = (file: string) => fs.readFileSync(file, 'utf8').trimEnd().split('\n');

/** A stdio MCP server that answers every tool call, but fails `failTool`'s; `echo` puts each call's arguments in its answer. */
function fakeConsola(dir: string, failTool = '', echo = false): string {
  const server = path.join(dir, 'fake-consola.cjs');
  fs.writeFileSync(
    server,
    `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
      : message.params.name === ${JSON.stringify(failTool)}
        ? { content: [{ type: 'text', text: 'No such output: x\\nmore' }], isError: true }
        : { content: [{ type: 'text', text: 'ok ' + message.params.name + (${JSON.stringify(echo)} ? ' ' + JSON.stringify(message.params.arguments) : '') }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`,
  );
  const config = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    config,
    JSON.stringify({ mcpServers: { consola: { command: process.execPath, args: [server] } } }),
  );
  return config;
}

// Each test spawns Node at least once; a loaded machine is slow to.
describe('the stub claude in stream-json', { timeout: 30_000 }, () => {
  it('prints init first and a result last in stream-json', () => {
    const { stdout, status } = turn({ STUB_CLAUDE_COST: '0.02' });
    const lines = stdout.trim().split('\n');
    expect(JSON.parse(lines[0])).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-stub-1',
      mcp_servers: [{ name: 'consola', status: 'connected' }],
      tools: ['Read', 'Grep', 'Glob'],
    });
    expect(Object.keys(JSON.parse(lines.at(-1) ?? '{}'))[0]).toBe('duration_api_ms');
    expect(JSON.parse(lines.at(-1) ?? '{}')).toEqual({
      duration_api_ms: 0,
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.02,
      result: 'FINDINGS: done',
      permission_denials: [],
      api_error_status: null,
      session_id: 's1',
    });
    expect(lines).toHaveLength(2);
    expect(status).toBe(0);
  });

  it('takes its model, turns and cost from the knobs, with defaults', () => {
    const named = jsonLines(
      turn({ STUB_CLAUDE_MODEL: 'claude-opus-5-5', STUB_CLAUDE_TURNS: '7' }).stdout,
    );
    expect(named[0].model).toBe('claude-opus-5-5');
    expect(named.at(-1)).toMatchObject({ num_turns: 7, total_cost_usd: 0.0123 });
  });

  it('a comma list gives each turn of a conversation its own value, the last once it runs out', () => {
    const dir = scratch();
    const config = scratch();
    const log = path.join(dir, 'claude.log');
    const env = {
      STUB_CLAUDE_LOG: log,
      STUB_CLAUDE_COST: '0.0015,0.003',
      STUB_CLAUDE_TURNS: '3,2',
    };
    const cost = (...flags: string[]) =>
      jsonLines(
        spawnSync(process.execPath, [STUB, '-p', ...flags, ...REPORT, '--', 'hi'], {
          env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, ...env },
          encoding: 'utf8',
        }).stdout,
      ).at(-1);
    // The real CLI's `total_cost_usd` is the conversation's running total (canary row 14).
    expect(cost('--session-id', 'c1')).toMatchObject({ total_cost_usd: 0.0015, num_turns: 3 });
    expect(cost('--resume', 'c1')).toMatchObject({ total_cost_usd: 0.003, num_turns: 2 });
    expect(cost('--resume', 'c1')).toMatchObject({ total_cost_usd: 0.003, num_turns: 2 });
    // Another conversation starts the list again.
    expect(cost('--session-id', 'c2')).toMatchObject({ total_cost_usd: 0.0015, num_turns: 3 });
  });

  it('error_max_turns is an error with no result text', () => {
    const { stdout, status } = turn({ STUB_CLAUDE_SUBTYPE: 'error_max_turns' });
    const result = jsonLines(stdout).at(-1);
    expect(result).toMatchObject({ type: 'result', subtype: 'error_max_turns', is_error: true });
    expect(result).not.toHaveProperty('result');
    expect(status).toBe(1);
  });

  it('another subtype is an error that keeps its findings line', () => {
    const { stdout, status } = turn({ STUB_CLAUDE_SUBTYPE: 'error_during_execution' });
    expect(jsonLines(stdout).at(-1)).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'FINDINGS: done',
    });
    expect(status).toBe(1);
  });

  it('a usage limit says so twice', () => {
    const { stdout, status } = turn({ STUB_CLAUDE_LIMIT: '1' });
    const events = jsonLines(stdout);
    const limit = "You've hit your limit · resets 3pm (Europe/Madrid)";
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: limit }] },
    });
    expect(events[2]).toMatchObject({ type: 'result', is_error: true, result: limit });
    expect(status).toBe(1);
  });

  it('stderr is a line of its own', () => {
    const { stdout, stderr, status } = turn({ STUB_CLAUDE_STDERR: 'Warning: stub' });
    expect(stderr).toBe('Warning: stub\n');
    expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'result', is_error: false });
    expect(status).toBe(0);
  });

  it('denied tools are listed', () => {
    const { stdout, status } = turn({ STUB_CLAUDE_DENIED: 'Read,Grep' });
    expect(jsonLines(stdout).at(-1)).toMatchObject({
      is_error: false,
      permission_denials: [
        { tool_name: 'Read', tool_use_id: 'toolu_denied_1', tool_input: {} },
        { tool_name: 'Grep', tool_use_id: 'toolu_denied_2', tool_input: {} },
      ],
    });
    expect(status).toBe(0);
  });

  it('prints a tool_use before each tool it calls', () => {
    const dir = scratch();
    const outputs = path.join(dir, 'outputs.json');
    const handover = path.join(dir, 'handover.md');
    fs.writeFileSync(outputs, JSON.stringify({ verdict: 'approve' }));
    fs.writeFileSync(handover, '# Handover\n');
    const log = path.join(dir, 'claude.log');
    const { stdout, status } = turn(
      {
        STUB_CLAUDE_LOG: log,
        STUB_CLAUDE_OUTPUTS: outputs,
        STUB_CLAUDE_HANDOVER: handover,
        STUB_CLAUDE_READS: 'previous.review.handover',
      },
      [...REPORT, '--mcp-config', fakeConsola(dir)],
    );
    const events = jsonLines(stdout);
    const tools = events
      .filter((event) => event.type === 'assistant')
      .map(
        (event) => (event.message as { content: Array<{ type: string; name: string }> }).content,
      );
    expect(tools).toEqual([
      [expect.objectContaining({ type: 'tool_use', name: 'mcp__consola__consola_read_artifact' })],
      [expect.objectContaining({ type: 'tool_use', name: 'mcp__consola__consola_write_artifact' })],
      [expect.objectContaining({ type: 'tool_use', name: 'mcp__consola__consola_set_outputs' })],
    ]);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
    expect(status).toBe(0);
    expect(readLog(log).slice(1)).toEqual([
      'READ previous.review.handover ok consola_read_artifact',
      'TOOL consola_write_artifact ok consola_write_artifact',
      'TOOL consola_set_outputs ok consola_set_outputs',
      'END s1 exit 0',
    ]);
  });

  it('a failed tool call fails the turn with its line as the result', () => {
    const dir = scratch();
    const outputs = path.join(dir, 'outputs.json');
    fs.writeFileSync(outputs, JSON.stringify({ x: 1 }));
    const { stdout, stderr, status } = turn({ STUB_CLAUDE_OUTPUTS: outputs }, [
      ...REPORT,
      '--mcp-config',
      fakeConsola(dir, 'consola_set_outputs'),
    ]);
    expect(jsonLines(stdout).at(-1)).toMatchObject({
      type: 'result',
      is_error: true,
      result: 'TOOL consola_set_outputs ERROR No such output: x',
    });
    expect(stderr).toBe('');
    expect(status).toBe(1);
  });

  it('a server it cannot reach fails the turn with that line', () => {
    const dir = scratch();
    const outputs = path.join(dir, 'outputs.json');
    fs.writeFileSync(outputs, JSON.stringify({ x: 1 }));
    const { stdout, status } = turn({ STUB_CLAUDE_OUTPUTS: outputs });
    expect(jsonLines(stdout).at(-1)).toMatchObject({
      is_error: true,
      result: 'MCP no --mcp-config',
    });
    expect(status).toBe(1);
  });

  it("posts each hook to --settings' endpoint, StopFailure just before the result", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        posts.push({ path: request.url, ...JSON.parse(body) });
        response.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/attention/t`;
    const dir = scratch();
    const hooks = path.join(dir, 'hooks.json');
    fs.writeFileSync(
      hooks,
      JSON.stringify([
        'UserPromptSubmit',
        'Notification:permission_prompt',
        'StopFailure:rate_limit',
        'PermissionRequest',
      ]),
    );
    const log = path.join(dir, 'claude.log');
    const { stdout, code } = await run(
      ['--settings', claudeSettings({ attentionUrl: url })!],
      { STUB_CLAUDE_HOOKS_FILE: hooks, STUB_CLAUDE_LOG: log },
      dir,
    );
    expect(posts).toEqual([
      { path: '/attention/t', hook_event_name: 'UserPromptSubmit', session_id: 's1' },
      {
        path: '/attention/t',
        hook_event_name: 'Notification',
        session_id: 's1',
        notification_type: 'permission_prompt',
      },
      {
        path: '/attention/t',
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { file_path: 'src/catalog.ts' },
      },
      {
        path: '/attention/t',
        hook_event_name: 'StopFailure',
        session_id: 's1',
        error: 'rate_limit',
      },
    ]);
    expect(readLog(log).slice(1)).toEqual([
      'HOOK UserPromptSubmit 200',
      'HOOK Notification 200',
      'HOOK PermissionRequest 200',
      'HOOK StopFailure 200',
      'END s1 exit 0',
    ]);
    expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'result' });
    expect(code).toBe(0);
  });

  it('holds after init until its file appears', async () => {
    const dir = scratch();
    const holdFile = path.join(dir, 'hold');
    const log = path.join(dir, 'claude.log');
    let seen = '';
    const done = run([], { STUB_CLAUDE_HOLD: holdFile, STUB_CLAUDE_LOG: log }, dir, (chunk) => {
      seen += chunk;
    });
    await expect
      .poll(() => fs.existsSync(log) && readLog(log).includes('HOLD waiting'), { timeout: 10_000 })
      .toBe(true);
    // Held: init is out, the result is not.
    await expect.poll(() => seen.split('\n').filter(Boolean).length).toBe(1);
    expect(JSON.parse(seen.split('\n')[0])).toMatchObject({ type: 'system', subtype: 'init' });
    fs.writeFileSync(holdFile, '');
    const { stdout, code } = await done;
    expect(jsonLines(stdout).at(-1)).toMatchObject({ type: 'result', is_error: false });
    expect(code).toBe(0);
    expect(readLog(log).slice(1)).toEqual(['HOLD waiting', 'HOLD open', 'END s1 exit 0']);
  });

  it('writes its transcript as in text mode: findings only for a turn that finished', () => {
    const transcript = (env: Record<string, string>) => {
      const config = scratch();
      const { status } = spawnSync(
        process.execPath,
        [STUB, '-p', '--session-id', 's1', ...REPORT, '--', 'hi'],
        { env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, ...env }, encoding: 'utf8' },
      );
      const lines = fs.readFileSync(path.join(config, 'projects', 'p', 's1.jsonl'), 'utf8');
      return { status, records: jsonLines(lines).map((line) => line.type) };
    };
    expect(transcript({})).toEqual({ status: 0, records: ['user', 'assistant'] });
    expect(transcript({ STUB_CLAUDE_SUBTYPE: 'error_max_turns' })).toEqual({
      status: 1,
      records: ['user'],
    });
  });

  it('text mode is unchanged', () => {
    expect(turn({}, []).stdout).toBe('FINDINGS: done\n');
  });

  it('text mode ignores the stream-json knobs', () => {
    const dir = scratch();
    const log = path.join(dir, 'claude.log');
    const { stdout, stderr, status } = turn(
      {
        STUB_CLAUDE_LOG: log,
        STUB_CLAUDE_STDERR: 'Warning: stub',
        STUB_CLAUDE_LIMIT: '1',
        STUB_CLAUDE_DENIED: 'Read',
        STUB_CLAUDE_SUBTYPE: 'error_max_turns',
        STUB_CLAUDE_HOLD: path.join(dir, 'never'),
        STUB_CLAUDE_HOOKS_FILE: path.join(dir, 'never.json'),
      },
      [],
    );
    expect(stdout).toBe('FINDINGS: done\n');
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(readLog(log)).toEqual([`${process.cwd()} :: -p --session-id s1 -- hi`, 'END s1 exit 0']);
  });

  it('STUB_CLAUDE_OUTPUTS_SEQ sets the next outputs at each launch, the last once it runs out, and beats STUB_CLAUDE_OUTPUTS', () => {
    const dir = scratch();
    const sequence = path.join(dir, 'outputs-seq.json');
    fs.writeFileSync(sequence, JSON.stringify([{ findings: 1 }, { findings: 0 }]));
    const outputs = path.join(dir, 'outputs.json');
    fs.writeFileSync(outputs, JSON.stringify({ findings: 7 }));
    const log = path.join(dir, 'claude.log');
    const config = fakeConsola(dir, '', true);
    const launch = (id: string, env: Record<string, string>) => {
      const before = fs.existsSync(log) ? readLog(log).length : 0;
      const { status } = spawnSync(
        process.execPath,
        [STUB, '-p', '--session-id', id, ...REPORT, '--mcp-config', config, '--', 'hi'],
        {
          env: {
            PATH: process.env.PATH,
            CLAUDE_CONFIG_DIR: scratch(),
            STUB_CLAUDE_LOG: log,
            ...env,
          },
          encoding: 'utf8',
        },
      );
      expect(status).toBe(0);
      return readLog(log)
        .slice(before)
        .filter((line) => line.startsWith('TOOL '));
    };
    const set = (findings: number) => [
      `TOOL consola_set_outputs ok consola_set_outputs {"outputs":{"findings":${findings}}}`,
    ];
    // Each launch, a new conversation as each loop round is, takes the next entry.
    expect(launch('r1', { STUB_CLAUDE_OUTPUTS_SEQ: sequence })).toEqual(set(1));
    expect(launch('r2', { STUB_CLAUDE_OUTPUTS_SEQ: sequence })).toEqual(set(0));
    expect(fs.readFileSync(`${sequence}.n`, 'utf8')).toBe('2');
    // Past the end, the last again.
    expect(launch('r3', { STUB_CLAUDE_OUTPUTS_SEQ: sequence })).toEqual(set(0));
    // With both set, the sequence wins; without it, STUB_CLAUDE_OUTPUTS is as before.
    fs.rmSync(`${sequence}.n`);
    expect(
      launch('r4', { STUB_CLAUDE_OUTPUTS_SEQ: sequence, STUB_CLAUDE_OUTPUTS: outputs }),
    ).toEqual(set(1));
    expect(launch('r5', { STUB_CLAUDE_OUTPUTS: outputs })).toEqual(set(7));
    // A `null` entry sets nothing, and still moves the count on (a write step between two that set outputs).
    fs.writeFileSync(sequence, JSON.stringify([null, { findings: 2 }]));
    fs.rmSync(`${sequence}.n`);
    expect(
      launch('r7', { STUB_CLAUDE_OUTPUTS_SEQ: sequence, STUB_CLAUDE_OUTPUTS: outputs }),
    ).toEqual([]);
    expect(launch('r8', { STUB_CLAUDE_OUTPUTS_SEQ: sequence })).toEqual(set(2));
    fs.writeFileSync(sequence, JSON.stringify([{ findings: 1 }, { findings: 0 }]));
    // A sequence file that is not there sets what STUB_CLAUDE_OUTPUTS says.
    expect(
      launch('r6', {
        STUB_CLAUDE_OUTPUTS_SEQ: path.join(dir, 'absent.json'),
        STUB_CLAUDE_OUTPUTS: outputs,
      }),
    ).toEqual(set(7));
  });

  it('logs nothing new without the new knobs', () => {
    const dir = scratch();
    const log = path.join(dir, 'claude.log');
    const { status } = turn({ STUB_CLAUDE_LOG: log });
    expect(status).toBe(0);
    expect(readLog(log)).toEqual([
      `${process.cwd()} :: -p --session-id s1 ${REPORT.join(' ')} -- hi`,
      'END s1 exit 0',
    ]);
  });
});

/** One stream-json turn, spawned so this process can answer it meanwhile. */
function run(
  extra: string[],
  env: Record<string, string>,
  config: string,
  onStdout?: (chunk: string) => void,
): Promise<{ stdout: string; code: number | null }> {
  const child = spawn(
    process.execPath,
    [STUB, '-p', '--session-id', 's1', ...REPORT, ...extra, '--', 'hi'],
    { env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config, ...env } },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    onStdout?.(chunk);
  });
  return new Promise((resolve) => child.on('close', (code) => resolve({ stdout, code })));
}

/*
 * The control protocol (`--input-format stream-json`), asked as the drivers
 * ask it (`requestControl`, the real reader), and what a print turn's `init`
 * says it loaded: the stub answers a server probe and a skills deny list,
 * and keeps exactly what the real CLI's `--mcp-config`, strict and
 * `allowedMcpServers` keep (spike Q1b, Q1f6, Q1f7; canary row 22).
 */

const CORALOGIX = 'https://mcp.coralogix.example/mcp';
const TRACKER = 'https://tracker.example/mcp';
const SLACK = 'https://mcp.slack.example/mcp';

/** The four servers of the plan's fixture: two connectors, a stdio and an http user server. */
const FOUR = [
  {
    name: 'claude.ai Coralogix',
    scope: 'claudeai',
    type: 'claudeai-proxy',
    url: CORALOGIX,
    status: 'connected',
    tools: ['query_logs'],
  },
  { name: 'grafana', scope: 'dynamic', type: 'stdio', status: 'connected', tools: ['query.logs'] },
  { name: 'tracker', scope: 'dynamic', type: 'http', url: TRACKER, status: 'connected' },
  {
    name: 'claude.ai Slack',
    scope: 'claudeai',
    type: 'claudeai-proxy',
    url: SLACK,
    status: 'connected',
  },
];

/** A `claude` on disk, as the drivers spawn it: a wrapper running the stub under this Node. */
function stubBinary(dir: string): string {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`,
    { mode: 0o755 },
  );
  return file;
}

/** A knob file holding `servers`. */
function knob(dir: string, servers: unknown[], name = 'mcp.json'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(servers));
  return file;
}

/** A folder holding `<dir>/.claude.json`, as a harness's account file is named. */
function accountFile(dir: string): string {
  const file = path.join(dir, 'profile', '.claude.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  return file;
}

describe('the stub claude speaks the control protocol', { timeout: 30_000 }, () => {
  const ask = (
    dir: string,
    env: Record<string, string>,
    requests = [INITIALIZE],
    extraArgs: string[] = [],
  ) =>
    requestControl(
      stubBinary(dir),
      dir,
      { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: scratch(), ...env },
      requests,
      // Far short of the 15 s default: "at once" means the stub answered.
      { timeoutMs: 8000, extraArgs },
    );

  it('without either knob, refuses the protocol as before and logs nothing', () => {
    const dir = scratch();
    const log = path.join(dir, 'claude.log');
    const { status } = spawnSync(
      process.execPath,
      [STUB, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '-p'],
      { env: { PATH: process.env.PATH, STUB_CLAUDE_LOG: log }, encoding: 'utf8' },
    );
    expect(status).toBe(1);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('answers initialize with its commands and two models, and anything else with an error at once', async () => {
    const dir = scratch();
    const [initialize] = await ask(dir, { STUB_CLAUDE_COMMANDS: 'dataviz' });
    expect(initialize).toEqual({
      commands: [{ name: 'dataviz' }],
      agents: [],
      models: [
        { value: 'opus', displayName: 'Opus' },
        { value: 'haiku', displayName: 'Haiku' },
      ],
    });
    await expect(
      ask(dir, { STUB_CLAUDE_COMMANDS: 'dataviz' }, [
        INITIALIZE,
        { requestId: 'u', request: { subtype: 'get_usage' } },
      ]),
    ).rejects.toThrow('the stub does not answer get_usage');
  });

  it('fails mcp_status while its knob names no file, and answers once the file is there', async () => {
    const dir = scratch();
    const file = path.join(dir, 'mcp.json');
    const account = accountFile(dir);
    const probe = () =>
      ask(dir, { STUB_CLAUDE_MCP: file }, [INITIALIZE, MCP_STATUS], ['--mcp-config', account]);
    await expect(probe()).rejects.toThrow('STUB_CLAUDE_MCP names no file');
    knob(dir, [FOUR[1]]);
    const [, status] = await probe();
    expect(status).toEqual({
      mcpServers: [
        {
          name: 'grafana',
          status: 'connected',
          scope: 'dynamic',
          config: { type: 'stdio' },
          tools: [{ name: 'query.logs' }],
        },
      ],
    });
  });

  it("lists the plugin dir's skills after its commands, and logs each request with its folder and argv", async () => {
    const dir = scratch();
    const log = path.join(dir, 'claude.log');
    const plugin = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(plugin, 'skills', 'incident-triage'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'skills', 'incident-triage', 'SKILL.md'), '# Triage\n');
    // A folder with no SKILL.md is no skill.
    fs.mkdirSync(path.join(plugin, 'skills', 'notes'));
    const [initialize] = await ask(
      dir,
      { STUB_CLAUDE_COMMANDS: 'dataviz,simplify', STUB_CLAUDE_LOG: log },
      [INITIALIZE],
      ['--plugin-dir', plugin, '--add-dir', plugin],
    );
    expect((initialize as { commands: unknown }).commands).toEqual([
      { name: 'dataviz' },
      { name: 'simplify' },
      { name: 'consola-step:incident-triage' },
    ]);
    const [line] = readLog(log);
    expect(line.startsWith(`CONTROL initialize in ${fs.realpathSync(dir)} with `)).toBe(true);
    expect(line).toContain(`--plugin-dir ${plugin} --add-dir ${plugin}`);
    expect(line).not.toContain(' :: ');
    expect(readLog(log)).toHaveLength(1);
  });

  it('answers mcp_status with every server the probe would load, in the real shape', async () => {
    const dir = scratch();
    const [, status] = await ask(
      dir,
      { STUB_CLAUDE_MCP: knob(dir, FOUR) },
      [INITIALIZE, MCP_STATUS],
      [
        '--restricted',
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Read',
        '--mcp-config',
        accountFile(dir),
      ],
    );
    expect(mapMcpStatus(status)).toEqual([
      {
        name: 'claude.ai Coralogix',
        source: 'connector',
        transport: 'claudeai-proxy',
        url: CORALOGIX,
        tools: ['query_logs'],
        status: 'connected',
        signInHint: CLAUDE_SIGN_IN_HINT,
      },
      {
        name: 'grafana',
        source: 'user',
        transport: 'stdio',
        tools: ['query.logs'],
        status: 'connected',
        signInHint: CLAUDE_SIGN_IN_HINT,
      },
      {
        name: 'tracker',
        source: 'user',
        transport: 'http',
        url: TRACKER,
        status: 'connected',
        signInHint: CLAUDE_SIGN_IN_HINT,
      },
      {
        name: 'claude.ai Slack',
        source: 'connector',
        transport: 'claudeai-proxy',
        url: SLACK,
        status: 'connected',
        signInHint: CLAUDE_SIGN_IN_HINT,
      },
    ]);
  });

  it('lists no user server without the account file, and no connector under strict', async () => {
    const dir = scratch();
    const names = async (extraArgs: string[]) => {
      const [, status] = await ask(
        dir,
        { STUB_CLAUDE_MCP: knob(dir, FOUR) },
        [INITIALIZE, MCP_STATUS],
        extraArgs,
      );
      return mapMcpStatus(status).map((server) => server.name);
    };
    expect(await names(['--restricted'])).toEqual(['claude.ai Coralogix', 'claude.ai Slack']);
    expect(await names(['--strict-mcp-config', '--mcp-config', accountFile(dir)])).toEqual([
      'grafana',
      'tracker',
    ]);
  });
});

describe("the drivers' own questions, asked of the stub", { timeout: 30_000 }, () => {
  it('answers the server probe as Claude is probed, a pending server settling on a later ask', async () => {
    const dir = scratch();
    const file = knob(dir, [{ ...FOUR[1], status: 'pending' }, FOUR[0]]);
    // The probe asks again every 50 ms here; the knob settles after its first answer.
    setTimeout(() => knob(dir, [FOUR[1], FOUR[0]]), 300);
    const report = await probeClaudeMcpServers(
      stubBinary(dir),
      { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: scratch(), STUB_CLAUDE_MCP: file },
      accountFile(dir),
      { everyMs: 50, forMs: 10_000, timeoutMs: 15_000 },
    );
    expect(report.map((server) => [server.name, server.status])).toEqual([
      ['grafana', 'connected'],
      ['claude.ai Coralogix', 'connected'],
    ]);
  });

  it("answers the skills deny list's initialize: every listed name but the step's own", async () => {
    const dir = scratch();
    const plugin = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(plugin, 'skills', 'incident-triage'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'skills', 'incident-triage', 'SKILL.md'), '# Triage\n');
    const rules = await askSkillDenyRules(
      stubBinary(dir),
      dir,
      {
        PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: scratch(),
        STUB_CLAUDE_COMMANDS: 'dataviz,simplify',
      },
      ['--strict-mcp-config', '--plugin-dir', plugin, '--add-dir', plugin, '--restricted'],
      ['incident-triage'],
    );
    expect(rules).toEqual(['Skill(dataviz)', 'Skill(simplify)']);
  });
});

describe('what a print turn of the stub loads', { timeout: 30_000 }, () => {
  /** One stream-json turn's `init` and stderr, with STUB_CLAUDE_MCP holding `servers`. */
  const initOf = (servers: unknown[], extra: string[], env: Record<string, string> = {}) => {
    const dir = scratch();
    const { stdout, stderr, status } = turn({ STUB_CLAUDE_MCP: knob(dir, servers), ...env }, [
      ...REPORT,
      ...extra.map((arg) => (arg === '<account>' ? accountFile(dir) : arg)),
    ]);
    expect(status).toBe(0);
    return { init: jsonLines(stdout)[0], stderr };
  };
  const names = (init: Record<string, unknown>) =>
    (init.mcp_servers as Array<{ name: string }>).map((server) => server.name);
  const allow = (...entries: Array<{ serverName: string } | { serverUrl: string }>) =>
    claudeSettings({ allowedMcpServers: entries }) ?? '';

  it('loads user servers from the account file and, under strict, no connector', () => {
    const { init, stderr } = initOf(FOUR, [
      '--strict-mcp-config',
      '--mcp-config',
      'C',
      '<account>',
    ]);
    expect(names(init)).toEqual(['consola', 'grafana', 'tracker']);
    expect(init.mcp_servers).toEqual([
      { name: 'consola', status: 'connected' },
      { name: 'grafana', status: 'connected' },
      { name: 'tracker', status: 'connected' },
    ]);
    expect(stderr).toBe('');
  });

  it('keeps what the allow-list keeps: stdio by name, remote by URL, and names the rest on stderr', () => {
    const { init, stderr } = initOf(FOUR, [
      '--mcp-config',
      'C',
      '<account>',
      '--settings',
      allow({ serverName: 'consola' }, { serverName: 'grafana' }, { serverUrl: CORALOGIX }),
      '--tools',
      'Read,Grep,Glob,Skill',
    ]);
    // In the profile's order, as the knob lists them.
    expect(names(init)).toEqual(['consola', 'claude.ai Coralogix', 'grafana']);
    expect(stderr).toBe(
      'Warning: MCP servers blocked by enterprise policy: tracker, claude.ai Slack\n',
    );
    expect(init.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Skill',
      'mcp__claude_ai_Coralogix__query_logs',
      'mcp__grafana__query_logs',
    ]);
  });

  it('keeps a remote server by name only while the allow-list has no URL entry', () => {
    const byName = initOf(FOUR, [
      '--mcp-config',
      'C',
      '<account>',
      '--settings',
      allow({ serverName: 'tracker' }),
    ]);
    expect(names(byName.init)).toEqual(['consola', 'tracker']);
    const withUrl = initOf(FOUR, [
      '--mcp-config',
      'C',
      '<account>',
      '--settings',
      allow({ serverName: 'tracker' }, { serverUrl: 'https://other.example/mcp' }),
    ]);
    expect(names(withUrl.init)).toEqual(['consola']);
    expect(withUrl.stderr).toBe(
      'Warning: MCP servers blocked by enterprise policy: claude.ai Coralogix, grafana, tracker, claude.ai Slack\n',
    );
  });

  it('blocks a stdio server named outside [A-Za-z0-9_-] whatever the allow-list says, as the real CLI does', () => {
    const dotted = {
      name: 'grafana.prod',
      scope: 'dynamic',
      type: 'stdio',
      status: 'connected',
      tools: ['q'],
    };
    const { init, stderr } = initOf(
      [dotted, FOUR[1]],
      [
        '--mcp-config',
        'C',
        '<account>',
        '--settings',
        allow({ serverName: 'grafana.prod' }, { serverName: 'grafana' }),
      ],
    );
    expect(names(init)).toEqual(['consola', 'grafana']);
    expect(stderr).toBe('Warning: MCP server blocked by enterprise policy: grafana.prod\n');
  });

  it("gives each server its knob's status, read again by every process", () => {
    const dir = scratch();
    const file = knob(dir, [FOUR[0]]);
    const first = jsonLines(turn({ STUB_CLAUDE_MCP: file }, REPORT).stdout)[0];
    expect(first.mcp_servers).toEqual([
      { name: 'consola', status: 'connected' },
      { name: 'claude.ai Coralogix', status: 'connected' },
    ]);
    knob(dir, [{ ...FOUR[0], status: 'needs-auth' }]);
    const second = jsonLines(turn({ STUB_CLAUDE_MCP: file }, REPORT).stdout)[0];
    expect(second.mcp_servers).toEqual([
      { name: 'consola', status: 'connected' },
      { name: 'claude.ai Coralogix', status: 'needs-auth' },
    ]);
  });

  it("lists the plugin dir's skills, and Skill only when --tools lists it", () => {
    const dir = scratch();
    const plugin = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(plugin, 'skills', 'incident-triage'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'skills', 'incident-triage', 'SKILL.md'), '# Triage\n');
    const { stdout } = turn({}, [...REPORT, '--plugin-dir', plugin, '--add-dir', plugin]);
    const init = jsonLines(stdout)[0];
    expect(init.skills).toEqual(['consola-step:incident-triage']);
    expect(init.tools).toEqual(['Read', 'Grep', 'Glob']);
  });
});

/*
 * Slice 3-B Task 23: the knobs that make the stub write in its checkout,
 * leave a process, move `HEAD` and log its environment. Every knob but the
 * environment log acts only on a launch whose `--tools` holds `Write`, and
 * counts only those (review S6): in §4.1 a read-only step launches in the
 * same checkout as the write steps.
 */
describe('the stub claude in a write step', { timeout: 30_000 }, () => {
  const WRITE_TOOLS = ['--tools', 'Read,Grep,Glob,Edit,Write,Bash'];
  const READ_TOOLS = ['--tools', 'Read,Grep,Glob'];
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

  /** A git repository with one commit, `src/app.ts` reading `broken`. */
  function repo(): string {
    const dir = fs.realpathSync(scratch());
    spawnSync('git', ['init', '-q', '-b', 'main', dir]);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'broken');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base');
    return dir;
  }

  /** One print launch in `cwd`, its own process group leader, as node-pty starts the CLI. */
  function launch(
    cwd: string,
    id: string,
    tools: string[],
    env: Record<string, string>,
    extra: string[] = ['-p'],
  ): Promise<{ status: number | null; pid: number }> {
    const child = spawn(
      process.execPath,
      [STUB, ...extra, '--session-id', id, ...tools, '--', 'hi'],
      {
        cwd,
        detached: true,
        env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: scratch(), ...env },
        stdio: 'ignore',
      },
    );
    return new Promise((resolve) => {
      child.on('exit', (status) => resolve({ status, pid: child.pid! }));
    });
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('writes each Write launch its entry and commits nothing; a read-only launch takes none', async () => {
    const dir = repo();
    const knobs = scratch();
    const writes = path.join(knobs, 'writes.json');
    fs.writeFileSync(
      writes,
      JSON.stringify([
        { files: { 'src/app.ts': 'fixed' } },
        { files: { 'src/app.ts': 'fixed twice' } },
      ]),
    );
    const log = path.join(knobs, 'claude.log');
    const leave = path.join(knobs, 'leftover.pid');
    const head = git(dir, 'rev-parse', 'HEAD');
    const env = {
      STUB_CLAUDE_LOG: log,
      STUB_CLAUDE_WRITES: writes,
      STUB_CLAUDE_MOVE_HEAD: '1',
      STUB_CLAUDE_LEAVE_PROCESS: leave,
    };
    // Review S6: a read-only launch in the same checkout takes no entry, moves no HEAD, leaves no process.
    expect((await launch(dir, 'triage', READ_TOOLS, env)).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('broken');
    expect(git(dir, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');
    expect(fs.existsSync(leave)).toBe(false);
    expect(fs.existsSync(`${writes}.n`)).toBe(false);

    // The write launches without the other two knobs: this row is about the files.
    const quiet = { STUB_CLAUDE_LOG: log, STUB_CLAUDE_WRITES: writes };
    expect((await launch(dir, 'fix', WRITE_TOOLS, quiet)).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('fixed');
    // It never commits (review S1: Consola commits every step).
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('M src/app.ts');
    expect(readLog(log)).toContain('WROTE src/app.ts');
    // The next Write launch takes the second entry, and past the end the last.
    expect((await launch(dir, 'address', WRITE_TOOLS, quiet)).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('fixed twice');
    expect(fs.readFileSync(`${writes}.n`, 'utf8')).toBe('2');
  });

  it('STUB_CLAUDE_HOLD_WRITE holds a Write launch only, after its files are written', async () => {
    const dir = repo();
    const knobs = scratch();
    const log = path.join(knobs, 'claude.log');
    const gate = path.join(knobs, 'hold');
    const writes = path.join(knobs, 'writes.json');
    fs.writeFileSync(writes, JSON.stringify([{ files: { 'src/app.ts': 'fixed' } }]));
    const env = { STUB_CLAUDE_LOG: log, STUB_CLAUDE_HOLD_WRITE: gate, STUB_CLAUDE_WRITES: writes };
    // A read-only launch passes straight through.
    expect((await launch(dir, 'triage', [...READ_TOOLS, ...REPORT], env)).status).toBe(0);
    expect(readLog(log)).not.toContain('HOLD waiting');
    const held = launch(dir, 'fix', [...WRITE_TOOLS, ...REPORT], env);
    const deadline = Date.now() + 20_000;
    while (!readLog(log).includes('HOLD waiting') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Held, with its files already written.
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('fixed');
    expect(readLog(log).some((line) => line.startsWith('END fix '))).toBe(false);
    fs.writeFileSync(gate, '');
    expect((await held).status).toBe(0);
    expect(readLog(log)).toContain('HOLD open');
  });

  it('STUB_CLAUDE_MOVE_HEAD detaches HEAD after a Write launch only', async () => {
    const dir = repo();
    const env = { STUB_CLAUDE_MOVE_HEAD: '1' };
    await launch(dir, 'review', READ_TOOLS, env);
    expect(git(dir, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');
    await launch(dir, 'fix', WRITE_TOOLS, env);
    expect(git(dir, 'symbolic-ref', '-q', 'HEAD')).toBe('');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'main'));
  });

  it("STUB_CLAUDE_LEAVE_PROCESS leaves a live process in the checkout, in the launch's own group, once", async () => {
    const dir = repo();
    const leave = path.join(scratch(), 'leftover.pid');
    const first = await launch(dir, 'fix', WRITE_TOOLS, { STUB_CLAUDE_LEAVE_PROCESS: leave });
    expect(first.status).toBe(0);
    const pid = Number(fs.readFileSync(leave, 'utf8'));
    onTestFinished(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(`${leave}.done`)).toBe(true);
    // Its group is the launch's: the CLI's, which Consola ends after the turn.
    const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    expect(Number(group.stdout.trim())).toBe(first.pid);
    const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    expect(cwd.stdout.split('\n')).toContain(`n${dir}`);
    // Once: the next Write launch leaves none.
    fs.rmSync(leave);
    await launch(dir, 'address', WRITE_TOOLS, { STUB_CLAUDE_LEAVE_PROCESS: leave });
    expect(fs.existsSync(leave)).toBe(false);
    process.kill(pid, 'SIGKILL');
  });

  it('STUB_CLAUDE_ENV_LOG logs every launch’s variable names, never a value', async () => {
    const dir = repo();
    const envLog = path.join(scratch(), 'env.log');
    await launch(dir, 'fix', WRITE_TOOLS, {
      STUB_CLAUDE_ENV_LOG: envLog,
      GH_TOKEN: 'gh-e2e-dummy',
      CI: '1',
    });
    await launch(dir, 'review', READ_TOOLS, { STUB_CLAUDE_ENV_LOG: envLog }, ['-p']);
    const lines = readLog(envLog);
    expect(lines).toHaveLength(2);
    const [fix, review] = lines;
    expect(fix.startsWith('ENV fix :: ')).toBe(true);
    const names = fix.slice('ENV fix :: '.length).split(' ');
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['CI', 'GH_TOKEN', 'PATH']));
    expect(fix).not.toContain('gh-e2e-dummy');
    expect(review.startsWith('ENV review :: ')).toBe(true);
    expect(review).not.toContain('GH_TOKEN');
  });

  it('an interactive Write launch with STUB_CLAUDE_WRITES_OPEN writes, then stays open until told to close', async () => {
    const dir = repo();
    const knobs = scratch();
    const open = path.join(knobs, 'open.json');
    fs.writeFileSync(open, JSON.stringify([{ files: { 'NOTES.md': 'notes' } }]));
    const log = path.join(knobs, 'claude.log');
    const ended = launch(
      dir,
      'fix',
      WRITE_TOOLS,
      { STUB_CLAUDE_LOG: log, STUB_CLAUDE_WRITES_OPEN: open },
      [],
    );
    const deadline = Date.now() + 20_000;
    while (
      !(fs.existsSync(log) && readLog(log).includes('OPEN waiting')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8')).toBe('notes');
    expect(readLog(log)).not.toContain('OPEN closed');
    fs.writeFileSync(`${open}.close`, '');
    expect((await ended).status).toBe(0);
    expect(readLog(log)).toEqual(
      expect.arrayContaining(['WROTE NOTES.md', 'OPEN waiting', 'OPEN closed']),
    );
    // A print launch does not take its entries: they are an open session's.
    fs.rmSync(path.join(dir, 'NOTES.md'));
    await launch(dir, 'fix', WRITE_TOOLS, { STUB_CLAUDE_WRITES_OPEN: open });
    expect(fs.existsSync(path.join(dir, 'NOTES.md'))).toBe(false);
  });
});
