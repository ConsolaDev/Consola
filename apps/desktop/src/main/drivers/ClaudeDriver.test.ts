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
