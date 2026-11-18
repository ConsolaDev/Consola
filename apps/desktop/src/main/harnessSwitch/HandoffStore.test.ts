import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HandoffStore } from './HandoffStore';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-handoffs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('HandoffStore', () => {
  it('writes a handoff under its session, owner-only, leaving nothing partial', async () => {
    const store = new HandoffStore(root);
    const file = await store.write(
      'session-1',
      'claude-personal',
      '# Handoff\n',
      new Date('2026-11-17T21:00:00.123Z'),
    );

    expect(file).toBe(path.join(root, 'session-1', '2026-11-17T21-00-00-123Z-claude-personal.md'));
    expect(fs.readFileSync(file, 'utf8')).toBe('# Handoff\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(root, 'session-1'))).toEqual([path.basename(file)]);
  });

  it('keeps every handoff of a session until the session goes', async () => {
    const store = new HandoffStore(root);
    await store.write('session-1', 'claude-personal', 'one', new Date('2026-11-17T21:00:00Z'));
    await store.write('session-1', 'codex', 'two', new Date('2026-11-17T22:00:00Z'));
    await store.write('session-2', 'codex', 'other', new Date('2026-11-17T22:00:00Z'));
    expect(fs.readdirSync(path.join(root, 'session-1'))).toHaveLength(2);

    await store.removeAll('session-1');
    expect(fs.existsSync(path.join(root, 'session-1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'session-2'))).toBe(true);
    await expect(store.removeAll('never-had-any')).resolves.toBeUndefined();
  });

  it('refuses names that would leave its folder', async () => {
    const store = new HandoffStore(root);
    await expect(store.write('../escape', 'codex', 'x')).rejects.toThrow(/Invalid handoff name/);
    await expect(store.write('session-1', '../codex', 'x')).rejects.toThrow(/Invalid handoff name/);
    await store.removeAll('..');
    expect(fs.existsSync(root)).toBe(true);
  });
});
