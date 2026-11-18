import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTextGenerationArgs, ClaudeDriver } from './ClaudeDriver';
import type { HarnessConfig } from './HarnessDriver';

// (vi.mock is hoisted above the imports.) The real probe runs the user's interactive login shell, which can take seconds.
vi.mock('../LoginEnvironment', () => ({
  getLoginEnv: () => process.env,
  loginEnvProblem: () => null,
}));

const driver = new ClaudeDriver();
const config: HarnessConfig = { extraArgs: ['--verbose'] };

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
