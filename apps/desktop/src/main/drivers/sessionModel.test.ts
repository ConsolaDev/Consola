import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDriver } from './index';

let configDir: string;
beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-model-'));
});
afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});
const config = () => ({ configDir, extraArgs: [] });
const write = (file: string, records: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
};

describe('runtime session models', () => {
  it('reads the latest Claude model and ignores synthetic responses and incomplete writes', async () => {
    const file = path.join(configDir, 'projects', 'repo', 'session-1.jsonl');
    write(file, [
      { type: 'assistant', message: { model: 'claude-sonnet-4-6' } },
      { type: 'assistant', message: { model: 'claude-opus-4-6' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'user', message: { model: 'ignore-user-content' } },
    ]);
    fs.appendFileSync(file, '{"type":');
    expect(await getDriver('claude').getSessionModel?.(config(), 'session-1')).toBe(
      'claude-opus-4-6',
    );
  });

  it('follows the Codex session mapping and refreshes after a model switch', async () => {
    write(path.join(configDir, 'consola', 'sessions', 'session-1.json'), [
      { threadId: 'native-1' },
    ]);
    const file = path.join(
      configDir,
      'sessions',
      '2026',
      '09',
      '09',
      'rollout-date-native-1.jsonl',
    );
    write(file, [{ type: 'turn_context', payload: { model: 'gpt-5.4' } }]);
    expect(await getDriver('codex').getSessionModel?.(config(), 'session-1')).toBe('gpt-5.4');
    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }) + '\n',
    );
    expect(await getDriver('codex').getSessionModel?.(config(), 'session-1')).toBe('gpt-5.6');
  });

  it('follows the Antigravity session mapping and refreshes after a model switch', async () => {
    const convId = '11111111-1111-4111-8111-111111111111';
    write(path.join(configDir, 'consola', 'sessions', 'session-1.json'), [
      { conversationId: convId },
    ]);
    const file = path.join(
      configDir,
      'brain',
      convId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    write(file, [{ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high' }]);
    expect(await getDriver('antigravity').getSessionModel?.(config(), 'session-1')).toBe(
      'gemini-4-neon-high',
    );
    fs.appendFileSync(
      file,
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh' }) +
        '\n',
    );
    expect(await getDriver('antigravity').getSessionModel?.(config(), 'session-1')).toBe(
      'gemini-4-neon-xhigh',
    );
  });

  it('finds the model even when a large tool result follows it', async () => {
    write(path.join(configDir, 'projects', 'repo', 'session-1.jsonl'), [
      { type: 'assistant', message: { model: 'claude-opus-4-6' } },
      { type: 'user', message: { content: 'x'.repeat(200_000) } },
    ]);
    expect(await getDriver('claude').getSessionModel?.(config(), 'session-1')).toBe(
      'claude-opus-4-6',
    );
  });

  it('has no model for an unknown session or an invalid session ID', async () => {
    for (const id of ['claude', 'codex', 'antigravity'] as const) {
      expect(await getDriver(id).getSessionModel?.(config(), 'missing')).toBeNull();
      expect(await getDriver(id).getSessionModel?.(config(), '../escape')).toBeNull();
    }
  });
});
