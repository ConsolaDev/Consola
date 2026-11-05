import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  ZOOM_STEP,
  detailScale,
  fitView,
  isAtFit,
  isAtMax,
  makeFrame,
  overflows,
  panBy,
  reframe,
  wheelPixels,
  wheelZoomFactor,
  zoomTo,
  type Frame,
  type Point,
  type View,
} from './imageZoom';
import './styles.css';

export interface ViewedImage {
  /** The source the page is showing, already loaded: for a `<picture>`, the one it picked. */
  src: string;
  alt: string;
  /** The image's own pixels. */
  width: number;
  height: number;
}

/** Room kept around a fitted image, clear of the toolbar above and the hint below. */
const PADDING: Point = { x: 32, y: 64 };
/** How far a pointer may wander and still be a click rather than a drag. */
const CLICK_SLOP = 4;
/** Share of the stage one arrow key pans. */
const ARROW_PAN = 0.15;
/** Device pixels per image pixel from which smoothing would only blur: past it, each pixel is drawn as a square. */
const PIXELATE_FROM = 4;
const MOD_KEY = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

interface ViewerState {
  frame: Frame;
  view: View;
  /** Discrete jumps (buttons, keys, a click) glide; a pinch or drag tracks the hand exactly. */
  animate: boolean;
}

interface Gesture {
  pointerId: number;
  start: Point;
  from: View;
  onImage: boolean;
  dragged: boolean;
}

/**
 * A full-window view of one image that zooms and pans, the way an image
 * viewer would: it opens fitted to the window, then pinch or ⌘-scroll zooms
 * toward the pointer, scroll or drag pans, and a click on the image jumps
 * between fitted and its actual pixels. A Radix dialog, so focus is trapped
 * while it is open and returns to the image that opened it.
 */
export function ImageViewer({ image, onClose }: { image: ViewedImage | null; onClose: () => void }) {
  return (
    <Dialog.Root open={image !== null} onOpenChange={(open) => !open && onClose()}>
      {/* No Dialog.Overlay: the content is the full-window scrim itself. As
          separate portals the two can land in either order, and an overlay
          above the content swallows every click on the image. */}
      <Dialog.Portal>{image && <ViewerContent key={image.src} image={image} onClose={onClose} />}</Dialog.Portal>
    </Dialog.Root>
  );
}

function ViewerContent({ image, onClose }: { image: ViewedImage; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const gesture = useRef<Gesture | null>(null);
  // Read on the first render, before the dialog moves focus into itself.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const [state, setState] = useState<ViewerState | null>(null);
  const [dragging, setDragging] = useState(false);

  const apply = useCallback((next: (current: ViewerState) => View, animate: boolean) => {
    setState((current) => (current ? { ...current, view: next(current), animate } : current));
  }, []);

  // Measured before the first paint, so the image never shows unfitted. A
  // window resize keeps a fitted image fitted and holds a zoomed one in place.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const { width, height } = stage.getBoundingClientRect();
      const frame = makeFrame({ width: image.width, height: image.height }, { width, height }, PADDING);
      setState((current) => ({
        frame,
        view: !current || isAtFit(current.frame, current.view) ? fitView(frame) : reframe(frame, current.view),
        animate: false,
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [image.width, image.height]);

  // React registers wheel listeners as passive, and a passive listener cannot
  // stop the page from scrolling or zooming, so this one is added by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      // A trackpad pinch arrives as a wheel event with ctrlKey set.
      if (event.ctrlKey || event.metaKey) {
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const factor = wheelZoomFactor(event.deltaY, event.deltaMode, rect.height);
        apply(({ frame, view }) => zoomTo(frame, view, view.scale * factor, point), false);
      } else {
        const dx = wheelPixels(event.deltaX, event.deltaMode, rect.height);
        const dy = wheelPixels(event.deltaY, event.deltaMode, rect.height);
        apply(({ frame, view }) => panBy(frame, view, -dx, -dy), false);
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [apply]);

  const zoomBy = (factor: number) => apply(({ frame, view }) => zoomTo(frame, view, view.scale * factor), true);
  const toggle = (point?: Point) =>
    apply(({ frame, view }) => (isAtFit(frame, view) ? zoomTo(frame, view, detailScale(frame.fit), point) : fitView(frame)), true);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const pan = (dx: number, dy: number) =>
      apply(({ frame, view }) => panBy(frame, view, dx * frame.stage.width * ARROW_PAN, dy * frame.stage.height * ARROW_PAN), true);
    switch (event.key) {
      case '+':
      case '=':
        zoomBy(ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        apply(({ frame }) => fitView(frame), true);
        break;
      case '1':
        apply(({ frame, view }) => zoomTo(frame, view, 1), true);
        break;
      // Arrows move the view, as scrolling would: Left shows more of the left.
      case 'ArrowLeft':
        pan(1, 0);
        break;
      case 'ArrowRight':
        pan(-1, 0);
        break;
      case 'ArrowUp':
        pan(0, 1);
        break;
      case 'ArrowDown':
        pan(0, -1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // A press only becomes a drag once it moves; until then it may still be a
  // click. The pointer is captured only for a drag, so a plain click lands on
  // whatever was under it.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !state) return;
    gesture.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      from: state.view,
      onImage: event.target === imageRef.current,
      dragged: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (!current.dragged) {
      if (Math.hypot(dx, dy) < CLICK_SLOP) return;
      current.dragged = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    apply(({ frame }) => panBy(frame, current.from, dx, dy), false);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    setDragging(false);
    if (event.type === 'pointercancel') gesture.current = null;
  };

  // Decided on click rather than pointerup: closing on pointerup would let
  // the click that follows land on the page beneath.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.dragged) return;
    if (current?.onImage ?? event.target === imageRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      toggle({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      onClose();
    }
  };

  const atFit = !state || isAtFit(state.frame, state.view);
  const atMax = !!state && isAtMax(state.frame, state.view);
  const canPan = !!state && overflows(state.frame, state.view);
  const cursor = dragging ? 'grabbing' : canPan ? 'grab' : atFit ? 'zoom-in' : 'zoom-out';
  const percent = (scale: number) => `${Math.round(scale * 100)}%`;
  const pixelated = !!state && state.view.scale * (window.devicePixelRatio || 1) >= PIXELATE_FROM;
  const caption = image.alt.trim();
  const title = caption && caption.toLowerCase() !== 'image' ? caption : 'Image';

  return (
    <Dialog.Content
      ref={contentRef}
      className="image-viewer"
      onKeyDown={onKeyDown}
      // Focus the viewer itself, not its first button, so the keys work at once
      // and nothing shows a focus ring that the mouse did not ask for.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.focus();
      }}
      // Radix hands focus back to a Dialog.Trigger, and the viewer has none:
      // whatever opened it gets focus back instead of the page losing it.
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        opener?.focus();
      }}
      // The Inbox closes its detail pane on Esc; this Esc closes only the viewer.
      onEscapeKeyDown={(event) => event.stopPropagation()}
    >
      <div
        ref={stageRef}
        className="image-viewer-stage"
        data-cursor={cursor}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
      >
        {state && (
          <img
            ref={imageRef}
            className="image-viewer-image"
            src={image.src}
            alt={image.alt}
            draggable={false}
            data-animate={state.animate || undefined}
            data-pixelated={pixelated || undefined}
            style={{
              width: state.frame.image.width * state.view.scale,
              height: state.frame.image.height * state.view.scale,
              transform: `translate(${state.view.x}px, ${state.view.y}px)`,
            }}
          />
        )}
      </div>
      <div className="image-viewer-bar">
        <Dialog.Title className="image-viewer-title">{title}</Dialog.Title>
        <div className="image-viewer-tools" role="toolbar" aria-label="Zoom">
          <button type="button" className="image-viewer-button" aria-label="Zoom out" disabled={atFit} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <ZoomOut size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="image-viewer-button image-viewer-percent"
            aria-label={atFit ? `Zoom to ${percent(detailScale(state?.frame.fit ?? 1))}` : 'Fit to window'}
            onClick={() => toggle()}
          >
            {percent(state?.view.scale ?? 1)}
          </button>
          <button type="button" className="image-viewer-button" aria-label="Zoom in" disabled={atMax} onClick={() => zoomBy(ZOOM_STEP)}>
            <ZoomIn size={16} aria-hidden="true" />
          </button>
          <span className="image-viewer-divider" aria-hidden="true" />
          <Dialog.Close asChild>
            <button type="button" className="image-viewer-button" aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>
      </div>
      <Dialog.Description className="image-viewer-hint" data-hidden={!atFit || undefined}>
        Click, pinch or {MOD_KEY}-scroll to zoom · Drag or scroll to pan · Esc to close
      </Dialog.Description>
    </Dialog.Content>
  );
}
