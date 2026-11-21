import { useEffect, useState } from 'react';
import { windowBridge } from '../../services/windowBridge';
import './styles.css';

/** How long the hint stays after ⌘Q is let go, so it can still be read. */
const LINGER_MS = 1200;

/**
 * "Hold ⌘Q or press twice to quit", while main is holding a ⌘Q back.
 *
 * Main decides everything (main/quitShortcut.ts); this only shows the
 * sentence while the key is down, and for a moment after.
 */
export function QuitHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = windowBridge.onQuitShortcut((state) => {
      clearTimeout(hideTimer);
      if (state === 'down') setVisible(true);
      else hideTimer = setTimeout(() => setVisible(false), LINGER_MS);
    });
    return () => {
      clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  if (!visible) return null;
  return (
    <div className="quit-hint" role="status">
      <div className="quit-hint-pill">Hold ⌘Q or press twice to quit</div>
    </div>
  );
}
