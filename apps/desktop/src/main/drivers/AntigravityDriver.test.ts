import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDriverDescriptor } from '../../shared/constants';
import { AntigravityDriver, withTitleSettings } from './AntigravityDriver';
import { getDriver } from './index';

let loginEnv: NodeJS.ProcessEnv = {};
vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => loginEnv }));

const binaryPath = path.resolve('tests/fixtures/antigravity.cjs');
const sessionId = '11111111-1111-4111-8111-111111111111';
const nativeIdA = 'aaaaaaaa-1111-4111-8111-111111111111';
const nativeIdB = 'bbbbbbbb-2222-4222-8222-222222222222';

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-agy-test-'));
  loginEnv = {
    PATH: process.env.PATH,
    CONSOLA_AGY_FIXTURE_DIR: configDir,
  };
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

const driver = () => getDriver('antigravity');
const config = () => ({ binaryPath, configDir, extraArgs: [] as string[] });
const launch = (resume = false) => ({ sessionId, resume, cwd: configDir });

function writeTranscript(conversationId: string, lines: Array<Record<string, unknown>>): void {
  const dir = path.join(configDir, 'brain', conversationId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

describe('withTitleSettings', () => {
  it('appends Consola’s title command when no --settings flag is present', () => {
    const args = withTitleSettings(['--mode', 'plan']);
    expect(args.slice(0, 2)).toEqual(['--mode', 'plan']);
    expect(args[2]).toBe('--settings');
    expect(JSON.parse(args[3])).toEqual({
      title: { type: 'command', command: expect.stringContaining('conversation_id') },
    });
  });

  it('merges inline --settings JSON and --settings=<file> without dropping user overrides', () => {
    const file = path.join(configDir, 'extra-settings.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mode: 'auto' }), 'utf8');

    const args = withTitleSettings([
      '--settings',
      '{"mode":"plan"}',
      `--settings=${file}`,
      '--yolo',
    ]);
    expect(args.filter((entry) => entry === '--settings')).toHaveLength(1);
    expect(args[0]).toBe('--yolo');
    expect(JSON.parse(args[2])).toEqual({
      mode: 'auto',
      theme: 'dark',
      title: { type: 'command', command: expect.stringContaining('conversation_id') },
    });
  });

  it('leaves unparseable --settings untouched rather than replacing user config', () => {
    const args = withTitleSettings(['--settings', 'not-json-or-existing-file', '--mode', 'plan']);
    expect(args).toEqual(['--settings', 'not-json-or-existing-file', '--mode', 'plan']);
  });
});

describe('Antigravity harness', () => {
  it('is available in settings and routes to its own driver', () => {
    expect(getDriverDescriptor('antigravity')).toMatchObject({
      id: 'antigravity',
      available: true,
      binaryName: 'agy',
      defaultConfigDir: '~/.gemini/antigravity-cli',
      supportsCapabilities: true,
      supportsConversationReading: true,
    });
    expect(getDriverDescriptor('antigravity').configDirEnvVar).toBeUndefined();
    expect(driver().id).toBe('antigravity');
  });

  it('copies the base environment without mutating it', () => {
    const env = { PATH: '/bin', EXTRA: '1' };
    const composed = driver().composeEnv(config(), env);
    expect(composed).toEqual(env);
    expect(composed).not.toBe(env);
  });

  it('resolves pinned binaries, PATH installations, or falls back to agy', () => {
    const agy = new AntigravityDriver();
    expect(agy.resolveBinary(config())).toBe(binaryPath);

    const binDir = path.join(configDir, 'bin');
    fs.mkdirSync(binDir);
    const fakeAgy = path.join(binDir, 'agy');
    fs.writeFileSync(fakeAgy, '#!/bin/sh\n', { mode: 0o755 });
    loginEnv = { PATH: binDir };
    expect(agy.resolveBinary({ extraArgs: [] })).toBe(fakeAgy);
  });

  it('starts fresh without --conversation, forwards model/extraArgs/prompt, and resumes once mapped', () => {
    const agy = new AntigravityDriver();
    const first = agy.buildSessionArgs(
      { ...config(), extraArgs: ['--mode', 'plan'] },
      {
        ...launch(),
        model: 'gemini-4-neon-xhigh',
        initialPrompt: 'Explain this repository',
        mcpConfigPath: path.join(configDir, 'mcp.json'),
      },
    );

    expect(first).not.toContain('--conversation');
    expect(first.slice(0, 4)).toEqual(['--model', 'gemini-4-neon-xhigh', '--mode', 'plan']);
    expect(first[4]).toBe('--settings');
    expect(JSON.parse(first[5]).title.type).toBe('command');
    expect(first.slice(6)).toEqual(['--prompt-interactive', 'Explain this repository']);

    // Simulate agy emitting its conversation UUID via OSC 2.
    const observe = agy.createOutputObserver(config(), sessionId);
    observe(`\x1b]2;${nativeIdA}\x07`);

    const resumed = new AntigravityDriver().buildSessionArgs(config(), launch(true));
    expect(resumed.slice(0, 2)).toEqual(['--conversation', nativeIdA]);
  });

  it('tracks in-terminal conversation switches split across chunks and isolates tabs', () => {
    const agy = new AntigravityDriver();
    const secondSessionId = '22222222-2222-4222-8222-222222222222';
    const observeFirst = agy.createOutputObserver(config(), sessionId);
    const observeSecond = agy.createOutputObserver(config(), secondSessionId);

    observeFirst(`\x1b]0;${nativeIdA}\x07`);
    observeSecond(`\x1b]2;${nativeIdA}\x1b\\`);

    // Split OSC 2 with ST terminator byte-by-byte on the first tab only.
    for (const ch of `\x1b]2;${nativeIdB}\x1b\\`) observeFirst(ch);

    expect(new AntigravityDriver().buildSessionArgs(config(), launch(true)).slice(0, 2)).toEqual([
      '--conversation',
      nativeIdB,
    ]);
    expect(
      new AntigravityDriver()
        .buildSessionArgs(config(), { ...launch(true), sessionId: secondSessionId })
        .slice(0, 2),
    ).toEqual(['--conversation', nativeIdA]);

    // Previous mapping is kept in .bak.
    const backup = path.join(configDir, 'consola', 'sessions', `${sessionId}.json.bak`);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8')).conversationId).toBe(nativeIdA);
  });

  it('ignores non-OSC UUIDs, other OSCs, malformed titles, and oversized sequences', () => {
    const agy = new AntigravityDriver();
    const observe = agy.createOutputObserver(config(), sessionId);
    observe(`\x1b]2;${nativeIdA}\x07`);

    observe(
      `To resume, run agy --conversation ${nativeIdB}\r\n` +
        `\x1b]2;\x07\x1b]2;Project ${nativeIdB}\x07\x1b]7;${nativeIdB}\x07`,
    );
    observe(`\x1b]2;${'x'.repeat(2048)}`);
    expect(new AntigravityDriver().buildSessionArgs(config(), launch(true)).slice(0, 2)).toEqual([
      '--conversation',
      nativeIdA,
    ]);

    observe(`\x1b]2;${nativeIdB}\x1b`);
    observe('\\');
    expect(new AntigravityDriver().buildSessionArgs(config(), launch(true)).slice(0, 2)).toEqual([
      '--conversation',
      nativeIdB,
    ]);
  });

  it('refuses corrupt mappings and invalid session IDs', () => {
    const agy = new AntigravityDriver();
    expect(() => agy.buildSessionArgs(config(), { ...launch(), sessionId: '../escape' })).toThrow(
      /Invalid Consola session ID/,
    );
    expect(() => agy.createOutputObserver(config(), '../escape')).toThrow(
      /Invalid Consola session ID/,
    );

    const mappingFile = path.join(configDir, 'consola', 'sessions', `${sessionId}.json`);
    fs.mkdirSync(path.dirname(mappingFile), { recursive: true });
    fs.writeFileSync(mappingFile, 'not json', 'utf8');
    expect(() => agy.buildSessionArgs(config(), launch(true))).toThrow(/Could not read/);

    fs.writeFileSync(mappingFile, JSON.stringify({ conversationId: 'not-a-uuid' }), 'utf8');
    expect(() => agy.buildSessionArgs(config(), launch(true))).toThrow(
      /Invalid saved Antigravity conversation ID/,
    );
  });

  it('reads first prompt, full conversation, and runtime model from the active transcript', async () => {
    const agy = new AntigravityDriver();
    expect(await agy.readFirstPrompt(config(), sessionId)).toBeNull();
    expect(await agy.readConversation(config(), sessionId)).toBeNull();
    expect(await agy.getSessionModel(config(), sessionId)).toBeNull();

    agy.createOutputObserver(config(), sessionId)(`\x1b]2;${nativeIdA}\x07`);
    expect(await agy.readConversation(config(), sessionId)).toBeNull();

    writeTranscript(nativeIdA, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-12T10:00:00Z',
        content: '<USER_REQUEST>Refactor the router</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'gemini-4-neon-xhigh',
        created_at: '2026-11-12T10:00:01Z',
        content: 'Refactored.',
      },
    ]);

    expect(await agy.readFirstPrompt(config(), sessionId)).toBe('Refactor the router');
    expect(await agy.getSessionModel(config(), sessionId)).toBe('gemini-4-neon-xhigh');
    expect(await agy.readConversation(config(), sessionId)).toEqual({
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Refactor the router', at: '2026-11-12T10:00:00Z' },
        { kind: 'text', text: 'Refactored.', at: '2026-11-12T10:00:01Z' },
      ],
    });
    expect(await agy.readConversation(config(), '../invalid')).toBeNull();
  });

  it('probes health, version, and non-sensitive auth hints without starting a turn', async () => {
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true,
      version: '1.5.13',
      resolvedBinary: binaryPath,
      account: { displayName: 'Google' },
    });

    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ modelProvider: 'gemini' }),
      'utf8',
    );
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true,
      account: { displayName: 'Gemini API key' },
    });

    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ gcp: { project: 'my-gcp-project' } }),
      'utf8',
    );
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true,
      account: { displayName: 'Google Cloud', organizationName: 'my-gcp-project' },
    });

    fs.rmSync(path.join(configDir, 'settings.json'));
    loginEnv = {
      ...loginEnv,
      AGY_ADC_AUTH: 'true',
      GOOGLE_CLOUD_PROJECT: 'adc-project',
    };
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true,
      account: { displayName: 'Google Cloud (ADC)', organizationName: 'adc-project' },
    });

    fs.writeFileSync(path.join(configDir, 'logged-out'), '', 'utf8');
    expect(await driver().probeHealth(config())).toMatchObject({
      available: true,
      version: '1.5.13',
      account: undefined,
    });
  });

  it('reports a missing pinned binary for health and capabilities without falling back', async () => {
    const missing = path.join(configDir, 'missing-agy');
    expect(await driver().probeHealth({ ...config(), binaryPath: missing })).toMatchObject({
      available: false,
      resolvedBinary: missing,
      error: expect.stringContaining('Not executable'),
    });
    await expect(driver().probeCapabilities!({ ...config(), binaryPath: missing })).rejects.toThrow(
      /Not executable/,
    );
  });

  it('discovers models, commands, and agents via probeCapabilities', async () => {
    const capabilities = await driver().probeCapabilities!(config());
    expect(capabilities.models.map((model) => model.value)).toContain('gemini-4-neon-xhigh');
    expect(capabilities.commands.map((command) => command.name)).toContain('antigravity-guide');
    expect(capabilities.agents.map((agent) => agent.name)).toEqual(['reviewer']);
  });

  it('offers no attention hooks and launches identically with or without an attention URL', () => {
    const agy = new AntigravityDriver();
    expect(getDriver('antigravity').attentionHooks).toBeUndefined();
    const plain = agy.buildSessionArgs(config(), launch());
    const offered = agy.buildSessionArgs(config(), {
      ...launch(),
      attentionUrl: 'http://127.0.0.1:1/attention/x',
    });
    expect(offered).toEqual(plain);
  });
});

describe("Antigravity's profile folder (slice 3-B Task 17, Call 21)", () => {
  it('is what the harness pins, else ~/.gemini, which holds its data dir and its sign-in', () => {
    const agy = new AntigravityDriver();
    expect(agy.profileDir({ configDir: '/h/.agy-work', extraArgs: [] })).toBe('/h/.agy-work');
    expect(agy.profileDir({ extraArgs: [] })).toBe(path.join(os.homedir(), '.gemini'));
  });
});
