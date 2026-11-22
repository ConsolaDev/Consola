import { describe, expect, it } from 'vite-plus/test';
import { isIdle } from './idle.ts';

const MIN = 60_000;
const NOW = 10_000_000;

describe('isIdle', () => {
  it('is never idle while a client is connected', () => {
    expect(
      isIdle({ lastActivityMs: NOW - 60 * MIN, connectedClients: 1, nowMs: NOW, idleMinutes: 10 }),
    ).toBe(false);
  });

  it('is not idle 9 minutes after the last activity', () => {
    expect(
      isIdle({ lastActivityMs: NOW - 9 * MIN, connectedClients: 0, nowMs: NOW, idleMinutes: 10 }),
    ).toBe(false);
  });

  it('is idle 10 minutes after the last activity', () => {
    expect(
      isIdle({ lastActivityMs: NOW - 10 * MIN, connectedClients: 0, nowMs: NOW, idleMinutes: 10 }),
    ).toBe(true);
  });
});
