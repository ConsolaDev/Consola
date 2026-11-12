import { useEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from './useReducedMotion';

/** Ease-out-quart: quick to arrive, quiet to stop. */
const EASE_OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';

/**
 * A short settle-in (fade and a few pixels' rise) on the element whenever
 * `key` changes after the first render. It is how a choice made in one place
 * is seen to land in another: picking a scope in the sidebar's scope row
 * settles the session list it filters.
 *
 * Transform and opacity only, so nothing reflows; none at all when the
 * system asks for reduced motion.
 */
export function useSettleOnChange(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  { delay = 0, rise = 3 }: { delay?: number; rise?: number } = {},
) {
  const reduced = useReducedMotion();
  const previous = useRef(key);

  useEffect(() => {
    if (Object.is(previous.current, key)) return;
    previous.current = key;
    const element = ref.current;
    if (reduced || !element || typeof element.animate !== 'function') return;
    const animation = element.animate(
      [{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 180, delay, easing: EASE_OUT, fill: 'backwards' },
    );
    return () => animation.cancel();
  }, [key, reduced, delay, rise, ref]);
}
