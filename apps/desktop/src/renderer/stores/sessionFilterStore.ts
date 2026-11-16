import { create } from 'zustand';
import type { FacetKey, SessionFilters } from '../utils/sessionFilters';

interface SessionFilterState {
  /** Workspace id → its selected facet values. No key is no filter. */
  filters: Record<string, SessionFilters>;
  toggle: (workspaceId: string, facet: FacetKey, value: string) => void;
  clear: (workspaceId: string) => void;
}

/**
 * A view concern, so it lives here and not on the workspace record: in
 * memory, per workspace, window-local — the same footing as `homeStore`'s
 * scope filter, which is the scope facet of the same bar. Writing it would
 * mean an fsync and a broadcast to every window for a click on a chip.
 */
export const useSessionFilterStore = create<SessionFilterState>((set) => ({
  filters: {},
  toggle: (workspaceId, facet, value) => set((state) => {
    const current = state.filters[workspaceId] ?? {};
    const chosen = current[facet] ?? [];
    const next = chosen.includes(value) ? chosen.filter((candidate) => candidate !== value) : [...chosen, value];
    const { [facet]: _previous, ...rest } = current;
    const updated: SessionFilters = next.length > 0 ? { ...rest, [facet]: next } : rest;
    return { filters: { ...state.filters, [workspaceId]: updated } };
  }),
  clear: (workspaceId) => set((state) => {
    const { [workspaceId]: _previous, ...rest } = state.filters;
    return { filters: rest };
  }),
}));
