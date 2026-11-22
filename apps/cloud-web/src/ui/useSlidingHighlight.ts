import { type CSSProperties, type PointerEvent, useCallback, useRef, useState } from 'react';

type Box = { x: number; y: number; width: number; height: number };

/**
 * One highlight under a group of links that slides to whichever the pointer is over, as Vercel's
 * nav does. It appears in place where the pointer enters the group (no slide from wherever it
 * last was), slides while the pointer moves between links, and fades where the pointer leaves.
 *
 * `selector` picks the links inside the container. Spread `container` on the element that holds
 * them, which must be positioned, and render one element with `highlight` inside it.
 */
export function useSlidingHighlight<Container extends HTMLElement>(selector: string) {
  const ref = useRef<Container>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [shown, setShown] = useState(false);
  // True for the frame the highlight lands where the pointer entered, so it does not slide there.
  const [instant, setInstant] = useState(true);

  const onPointerOver = useCallback(
    (event: PointerEvent<Container>) => {
      const container = ref.current;
      const link = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!container || !link || !container.contains(link)) return;
      const outer = container.getBoundingClientRect();
      const inner = link.getBoundingClientRect();
      setBox({
        x: inner.left - outer.left + container.scrollLeft,
        y: inner.top - outer.top + container.scrollTop,
        width: inner.width,
        height: inner.height,
      });
      setInstant(!shown);
      setShown(true);
    },
    [selector, shown],
  );

  const onPointerLeave = useCallback(() => setShown(false), []);

  const style: CSSProperties = box
    ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }
    : {};

  return {
    container: { ref, onPointerOver, onPointerLeave },
    highlight: {
      style,
      'aria-hidden': true as const,
      'data-shown': shown || undefined,
      'data-instant': instant || undefined,
    },
  };
}
