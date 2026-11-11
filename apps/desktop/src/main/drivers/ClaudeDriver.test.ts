import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
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
