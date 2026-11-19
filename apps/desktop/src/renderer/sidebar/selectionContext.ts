import { createContext, useContext } from 'react';
import type { EntryKey } from './entry';

/**
 * What a row needs to extend a selection: the rows as drawn, and the one that
 * is open (where a first ⇧-click range starts). Provided by the sidebar, which
 * is the only place the drawn order is known.
 */
export interface SelectionFrame {
  workspaceId: string;
  order: readonly EntryKey[];
  openKey: EntryKey | null;
}

export const SelectionContext = createContext<SelectionFrame | null>(null);

export function useSelectionFrame(): SelectionFrame | null {
  return useContext(SelectionContext);
}
