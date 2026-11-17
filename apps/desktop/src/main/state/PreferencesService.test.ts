import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStateFile } from './JsonStateFile';
import { PreferencesService } from './PreferencesService';

let dir: string;
const file = () => path.join(dir, 'preferences.json');
const build = () => new PreferencesService(new JsonStateFile<unknown>(file()));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-prefs-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('PreferencesService', () => {
  it('starts with auto-settle on at 7 days and nothing explained', () => {
    const service = build();
    service.load();
    expect(service.get()).toEqual({ autoSettleDays: 7, hasExplainedAutoSettle: false, pendingAutoSettle: [] });
  });

  it('loads non-fatally from a corrupt file', () => {
    fs.writeFileSync(file(), '{not json');
    fs.writeFileSync(`${file()}.bak`, 'also {not json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = build();
    expect(() => service.load()).not.toThrow();
    expect(service.get().autoSettleDays).toBe(7);
    error.mockRestore();
  });

  it('falls back per field when a value is malformed', () => {
    fs.writeFileSync(file(), JSON.stringify({ autoSettleDays: 'soon', hasExplainedAutoSettle: true, pendingAutoSettle: ['a', 3] }));
    const service = build();
    service.load();
    expect(service.get()).toEqual({ autoSettleDays: 7, hasExplainedAutoSettle: true, pendingAutoSettle: ['a'] });
  });

  it('persists a changed threshold, and 0 means off', () => {
    const service = build();
    service.load();
    service.setAutoSettleDays(0);
    const next = build();
    next.load();
    expect(next.get().autoSettleDays).toBe(0);
  });

  it('ignores a nonsense threshold', () => {
    const service = build();
    service.load();
    service.setAutoSettleDays(-3);
    service.setAutoSettleDays(Number.NaN);
    expect(service.get().autoSettleDays).toBe(7);
  });

  it('acknowledging is permanent and clears what was pending', () => {
    const service = build();
    service.load();
    service.addPendingAutoSettle(['a']);
    service.acknowledgeAutoSettle();
    service.addPendingAutoSettle(['b']);
    const next = build();
    next.load();
    expect(next.get()).toMatchObject({ hasExplainedAutoSettle: true, pendingAutoSettle: [] });
  });
});
