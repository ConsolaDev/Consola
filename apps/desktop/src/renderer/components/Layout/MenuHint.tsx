import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';

/**
 * A title-bar menu's explaining tooltip: what the menu is, shown on a
 * lingering hover. Wrap the menu's trigger with it.
 *
 * It stays quiet while its menu is open, and after the menu closes until the
 * pointer comes back, because closing returns focus to the trigger, and a
 * tooltip that answers that focus would pop up right after the choice was made.
 */
export function MenuHint({
  menuOpen, title, children, content,
}: { menuOpen: boolean; title: string; children: ReactElement; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [quiet, setQuiet] = useState(false);
  useEffect(() => { if (menuOpen) setQuiet(true); }, [menuOpen]);

  return (
    <Tooltip.Provider delayDuration={450}>
      <Tooltip.Root open={open && !menuOpen && !quiet} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild onPointerEnter={() => setQuiet(false)}>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content title-hint" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
            <span className="title-hint-title">{title}</span>
            {content}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
