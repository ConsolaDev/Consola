/*
 * The wheel-distance logic below is ported from Orca
 * (https://github.com/stablyai/orca: pane-terminal-tui-wheel-reports.ts and
 * pane-terminal-mouse-wheel.ts), used under its MIT License:
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Terminal } from '@xterm/xterm';

/**
 * Wheel scrolling for TUIs that take the mouse.
 *
 * A fullscreen CLI (Claude's `tui: fullscreen`, the default) asks for mouse
 * reports and scrolls its own transcript, one row per wheel report. xterm
 * sends exactly one report per DOM wheel event, whatever the event's
 * distance, and drops small trackpad deltas altogether until they add up to
 * a row: a notch worth six rows scrolls one, and a trackpad flick sheds most
 * of its distance. Scrolling a long conversation then feels stuck.
 *
 * Instead each event is turned into as many reports as the rows it moved
 * (ported from Orca's pane-terminal-tui-wheel-reports): a continuous device
 * (trackpad, Magic Mouse) one report per row with the fraction carried, a
 * notched wheel a compressed curve with a bonus for fast spins. The reports
 * are replayed into xterm as one-line wheel events, so xterm still encodes
 * them in whichever mouse protocol the CLI asked for.
 */

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** A notch reports wheelDelta 120 per step; anything smaller is continuous. */
const NOTCH_WHEEL_DELTA_MIN = 100;
const NOTCH_WHEEL_DELTA_UNIT = 120;
/** A trackpad gesture is over once it pauses this long. */
const CONTINUOUS_GESTURE_IDLE_MS = 300;
// Chromium's wheelDelta per CSS px for continuous devices: 3 on macOS, 1 elsewhere.
const CONTINUOUS_WHEEL_DELTA_RATIOS = [3, 1];
const CONTINUOUS_WHEEL_DELTA_TOLERANCE = 3;
const DEFAULT_CELL_HEIGHT = 16;
const NOTCH_DISTANCE_GAIN = 1.6;
const NOTCH_COMPRESSED_MAX_ROWS = 6;
const NOTCH_BURST_FULL_INTERVAL_MS = 16;
const NOTCH_BURST_MAX_INTERVAL_MS = 45;
const NOTCH_BURST_MAX_BONUS_ROWS = 3;
const NOTCH_BURST_RAMP_EVENTS = 4;
const NOTCH_BURST_MAX_ROWS = 9;
/** A notch smaller than this share of the last one is momentum running out. */
const MOMENTUM_TAIL_RATIO = 0.85;

/** The xterm class that says the program asked for mouse reports. */
const MOUSE_REPORTING_CLASS = 'enable-mouse-events';

export interface WheelInput {
  deltaY: number;
  deltaMode?: number;
  timeStamp?: number;
  /** Chromium's legacy delta: tells a notched wheel from a trackpad. */
  wheelDelta?: number;
  wheelDeltaY?: number;
}

export interface WheelMetrics {
  /** CSS pixels per terminal row. */
  cellHeight?: number;
  rows?: number;
}

export interface WheelState {
  continuousGestureAt: number | null;
  fastStreak: number;
  lastDistanceRows: number | null;
  lastInputAt: number | null;
  direction: -1 | 0 | 1;
  /** The fraction of a row not yet reported. */
  pendingRows: number;
}

export function createWheelState(): WheelState {
  return {
    continuousGestureAt: null,
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    direction: 0,
    pendingRows: 0,
  };
}

function legacyDelta(event: WheelInput): number | null {
  if (typeof event.wheelDeltaY === 'number' && Number.isFinite(event.wheelDeltaY)) {
    return event.wheelDeltaY;
  }
  if (typeof event.wheelDelta === 'number' && Number.isFinite(event.wheelDelta)) {
    return event.wheelDelta;
  }
  return null;
}

function inputTime(event: WheelInput): number | null {
  return typeof event.timeStamp === 'number' && Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : null;
}

/**
 * Whether this event belongs to a continuous gesture.
 *
 * A small wheelDelta can only come from a continuous device, but a fast
 * trackpad event can reach a notch-sized one. Native terminals get a
 * per-device precision flag; this emulates it by keeping a gesture
 * continuous while large events keep the continuous delta shape, which a
 * notch never has.
 */
function isContinuous(event: WheelInput, state: WheelState): boolean {
  if ((event.deltaMode ?? DOM_DELTA_PIXEL) !== DOM_DELTA_PIXEL) {
    state.continuousGestureAt = null;
    return false;
  }
  const at = inputTime(event);
  const legacy = legacyDelta(event);
  const continuous =
    legacy === null ||
    Math.abs(legacy) < NOTCH_WHEEL_DELTA_MIN ||
    (at !== null &&
      state.continuousGestureAt !== null &&
      at >= state.continuousGestureAt &&
      at - state.continuousGestureAt <= CONTINUOUS_GESTURE_IDLE_MS &&
      CONTINUOUS_WHEEL_DELTA_RATIOS.some(
        (ratio) =>
          Math.abs(Math.abs(event.deltaY) * ratio - Math.abs(legacy)) <=
          CONTINUOUS_WHEEL_DELTA_TOLERANCE,
      ));
  state.continuousGestureAt = continuous ? at : null;
  return continuous;
}

function distanceRows(event: WheelInput, metrics: WheelMetrics, continuous: boolean): number {
  const mode = event.deltaMode ?? DOM_DELTA_PIXEL;
  const delta = Math.abs(event.deltaY);
  const cellHeight =
    metrics.cellHeight && Number.isFinite(metrics.cellHeight) && metrics.cellHeight > 0
      ? metrics.cellHeight
      : DEFAULT_CELL_HEIGHT;
  const rows =
    mode === DOM_DELTA_LINE
      ? delta
      : mode === DOM_DELTA_PAGE
        ? delta * Math.max(1, metrics.rows ?? 1)
        : delta / cellHeight;
  if (continuous) return rows;
  const legacy = legacyDelta(event);
  const legacyRows = legacy === null ? 0 : Math.abs(legacy) / NOTCH_WHEEL_DELTA_UNIT;
  return Math.max(1, rows, legacyRows);
}

/** Bonus rows for a notched wheel spun fast; nothing for a lone notch or a fading one. */
function burstRows(event: WheelInput, state: WheelState, rows: number): number {
  const at = inputTime(event);
  if (at === null) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    return 0;
  }
  const elapsed = state.lastInputAt === null ? null : at - state.lastInputAt;
  const fading =
    state.lastDistanceRows !== null && rows < state.lastDistanceRows * MOMENTUM_TAIL_RATIO;
  state.lastDistanceRows = rows;
  state.lastInputAt = at;
  if (fading || elapsed === null || elapsed < 0 || elapsed > NOTCH_BURST_MAX_INTERVAL_MS) {
    state.fastStreak = 0;
    return 0;
  }
  const cadence =
    elapsed <= NOTCH_BURST_FULL_INTERVAL_MS
      ? 1
      : (NOTCH_BURST_MAX_INTERVAL_MS - elapsed) /
        (NOTCH_BURST_MAX_INTERVAL_MS - NOTCH_BURST_FULL_INTERVAL_MS);
  state.fastStreak = Math.min(NOTCH_BURST_RAMP_EVENTS, state.fastStreak + 1);
  return NOTCH_BURST_MAX_BONUS_ROWS * cadence * (state.fastStreak / NOTCH_BURST_RAMP_EVENTS);
}

/** How many wheel reports this event is worth. Mutates `state`. */
export function wheelReportCount(
  event: WheelInput,
  state: WheelState,
  metrics: WheelMetrics = {},
): number {
  const direction = event.deltaY < 0 ? -1 : 1;
  if (state.direction !== 0 && state.direction !== direction) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    state.pendingRows = 0;
  }
  state.direction = direction;

  const continuous = isContinuous(event, state);
  const rows = distanceRows(event, metrics, continuous);
  let total: number;
  if (continuous) {
    // One row per row moved, fraction carried: a flick keeps its inertia.
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    total = state.pendingRows + rows;
  } else {
    const compressed =
      rows <= 1
        ? rows
        : Math.min(NOTCH_COMPRESSED_MAX_ROWS, 1 + Math.log2(rows) * NOTCH_DISTANCE_GAIN);
    total =
      state.pendingRows +
      Math.min(NOTCH_BURST_MAX_ROWS, compressed + burstRows(event, state, rows));
  }
  const reports = Math.trunc(total);
  state.pendingRows = total - reports;
  return reports;
}

/** Marks the one-line events this module replays, so it lets them through. */
const replayed = new WeakSet<WheelEvent>();

function oneRow(event: WheelEvent): WheelEvent {
  const clone = new WheelEvent(event.type, {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    view: event.view,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    deltaY: event.deltaY < 0 ? -1 : 1,
    deltaMode: DOM_DELTA_LINE,
  });
  replayed.add(clone);
  return clone;
}

/**
 * Scroll a mouse-reporting TUI by the distance the wheel actually moved.
 *
 * Only while the program has mouse reporting on: otherwise the wheel scrolls
 * xterm's own scrollback, which already follows the distance. Shift+wheel is
 * left alone, since xterm never reports it.
 *
 * `batch` runs each replay: the reports xterm emits inside it are one
 * gesture's, for the caller to send as one write.
 */
export function attachTuiWheel(
  terminal: Terminal,
  batch: (replay: () => void) => void = (replay) => replay(),
): void {
  const state = createWheelState();
  let pending = 0;
  let pendingEvent: WheelEvent | null = null;
  let target: EventTarget | null = null;
  let scheduled = false;

  const drain = () => {
    scheduled = false;
    const event = pendingEvent;
    const count = pending;
    pending = 0;
    pendingEvent = null;
    const to = target;
    if (!event || !to || terminal.modes.mouseTrackingMode === 'none') return;
    batch(() => {
      for (let i = 0; i < count; i++) to.dispatchEvent(oneRow(event));
    });
  };

  terminal.attachCustomWheelEventHandler((event) => {
    if (replayed.has(event)) return true;
    const element = terminal.element;
    if (
      terminal.modes.mouseTrackingMode === 'none' ||
      !element?.classList.contains(MOUSE_REPORTING_CLASS) ||
      event.deltaY === 0 ||
      event.shiftKey
    ) {
      return true;
    }

    const direction = event.deltaY < 0 ? -1 : 1;
    if (pendingEvent && (pendingEvent.deltaY < 0 ? -1 : 1) !== direction) pending = 0;

    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    const height = screen?.getBoundingClientRect().height ?? 0;
    pending += wheelReportCount(event, state, {
      cellHeight: height > 0 && terminal.rows > 0 ? height / terminal.rows : undefined,
      rows: terminal.rows,
    });
    pendingEvent = event;
    target = event.currentTarget ?? element;
    // Replay after xterm's own handler has returned for this event.
    if (!scheduled && pending > 0) {
      scheduled = true;
      queueMicrotask(drain);
    }
    // xterm still cancels the original event, so the page never scrolls.
    return false;
  });
}
