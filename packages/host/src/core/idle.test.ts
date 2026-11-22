import { describe, expect, it } from 'vite-plus/test';
import { isIdle } from './idle.ts';

const MIN = 60_000;
const NOW = 10_000_000;
const QUIET = { connectedClients: 0, turnRunning: false, nowMs: NOW, idleMinutes: 10 };

describe('isIdle', () => {
  it('is never idle while a client is connected', () => {
    expect(isIdle({ ...QUIET, lastActivityMs: NOW - 60 * MIN, connectedClients: 1 })).toBe(false);
  });

  it('is never idle while a turn runs', () => {
    expect(isIdle({ ...QUIET, lastActivityMs: NOW - 60 * MIN, turnRunning: true })).toBe(false);
  });

  it('is not idle 9 minutes after the last activity', () => {
    expect(isIdle({ ...QUIET, lastActivityMs: NOW - 9 * MIN })).toBe(false);
  });

  it('is idle 10 minutes after the last activity', () => {
    expect(isIdle({ ...QUIET, lastActivityMs: NOW - 10 * MIN })).toBe(true);
  });

  it('counts minutes in fractions', () => {
    expect(isIdle({ ...QUIET, idleMinutes: 0.5, lastActivityMs: NOW - 29_999 })).toBe(false);
    expect(isIdle({ ...QUIET, idleMinutes: 0.5, lastActivityMs: NOW - 30_000 })).toBe(true);
  });
});
