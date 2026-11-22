import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * Whether `ref`'s element has been laid out at a size, from the first time it
 * has been on.
 *
 * A react-resizable-panels `Group` must not mount before its box has its
 * size. It checks the saved sizes (`useDefaultLayout`) against the box as it
 * mounts: one that mounts at no size (4.5.9 marks it `defaultLayoutDeferred`)
 * is laid out, once measured, from its panels' own defaults, and one that
 * mounts at a size too small for its minimums is squeezed to fit; either
 * way the saved sizes are lost, and then written over. A group in the side
 * panel mounts so whenever the side panel itself comes on screen, shown or
 * at launch: in that commit its layout effects run before the side panel's
 * own group has laid the side panel out. So this asks a `ResizeObserver`,
 * whose answer comes after layout, never the box as the effects find it.
 */
export function useSized(ref: RefObject<HTMLElement | null>): boolean {
  const [sized, setSized] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (sized || !element) return undefined;
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0) setSized(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, sized]);
  return sized;
}
