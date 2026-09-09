import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDriver } from './index';
import type { HarnessDriverId } from '../../shared/types';
import { getDriverDescriptor } from '../../shared/constants';
import { CodexDriver } from './CodexDriver';
import { createCodexThread } from './codexAppServer';
import { listCodexModels, codexModelConfigArgs } from './codexModels';

vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: process.env.PATH }) }));

const binaryPath = path.resolve('tests/fixtures/codex.cjs');
const sessionId = '11111111-1111-4111-8111-111111111111';
let configDir: string;
beforeEach(() => { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-codex-test-')); });
afterEach(() => { fs.rmSync(configDir, { recursive: true, force: true }); });
const driver = () => getDriver('codex' as HarnessDriverId);
const config = () => ({ binaryPath, configDir, extraArgs: [] as string[] });
const launch = (resume = false) => ({ sessionId, resume, cwd: configDir });

describe('Codex harness', () => {
  it('is available in settings and routes to its own driver', () => {
    expect(getDriverDescriptor('codex' as HarnessDriverId)).toMatchObject({
      id: 'codex', available: true, configDirEnvVar: 'CODEX_HOME',
    });
    expect(driver().id).toBe('codex');
  });

  it('preserves the ambient profile unless an explicit one is selected', () => {
    const env = { PATH: '/bin', CODEX_HOME: '/ambient' };
    expect(driver().composeEnv({ extraArgs: [] }, env)).toEqual(env);
    expect(driver().composeEnv(config(), env).CODEX_HOME).toBe(configDir);
    expect(env.CODEX_HOME).toBe('/ambient');
  });

  it('checks the configured binary and login without starting a turn', async () => {
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true, version: '0.114.0', resolvedBinary: binaryPath,
      account: { displayName: 'ChatGPT' },
    });
  });

  it('reports a missing pinned binary without falling back to another installation', async () => {
    const missing = path.join(configDir, 'missing');
    expect(await driver().probeHealth({ ...config(), binaryPath: missing })).toMatchObject({
      available: false, resolvedBinary: missing, error: expect.stringContaining('Not executable'),
    });
  });

  it('persists a native conversation ID and resumes exactly that conversation after a driver reload', async () => {
    const first = await driver().buildSessionArgs(config(), launch());
    expect(first[0]).toBe('resume');
    expect(first[1]).not.toBe(sessionId);
    expect(fs.existsSync(path.join(configDir, first[1] + '.json'))).toBe(true);
    expect(await new CodexDriver().buildSessionArgs(config(), launch(true))).toEqual(first);
    // Even a stale hasStarted=false cannot replace an already-created thread.
    expect(await driver().buildSessionArgs(config(), launch())).toEqual(first);
  });

  it('keeps concurrent tabs in the same profile on distinct conversations', async () => {
    const [a, b] = await Promise.all([
      driver().buildSessionArgs(config(), launch()),
      driver().buildSessionArgs(config(), { ...launch(), sessionId: '22222222-2222-4222-8222-222222222222' }),
    ]);
    expect(a[1]).not.toBe(b[1]);
    expect(fs.existsSync(path.join(configDir, a[1] + '.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, b[1] + '.json'))).toBe(true);
  });

  it('coalesces simultaneous preparation of the same session', async () => {
    const [a, b] = await Promise.all([
      driver().buildSessionArgs(config(), launch()),
      driver().buildSessionArgs(config(), launch()),
    ]);
    expect(a).toEqual(b);
    expect(fs.readdirSync(configDir).filter(file => file.endsWith('.json'))).toHaveLength(1);
  });

  it('reports signed-out profiles without inventing an account', async () => {
    fs.writeFileSync(path.join(configDir, 'logged-out'), '');
    expect(await driver().probeHealth(config())).toMatchObject({ available: true, account: undefined });
  });

  it('does not expose API key fragments from login status', async () => {
    fs.writeFileSync(path.join(configDir, 'api-key'), '');
    const result = await driver().probeHealth(config());
    expect(result.account?.displayName).toBe('API key');
    expect(JSON.stringify(result)).not.toContain('fixture-private-key-fragment');
  });

  it('refuses corrupt session mappings instead of silently starting over', async () => {
    await driver().buildSessionArgs(config(), launch());
    const mapping = path.join(configDir, 'consola', 'sessions', sessionId + '.json');
    fs.writeFileSync(mapping, 'broken JSON');
    await expect(driver().buildSessionArgs(config(), launch(true))).rejects.toThrow('Could not read');
  });

  it('passes model, extra arguments and a literal initial prompt to the interactive CLI', async () => {
    const args = await driver().buildSessionArgs({ ...config(), extraArgs: ['--sandbox', 'read-only'] }, {
      ...launch(), model: 'chosen-model', initialPrompt: '-Explain this\nwith examples',
    });
    expect(args.slice(2)).toEqual([
      '--model', 'chosen-model', '--sandbox', 'read-only', '--', '-Explain this\nwith examples',
    ]);
  });

  it('translates conductor stdio MCP configuration into Codex TOML overrides', async () => {
    const mcpConfigPath = path.join(configDir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { consola: {
      type: 'stdio', command: '/path with spaces/electron', args: ['/shim.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1', CONSOLA_CONDUCTOR_TOKEN: 'test-token' },
    } } }));
    const args = await driver().buildSessionArgs(config(), { ...launch(), mcpConfigPath });
    expect(args).toContain('-c');
    expect(args.join(' ')).toContain('mcp_servers.consola=');
    expect(args.join(' ')).toContain('"/path with spaces/electron"');
    expect(args.join(' ')).toContain('"CONSOLA_CONDUCTOR_TOKEN" = "test-token"');
  });
});

describe('Codex preparation failures', () => {
  it.each([
    ['invalid', 'Invalid response'],
    ['reject', 'could not prepare'],
    ['exit', 'exited before'],
    ['hang', 'timeout'],
  ])('rejects %s responses without leaving the caller waiting', async (mode, message) => {
    await expect(createCodexThread(binaryPath, configDir, {
      PATH: process.env.PATH, CODEX_HOME: configDir, CONSOLA_CODEX_FIXTURE_MODE: mode,
    }, 'Test', 1000)).rejects.toThrow(message);
  });
});


describe('Codex model discovery', () => {
  it('enables discovery, reads every page, excludes hidden models, and creates no conversation', async () => {
    expect(getDriverDescriptor('codex').supportsCapabilities).toBe(true);
    const capabilities = await driver().probeCapabilities!(config());
    expect(capabilities.models.map(model => model.value)).toEqual(['fixture-model-a', 'fixture-model-b']);
    expect(capabilities.models[0]).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['high'] });
    expect(fs.readdirSync(configDir)).toEqual([]);
  });

  it('forwards provider config flags without forwarding interactive-only flags', () => {
    expect(codexModelConfigArgs(['--sandbox', 'read-only', '-c', 'model_provider="custom"', '--config=model="example"', '--enable', 'feature', '--model', 'other'])).toEqual([
      '-c', 'model_provider="custom"', '--config=model="example"', '--enable', 'feature',
    ]);
  });

  it.each([
    ['invalid', 'Invalid model response'],
    ['reject', 'could not list models'],
    ['exit', 'exited before'],
    ['hang', 'timed out'],
  ])('handles %s discovery failures without exposing raw diagnostics', async (mode, message) => {
    const result = listCodexModels(binaryPath, configDir, {
      PATH: process.env.PATH, CODEX_HOME: configDir, CONSOLA_CODEX_FIXTURE_MODE: mode,
    }, [], 1000);
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toThrow('fixture-private-key-fragment');
  });

  it.each(['malformed', 'cycle'])('rejects %s model pages instead of showing a misleading list', async mode => {
    await expect(listCodexModels(binaryPath, configDir, {
      PATH: process.env.PATH, CODEX_HOME: configDir, CONSOLA_CODEX_MODELS_FIXTURE: mode,
    })).rejects.toThrow('Invalid model response');
  });
});
