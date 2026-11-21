import { useEffect, useRef, useState } from 'react';
import type { SidebarDensity } from '../../stores/settingsStore';

/** Long enough for the settle (300ms) to finish before the marker goes. */
const SHIFT_MS = 420;

/**
 * A marker for the moment the sidebar's density changes, alternating between
 * two values so a second change inside the window restarts the settle rather
 * than being swallowed by the first. Absent at rest and on mount: only a
 * change the person makes moves anything.
 */
export function useDensityShift(density: SidebarDensity): 'a' | 'b' | undefined {
  const [shift, setShift] = useState<'a' | 'b' | undefined>(undefined);
  const previous = useRef(density);

  useEffect(() => {
    if (previous.current === density) return;
    previous.current = density;
    setShift((current) => (current === 'a' ? 'b' : 'a'));
    const timer = window.setTimeout(() => setShift(undefined), SHIFT_MS);
    return () => window.clearTimeout(timer);
  }, [density]);

  return shift;
}
