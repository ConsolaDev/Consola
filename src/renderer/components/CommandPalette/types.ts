import type { LucideIcon } from 'lucide-react';
import type { GitFileStatus } from '../../types/electron';
import type { SessionStatus } from '../../utils/sessionStatus';

/** Result groups, in the order they are rendered. */
export type PaletteSection = 'actions' | 'sessions' | 'workspaces' | 'files';

export const SECTION_ORDER: PaletteSection[] = ['actions', 'sessions', 'workspaces', 'files'];

export const SECTION_LABELS: Record<PaletteSection, string> = {
  actions: 'ACTIONS',
  sessions: 'SESSIONS',
  workspaces: 'WORKSPACES',
  files: 'CHANGED FILES',
};

/**
 * A section the palette has been narrowed to.
 *
 * Scope is not a mode: it changes which candidates exist, not what the palette
 * is asking for, so a query still means the same thing inside one.
 */
export type PaletteScope = PaletteSection;

/**
 * The leading characters that narrow the palette, in legend order.
 *
 * Held as one list rather than two maps so a sigil and its section cannot
 * drift apart; the lookups below are over four entries.
 */
export const SCOPE_SIGILS: ReadonlyArray<{ sigil: string; scope: PaletteScope }> = [
  { sigil: '>', scope: 'actions' },
  { sigil: '@', scope: 'sessions' },
  { sigil: '#', scope: 'workspaces' },
  { sigil: '~', scope: 'files' },
];

export function scopeForSigil(character: string): PaletteScope | null {
  return SCOPE_SIGILS.find((entry) => entry.sigil === character)?.scope ?? null;
}

export function sigilForScope(scope: PaletteScope): string {
  return SCOPE_SIGILS.find((entry) => entry.scope === scope)?.sigil ?? '';
}

/** Title case, unlike SECTION_LABELS: these read as a phrase, not a heading. */
export const SCOPE_LABELS: Record<PaletteScope, string> = {
  actions: 'Actions',
  sessions: 'Sessions',
  workspaces: 'Workspaces',
  files: 'Changed files',
};

export const SCOPE_PLACEHOLDERS: Record<PaletteScope, string> = {
  actions: 'Search actions…',
  sessions: 'Search sessions…',
  workspaces: 'Search workspaces…',
  files: 'Search changed files…',
};

/**
 * What the palette is currently asking for.
 *
 * An action that needs a target pushes the mode that collects it rather than
 * flattening every possible target into the root list — otherwise a dozen
 * workspaces would mean a dozen "New session in…" rows crowding out
 * everything else.
 */
export type PaletteMode =
  | { kind: 'root' }
  | { kind: 'pick-workspace' }
  | { kind: 'pick-session'; purpose: 'rename' | 'delete' | 'restart' }
  | { kind: 'pick-harness'; workspaceId: string }
  | { kind: 'rename-session'; workspaceId: string; sessionId: string };

interface PaletteItemBase {
  /** Unique across the whole result set. */
  id: string;
  label: string;
  /** Right-aligned dim context. Searchable, at a discount. */
  context?: string;
}

export interface ActionPaletteItem extends PaletteItemBase {
  kind: 'action';
  section: 'actions';
  icon: LucideIcon;
  /** Shown right-aligned when the action already has a global shortcut. */
  shortcutHint?: string;
  /** Pushes a mode to collect a target. Mutually exclusive with `run`. */
  pushMode?: Exclude<PaletteMode, { kind: 'root' }>;
  run?: () => void | Promise<void>;
}

export interface SessionPaletteItem extends PaletteItemBase {
  kind: 'session';
  section: 'sessions';
  workspaceId: string;
  sessionId: string;
}

export interface WorkspacePaletteItem extends PaletteItemBase {
  kind: 'workspace';
  section: 'workspaces';
  workspaceId: string;
  isGitRepo: boolean;
  status: SessionStatus;
}

export interface FilePaletteItem extends PaletteItemBase {
  kind: 'file';
  section: 'files';
  rootPath: string;
  relativePath: string;
  status: GitFileStatus;
}

export interface HarnessPaletteItem extends PaletteItemBase {
  kind: 'harness';
  section: 'actions';
  harnessId: string;
  accentColor: string;
}

export type PaletteItem =
  | ActionPaletteItem
  | SessionPaletteItem
  | WorkspacePaletteItem
  | FilePaletteItem
  | HarnessPaletteItem;

/** One rendered group: a header plus the rows under it. */
export interface PaletteGroup {
  section: PaletteSection;
  items: PaletteItem[];
}

/**
 * Rows in render order, alongside the flat list keyboard selection indexes
 * into. Headers are never part of `flat`, so arrow keys cannot land on one.
 */
export interface PaletteResults {
  groups: PaletteGroup[];
  flat: PaletteItem[];
}
