import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { claudeHookSettings } from '../drivers/claudeHooks';

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

/** A stdio MCP server that answers every tool call, but fails `failTool`'s. */
function fakeConsola(dir: string, failTool = ''): string {
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
        : { content: [{ type: 'text', text: 'ok ' + message.params.name }] };
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
    const env = { STUB_CLAUDE_LOG: log, STUB_CLAUDE_COST: '0.0015,0.003', STUB_CLAUDE_TURNS: '3,2' };
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
      ['--settings', claudeHookSettings(url)],
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
