import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseAntigravityAgents,
  parseAntigravityHelpCommands,
  parseAntigravityModels,
  parseAntigravitySkills,
  probeAntigravityCapabilities,
} from './antigravityCapabilities';

const binaryPath = path.resolve('tests/fixtures/antigravity.cjs');

describe('parseAntigravityModels', () => {
  it('parses tab-separated and column-aligned models, stripping CR spinners and duplicates', () => {
    const stdout = [
      '\rLoading models...\rgemini-4-neon-high\tGemini 4 Neon (High)',
      'gemini-4-neon-xhigh   Gemini 4 Neon (XHigh)',
      'gemini-4-neon-high\tDuplicate Ignored',
      '',
      'single-token-noise',
    ].join('\n');

    expect(parseAntigravityModels(stdout)).toEqual([
      {
        value: 'gemini-4-neon-high',
        resolvedModel: 'gemini-4-neon-high',
        displayName: 'Gemini 4 Neon (High)',
        description: '',
      },
      {
        value: 'gemini-4-neon-xhigh',
        resolvedModel: 'gemini-4-neon-xhigh',
        displayName: 'Gemini 4 Neon (XHigh)',
        description: '',
      },
    ]);
  });

  it('throws on empty or unrecognised output instead of inventing an empty list', () => {
    expect(() => parseAntigravityModels('')).toThrow(/Invalid model response/);
    expect(() => parseAntigravityModels('not-a-model-line\n')).toThrow(/Invalid model response/);
  });
});

describe('Antigravity JSON command parsers', () => {
  it('parses /help commands, stripping leading slashes and keeping aliases', () => {
    const stdout = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'help',
        data: {
          commands: [
            { name: '/model', description: 'Switch model' },
            { name: 'usage', aliases: ['quota', ' '], description: 'View quota' },
            { description: 'nameless' },
          ],
        },
      },
    });
    expect(parseAntigravityHelpCommands(stdout)).toEqual([
      { name: 'model', description: 'Switch model', aliases: undefined },
      { name: 'usage', description: 'View quota', aliases: ['quota'] },
    ]);
  });

  it('parses /skills and /agents envelopes', () => {
    const skills = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'skills',
        data: { skills: [{ name: '/guide', description: 'Read guide' }] },
      },
    });
    const agents = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'agents',
        data: { agents: [{ name: 'reviewer', description: 'Code reviewer' }] },
      },
    });
    expect(parseAntigravitySkills(skills)).toEqual([{ name: 'guide', description: 'Read guide' }]);
    expect(parseAntigravityAgents(agents)).toEqual([
      { name: 'reviewer', description: 'Code reviewer' },
    ]);
  });

  it('throws on invalid JSON envelopes', () => {
    expect(() => parseAntigravityHelpCommands('not json')).toThrow(/Invalid command response/);
    expect(() =>
      parseAntigravityHelpCommands(JSON.stringify({ status: 'ERROR', command: { name: 'help' } })),
    ).toThrow(/Invalid command response/);
    expect(() =>
      parseAntigravitySkills(JSON.stringify({ status: 'SUCCESS', command: { name: 'other' } })),
    ).toThrow(/Invalid skills response/);
    expect(() =>
      parseAntigravityAgents(
        JSON.stringify({ status: 'SUCCESS', command: { name: 'agents', data: {} } }),
      ),
    ).toThrow(/Invalid agents response/);
  });
});

describe('probeAntigravityCapabilities', () => {
  it('collects models, merged help + skill commands, and agents from the CLI', async () => {
    const capabilities = await probeAntigravityCapabilities(binaryPath, os.tmpdir(), {
      PATH: process.env.PATH,
    });

    expect(capabilities.models.map((model) => model.value)).toEqual([
      'gemini-4-neon-high',
      'gemini-4-neon-xhigh',
      'gemini-3.8-flash-high',
      'gemini-pro-orchestrator-neon',
    ]);
    expect(capabilities.commands).toEqual([
      { name: 'help', description: 'Show available commands and keybindings', aliases: undefined },
      {
        name: 'model',
        description: 'Set a model, or run a single prompt on another model',
        aliases: undefined,
      },
      { name: 'usage', description: 'View model quota usage', aliases: ['quota'] },
      { name: 'antigravity-guide', description: 'Antigravity CLI guide' },
    ]);
    expect(capabilities.agents).toEqual([
      { name: 'reviewer', description: 'Reviews code changes' },
    ]);
    expect(capabilities.outputStyles).toEqual([]);
  });

  it.each([
    ['logged-out', /Not signed in/],
    ['malformed', /Invalid model response/],
    ['exit', /Could not load Antigravity models/],
    ['hang', /Could not load Antigravity models/],
  ])('handles %s probe failures cleanly', async (mode, pattern) => {
    await expect(
      probeAntigravityCapabilities(
        binaryPath,
        os.tmpdir(),
        { PATH: process.env.PATH, CONSOLA_AGY_FIXTURE_MODE: mode },
        300,
      ),
    ).rejects.toThrow(pattern);
  });

  it('reports when the binary does not exist', async () => {
    await expect(
      probeAntigravityCapabilities(
        path.join(os.tmpdir(), 'definitely-missing-agy-binary'),
        os.tmpdir(),
        { PATH: process.env.PATH },
      ),
    ).rejects.toThrow(/Not found/);
  });
});
