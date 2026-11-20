import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SNOOZE_PRESETS } from '../../shared/snooze';
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
    expect(service.get()).toEqual({
      autoSettleDays: 7,
      hasExplainedAutoSettle: false,
      pendingAutoSettle: [],
      worktreeCleanup: {
        prFinished: false,
        sessionDeleted: false,
        settledDays: 0,
        runFinished: { enabled: false, afterMinutes: 60 },
      },
      snoozePresets: DEFAULT_SNOOZE_PRESETS,
      snoozeAtUsageLimit: false,
    });
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
    fs.writeFileSync(
      file(),
      JSON.stringify({
        autoSettleDays: 'soon',
        hasExplainedAutoSettle: true,
        pendingAutoSettle: ['a', 3],
        snoozePresets: [
          { kind: 'after', minutes: 30 },
          { kind: 'after', minutes: -1 },
        ],
        snoozeAtUsageLimit: 'yes',
      }),
    );
    const service = build();
    service.load();
    expect(service.get()).toEqual({
      autoSettleDays: 7,
      hasExplainedAutoSettle: true,
      pendingAutoSettle: ['a'],
      worktreeCleanup: {
        prFinished: false,
        sessionDeleted: false,
        settledDays: 0,
        runFinished: { enabled: false, afterMinutes: 60 },
      },
      snoozePresets: [{ kind: 'after', minutes: 30 }],
      snoozeAtUsageLimit: false,
    });
  });

  it('reads worktree cleanup rules field by field, every one off by default', () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({
        worktreeCleanup: {
          prFinished: true,
          sessionDeleted: 'yes',
          settledDays: -3,
          runFinished: { enabled: true, afterMinutes: 'later' },
          extra: 'dropped',
        },
      }),
    );
    const service = build();
    service.load();
    expect(service.get().worktreeCleanup).toEqual({
      prFinished: true,
      sessionDeleted: false,
      settledDays: 0,
      runFinished: { enabled: true, afterMinutes: 60 },
    });
  });

  it('sets the rules from known keys and hands out copies', () => {
    const service = build();
    service.load();
    const listener = vi.fn();
    service.onChange(listener);
    service.setWorktreeCleanup({
      settledDays: 7,
      runFinished: { enabled: true, afterMinutes: 15 },
    });
    const rules = service.get().worktreeCleanup;
    expect(rules).toEqual({
      prFinished: false,
      sessionDeleted: false,
      settledDays: 7,
      runFinished: { enabled: true, afterMinutes: 15 },
    });
    rules.runFinished.afterMinutes = 999;
    expect(service.get().worktreeCleanup.runFinished.afterMinutes).toBe(15);
    expect(listener).toHaveBeenCalledTimes(1);
    const reloaded = build();
    reloaded.load();
    expect(reloaded.get().worktreeCleanup.settledDays).toBe(7);
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
