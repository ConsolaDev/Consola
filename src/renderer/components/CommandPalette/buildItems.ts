import {
  Boxes,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitCommit,
  Minus,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Palette,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { GitFileStatus } from '../../types/electron';
import type { Harness } from '../../stores/harnessStore';
import type { Session, Workspace } from '../../stores/workspaceStore';
import type { TerminalState } from '../../stores/terminalStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSettingsStore, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../stores/settingsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { dialogBridge } from '../../services/dialogBridge';
import { openNewSessionComposer } from '../../utils/sessionActions';
import { workspaceStatusFor } from '../../utils/sessionStatus';
import { isMac } from '../../utils/platform';
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
  terminals: Record<string, TerminalState>;
  fileStatuses: Map<string, GitFileStatus>;
  /** Which repository `fileStatuses` actually describes. */
  gitStatusRootPath: string | null;
  stagedCount: number;
  commitMessage: string;
  isGitReviewOpen: boolean;
  terminalFontSize: number;
  openSettings: () => void;
}

/**
 * Whether the loaded git status describes the active workspace.
 *
 * `gitStatusStore` tracks one repository at a time and only refreshes while a
 * session in that workspace is on screen, so without this check the palette
 * would happily offer to commit against a repository the user left behind.
 */
function hasFreshGitStatus(ctx: PaletteContext): boolean {
  return (
    ctx.activeWorkspace !== null &&
    ctx.activeWorkspace.isGitRepo &&
    ctx.gitStatusRootPath === ctx.activeWorkspace.path
  );
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
      // Opens the composer rather than creating a record, so backing out
      // leaves no empty session behind.
      run: () => openNewSessionComposer(activeWorkspace.id),
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
    run: async () => {
      const folder = await dialogBridge.selectFolder();
      if (!folder) return;
      const workspace = await useWorkspaceStore
        .getState()
        .createWorkspace(folder.name, folder.path, folder.isGitRepo);
      await useNavigationStore.getState().setActiveWorkspace(workspace.id);
    },
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

  // The explorer and review panels only exist inside a session's content view.
  if (activeSession) {
    items.push({
      kind: 'action',
      section: 'actions',
      id: 'action.view.toggle-explorer',
      label: 'Toggle file explorer',
      icon: FolderTree,
      shortcutHint: isMac ? '⇧⌘E' : 'Ctrl+Shift+E',
      run: () => useNavigationStore.getState().toggleExplorer(),
    });
  }

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
  if (activeWorkspace?.isGitRepo) {
    const rootPath = activeWorkspace.path;

    if (activeSession) {
      items.push({
        kind: 'action',
        section: 'actions',
        id: 'action.git.toggle-review',
        // One row rather than separate open and toggle entries, labelled by
        // what it is about to do. Gated on isGitRepo to match the toolbar.
        label: ctx.isGitReviewOpen ? 'Close git review' : 'Open git review',
        icon: GitBranch,
        run: () => useGitReviewStore.getState().toggle(),
      });
    }

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
          // The review panel is where the draft and any error surface.
          useGitReviewStore.getState().open();
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
            useGitReviewStore.getState().open();
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
  entries: Array<{ session: Session; workspace: Workspace }>
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
  terminals: Record<string, TerminalState>
): WorkspacePaletteItem[] {
  return workspaces.map((workspace) => ({
    kind: 'workspace',
    section: 'workspaces',
    id: `workspace:${workspace.id}`,
    label: workspace.name,
    context: workspace.path,
    workspaceId: workspace.id,
    isGitRepo: workspace.isGitRepo,
    status: workspaceStatusFor(workspace, terminals),
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
  if (!ctx.activeSession || !hasFreshGitStatus(ctx) || !ctx.activeWorkspace) return [];

  const rootPath = ctx.activeWorkspace.path;
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

export function buildHarnessItems(harnesses: Harness[], currentDefaultId: string): HarnessPaletteItem[] {
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
  ctx: PaletteContext
): PaletteItem[] {
  switch (mode.kind) {
    case 'pick-workspace':
      return buildWorkspaceItems(ctx.workspaces, ctx.terminals);
    case 'pick-session':
      return buildSessionItems(mode.purpose === 'restart' ? ctx.exitedSessions : ctx.allSessions);
    case 'pick-harness': {
      const workspace = ctx.workspaces.find((candidate) => candidate.id === mode.workspaceId);
      return buildHarnessItems(ctx.selectableHarnesses, workspace?.defaultHarnessId ?? '');
    }
  }
}
