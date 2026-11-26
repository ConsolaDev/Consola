import { describe, expect, it } from 'vitest';
import { createWheelState, wheelReportCount } from './tuiWheel';
import type { WheelInput } from './tuiWheel';

const CELL = 18;

/** A trackpad event as Chromium reports it on macOS: wheelDelta is -3 × deltaY. */
const trackpad = (deltaY: number, timeStamp: number): WheelInput => ({
  deltaY,
  deltaMode: 0,
  wheelDeltaY: -3 * deltaY,
  timeStamp,
});

/** A notched mouse wheel on macOS: a pixel delta, wheelDelta in steps of 120. */
const notch = (deltaY: number, timeStamp: number, steps = 1): WheelInput => ({
  deltaY,
  deltaMode: 0,
  wheelDeltaY: (deltaY < 0 ? 120 : -120) * steps,
  timeStamp,
});

const total = (events: WheelInput[]) => {
  const state = createWheelState();
  return events.reduce((n, e) => n + wheelReportCount(e, state, { cellHeight: CELL, rows: 40 }), 0);
};

describe('wheelReportCount', () => {
  it('reports a trackpad flick row for row, carrying fractions', () => {
    // 60 events of 6 px: 360 px is 20 rows, though no single event is a row.
    const events = Array.from({ length: 60 }, (_, i) => trackpad(-6, i * 8));
    expect(total(events)).toBe(20);
  });

  it('keeps a hard flick continuous once its deltas grow notch-sized', () => {
    // wheelDelta 3 × 54 = 162 crosses the notch threshold, but keeps the
    // continuous shape inside the gesture, so it stays 1:1 (3 rows each).
    const events = [
      trackpad(-10, 0),
      ...Array.from({ length: 10 }, (_, i) => trackpad(-54, 8 + i * 8)),
    ];
    expect(total(events)).toBe(Math.trunc((10 + 540) / CELL));
  });

  it('scrolls a lone notch more than one row, but not its full pixel distance', () => {
    const state = createWheelState();
    const reports = wheelReportCount(notch(-100, 0), state, { cellHeight: CELL, rows: 40 });
    // 100 px is 5.6 rows; the curve compresses that to 1 + log2(5.6) × 1.6 ≈ 4.9.
    expect(reports).toBe(4);
  });

  it('adds a bonus for a wheel spun fast, capped per event', () => {
    const slow = total([notch(-40, 0), notch(-40, 200), notch(-40, 400), notch(-40, 600)]);
    const fast = total([notch(-40, 0), notch(-40, 10), notch(-40, 20), notch(-40, 30)]);
    expect(fast).toBeGreaterThan(slow);
    const state = createWheelState();
    for (let i = 0; i < 20; i++) {
      expect(
        wheelReportCount(notch(-4000, i * 5, 30), state, { cellHeight: CELL, rows: 40 }),
      ).toBeLessThanOrEqual(10);
    }
  });

  it('drops what is pending when the direction reverses', () => {
    const state = createWheelState();
    const metrics = { cellHeight: CELL, rows: 40 };
    // 0.9 of a row pending upward…
    expect(wheelReportCount(trackpad(-16, 0), state, metrics)).toBe(0);
    // …is not spent on the first downward event.
    expect(wheelReportCount(trackpad(3, 8), state, metrics)).toBe(0);
    expect(state.pendingRows).toBeCloseTo(3 / CELL);
  });

  it('honours line and page deltas', () => {
    const state = createWheelState();
    expect(
      wheelReportCount({ deltaY: -3, deltaMode: 1 }, state, { cellHeight: CELL, rows: 40 }),
    ).toBe(3);
    const page = createWheelState();
    // A page is the screen's rows, compressed like any discrete step.
    expect(
      wheelReportCount({ deltaY: 1, deltaMode: 2 }, page, { cellHeight: CELL, rows: 40 }),
    ).toBe(6);
  });
});
