import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpClientPort, NodeMcpClientOptions } from '@consola/automation-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationMcpDeps } from './mcpWiring';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-wiring-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const FAKE_PORT: McpClientPort = {
  transports: ['stdio', 'http'],
  connect: async () => ({ ok: false, reason: 'fake' }),
  endOrphan: async () => 'unknown',
};

describe('automationMcpDeps', () => {
  it('makes the client in <userData>/mcp-calls, with the login environment once its retry settled, as a copy', async () => {
    const made: NodeMcpClientOptions[] = [];
    const makeClient = vi.fn((options: NodeMcpClientOptions) => {
      made.push(options);
      return FAKE_PORT;
    });
    let release!: () => void;
    const retried = new Promise<void>((resolve) => {
      release = resolve;
    });
    const login: NodeJS.ProcessEnv = { HOME: '/Users/JaviDev', PATH: '/usr/bin:/bin' };
    const deps = automationMcpDeps({
      userDataDir: userData,
      loginEnv: async () => {
        await retried;
        return login;
      },
      makeClient,
    });
    expect(deps.mcp).toBe(FAKE_PORT);
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(made[0].workRoot).toBe(path.join(userData, 'mcp-calls'));
    expect(made[0].platform).toBeUndefined();

    let settled = false;
    const env = made[0].baseEnv().then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    release();
    const answered = await env;
    expect(answered).toEqual(login);
    expect(answered).not.toBe(login);
  });

  it('keeps Check server groups in <userData>/mcp-server-groups.json', () => {
    const { serverGroups } = automationMcpDeps({
      userDataDir: userData,
      loginEnv: async () => ({}),
      makeClient: () => FAKE_PORT,
    });
    expect(serverGroups.read()).toBeNull();
    const file = {
      version: 1 as const,
      groups: [
        {
          pgid: 4242,
          startedAt: 'Mon Nov 23 09:00:00 2026',
          for: 'ws-1/briefing/slack',
          at: '2026-11-23T09:00:00.000Z',
        },
      ],
    };
    serverGroups.write(file);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(userData, 'mcp-server-groups.json'), 'utf8'),
    ) as unknown;
    expect(onDisk).toEqual(file);
    expect(serverGroups.read()).toEqual(file);
  });
});
