import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { HarnessService, type HarnessStateFile } from './HarnessService';

let dir: string;
let service: HarnessService;

function build(): HarnessService {
  const file = new JsonStateFile<HarnessStateFile>(path.join(dir, 'harnesses.json'));
  const built = new HarnessService(file);
  built.load();
  return built;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-harness-'));
  service = build();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('HarnessService', () => {
  it('seeds the built-in harness, which pins nothing', () => {
    const builtIn = service.getAll().find((harness) => harness.isBuiltIn);

    expect(builtIn?.id).toBe('default');
    expect(builtIn?.binaryPath).toBeUndefined();
    expect(builtIn?.configDir).toBeUndefined();
    expect(builtIn?.extraArgs).toEqual([]);
  });

  it('persists an added harness across a reload', () => {
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    expect(build().getAll().map((harness) => harness.id)).toContain('work');
  });

  it('archives rather than deletes, so sessions can still resume', () => {
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    service.archiveHarness('work');

    const archived = service.getAll().find((harness) => harness.id === 'work');
    expect(archived).toBeDefined();
    expect(archived?.archived).toBe(true);
  });

  it('refuses to archive the built-in harness', () => {
    service.archiveHarness('default');

    expect(service.getAll().find((harness) => harness.id === 'default')?.archived).toBe(false);
  });

  it('refuses an import once a harness has been written, even on a fresh install', () => {
    // The built-in is seeded in memory on a fresh install but nothing is on disk
    // yet — this is the window where a stale import could replace real config.
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    expect(service.importState([])).toBe(false);
    expect(service.getAll().map((harness) => harness.id)).toContain('work');
  });

  it('accepts an import once and ignores every later one', () => {
    const first = service.importState([
      {
        id: 'imported',
        driverId: 'claude',
        name: 'Imported',
        accentColor: '#22c55e',
        enabled: true,
        archived: false,
        isBuiltIn: false,
        extraArgs: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(first).toBe(true);
    expect(service.importState([])).toBe(false);
    expect(service.getAll().map((harness) => harness.id)).toContain('imported');
  });

  it('treats an imported empty list as state, so a second import cannot replace it', () => {
    expect(service.importState([])).toBe(true);

    const second = service.importState([
      {
        id: 'late',
        driverId: 'claude',
        name: 'Late',
        accentColor: '#22c55e',
        enabled: true,
        archived: false,
        isBuiltIn: false,
        extraArgs: [],
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(second).toBe(false);
    expect(service.getAll().map((harness) => harness.id)).not.toContain('late');
  });

  it('does not adopt state that failed to reach disk', () => {
    service.addHarness({ id: 'work', driverId: 'claude', name: 'Work', accentColor: '#3b82f6' });

    const file = new JsonStateFile<HarnessStateFile>(path.join(dir, 'harnesses.json'));
    const failing = new HarnessService(file);
    failing.load();
    vi.spyOn(file, 'write').mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    expect(() => failing.archiveHarness('work')).toThrow('ENOSPC');

    // The caller saw the failure; nothing else may see the phantom archive.
    expect(failing.getAll().find((harness) => harness.id === 'work')?.archived).toBe(false);
  });

  it('does not report state it failed to persist as established', () => {
    const file = new JsonStateFile<HarnessStateFile>(path.join(dir, 'harnesses.json'));
    const failing = new HarnessService(file);
    failing.load();
    vi.spyOn(file, 'write').mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    expect(() =>
      failing.importState([
        {
          id: 'imported',
          driverId: 'claude',
          name: 'Imported',
          accentColor: '#22c55e',
          enabled: true,
          archived: false,
          isBuiltIn: false,
          extraArgs: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ])
    ).toThrow('ENOSPC');

    // A snapshot that answers with records while still asking to be imported
    // would let the next import overwrite them.
    expect(failing.hasState()).toBe(false);
    expect(failing.getAll().map((harness) => harness.id)).not.toContain('imported');
  });

  it('clears a pinned binary path when asked to, so a harness can go back to PATH', () => {
    service.addHarness({
      id: 'work',
      driverId: 'claude',
      name: 'Work',
      accentColor: '#3b82f6',
      binaryPath: '/opt/custom/claude',
    });

    service.updateHarness('work', { binaryPath: undefined });

    const harness = service.getAll().find((entry) => entry.id === 'work');
    expect(harness?.binaryPath).toBeUndefined();
  });
});
