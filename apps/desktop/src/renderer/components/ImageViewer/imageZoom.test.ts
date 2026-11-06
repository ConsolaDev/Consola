import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  ZOOM_STEP,
  detailScale,
  fitScale,
  fitView,
  isAtFit,
  makeFrame,
  overflows,
  panBy,
  wheelZoomFactor,
  zoomTo,
} from './imageZoom';

const STAGE = { width: 1000, height: 800 };
const PADDING = { x: 0, y: 0 };

describe('fitScale', () => {
  it('shrinks a large image until all of it shows', () => {
    expect(fitScale({ width: 2000, height: 1000 }, STAGE, PADDING)).toBe(0.5);
    expect(fitScale({ width: 1000, height: 1600 }, STAGE, PADDING)).toBe(0.5);
  });

  it('never enlarges a small image past its own pixels', () => {
    expect(fitScale({ width: 200, height: 100 }, STAGE, PADDING)).toBe(1);
  });

  it('keeps the padding clear on every side', () => {
    expect(fitScale({ width: 2000, height: 100 }, STAGE, { x: 100, y: 0 })).toBe(0.4);
  });

  it('stays positive when the stage is smaller than its padding', () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 50, height: 50 }, { x: 40, y: 40 })).toBeGreaterThan(0);
  });
});

describe('fitView', () => {
  it('centres the fitted image in the stage', () => {
    const frame = makeFrame({ width: 2000, height: 1000 }, STAGE, PADDING);
    expect(fitView(frame)).toEqual({ scale: 0.5, x: 0, y: 150 });
  });
});

describe('zoomTo', () => {
  const frame = makeFrame({ width: 2000, height: 1600 }, STAGE, PADDING);
  const fit = fitView(frame);

  it('keeps the point under the cursor in place', () => {
    const point = { x: 300, y: 200 };
    const before = { x: (point.x - fit.x) / fit.scale, y: (point.y - fit.y) / fit.scale };
    const view = zoomTo(frame, fit, 1, point);
    const after = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zooms about the centre when no point is given', () => {
    const view = zoomTo(frame, fit, 1);
    expect(view).toEqual({ scale: 1, x: -500, y: -400 });
  });

  it('stops at the fitted size and at the maximum', () => {
    expect(zoomTo(frame, fit, 0.01).scale).toBe(fit.scale);
    expect(zoomTo(frame, fit, 1000).scale).toBe(MAX_SCALE);
  });

  it('never lets an edge of a zoomed image come inside the stage', () => {
    const view = zoomTo(frame, fit, 2, { x: 0, y: 0 });
    expect(view.x).toBeLessThanOrEqual(0);
    expect(view.y).toBeLessThanOrEqual(0);
    expect(view.x + 2000 * view.scale).toBeGreaterThanOrEqual(STAGE.width);
    expect(view.y + 1600 * view.scale).toBeGreaterThanOrEqual(STAGE.height);
  });
});

describe('panBy', () => {
  const frame = makeFrame({ width: 2000, height: 1600 }, STAGE, PADDING);

  it('moves a zoomed image with the pointer', () => {
    const view = { scale: 1, x: -500, y: -400 };
    expect(panBy(frame, view, 100, -50)).toEqual({ scale: 1, x: -400, y: -450 });
  });

  it('stops at the image edges', () => {
    const view = { scale: 1, x: -500, y: -400 };
    expect(panBy(frame, view, 10_000, 10_000)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panBy(frame, view, -10_000, -10_000)).toEqual({ scale: 1, x: -1000, y: -800 });
  });

  it('keeps an axis that fits centred', () => {
    const wide = makeFrame({ width: 4000, height: 400 }, STAGE, PADDING);
    const view = { scale: 1, x: -1000, y: 200 };
    expect(panBy(wide, view, 0, 300).y).toBe(200);
  });
});

describe('detailScale', () => {
  it('shows a shrunk image at its actual pixels', () => {
    expect(detailScale(0.25)).toBe(1);
    expect(detailScale(0.54)).toBe(1);
  });

  it('doubles an image whose actual pixels would barely be larger', () => {
    expect(detailScale(1)).toBe(2);
    expect(detailScale(0.8)).toBe(1.6);
  });
});

describe('isAtFit and overflows', () => {
  const frame = makeFrame({ width: 2000, height: 1600 }, STAGE, PADDING);

  it('recognises the fitted view', () => {
    expect(isAtFit(frame, fitView(frame))).toBe(true);
    expect(isAtFit(frame, zoomTo(frame, fitView(frame), 1))).toBe(false);
  });

  it('reports overflow only once the image outgrows the stage', () => {
    expect(overflows(frame, fitView(frame))).toBe(false);
    expect(overflows(frame, zoomTo(frame, fitView(frame), 1))).toBe(true);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in when the wheel or pinch moves up, out when it moves down', () => {
    expect(wheelZoomFactor(-10, 0, 800)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10, 0, 800)).toBeLessThan(1);
  });

  it('is symmetric, so in then out lands where it started', () => {
    expect(wheelZoomFactor(-10, 0, 800) * wheelZoomFactor(10, 0, 800)).toBeCloseTo(1);
  });

  it('caps one notch of a mouse wheel at a single step', () => {
    expect(wheelZoomFactor(-1000, 0, 800)).toBeCloseTo(ZOOM_STEP);
    expect(wheelZoomFactor(1000, 0, 800)).toBeCloseTo(1 / ZOOM_STEP);
    // Firefox-style line deltas: three lines is one notch.
    expect(wheelZoomFactor(-3, 1, 800)).toBeCloseTo(ZOOM_STEP);
  });
});
