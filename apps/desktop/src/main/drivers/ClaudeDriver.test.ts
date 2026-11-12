import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeDriver } from './ClaudeDriver';
import type { HarnessConfig } from './HarnessDriver';

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
      '--session-id', 'abc',
      '--mcp-config', '/tmp/conductor.json',
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

describe('getRecentReplies', () => {
  it('refuses a session id that could escape the projects directory', async () => {
    expect(await driver.getRecentReplies(config, '../etc/passwd', 3)).toBeNull();
  });

  it('returns the replies from a transcript in the harness config directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-driver-'));
    try {
      const project = path.join(dir, 'projects', '-Users-someone-repo');
      fs.mkdirSync(project, { recursive: true });
      const id = '22222222-2222-4222-8222-222222222222';
      const line = (type: string, content: unknown) =>
        JSON.stringify({ type, message: { role: type, content } });
      fs.writeFileSync(
        path.join(project, `${id}.jsonl`),
        [
          line('user', 'review it'),
          line('assistant', [{ type: 'text', text: 'Two issues found.' }]),
        ].join('\n') + '\n'
      );
      expect(await driver.getRecentReplies({ ...config, configDir: dir }, id, 3)).toEqual([
        'Two issues found.',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null when the session has no transcript', async () => {
    expect(
      await driver.getRecentReplies({ ...config, configDir: '/nonexistent-consola-dir' }, 'abc', 3)
    ).toBeNull();
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
    expect(driver.readWorkingDirectory(harness(), 4242)).toBe('/code/consola/.claude/worktrees/assistant');
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
