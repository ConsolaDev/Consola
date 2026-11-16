import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import type { Entry } from './entry';
import { RunRow, activateRun } from '../components/Sidebar/rows/RunRow';
import { SessionRow } from '../components/Sidebar/rows/SessionRow';
import { activateSession } from '../utils/sessionActions';
import { idOfKey } from './entries';

/** What every row gets. Rows look their own record up by `entry.key`; the entry carries none. */
export interface RowProps {
  entry: Entry;
  workspaceId: string;
  /** Whether this is the entry the window is showing. */
  active: boolean;
  /** One step in, for a conductor's children. */
  child?: boolean;
  /** Opens the entry, as its kind decides. */
  onActivate: () => void;
  /** Drawn at the row's trailing edge: a tree's aggregate badge. */
  trailing?: ReactNode;
}

export interface RowKind {
  Row: ComponentType<RowProps>;
  /** What choosing the row does. */
  activate: (workspaceId: string, entry: Entry) => void;
}

/**
 * Every kind of row the sidebar can draw, by `Entry.kind`. A new source of
 * entries (slice 6's runs) is one provider plus one line here: bucketing, the
 * fold and the sidebar never name a kind.
 */
export const ROW_KINDS: Record<string, RowKind> = {
  session: {
    Row: SessionRow,
    activate: (workspaceId, entry) => activateSession(workspaceId, idOfKey(entry.key)),
  },
  run: { Row: RunRow, activate: activateRun },
};

/** The row for an entry, or nothing for a kind nobody registered. */
export function entryRow(
  entry: Entry,
  props: { workspaceId: string; active: boolean; child?: boolean; trailing?: ReactNode }
): ReactElement | null {
  const kind = ROW_KINDS[entry.kind];
  if (!kind) return null;
  return createElement(kind.Row, {
    key: entry.key,
    entry,
    ...props,
    onActivate: () => kind.activate(props.workspaceId, entry),
  });
}
