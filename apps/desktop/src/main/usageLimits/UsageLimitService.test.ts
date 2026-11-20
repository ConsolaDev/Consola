import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Snoozer } from '../attention/Snoozer';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { HarnessLimits } from '../../shared/usageLimits';
import type { Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import type { HarnessDriver } from '../drivers';
import { JsonStateFile } from '../state/JsonStateFile';
import { HarnessLimitsCache } from './HarnessLimitsCache';
import { type UsageLimitsStateFile, UsageLimitService } from './UsageLimitService';

const HOUR = 60 * 60 * 1000;
const T0 = 10_000_000;

let dir: string;
let workspace: Workspace;
let terminals: Map<string, TerminalStatus>;
let answer: HarnessLimits | Error;
let reads: number;
let snoozer: {
  usageLimitStopped: Mock<Snoozer['usageLimitStopped']>;
  usageLimitHit: Mock<Snoozer['usageLimitHit']>;
};
let service: UsageLimitService;

const driver = {
  id: 'claude',
  usageLimits: {
    read: async () => {
      reads++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
} as unknown as HarnessDriver;

const usedUp = (resetsAt?: number): HarnessLimits => ({
  available: true,
  checkedAt: T0,
  windows: [{ id: 'five_hour', kind: 'session', usedPercent: 100, resetsAt }],
});
const below: HarnessLimits = {
  available: true,
  checkedAt: T0,
  windows: [{ id: 'five_hour', kind: 'session', usedPercent: 40, resetsAt: T0 + HOUR }],
};

function build() {
  service?.stop();
  service = new UsageLimitService({
    getWorkspaces: () => [workspace],
    harnessOf: () => ({ harnessId: 'h1', driver, config: { extraArgs: [] } }),
    cache: new HarnessLimitsCache(() => Date.now()),
    snoozer,
    terminalStatus: (instanceId) => terminals.get(instanceId) ?? 'exited',
    file: new JsonStateFile<UsageLimitsStateFile>(path.join(dir, 'usage-limits.json')),
  });
  service.load();
}

/** Let the asked CLI answer, and the service act on it. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-usage-'));
  workspace = makeWorkspace({
    id: 'w1',
    sessions: [
      makeSession({
        id: 's1',
        name: 's1',
        instanceId: 'inst-1',
        kind: 'interactive',
        claudeSessionId: 'conv-1',
      }),
    ],
  });
  terminals = new Map([['inst-1', 'ready']]);
  answer = usedUp(T0 + 2 * HOUR);
  reads = 0;
  snoozer = {
    usageLimitStopped: vi.fn<Snoozer['usageLimitStopped']>(),
    usageLimitHit: vi.fn<Snoozer['usageLimitHit']>(() => 'snoozed'),
  };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  build();
});

afterEach(() => {
  service.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a hook says a turn stopped on a limit', () => {
  it('limits the session at once, then learns the reset from the CLI', async () => {
    service.hookStopped('inst-1');
    expect(service.state().sessions.s1).toEqual({ stoppedAt: T0, signal: 'hook' });
    expect(snoozer.usageLimitStopped).toHaveBeenCalledWith('s1', { at: T0 });
    await settle();
    expect(service.state().sessions.s1).toMatchObject({
      resetsAt: T0 + 2 * HOUR,
      window: 'five_hour',
    });
    expect(service.resetFor('s1')).toBe(T0 + 2 * HOUR);
  });

  it('stays limited with no time when nothing is used up, or the CLI does not answer', async () => {
    answer = below;
    service.hookStopped('inst-1');
    await settle();
    expect(service.state().sessions.s1).toEqual({ stoppedAt: T0, signal: 'hook' });
    answer = new Error('no answer');
    service.hookStopped('inst-1');
    await settle();
    expect(service.resetFor('s1')).toBeUndefined();
  });

  it('ends on the next finished turn or when the CLI is done waiting', async () => {
    service.hookStopped('inst-1');
    await settle();
    service.hookCleared('inst-1');
    expect(service.state().sessions).toEqual({});
  });
});

describe('the CLI’s notice on screen', () => {
  it('limits only once the CLI confirms a used-up window', async () => {
    answer = below;
    service.noticeChanged('inst-1', true);
    await settle();
    expect(service.state().sessions).toEqual({});
    expect(snoozer.usageLimitStopped).not.toHaveBeenCalled();

    service.noticeChanged('inst-1', false);
    answer = usedUp(T0 + HOUR);
    service.noticeChanged('inst-1', true);
    await settle();
    expect(service.state().sessions.s1).toMatchObject({ signal: 'notice', resetsAt: T0 + HOUR });
    expect(snoozer.usageLimitStopped).toHaveBeenCalledTimes(1);
  });

  it('ends when the notice leaves, for a limit only it said', async () => {
    service.noticeChanged('inst-1', true);
    await settle();
    service.noticeChanged('inst-1', false);
    expect(service.state().sessions).toEqual({});
  });
});

describe('offering a snooze', () => {
  it('waits for the answer and for the terminal to come to rest, and offers a stop once', async () => {
    terminals.set('inst-1', 'working');
    service.hookStopped('inst-1');
    await settle();
    expect(snoozer.usageLimitHit).not.toHaveBeenCalled();
    terminals.set('inst-1', 'ready');
    service.statusChanged('inst-1', 'ready');
    expect(snoozer.usageLimitHit).toHaveBeenCalledWith('s1', {
      stoppedAt: T0,
      resetsAt: T0 + 2 * HOUR,
      newStop: true,
    });
    service.statusChanged('inst-1', 'ready');
    expect(snoozer.usageLimitHit).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ newStop: false }),
    );
  });

  it('never for a reset under a minute away', async () => {
    answer = usedUp(T0 + 30_000);
    service.hookStopped('inst-1');
    await settle();
    expect(snoozer.usageLimitHit).not.toHaveBeenCalled();
  });

  it('remembers a stop was offered across a restart, so an Undo stays undone', async () => {
    service.hookStopped('inst-1');
    await settle();
    build();
    service.statusChanged('inst-1', 'ready');
    expect(snoozer.usageLimitHit).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ newStop: false }),
    );
  });
});

describe('when the reset passes', () => {
  it('asks again and ends the limit the CLI no longer shows', async () => {
    service.hookStopped('inst-1');
    await settle();
    answer = below;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(reads).toBe(2);
    expect(service.state().sessions).toEqual({});
  });

  it('follows a reset that moved later', async () => {
    service.hookStopped('inst-1');
    await settle();
    answer = usedUp(T0 + 5 * HOUR);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(service.resetFor('s1')).toBe(T0 + 5 * HOUR);
    expect(snoozer.usageLimitHit).toHaveBeenLastCalledWith('s1', {
      stoppedAt: T0,
      resetsAt: T0 + 5 * HOUR,
      newStop: false,
    });
  });
});

describe('the session moving on', () => {
  it('forgets a limit whose conversation was replaced, or whose session was deleted', async () => {
    service.hookStopped('inst-1');
    await settle();
    workspace.sessions[0] = { ...workspace.sessions[0], claudeSessionId: 'conv-2' };
    service.sync();
    expect(service.state().sessions).toEqual({});
  });
});

describe('a whole harness at its limit', () => {
  it('is limited only by a window every model counts against', async () => {
    answer = {
      available: true,
      checkedAt: T0,
      windows: [
        { id: 'opus', kind: 'weekly', usedPercent: 100, resetsAt: T0 + HOUR, model: 'Opus' },
      ],
    };
    await service.refreshHarnesses([{ harnessId: 'h1', driver, config: { extraArgs: [] } }]);
    expect(service.limitedUntil('h1')).toBeUndefined();
    answer = usedUp(T0 + HOUR);
    vi.setSystemTime(T0 + 2 * 60_000);
    await service.refreshHarnesses([{ harnessId: 'h1', driver, config: { extraArgs: [] } }]);
    expect(service.limitedUntil('h1')).toBe(T0 + HOUR);
    expect(service.state().harnesses).toEqual({ h1: { resetsAt: T0 + HOUR } });
  });
});
