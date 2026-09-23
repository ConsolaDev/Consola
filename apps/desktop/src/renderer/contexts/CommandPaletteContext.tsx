import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import type { PaletteScope } from '../components/CommandPalette/types';

interface CommandPaletteContextType {
  /** Opens narrowed to one section when given a scope, otherwise wide. */
  openPalette: (scope?: PaletteScope) => void;
  closePalette: () => void;
  togglePalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextType | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialScope, setInitialScope] = useState<PaletteScope | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  /**
   * Open and close, remembering what had focus.
   *
   * Radix restores focus on close by itself, but not reliably here — the
   * element it hands focus back to ends up being the body. The palette is
   * almost always opened from a focused terminal, and landing back on the body
   * would mean the next keystroke goes nowhere instead of to the CLI, so the
   * element is captured before opening and focused again afterwards.
   */
  const setOpen = useCallback((next: boolean, scope: PaletteScope | null = null) => {
    if (next) {
      returnFocusTo.current = document.activeElement as HTMLElement | null;
      // Held here rather than passed through open(): the palette resets itself
      // on every open, and this is what it resets the scope to.
      setInitialScope(scope);
    }
    setIsOpen(next);
    if (!next) {
      const target = returnFocusTo.current;
      returnFocusTo.current = null;
      // After the dialog has torn down, or it takes focus back on the way out.
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
    }
  }, []);

  const openPalette = useCallback(
    (scope?: PaletteScope) => setOpen(true, scope ?? null),
    [setOpen]
  );
  const closePalette = useCallback(() => setOpen(false), [setOpen]);
  // Toggles, so the same chord dismisses a palette that is already up.
  const togglePalette = useCallback(() => setOpen(!isOpen), [setOpen, isOpen]);

  return (
    <CommandPaletteContext.Provider value={{ openPalette, closePalette, togglePalette }}>
      {children}
      {/* Kept mounted while closed: the palette skips its own work in that
          state, and tearing the dialog down entirely loses the focus handling
          above. */}
      <CommandPalette open={isOpen} onOpenChange={setOpen} initialScope={initialScope} />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error('useCommandPalette must be used within a CommandPaletteProvider');
  }
  return context;
}
