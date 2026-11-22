import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skillHash } from '@consola/factory-spec';
import { buildTextGenerationArgs, ClaudeDriver } from './ClaudeDriver';
import { buildStepPlugin } from './claudeAgent';
import { claudeSettings } from './claudeHooks';
import type { ClaudeAgentGrants } from '../../shared/agentGrants';
import type { HarnessConfig, SessionLaunch } from './HarnessDriver';
import { stepTurnProblem } from './index';
import { RESULT_OK } from './streamJson.test-helpers';

// (vi.mock is hoisted above the imports.) The real probe runs the user's interactive login shell, which can take seconds.
vi.mock('../LoginEnvironment', () => ({
  getLoginEnv: () => process.env,
  loginEnvProblem: () => null,
}));

const driver = new ClaudeDriver();
const config: HarnessConfig = { extraArgs: ['--verbose'] };

describe('reporting step turns', () => {
  const bare: HarnessConfig = { extraArgs: [] };
  const URL = 'http://127.0.0.1:1/attention/t';
  const HOOKS = claudeSettings({ attentionUrl: URL })!;
  // READ_ONLY_ARGS as it is at the cut, written out rather than read from the driver.
  const READ_ONLY = [
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    'mcp__consola__consola_work_item_context',
    'mcp__consola__consola_list_inbox',
    'mcp__consola__consola_set_outputs',
    'mcp__consola__consola_write_artifact',
    'mcp__consola__consola_read_artifact',
    'mcp__consola__consola_list_artifacts',
    '--restricted',
  ];
  const turn: SessionLaunch = {
    sessionId: 's1',
    resume: false,
    toolPolicy: 'read-only',
    unattended: true,
    initialPrompt: 'p',
    attentionUrl: URL,
  };

  it('an unattended step turn adds exactly the two reporting flags', () => {
    const slice1 = ['-p', '--session-id', 's1', '--settings', HOOKS, ...READ_ONLY, '--', 'p'];
    expect(driver.buildSessionArgs(bare, turn)).toEqual(slice1);
    expect(driver.buildSessionArgs(bare, { ...turn, reportTurn: true })).toEqual([
      '-p',
      '--session-id',
      's1',
      '--settings',
      HOOKS,
      '--output-format',
      'stream-json',
      '--verbose',
      ...READ_ONLY,
      '--',
      'p',
    ]);
  });

  it('its reminder adds --max-turns too', () => {
    expect(
      driver.buildSessionArgs(bare, { ...turn, resume: true, reportTurn: true, maxTurns: 3 }),
    ).toEqual([
      '-p',
      '--resume',
      's1',
      '--settings',
      HOOKS,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '3',
      ...READ_ONLY,
      '--',
      'p',
    ]);
  });

  it("an interactive launch of a step's session is byte-identical to slice 1's", () => {
    expect(
      driver.buildSessionArgs(bare, {
        sessionId: 's1',
        resume: true,
        toolPolicy: 'read-only',
        attentionUrl: URL,
        reportTurn: true,
        maxTurns: 6,
      }),
    ).toEqual(['--resume', 's1', '--settings', HOOKS, ...READ_ONLY]);
  });

  it('a legacy unattended turn is unchanged', () => {
    const args = driver.buildSessionArgs(bare, { ...turn, resume: true });
    expect(args).toEqual(['-p', '--resume', 's1', '--settings', HOOKS, ...READ_ONLY, '--', 'p']);
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('--max-turns');
  });

  it('a cap without a report still caps an unattended turn, and only an unattended one', () => {
    expect(driver.buildSessionArgs(bare, { ...turn, maxTurns: 4 })).toEqual([
      '-p',
      '--session-id',
      's1',
      '--settings',
      HOOKS,
      '--max-turns',
      '4',
      ...READ_ONLY,
      '--',
      'p',
    ]);
  });

  it('everything keeps its place', () => {
    expect(
      driver.buildSessionArgs(
        { extraArgs: ['--append-system-prompt', 'x'] },
        {
          ...turn,
          model: 'opus',
          mcpConfigPath: '/m.json',
          reportTurn: true,
          maxTurns: 6,
        },
      ),
    ).toEqual([
      '-p',
      '--session-id',
      's1',
      '--model',
      'opus',
      '--mcp-config',
      '/m.json',
      '--settings',
      HOOKS,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '6',
      ...READ_ONLY,
      '--append-system-prompt',
      'x',
      '--',
      'p',
    ]);
  });

  it.each<[string[], string | null]>([
    [
      ['--max-turns', '50'],
      "This harness's extra arguments set `--max-turns`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    ],
    [
      ['--output-format=text', '--input-format', 'text'],
      "This harness's extra arguments set `--output-format` and `--input-format`, which would override what Consola launches each step's turn with. Remove them in Settings › Harnesses.",
    ],
    [
      ['--max-turns=9', '--input-format', 'text', '--output-format', 'json'],
      "This harness's extra arguments set `--output-format`, `--input-format` and `--max-turns`, which would override what Consola launches each step's turn with. Remove them in Settings › Harnesses.",
    ],
    [['--model', 'opus'], null],
    [['--max-turnsx', '--verbose'], null],
    [[], null],
  ])('stepTurnProblem names each flag that would override a step’s (%j)', (extraArgs, words) => {
    expect(driver.stepTurnProblem({ extraArgs })).toBe(words);
  });

  it('buildSessionArgs refuses a reporting turn the extra args would override', () => {
    const pinned: HarnessConfig = { extraArgs: ['--max-turns', '50'] };
    expect(() => driver.buildSessionArgs(pinned, { ...turn, reportTurn: true })).toThrow(
      "This harness's extra arguments set `--max-turns`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(driver.buildSessionArgs(pinned, turn)).toEqual([
      '-p',
      '--session-id',
      's1',
      '--settings',
      HOOKS,
      ...READ_ONLY,
      '--max-turns',
      '50',
      '--',
      'p',
    ]);
    // An interactive reopen reports nothing, so nothing of it is overridden.
    expect(() =>
      driver.buildSessionArgs(pinned, { ...turn, unattended: undefined, reportTurn: true }),
    ).not.toThrow();
  });

  it("a model the step sets makes the harness's own --model a step problem too", () => {
    const pinned: HarnessConfig = { extraArgs: ['--model', 'sonnet'] };
    // A step without a model compiles none, so the harness's own is left alone.
    expect(driver.stepTurnProblem(pinned)).toBeNull();
    expect(driver.stepTurnProblem(pinned, { model: false })).toBeNull();
    expect(driver.stepTurnProblem(pinned, { model: true })).toBe(
      "This harness's extra arguments set `--model`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(
      driver.stepTurnProblem(
        { extraArgs: ['--model=sonnet', '--max-turns', '5'] },
        { model: true },
      ),
    ).toBe(
      "This harness's extra arguments set `--model` and `--max-turns`, which would override what Consola launches each step's turn with. Remove them in Settings › Harnesses.",
    );
    expect(stepTurnProblem({ extraArgs: ['--model', 'sonnet'] }, { model: true })).toContain(
      '`--model`',
    );
    expect(stepTurnProblem({ extraArgs: ['--model', 'sonnet'] })).toBeNull();
    expect(
      stepTurnProblem({ driverId: 'codex', extraArgs: ['--model', 'x'] }, { model: true }),
    ).toBeNull();
  });

  it('buildSessionArgs refuses a reporting turn with a model on a harness that pins its own', () => {
    const pinned: HarnessConfig = { extraArgs: ['--model', 'sonnet'] };
    expect(() =>
      driver.buildSessionArgs(pinned, { ...turn, reportTurn: true, model: 'opus' }),
    ).toThrow(
      "This harness's extra arguments set `--model`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    // Without a model, the harness's own still wins, as it always has.
    expect(driver.buildSessionArgs(pinned, { ...turn, reportTurn: true })).toEqual([
      '-p',
      '--session-id',
      's1',
      '--settings',
      HOOKS,
      '--output-format',
      'stream-json',
      '--verbose',
      ...READ_ONLY,
      '--model',
      'sonnet',
      '--',
      'p',
    ]);
    // An interactive launch with a model is never refused: the person's own reopen.
    expect(() =>
      driver.buildSessionArgs(pinned, { ...turn, unattended: undefined, model: 'opus' }),
    ).not.toThrow();
    expect(() =>
      driver.buildSessionArgs(pinned, {
        ...turn,
        unattended: undefined,
        reportTurn: true,
        model: 'opus',
      }),
    ).not.toThrow();
  });

  it('asks the driver of the harness, and a driver without the method has nothing to say', () => {
    expect(stepTurnProblem({ driverId: 'claude', extraArgs: ['--output-format', 'text'] })).toBe(
      "This harness's extra arguments set `--output-format`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(stepTurnProblem({ extraArgs: ['--max-turns', '2'] })).toContain('`--max-turns`');
    expect(stepTurnProblem({ driverId: 'claude' })).toBeNull();
    expect(stepTurnProblem({ driverId: 'codex', extraArgs: ['--max-turns', '2'] })).toBeNull();
  });

  it('offers a turn reader', () => {
    const reader = new ClaudeDriver().createTurnReader();
    expect(reader.push(RESULT_OK)).toEqual([]);
    expect(reader.end().report.result).toMatchObject({ costUsd: 0.0412, turns: 7 });
  });
});

describe('buildSessionArgs MCP registration', () => {
  it('appends --mcp-config before the harness extra args when a path is set', () => {
    const args = driver.buildSessionArgs(config, {
      sessionId: 'abc',
      resume: false,
      mcpConfigPath: '/tmp/conductor.json',
    });
    expect(args).toEqual([
      '--session-id',
      'abc',
      '--mcp-config',
      '/tmp/conductor.json',
      '--verbose',
    ]);
  });

  it('omits the flag entirely when no path is given', () => {
    const args = driver.buildSessionArgs(config, { sessionId: 'abc', resume: true });
    expect(args).toEqual(['--resume', 'abc', '--verbose']);
  });

  it('keeps the flag on resume, so a relaunched conductor keeps its tools', () => {
    const args = driver.buildSessionArgs(config, {
      sessionId: 'abc',
      resume: true,
      mcpConfigPath: '/tmp/c.json',
    });
    expect(args).toEqual(['--resume', 'abc', '--mcp-config', '/tmp/c.json', '--verbose']);
  });
});

describe('readWorkingDirectory', () => {
  let configDir: string;
  const harness = (): HarnessConfig => ({ configDir, extraArgs: [] });
  const record = (pid: number, entry: unknown) => {
    fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify(entry));
  };

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-claude-config-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('reads where the process works from what the CLI records for it under its config dir', () => {
    // The shape Claude writes, abridged: it moves `cwd` when EnterWorktree
    // moves the process, and `sessionId` on /clear.
    record(4242, {
      pid: 4242,
      sessionId: 'ca8781ca-4ceb-46ae-b482-e7d784fd84b2',
      cwd: '/code/consola/.claude/worktrees/assistant',
      kind: 'interactive',
      status: 'busy',
    });
    expect(driver.readWorkingDirectory(harness(), 4242)).toBe(
      '/code/consola/.claude/worktrees/assistant',
    );
  });

  it('says nothing for a process the CLI has not recorded yet', () => {
    expect(driver.readWorkingDirectory(harness(), 4242)).toBeNull();
    record(1111, { pid: 1111, cwd: '/elsewhere' });
    expect(driver.readWorkingDirectory(harness(), 4242)).toBeNull();
  });

  it('refuses a record it does not recognise rather than guess from it', () => {
    record(4242, { pid: 4242, workingDirectory: '/code/consola' });
    expect(() => driver.readWorkingDirectory(harness(), 4242)).toThrow(/Unrecognised/);
    record(4242, { pid: 4242, cwd: 'relative/dir' });
    expect(() => driver.readWorkingDirectory(harness(), 4242)).toThrow(/Unrecognised/);
    record(4242, { pid: 9999, cwd: '/code/consola' });
    expect(() => driver.readWorkingDirectory(harness(), 4242)).toThrow(/Unrecognised/);
  });

  it('treats a record caught half-written as no answer yet, not as a new format', () => {
    record(4242, {});
    fs.writeFileSync(path.join(configDir, 'sessions', '4242.json'), '{"pid":4242,"cwd":"/co');
    expect(driver.readWorkingDirectory(harness(), 4242)).toBeNull();
  });
});

describe('transcript readers for session titles', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-driver-titles-'));
    const project = path.join(dir, 'projects', '-Users-someone-repo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Name me' } }),
        JSON.stringify({ type: 'custom-title', customTitle: 'Mine' }),
      ].join('\n') + '\n',
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuse an id that could escape the projects directory', async () => {
    expect(await driver.readFirstPrompt(config, '../etc/passwd')).toBeNull();
    expect(await driver.readCliNameSince(config, '../etc/passwd', 0)).toBeNull();
  });

  it('read under the harness config directory', async () => {
    const harness: HarnessConfig = { ...config, configDir: dir };
    expect(await driver.readFirstPrompt(harness, id)).toBe('Name me');
    expect((await driver.readCliNameSince(harness, id, 0))?.name).toBe('Mine');
  });
});

describe('one-shot text generation', () => {
  const TITLE_SCHEMA_STUB = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  };
  interface Echo {
    argv: string[];
    stdin: string;
    cwd: string;
    configDir?: string;
  }
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-generate-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function script(name: string, body: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  }
  const echoScript = () =>
    script(
      'echo.js',
      `let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const structured_output = { argv: process.argv.slice(2), stdin, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR };
  process.stdout.write(JSON.stringify({ is_error: false, structured_output }));
});`,
    );
  const printing = (name: string, json: string) =>
    script(name, `process.stdin.resume();\nprocess.stdout.write(${JSON.stringify(json)});`);
  const call = (binaryPath: string, extra: { timeoutMs?: number } = {}) =>
    new ClaudeDriver().generateText(
      { binaryPath, extraArgs: [] },
      { prompt: 'Title this', schema: TITLE_SCHEMA_STUB, model: 'haiku', ...extra },
    );

  it('builds the one-shot argv with effort and fast only when asked', () => {
    const base = { prompt: 'p', schema: TITLE_SCHEMA_STUB, model: 'haiku' };
    const plain = buildTextGenerationArgs(base);
    expect(plain).not.toContain('--effort');
    expect(plain[plain.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    expect(plain).toEqual(
      expect.arrayContaining([
        '--no-session-persistence',
        '--disable-slash-commands',
        '--strict-mcp-config',
      ]),
    );
    expect(plain[plain.indexOf('--tools') + 1]).toBe('');
    const both = buildTextGenerationArgs({ ...base, effort: 'low', fast: true });
    expect(both[both.indexOf('--effort') + 1]).toBe('low');
    expect(JSON.parse(both[both.indexOf('--settings') + 1])).toEqual({
      disableAllHooks: true,
      fastMode: true,
    });
  });

  it('runs from the home directory with the harness profile, prompt on stdin, extra args left out', async () => {
    const out = (await new ClaudeDriver().generateText(
      { binaryPath: echoScript(), configDir: '/tmp/prof', extraArgs: ['--verbose'] },
      { prompt: 'Title this', schema: {}, model: 'haiku' },
    )) as Echo;
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(os.homedir()));
    expect(out.stdin).toBe('Title this');
    expect(out.configDir).toBe('/tmp/prof');
    expect(out.argv).not.toContain('--verbose');
    expect(out.argv).toContain('--no-session-persistence');
  });

  it('rejects with the CLI error text', async () => {
    const bin = printing('err.js', '{"is_error":true,"result":"Not logged in"}');
    await expect(call(bin)).rejects.toThrow('Not logged in');
  });

  it('rejects when there is no structured answer', async () => {
    const bin = printing('none.js', '{"is_error":false,"result":"hi"}');
    await expect(call(bin)).rejects.toThrow('The title call returned no answer.');
  });

  it('rejects with the last stderr line on a non-zero exit', async () => {
    const bin = script(
      'fail.js',
      `process.stdin.resume();\nprocess.stderr.write('first\\nboom\\n\\n');\nprocess.exit(2);`,
    );
    await expect(call(bin)).rejects.toThrow('boom');
  });

  it("rejects with the CLI's own reason when it exits non-zero with an error answer", async () => {
    const bin = script(
      'refused.js',
      `process.stdin.resume();\nprocess.stdout.write('{"is_error":true,"result":"Not logged in"}');\nprocess.stderr.write('noise\\n');\nprocess.exit(1);`,
    );
    await expect(call(bin)).rejects.toThrow(/^Not logged in$/);
  });

  it('rejects with a generic reason for an error answer with no text', async () => {
    const bin = script(
      'blank.js',
      `process.stdin.resume();\nprocess.stdout.write('{"is_error":true,"result":"  "}');\nprocess.exit(1);`,
    );
    await expect(call(bin)).rejects.toThrow(/^The title call failed\.$/);
  });

  it('names the exit code when a failed run says nothing', async () => {
    const bin = script('silent.js', `process.stdin.resume();\nprocess.exit(3);`);
    await expect(call(bin)).rejects.toThrow(/^claude exited with code 3\.$/);
  });

  it('rejects a pinned binary that is not executable', async () => {
    const file = path.join(dir, 'plain.js');
    fs.writeFileSync(file, '');
    await expect(call(file)).rejects.toThrow(`Not executable: ${file}`);
  });

  it('kills a hung call at the timeout', async () => {
    const pidFile = path.join(dir, 'pid');
    const bin = script(
      'hang.js',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);`,
    );
    await expect(call(bin, { timeoutMs: 300 })).rejects.toThrow('The title call timed out.');
    // The child may have been killed before it wrote its pid, which is a pass.
    // If it did write one, that process must be gone.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 1000;
    let pid = Number.NaN;
    while (Date.now() < deadline) {
      if (Number.isNaN(pid) && fs.existsSync(pidFile)) {
        pid = Number(fs.readFileSync(pidFile, 'utf8')) || Number.NaN;
      }
      if (!Number.isNaN(pid) && !alive(pid)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!Number.isNaN(pid)) expect(alive(pid)).toBe(false);
  }, 10_000);
});

describe('probeMcpServers', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-probe-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A CLI that answers the probe at once and logs its argv to `argv.json` beside it. */
  function probeCli(): string {
    const file = path.join(dir, 'probe.cjs');
    fs.writeFileSync(
      file,
      `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
const lines = require('readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const response = message.request.subtype === 'initialize'
    ? { commands: [] }
    : { mcpServers: [{ name: 'grafana', status: 'connected', scope: 'dynamic', config: { type: 'stdio' } }] };
  process.stdout.write(JSON.stringify({ type: 'control_response',
    response: { subtype: 'success', request_id: message.request_id, response } }) + '\\n');
});
setTimeout(() => {}, 10000);`,
    );
    const shim = path.join(dir, 'claude');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    return shim;
  }
  const argvSeen = (): string[] =>
    JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[];

  it('refuses a pinned binary that is not executable', async () => {
    const file = path.join(dir, 'plain.js');
    fs.writeFileSync(file, '');
    await expect(
      new ClaudeDriver().probeMcpServers({ binaryPath: file, extraArgs: [] }),
    ).rejects.toThrow(`Not executable: ${file}`);
  });

  it("names the harness's account file to --mcp-config when it is there", async () => {
    const configDir = path.join(dir, 'profile');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{}');
    const report = await new ClaudeDriver().probeMcpServers({
      binaryPath: probeCli(),
      configDir,
      extraArgs: ['--mcp-config', 'extra.json'],
    });

    expect(report).toEqual([expect.objectContaining({ name: 'grafana', source: 'user' })]);
    const argv = argvSeen();
    expect(argv.slice(-2)).toEqual(['--mcp-config', path.join(configDir, '.claude.json')]);
    // The harness's extra args are not passed, as the capabilities probe passes none.
    expect(argv).not.toContain('extra.json');
  });

  it('passes no --mcp-config when the account file is not there', async () => {
    const configDir = path.join(dir, 'empty-profile');
    fs.mkdirSync(configDir);
    await new ClaudeDriver().probeMcpServers({ binaryPath: probeCli(), configDir, extraArgs: [] });

    expect(argvSeen()).not.toContain('--mcp-config');
  });
});

describe('compileAgent', () => {
  const grafana = [
    {
      name: 'grafana',
      source: 'user' as const,
      transport: 'stdio' as const,
      tools: ['query_logs'],
      status: 'connected',
    },
  ];
  const accountFileOf = (config: HarnessConfig): string | undefined => {
    const compiled = new ClaudeDriver().compileAgent({
      config,
      harnessName: 'Claude work',
      agent: { tools: 'read-only', mcpServers: [{ name: 'grafana' }], skills: [] },
      checkout: 'scope',
      servers: grafana,
    });
    if (!compiled.ok) throw new Error(compiled.problem);
    return compiled.grants.accountFile;
  };
  afterEach(() => vi.unstubAllEnvs());

  it("grants the harness's own account file: its config dir's, else the ambient one's, else the home folder's", () => {
    expect(accountFileOf({ configDir: '/home/alice/.claude-work', extraArgs: [] })).toBe(
      '/home/alice/.claude-work/.claude.json',
    );
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/home/alice/.claude-ambient');
    expect(accountFileOf({ extraArgs: [] })).toBe('/home/alice/.claude-ambient/.claude.json');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(accountFileOf({ extraArgs: [] })).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('refuses in the words compileClaudeAgent gives', () => {
    expect(
      new ClaudeDriver().compileAgent({
        config: { extraArgs: [] },
        harnessName: 'Claude work',
        agent: { tools: 'read-only', mcpServers: [{ name: 'plugin:miro:miro' }], skills: [] },
        checkout: 'scope',
        servers: grafana,
      }),
    ).toEqual({
      ok: false,
      problem: expect.stringMatching(/^`plugin:miro:miro` comes from a plugin/),
    });
  });
});

describe('stepTurnProblem, for an agent that names servers', () => {
  const words = (flags: string) =>
    `This harness's extra arguments set ${flags}, which would override what Consola launches each step's turn with. Remove ${flags.includes(' and ') ? 'them' : 'it'} in Settings › Harnesses.`;

  it('names --mcp-config and --strict-mcp-config when the step compiles servers', () => {
    expect(
      driver.stepTurnProblem({ extraArgs: ['--mcp-config', 'extra.json'] }, { servers: true }),
    ).toBe(words('`--mcp-config`'));
    expect(driver.stepTurnProblem({ extraArgs: ['--strict-mcp-config'] }, { servers: true })).toBe(
      words('`--strict-mcp-config`'),
    );
    expect(
      driver.stepTurnProblem({ extraArgs: ['--mcp-config=extra.json'] }, { servers: true }),
    ).toBe(words('`--mcp-config`'));
  });

  it('leaves them alone when it compiles none', () => {
    const both = { extraArgs: ['--mcp-config', 'extra.json', '--strict-mcp-config'] };
    expect(driver.stepTurnProblem(both, { servers: false })).toBeNull();
    expect(driver.stepTurnProblem(both)).toBeNull();
    expect(stepTurnProblem(both)).toBeNull();
  });

  it('lists them after --model and before the reporting flags', () => {
    expect(
      driver.stepTurnProblem(
        {
          extraArgs: [
            '--max-turns',
            '3',
            '--strict-mcp-config',
            '--mcp-config',
            'x.json',
            '--model',
            'sonnet',
          ],
        },
        { model: true, servers: true },
      ),
    ).toBe(words('`--model`, `--mcp-config`, `--strict-mcp-config` and `--max-turns`'));
    expect(
      driver.stepTurnProblem(
        { extraArgs: ['--model', 'sonnet', '--mcp-config', 'x.json', '--strict-mcp-config'] },
        { model: true, servers: true },
      ),
    ).toBe(words('`--model`, `--mcp-config` and `--strict-mcp-config`'));
    expect(stepTurnProblem({ extraArgs: ['--mcp-config', 'x.json'] }, { servers: true })).toBe(
      words('`--mcp-config`'),
    );
  });
});

describe("an agent's grants on a launch", () => {
  const ACCOUNT = '/home/alice/.claude-work/.claude.json';
  const URL = 'http://127.0.0.1:9/h';
  const EXTRA = ['--append-system-prompt', 'x'];
  // Consola's own read-only tools, written out rather than read from the driver.
  const READ_ONLY_TOOLS = [
    'mcp__consola__consola_work_item_context',
    'mcp__consola__consola_list_inbox',
    'mcp__consola__consola_set_outputs',
    'mcp__consola__consola_write_artifact',
    'mcp__consola__consola_read_artifact',
    'mcp__consola__consola_list_artifacts',
  ];
  const HOOKS = JSON.parse(claudeSettings({ attentionUrl: URL })!).hooks as unknown;
  const settings = (allowedMcpServers: unknown[], hooks = true) =>
    JSON.stringify({ ...(hooks ? { hooks: HOOKS } : {}), allowedMcpServers });
  const turn: SessionLaunch = {
    sessionId: 'S',
    resume: false,
    unattended: true,
    reportTurn: true,
    initialPrompt: 'P',
    toolPolicy: 'read-only',
    mcpConfigPath: '/m/consola.json',
    attentionUrl: URL,
    maxTurns: 40,
    model: 'opus',
  };
  const USER: ClaudeAgentGrants = {
    driverId: 'claude',
    servers: [{ name: 'grafana' }],
    skills: [],
    allowedMcpServers: [{ serverName: 'consola' }, { serverName: 'grafana' }],
    strict: true,
    accountFile: ACCOUNT,
    allowedTools: ['mcp__grafana__*'],
  };
  const CONNECTOR: ClaudeAgentGrants = {
    driverId: 'claude',
    servers: [{ name: 'claude.ai Coralogix' }],
    skills: [],
    allowedMcpServers: [
      { serverName: 'consola' },
      { serverUrl: 'https://mcp.coralogix.example/mcp' },
    ],
    strict: false,
    allowedTools: ['mcp__claude_ai_Coralogix__*'],
  };
  const extra = (extraArgs: string[] = EXTRA): HarnessConfig => ({ extraArgs });
  const args = (config: HarnessConfig, launch: SessionLaunch): string[] => {
    const built = driver.buildSessionArgs(config, launch);
    if (!Array.isArray(built)) throw new Error('expected a plain array');
    return built;
  };
  /** Every flag Consola adds sits before `--restricted`, and every extra arg after it. */
  const placed = (built: string[], extraArgs: string[] = EXTRA) => {
    const restricted = built.indexOf('--restricted');
    expect(restricted).toBeGreaterThan(-1);
    for (const flag of ['--mcp-config', '--settings', '--plugin-dir', '--add-dir', '--tools'])
      if (built.includes(flag)) expect(built.indexOf(flag)).toBeLessThan(restricted);
    for (const arg of extraArgs) expect(built.lastIndexOf(arg)).toBeGreaterThan(restricted);
  };

  it('no grants: exactly the argv without them', () => {
    const built = args(extra(), turn);
    expect(built).toEqual([
      '-p',
      '--session-id',
      'S',
      '--model',
      'opus',
      '--mcp-config',
      '/m/consola.json',
      '--settings',
      claudeSettings({ attentionUrl: URL }),
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '40',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      ...READ_ONLY_TOOLS,
      '--restricted',
      ...EXTRA,
      '--',
      'P',
    ]);
    placed(built);
  });

  it('a user server: its account file, the allow-list in the one --settings, its rule; strict kept', () => {
    const built = args(extra(), { ...turn, grants: USER });
    expect(built).toEqual([
      '-p',
      '--session-id',
      'S',
      '--model',
      'opus',
      '--mcp-config',
      '/m/consola.json',
      ACCOUNT,
      '--settings',
      settings([{ serverName: 'consola' }, { serverName: 'grafana' }]),
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '40',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      ...READ_ONLY_TOOLS,
      'mcp__grafana__*',
      '--restricted',
      ...EXTRA,
      '--',
      'P',
    ]);
    placed(built);
    expect(built.filter((arg) => arg === '--settings')).toHaveLength(1);
  });

  it('a connector: strict dropped, no account file, its URL in the allow-list', () => {
    const built = args(extra(), { ...turn, grants: CONNECTOR });
    expect(built).toEqual([
      '-p',
      '--session-id',
      'S',
      '--model',
      'opus',
      '--mcp-config',
      '/m/consola.json',
      '--settings',
      settings([{ serverName: 'consola' }, { serverUrl: 'https://mcp.coralogix.example/mcp' }]),
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '40',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      ...READ_ONLY_TOOLS,
      'mcp__claude_ai_Coralogix__*',
      '--restricted',
      ...EXTRA,
      '--',
      'P',
    ]);
    placed(built);
  });

  it('no attention URL: the allow-list alone in --settings', () => {
    const built = args(extra(), { ...turn, attentionUrl: undefined, grants: USER });
    expect(built[built.indexOf('--settings') + 1]).toBe(
      settings([{ serverName: 'consola' }, { serverName: 'grafana' }], false),
    );
  });

  it('the interactive reopen keeps the grants, with no print mode, report or cap', () => {
    const built = args(extra(), { ...turn, unattended: false, resume: true, grants: CONNECTOR });
    expect(built).toEqual([
      '--resume',
      'S',
      '--model',
      'opus',
      '--mcp-config',
      '/m/consola.json',
      '--settings',
      settings([{ serverName: 'consola' }, { serverUrl: 'https://mcp.coralogix.example/mcp' }]),
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      ...READ_ONLY_TOOLS,
      'mcp__claude_ai_Coralogix__*',
      '--restricted',
      ...EXTRA,
    ]);
    placed(built);
  });

  it('refuses a server grant without Consola’s own server', () => {
    expect(() => args(extra(), { ...turn, mcpConfigPath: undefined, grants: USER })).toThrow(
      "A step whose agent names MCP servers needs Consola's own server too, so it did not start.",
    );
  });

  it('refuses grants another driver compiled', () => {
    const codex = { ...USER, driverId: 'codex' } as unknown as ClaudeAgentGrants;
    expect(() => args(extra(), { ...turn, grants: codex })).toThrow(
      'These grants were compiled for another CLI, so this session cannot launch on Claude.',
    );
  });

  it('refuses grants on a session that is not read-only', () => {
    expect(() =>
      args(extra(), { ...turn, unattended: false, toolPolicy: undefined, grants: USER }),
    ).toThrow(
      "An agent's grants hold only in a read-only session, so this session cannot launch with them.",
    );
  });

  it("refuses a reporting turn with servers whose harness's extra args would override them, and not its reopen", () => {
    const pinned = extra(['--strict-mcp-config']);
    expect(() => args(pinned, { ...turn, grants: CONNECTOR })).toThrow(
      "This harness's extra arguments set `--strict-mcp-config`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(() =>
      args(pinned, { ...turn, unattended: false, resume: true, grants: CONNECTOR }),
    ).not.toThrow();
    // A skills-only grant compiles no server flags, so the harness's own are left alone.
    expect(() =>
      args(pinned, {
        ...turn,
        grants: {
          ...USER,
          servers: [],
          allowedMcpServers: undefined,
          accountFile: undefined,
          allowedTools: [],
        },
      }),
    ).not.toThrow();
  });

  describe('skills', () => {
    let dir: string;
    let pluginDir: string;
    /** The run's copy of the step's one skill, and its hash as the run's definition holds it. */
    const TRIAGE = '# Triage\n';
    const TRIAGE_HASH = skillHash([{ path: 'SKILL.md', bytes: new TextEncoder().encode(TRIAGE) }]);
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-step-skills-'));
      pluginDir = path.join(dir, 'run', 'look', '1', 'plugin');
      const skillsDir = path.join(dir, 'run', 'skills');
      fs.mkdirSync(path.join(skillsDir, 'incident-triage'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), TRIAGE);
      // The plugin as the attempt's first launch built it.
      await buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], {
        'incident-triage': TRIAGE_HASH,
      });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const skillGrants = (plugin: string): ClaudeAgentGrants => ({
      driverId: 'claude',
      servers: [],
      skills: ['incident-triage'],
      strict: true,
      allowedTools: ['Skill(consola-step:incident-triage)'],
      pluginDir: plugin,
      skillHashes: { 'incident-triage': TRIAGE_HASH },
    });

    /**
     * A CLI that answers `initialize` with `commands`, appending its cwd
     * and argv to `asked.jsonl` each time it is started.
     */
    function initializeCli(commands: string[], { exit }: { exit?: number } = {}): string {
      const file = path.join(dir, `cli-${commands.length}-${exit ?? 0}.cjs`);
      const log = path.join(dir, 'asked.jsonl');
      fs.writeFileSync(
        file,
        `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');
${exit !== undefined ? `process.stderr.write('boom'); process.exit(${exit});` : ''}
const lines = require('readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success',
    request_id: message.request_id, response: { commands: ${JSON.stringify(commands)}.map((name) => ({ name })) } } }) + '\\n');
});
setTimeout(() => {}, 10000);`,
      );
      const shim = path.join(dir, `claude-${commands.length}-${exit ?? 0}`);
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
      return shim;
    }
    const asked = (): Array<{ cwd: string; argv: string[] }> => {
      const log = path.join(dir, 'asked.jsonl');
      if (!fs.existsSync(log)) return [];
      return fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { cwd: string; argv: string[] });
    };
    const ALL = ['dataviz', 'simplify', 'clear', 'consola-step:incident-triage'];
    const denyFlags = (plugin: string) => [
      '--strict-mcp-config',
      '--plugin-dir',
      plugin,
      '--add-dir',
      plugin,
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,Skill',
      '--restricted',
    ];

    it('the plugin dir, Skill, its allow rule and a deny list asked of the CLI where the session runs', async () => {
      const config = { binaryPath: initializeCli(ALL), extraArgs: EXTRA };
      const cwd = fs.mkdtempSync(path.join(dir, 'checkout-'));
      const built = driver.buildSessionArgs(config, {
        ...turn,
        cwd,
        grants: skillGrants(pluginDir),
      });
      expect(Array.isArray(built)).toBe(false);
      const resolved = await built;
      expect(resolved).toEqual([
        '-p',
        '--session-id',
        'S',
        '--model',
        'opus',
        '--mcp-config',
        '/m/consola.json',
        '--settings',
        claudeSettings({ attentionUrl: URL }),
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '40',
        '--plugin-dir',
        pluginDir,
        '--add-dir',
        pluginDir,
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Read,Grep,Glob,Skill',
        '--allowedTools',
        ...READ_ONLY_TOOLS,
        'Skill(consola-step:incident-triage)',
        '--disallowedTools',
        'Skill(dataviz)',
        'Skill(simplify)',
        'Skill(clear)',
        '--restricted',
        ...EXTRA,
        '--',
        'P',
      ]);
      placed(resolved);
      const [ask] = asked();
      expect(fs.realpathSync(ask.cwd)).toBe(fs.realpathSync(cwd));
      // The handshake's flags, then exactly the skill flags: no server, no hook, no extra arg.
      expect(ask.argv.slice(-denyFlags(pluginDir).length)).toEqual(denyFlags(pluginDir));
      for (const absent of ['--mcp-config', '--settings', '--append-system-prompt'])
        expect(ask.argv).not.toContain(absent);
    });

    it('asks again on every launch, the reopen included, and never with the harness’s extra args', async () => {
      const config = { binaryPath: initializeCli(ALL), extraArgs: ['--mcp-config', 'x.json'] };
      const reopen = {
        ...turn,
        unattended: false,
        resume: true,
        cwd: dir,
        grants: skillGrants(pluginDir),
      };
      await driver.buildSessionArgs(config, reopen);
      await driver.buildSessionArgs(config, reopen);
      expect(asked()).toHaveLength(2);
      for (const ask of asked()) expect(ask.argv).not.toContain('--mcp-config');
    });

    it('fails the launch when the answer does not list the granted skill', async () => {
      const config = { binaryPath: initializeCli(['dataviz']), extraArgs: [] };
      await expect(
        driver.buildSessionArgs(config, { ...turn, cwd: dir, grants: skillGrants(pluginDir) }),
      ).rejects.toThrow(
        "Couldn't ask claude which skills it has: its answer does not list consola-step:incident-triage.",
      );
    });

    it('fails the launch when the CLI cannot be asked, with its reason', async () => {
      const config = { binaryPath: initializeCli(ALL, { exit: 2 }), extraArgs: [] };
      await expect(
        driver.buildSessionArgs(config, { ...turn, cwd: dir, grants: skillGrants(pluginDir) }),
      ).rejects.toThrow(/^Couldn't ask claude which skills it has: boom$/);
    });

    it('with the plugin dir gone: no skills at all, nothing asked, and a notice', () => {
      const config = { binaryPath: initializeCli(ALL), extraArgs: EXTRA };
      fs.rmSync(pluginDir, { recursive: true });
      const launch = { ...turn, cwd: dir, grants: skillGrants(pluginDir) };
      const built = args(config, launch);
      for (const absent of [
        '--plugin-dir',
        '--add-dir',
        'Read,Grep,Glob,Skill',
        'Skill(consola-step:incident-triage)',
        '--disallowedTools',
      ])
        expect(built).not.toContain(absent);
      expect(built[built.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
      expect(asked()).toHaveLength(0);
      expect(driver.launchNotice(launch)).toBe(
        "This step's skills are no longer kept; it continues without them.",
      );
    });

    const CHANGED = "This step's skills are not the ones its run holds; it continues without them.";
    it.each<
      [string, (plugin: string) => void, (grants: ClaudeAgentGrants) => ClaudeAgentGrants, string]
    >([
      [
        'a skill changed in its plugin dir since it was built',
        (plugin) =>
          fs.writeFileSync(
            path.join(plugin, 'skills', 'incident-triage', 'SKILL.md'),
            '# Not it\n',
          ),
        (grants) => grants,
        CHANGED,
      ],
      [
        'a skill added to its plugin dir',
        (plugin) => fs.mkdirSync(path.join(plugin, 'skills', 'stowaway')),
        (grants) => grants,
        CHANGED,
      ],
      [
        'grants that hold no hashes to check it against',
        () => {},
        ({ skillHashes: _hashes, ...grants }) => grants,
        "This step's skills cannot be checked against its run; it continues without them.",
      ],
    ])(
      'with %s: no skills at all, nothing asked, and a notice (review M1)',
      (_label, change, grantsOf, notice) => {
        const config = { binaryPath: initializeCli(ALL), extraArgs: EXTRA };
        change(pluginDir);
        const launch = { ...turn, cwd: dir, grants: grantsOf(skillGrants(pluginDir)) };
        const built = args(config, launch);
        for (const absent of [
          '--plugin-dir',
          '--add-dir',
          'Read,Grep,Glob,Skill',
          '--disallowedTools',
        ])
          expect(built).not.toContain(absent);
        expect(built).not.toContain('Skill(consola-step:incident-triage)');
        expect(built[built.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
        expect(asked()).toHaveLength(0);
        expect(driver.launchNotice(launch)).toBe(notice);
      },
    );

    it('builds no plugin flags for grants that hold a plugin dir and no skills', () => {
      const config = { binaryPath: initializeCli(ALL), extraArgs: [] };
      const built = args(config, {
        ...turn,
        cwd: dir,
        grants: { ...skillGrants(pluginDir), skills: [], allowedTools: [] },
      });
      expect(built).not.toContain('--plugin-dir');
      expect(built[built.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
      expect(asked()).toHaveLength(0);
    });

    it('says nothing before a launch whose skills are there, or that has none', () => {
      expect(driver.launchNotice({ ...turn, grants: skillGrants(pluginDir) })).toBeNull();
      expect(driver.launchNotice(turn)).toBeNull();
      expect(driver.launchNotice({ ...turn, grants: USER })).toBeNull();
    });

    it('stages the plugin dir from the run’s skills copy', async () => {
      const skillsDir = path.join(dir, 'run', 'skills');
      fs.rmSync(pluginDir, { recursive: true });
      await driver.stageSkills(skillGrants(pluginDir), skillsDir);
      expect(
        fs.readFileSync(path.join(pluginDir, 'skills', 'incident-triage', 'SKILL.md'), 'utf8'),
      ).toBe('# Triage\n');
      // Only the copy the run holds (review M1).
      fs.rmSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), '# Changed\n');
      await expect(driver.stageSkills(skillGrants(pluginDir), skillsDir)).rejects.toThrow(
        /skills\/incident-triage in the run folder is not the one its run holds/,
      );
      expect(fs.existsSync(pluginDir)).toBe(false);
      fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), TRIAGE);
      await expect(
        driver.stageSkills({ ...skillGrants(pluginDir), pluginDir: undefined }, skillsDir),
      ).rejects.toThrow(/no plugin dir/);
      // Grants with no skills have nothing to stage.
      await expect(driver.stageSkills(USER, skillsDir)).resolves.toBeUndefined();
      const codex = {
        ...skillGrants(pluginDir),
        driverId: 'codex',
      } as unknown as ClaudeAgentGrants;
      await expect(driver.stageSkills(codex, skillsDir)).rejects.toThrow(
        'These grants were compiled for another CLI, so this session cannot launch on Claude.',
      );
    });
  });
});
