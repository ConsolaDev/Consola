/**
 * The geometry of the image viewer, kept free of React and the DOM.
 *
 * A view is the image's scale (1 = one image pixel per CSS pixel) and the
 * offset of its top-left corner within the stage. Every function returns a
 * view already held to the frame's rules: never smaller than fitted, never
 * past MAX_SCALE, and never with an edge pulled inside the stage on an axis
 * where the image is larger than it. An axis where it is smaller stays centred.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

/** What a view is held against: the image's own pixels, the stage it sits in, and the scale that fits one in the other. */
export interface Frame {
  image: Size;
  stage: Size;
  fit: number;
}

/** Eight screen pixels per image pixel: enough to read a single pixel of a screenshot. */
export const MAX_SCALE = 8;
/** One press of +/− or one notch of a mouse wheel. */
export const ZOOM_STEP = 1.5;

const EPSILON = 1e-3;
/** Wheel pixels per e-fold of zoom. A trackpad pinch sends many small deltas, so this sets its speed. */
const WHEEL_PIXELS_PER_E = 100;
/** The largest delta one wheel event counts for, so a mouse notch is one step rather than a leap. */
const WHEEL_MAX_DELTA = WHEEL_PIXELS_PER_E * Math.log(ZOOM_STEP);
const LINE_PIXELS = 16;

/** The scale at which the whole image shows inside the padded stage. Never enlarges: a small image opens at its own size. */
export function fitScale(image: Size, stage: Size, padding: Point): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  const width = Math.max(stage.width - 2 * padding.x, 1);
  const height = Math.max(stage.height - 2 * padding.y, 1);
  return Math.min(1, width / image.width, height / image.height);
}

export function makeFrame(image: Size, stage: Size, padding: Point): Frame {
  return { image, stage, fit: fitScale(image, stage, padding) };
}

/** Where the image's edge may sit on one axis: centred if it fits, otherwise flush with or beyond both stage edges. */
function clampAxis(offset: number, length: number, stageLength: number): number {
  if (length <= stageLength) return (stageLength - length) / 2;
  return Math.min(0, Math.max(stageLength - length, offset));
}

function clampScale(frame: Frame, scale: number): number {
  return Math.min(Math.max(scale, frame.fit), Math.max(MAX_SCALE, frame.fit));
}

function clampView(frame: Frame, view: View): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, frame.image.width * view.scale, frame.stage.width),
    y: clampAxis(view.y, frame.image.height * view.scale, frame.stage.height),
  };
}

export function fitView(frame: Frame): View {
  return clampView(frame, { scale: frame.fit, x: 0, y: 0 });
}

/** Zooms to `scale`, keeping the image point under `point` (stage coordinates, default its centre) where it is. */
export function zoomTo(frame: Frame, view: View, scale: number, point?: Point): View {
  const next = clampScale(frame, scale);
  const at = point ?? { x: frame.stage.width / 2, y: frame.stage.height / 2 };
  const ratio = next / view.scale;
  return clampView(frame, {
    scale: next,
    x: at.x - (at.x - view.x) * ratio,
    y: at.y - (at.y - view.y) * ratio,
  });
}

export function panBy(frame: Frame, view: View, dx: number, dy: number): View {
  return clampView(frame, { scale: view.scale, x: view.x + dx, y: view.y + dy });
}

/** The same view held to a frame whose stage or image size changed. */
export function reframe(frame: Frame, view: View): View {
  return clampView(frame, { ...view, scale: clampScale(frame, view.scale) });
}

/**
 * Where a click on a fitted image goes: its actual pixels, unless those are
 * hardly larger than what already shows. Then twice the fitted size.
 */
export function detailScale(fit: number): number {
  return fit * ZOOM_STEP <= 1 ? 1 : fit * 2;
}

export function isAtFit(frame: Frame, view: View): boolean {
  return Math.abs(view.scale - frame.fit) < EPSILON;
}

export function isAtMax(frame: Frame, view: View): boolean {
  return view.scale >= Math.max(MAX_SCALE, frame.fit) - EPSILON;
}

/** Whether there is anything to pan to: the image is larger than the stage on some axis. */
export function overflows(frame: Frame, view: View): boolean {
  return (
    frame.image.width * view.scale > frame.stage.width + EPSILON ||
    frame.image.height * view.scale > frame.stage.height + EPSILON
  );
}

/**
 * The zoom factor for one wheel event. A trackpad pinch arrives as a wheel
 * event with ctrlKey and a small delta; a mouse wheel as a large one. Both go
 * through the same exponential, so in-then-out returns exactly to the start.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const pixels = wheelPixels(deltaY, deltaMode, pageHeight);
  const capped = Math.min(Math.max(pixels, -WHEEL_MAX_DELTA), WHEEL_MAX_DELTA);
  return Math.exp(-capped / WHEEL_PIXELS_PER_E);
}

/** Wheel deltas in CSS pixels, for panning with a plain scroll. */
export function wheelPixels(delta: number, deltaMode: number, pageHeight: number): number {
  return deltaMode === 1 ? delta * LINE_PIXELS : deltaMode === 2 ? delta * pageHeight : delta;
}
