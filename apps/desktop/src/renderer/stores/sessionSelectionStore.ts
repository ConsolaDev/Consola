import { create } from 'zustand';
import type { EntryKey } from '../sidebar/entry';
import { pruneSelection, rangeBetween } from '../sidebar/selection';

interface SessionSelectionState {
  /** The workspace the selection was made in; a selection never crosses one. */
  workspaceId: string | null;
  /** Selected rows, in drawn order. */
  keys: EntryKey[];
  /** Where a ⇧-click range starts: the last row ⌘-clicked or plainly chosen. */
  anchor: EntryKey | null;
}

const EMPTY: SessionSelectionState = { workspaceId: null, keys: [], anchor: null };

/**
 * The rows picked with ⌘-click and ⇧-click, for acting on several at once.
 * This window's alone: a selection is a gesture in progress, not a record.
 */
export const useSessionSelectionStore = create<SessionSelectionState>(() => ({ ...EMPTY }));

/** ⌘-click: add the row, or take it out. It becomes the anchor either way. */
export function toggleSelected(workspaceId: string, key: EntryKey, order: readonly EntryKey[]) {
  useSessionSelectionStore.setState((state) => {
    const current = state.workspaceId === workspaceId ? state.keys : [];
    const next = current.includes(key)
      ? current.filter((one) => one !== key)
      : pruneSelection([...current, key], order);
    return { workspaceId, keys: next, anchor: key };
  });
}

/**
 * ⇧-click: everything from the anchor to this row, as drawn. With no anchor
 * yet, the open row is where it starts, as a list's selection would.
 */
export function selectRange(
  workspaceId: string,
  key: EntryKey,
  order: readonly EntryKey[],
  openKey: EntryKey | null,
) {
  useSessionSelectionStore.setState((state) => {
    const anchor = state.workspaceId === workspaceId ? (state.anchor ?? openKey) : openKey;
    return { workspaceId, keys: rangeBetween(order, anchor, key), anchor: anchor ?? key };
  });
}

/** Drop rows that are no longer drawn: deleted, filtered out, folded away. */
export function pruneSelected(workspaceId: string, order: readonly EntryKey[]) {
  const state = useSessionSelectionStore.getState();
  if (state.workspaceId !== workspaceId || state.keys.length === 0) return;
  const keys = pruneSelection(state.keys, order);
  if (keys.length !== state.keys.length) useSessionSelectionStore.setState({ keys });
}

export function clearSelection() {
  const state = useSessionSelectionStore.getState();
  if (state.keys.length > 0 || state.anchor !== null)
    useSessionSelectionStore.setState({ ...EMPTY });
}
