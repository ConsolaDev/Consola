import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONDUCTOR_NAME_PATTERN, renderTemplate, scaffold } from './ConductorScaffold';

let scopeDir: string;

beforeEach(() => {
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-scaffold-'));
});

afterEach(() => {
  fs.rmSync(scopeDir, { recursive: true, force: true });
});

describe('renderTemplate', () => {
  it('substitutes every known placeholder', () => {
    expect(renderTemplate('a {{name}} b {{kickoff}}', { name: 'x', kickoff: 'y' })).toBe('a x b y');
  });

  it('leaves unknown placeholders visible rather than blanking them', () => {
    expect(renderTemplate('{{mystery}}', { name: 'x' })).toBe('{{mystery}}');
  });
});

describe('scaffold', () => {
  it('creates the conductor directory with all three files rendered', async () => {
    const dir = await scaffold(scopeDir, 'symbalance-api', 'Ship the API.', 'Sympower');

    expect(dir).toBe(path.join(scopeDir, 'conductor', 'symbalance-api'));

    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('symbalance-api');
    expect(claude).toContain('Ship the API.');
    expect(claude).toContain('Sympower');
    expect(claude).not.toContain('{{');

    const policy = fs.readFileSync(path.join(dir, 'POLICY.md'), 'utf8');
    expect(policy).toContain('Escalate');
    expect(policy).not.toContain('{{');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(state).toEqual({ version: 1, tasks: [], workers: {}, notes: '' });
  });

  it('names the consola_* tools in CLAUDE.md so the conductor knows its hands', async () => {
    const dir = await scaffold(scopeDir, 'tools-check', 'k', 'ws');
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    for (const tool of [
      'consola_spawn_session',
      'consola_send_prompt',
      'consola_session_status',
      'consola_group_status',
    ]) {
      expect(claude).toContain(tool);
    }
  });

  it('refuses when the directory already exists, naming the path', async () => {
    await scaffold(scopeDir, 'dup', 'k', 'ws');
    await expect(scaffold(scopeDir, 'dup', 'k', 'ws')).rejects.toThrow(
      path.join(scopeDir, 'conductor', 'dup')
    );
  });

  it('rejects names that would escape the conductor directory', async () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', '']) {
      await expect(scaffold(scopeDir, bad, 'k', 'ws')).rejects.toThrow(/Invalid conductor name/);
    }
    expect(CONDUCTOR_NAME_PATTERN.test('ok-name.v2_x')).toBe(true);
  });
});
