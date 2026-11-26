import {
  Boxes,
  FolderOpen,
  FolderPlus,
  GitCommit,
  Globe,
  List,
  Minus,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Palette,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { LocalServer } from '../../../shared/browser';
import type { OpenInTarget } from '../../../shared/openIn';
import type { GitFileStatus } from '../../types/electron';
import type { SettingsSection } from '../Dialogs/settingsSections';
import type { Harness } from '../../stores/harnessStore';
import type { Scope, Session, Workspace } from '../../stores/workspaceStore';
import { checkoutPathForSession, primaryScope, scopeForSession } from '../../../shared/workspace';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { toggleInfoPanel } from '../../stores/infoPanelRoomStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { pickOpenIn } from '../../stores/openInStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { TAB_KINDS } from '../../sidePanel/tabKinds';
import type { TabKindId } from '../../sidePanel/tabKinds';
import {
  useSettingsStore,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../../stores/settingsStore';
import { openNewWorkspaceDialog } from '../../stores/newWorkspaceDialogStore';
import { focusSessionAddressBar, openInSessionBrowser } from '../Browser/browserActions';
import { createQuickSession, openNewSessionDialog } from '../../utils/sessionActions';
import { workspaceStatusFor } from '../../utils/sessionStatus';
import type { AttentionMap } from '../../utils/sessionStatus';
import { isMac, WORKING_SHELF_SHORTCUT_LABEL } from '../../utils/platform';
import { INFO_PANEL_SHORTCUT_LABEL } from '../../utils/infoPanelShortcut';
import { OPEN_IN_SHORTCUT_LABEL } from '../../utils/openInShortcut';
import { SIDE_PANEL_SHORTCUT_LABEL } from '../../utils/sidePanelShortcut';
import type {
  PaletteMode,
  ActionPaletteItem,
  FilePaletteItem,
  HarnessPaletteItem,
  PaletteItem,
  SessionPaletteItem,
  WorkspacePaletteItem,
} from './types';

/**
 * Everything the builders read, captured once per render.
 *
 * Passing a snapshot rather than letting builders reach into stores keeps them
 * plain functions: they can be reasoned about, and their availability rules
 * read as ordinary conditions rather than as hook order.
 */
export interface PaletteContext {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeSession: Session | null;
  selectableHarnesses: Harness[];
  /** Named sessions across every workspace, most recently active first. */
  allSessions: Array<{ session: Session; workspace: Workspace }>;
  /** Sessions whose CLI has exited and can be restarted. */
  exitedSessions: Array<{ session: Session; workspace: Workspace }>;
  /** Keyed by instance id, for the same status dot the sidebar and switcher show. */
  /** Each session's attention, for the workspace dots. */
  statuses: AttentionMap;
  fileStatuses: Map<string, GitFileStatus>;
  /** Which repository `fileStatuses` actually describes. */
  gitStatusRootPath: string | null;
  stagedCount: number;
  commitMessage: string;
  /**
   * The side panel's tab kinds for the active session, in registry order;
   * empty without one, and while the Inbox or Automations lies over it.
   */
  tabKinds: Array<{ id: TabKindId; title: string; available: boolean }>;
  /** Whether the side panel is showing, so its row says what choosing it will do. */
  isSidePanelVisible: boolean;
  /**
   * Whether the info panel is on screen, so its row says what choosing it
   * will do: Show while it has stepped aside for a narrow window.
   */
  isInfoPanelVisible: boolean;
  /**
   * The Inbox or Automations lies over the active session. The session stays
   * active behind it, but its side panel is not on screen, and the side
   * panel's chords do nothing there.
   */
  isOverlayOpen: boolean;
  terminalFontSize: number;
  /** Servers running from the active session's folder, read when the palette opened. */
  localServers: LocalServer[];
  /** The apps a folder can be opened in, as main last listed them; asked again when the palette opens. */
  openInTargets: readonly OpenInTarget[];
  /** The app ⌘O opens in (`favouriteTarget`), whose row carries the chord. */
  openInFavouriteId: string | undefined;
  openSettings: (section?: SettingsSection) => void;
}

/**
 * The scope the palette should treat as "here": the active session's, or the
 * workspace's primary scope when no session is open. Git items act on this.
 */
function activeScope(ctx: PaletteContext): Scope | null {
  if (!ctx.activeWorkspace) return null;
  return scopeForSession(ctx.activeWorkspace, ctx.activeSession ?? undefined) ?? null;
}

/** The checkout git actions act on: the active session's, worktree included. */
function activeGitRoot(ctx: PaletteContext): string | null {
  if (!ctx.activeWorkspace) return null;
  return checkoutPathForSession(ctx.activeWorkspace, ctx.activeSession ?? undefined) ?? null;
}

/**
 * Whether the loaded git status describes the active workspace.
 *
 * `gitStatusStore` tracks one repository at a time and only refreshes while a
 * session in that workspace is on screen, so without this check the palette
 * would happily offer to commit against a repository the user left behind.
 */
function hasFreshGitStatus(ctx: PaletteContext): boolean {
  const scope = activeScope(ctx);
  return scope?.isGitRepo === true && ctx.gitStatusRootPath === activeGitRoot(ctx);
}

/** Actions, filtered to the ones that make sense right now. */
export function buildActionItems(ctx: PaletteContext): ActionPaletteItem[] {
  const items: ActionPaletteItem[] = [];
  const { activeWorkspace, activeSession } = ctx;

  // --- sessions and workspaces ------------------------------------------
  if (activeWorkspace) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.new-here',
      label: 'New session',
      context: activeWorkspace.name,
      icon: Plus,
      shortcutHint: isMac ? '⌘N' : 'Ctrl+N',
      run: async () => {
        await createQuickSession(activeWorkspace.id);
      },
    });
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.new-with-options',
      label: 'New session with options…',
      context: activeWorkspace.name,
      icon: Plus,
      shortcutHint: isMac ? '⇧⌘N' : 'Ctrl+Shift+N',
      run: () => openNewSessionDialog(activeWorkspace.id),
    });
  }

  if (activeWorkspace) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.workspace.settings',
      label: 'Workspace settings…',
      context: activeWorkspace.name,
      icon: Settings,
      // Straight to the Workspace group, which edits the workspace this
      // window is on: the one this row names.
      run: () => ctx.openSettings('general'),
    });
  }

  if (ctx.workspaces.length > 1) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.new-in',
      label: 'New session in…',
      icon: Plus,
      pushMode: { kind: 'pick-workspace' },
    });
  }

  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.workspace.add',
    label: 'Add workspace…',
    icon: FolderPlus,
    run: openNewWorkspaceDialog,
  });

  if (ctx.allSessions.length > 0) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.rename',
      label: 'Rename session…',
      icon: Pencil,
      pushMode: { kind: 'pick-session', purpose: 'rename' },
    });
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.delete',
      label: 'Delete session…',
      icon: Trash2,
      pushMode: { kind: 'pick-session', purpose: 'delete' },
    });
  }

  if (ctx.exitedSessions.length > 0) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.session.restart',
      label: 'Restart exited session…',
      icon: RotateCw,
      pushMode: { kind: 'pick-session', purpose: 'restart' },
    });
  }

  // --- view and layout ----------------------------------------------------
  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.view.toggle-sidebar',
    label: 'Toggle sidebar',
    icon: PanelLeft,
    shortcutHint: isMac ? '⌘\\' : 'Ctrl+\\',
    run: () => useNavigationStore.getState().toggleSidebar(),
  });

  // The info panel and the side panel only exist beside a session, and are
  // not on screen under an overlay, where their chords do nothing either.
  if (activeSession && !ctx.isOverlayOpen) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.view.toggle-info-panel',
      label: ctx.isInfoPanelVisible ? 'Hide info panel' : 'Show info panel',
      icon: List,
      shortcutHint: INFO_PANEL_SHORTCUT_LABEL,
      run: toggleInfoPanel,
    });
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.view.toggle-side-panel',
      label: ctx.isSidePanelVisible ? 'Hide side panel' : 'Show side panel',
      icon: PanelRight,
      shortcutHint: SIDE_PANEL_SHORTCUT_LABEL,
      run: () => useSidePanelStore.getState().toggleVisible(),
    });
  }

  // The browser only exists beside a session: these open its Browser tab.
  if (activeSession) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.browser.open-address',
      label: 'Open address in browser…',
      icon: Globe,
      run: () => void focusSessionAddressBar(activeSession.id),
    });
    for (const server of ctx.localServers) {
      items.push({
        kind: 'action',
        section: 'actions',
        id: `action.browser.open-server.${server.port}`,
        label: `Open localhost:${server.port} — ${server.command}`,
        icon: Globe,
        run: () => void openInSessionBrowser(activeSession.id, server.url),
      });
    }
  }

  // One row per tab kind that applies to the active session. The side panel
  // only exists beside one, on screen, so without a session, or under an
  // overlay, `tabKinds` is empty.
  for (const kind of TAB_KINDS) {
    const entry = ctx.tabKinds.find((candidate) => candidate.id === kind.id);
    if (!entry?.available) continue;
    items.push({
      kind: 'action',
      section: 'actions',
      id: `action.side-panel.open.${kind.id}`,
      label: `Open ${entry.title}`,
      icon: kind.icon,
      shortcutHint: kind.chord,
      run: () => useSidePanelStore.getState().openKind(kind.id),
    });
  }

  // One row per app the session's folder can be opened in, as the info
  // panel's "Open in" menu lists them; choosing one makes it the favourite,
  // as picking it there does. No folder, no rows: a removed worktree has none.
  const folder = activeGitRoot(ctx);
  if (activeSession && !ctx.isOverlayOpen && folder) {
    for (const target of ctx.openInTargets) {
      items.push({
        kind: 'action',
        section: 'actions',
        id: `action.open-in.${target.id}`,
        label: `Open folder in ${target.label}`,
        icon: FolderOpen,
        ...(target.id === ctx.openInFavouriteId ? { shortcutHint: OPEN_IN_SHORTCUT_LABEL } : {}),
        run: () => pickOpenIn(target, folder),
      });
    }
  }

  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.view.toggle-working-shelf',
    label: 'Show or hide working sessions',
    icon: PanelRight,
    shortcutHint: WORKING_SHELF_SHORTCUT_LABEL,
    run: () => useSettingsStore.getState().toggleSidebarShelf('working'),
  });

  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.view.cycle-theme',
    label: 'Cycle theme',
    icon: Palette,
    shortcutHint: isMac ? '⇧⌘T' : 'Ctrl+Shift+T',
    run: () => useSettingsStore.getState().cycleTheme(),
  });

  if (ctx.terminalFontSize < TERMINAL_FONT_SIZE_MAX) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.view.font-increase',
      label: 'Increase terminal font size',
      context: `${ctx.terminalFontSize}px`,
      icon: Plus,
      run: () => useSettingsStore.getState().setTerminalFontSize(ctx.terminalFontSize + 1),
    });
  }
  if (ctx.terminalFontSize > TERMINAL_FONT_SIZE_MIN) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.view.font-decrease',
      label: 'Decrease terminal font size',
      context: `${ctx.terminalFontSize}px`,
      icon: Minus,
      run: () => useSettingsStore.getState().setTerminalFontSize(ctx.terminalFontSize - 1),
    });
  }

  // --- git ----------------------------------------------------------------
  const scope = activeScope(ctx);
  const gitRoot = activeGitRoot(ctx);
  if (scope?.isGitRepo && gitRoot) {
    const rootPath = gitRoot;

    // Generate and commit need a status that actually describes this repo.
    if (hasFreshGitStatus(ctx) && ctx.stagedCount > 0) {
      items.push({
        kind: 'action',
        section: 'actions',
        id: 'action.git.generate-message',
        label: 'Generate commit message',
        context: `${ctx.stagedCount} staged`,
        icon: Sparkles,
        run: () => {
          // The Changes tab is where the draft and any error surface.
          useSidePanelStore.getState().openKind('changes');
          return useGitReviewStore.getState().generateCommitMessage(rootPath);
        },
      });

      if (ctx.commitMessage.trim() !== '') {
        items.push({
          kind: 'action',
          section: 'actions',
          id: 'action.git.commit',
          label: 'Commit staged changes',
          context: `${ctx.stagedCount} staged`,
          icon: GitCommit,
          run: () => {
            useSidePanelStore.getState().openKind('changes');
            return useGitReviewStore.getState().commitStaged(rootPath);
          },
        });
      }
    }

    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.git.refresh',
      label: 'Refresh git status',
      icon: RefreshCw,
      run: () => useGitStatusStore.getState().refresh(rootPath),
    });
  }

  // --- settings and harnesses ---------------------------------------------
  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.settings.open',
    label: 'Open settings',
    icon: Settings,
    shortcutHint: isMac ? '⌘,' : 'Ctrl+,',
    run: () => ctx.openSettings(),
  });

  items.push({
    kind: 'action',
    section: 'actions',
    id: 'action.harness.recheck',
    label: 'Re-check harnesses',
    icon: Boxes,
    run: () => useHarnessStore.getState().probeAll(),
  });

  if (activeWorkspace && ctx.selectableHarnesses.length > 1) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.harness.set-default',
      label: 'Set default harness…',
      context: activeWorkspace.name,
      icon: Boxes,
      pushMode: { kind: 'pick-harness', workspaceId: activeWorkspace.id },
    });
  }

  return items;
}

/** Every named session, labelled with the workspace it belongs to. */
export function buildSessionItems(
  entries: Array<{ session: Session; workspace: Workspace }>,
): SessionPaletteItem[] {
  return entries.map(({ session, workspace }) => ({
    kind: 'session',
    section: 'sessions',
    id: `session:${workspace.id}:${session.id}`,
    label: session.name,
    context: workspace.name,
    workspaceId: workspace.id,
    sessionId: session.id,
  }));
}

export function buildWorkspaceItems(
  workspaces: Workspace[],
  attention: AttentionMap,
): WorkspacePaletteItem[] {
  return workspaces.map((workspace) => ({
    kind: 'workspace',
    section: 'workspaces',
    id: `workspace:${workspace.id}`,
    label: workspace.name,
    context: primaryScope(workspace)?.path ?? '',
    workspaceId: workspace.id,
    icon: workspace.icon,
    status: workspaceStatusFor(workspace, attention),
  }));
}

/**
 * Changed files in the active workspace.
 *
 * Empty unless the loaded status describes this workspace, and unless a
 * session is open — the diff opens in the preview panel, which only exists
 * inside a session's content view.
 */
export function buildFileItems(ctx: PaletteContext): FilePaletteItem[] {
  const rootPath = activeGitRoot(ctx);
  if (!ctx.activeSession || !hasFreshGitStatus(ctx) || !rootPath) return [];

  const items: FilePaletteItem[] = [];

  ctx.fileStatuses.forEach((status, relativePath) => {
    items.push({
      kind: 'file',
      section: 'files',
      id: `file:${relativePath}`,
      label: relativePath.split('/').pop() ?? relativePath,
      context: relativePath,
      rootPath,
      relativePath,
      status,
    });
  });

  return items;
}

export function buildHarnessItems(
  harnesses: Harness[],
  currentDefaultId: string,
): HarnessPaletteItem[] {
  return harnesses
    .filter((harness) => harness.id !== currentDefaultId)
    .map((harness) => ({
      kind: 'harness',
      section: 'actions',
      id: `harness:${harness.id}`,
      label: harness.name,
      harnessId: harness.id,
      accentColor: harness.accentColor,
    }));
}

/** Rows offered by a sub-picker mode. */
export function buildPickerItems(
  mode: Extract<PaletteMode, { kind: 'pick-workspace' | 'pick-session' | 'pick-harness' }>,
  ctx: PaletteContext,
): PaletteItem[] {
  switch (mode.kind) {
    case 'pick-workspace':
      return buildWorkspaceItems(ctx.workspaces, ctx.statuses);
    case 'pick-session':
      return buildSessionItems(mode.purpose === 'restart' ? ctx.exitedSessions : ctx.allSessions);
    case 'pick-harness': {
      const workspace = ctx.workspaces.find((candidate) => candidate.id === mode.workspaceId);
      return buildHarnessItems(ctx.selectableHarnesses, workspace?.defaultHarnessId ?? '');
    }
  }
}
