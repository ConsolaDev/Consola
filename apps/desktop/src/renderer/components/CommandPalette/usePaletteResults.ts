import { useEffect, useMemo, useState } from 'react';
import type { LocalServer } from '../../../shared/browser';
import type { OpenInTarget } from '../../../shared/openIn';
import { browserBridge } from '../../services/browserBridge';
import { activityOf } from '../../../shared/attention';
import { checkoutPathForSession } from '../../../shared/workspace';
import { TAB_KINDS, tabFactsFor } from '../../sidePanel/tabKinds';
import { useAttentionStore } from '../../stores/attentionStore';
import { useFoundPullRequest } from '../../stores/branchPullRequestStore';
import { useCheckout } from '../../stores/checkoutStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useInfoPanelShown } from '../../stores/infoPanelRoomStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { loadOpenInTargets, useOpenInFavourite, useOpenInStore } from '../../stores/openInStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { rankItem } from './fuzzyMatch';
import {
  buildActionItems,
  buildFileItems,
  buildPickerItems,
  buildSessionItems,
  buildWorkspaceItems,
} from './buildItems';
import type { PaletteContext } from './buildItems';
import { SECTION_ORDER } from './types';
import type { PaletteGroup, PaletteItem, PaletteMode, PaletteResults, PaletteScope } from './types';

/**
 * Cap per group, so one long list cannot push the others off screen.
 *
 * Actions are exempt: the set is bounded by construction, and capping it meant
 * a browsing user with two workspaces never saw "Open settings" at all. The
 * scoped section is exempt too — nothing is competing for the space, and
 * hiding the ninth session from someone who asked for sessions is the exact
 * problem the scope was reached for.
 */
const MAX_PER_SECTION = 8;

function sectionLimit(section: PaletteItem['section'], scope: PaletteScope | null): number {
  if (section === 'actions' || section === scope) return Number.POSITIVE_INFINITY;
  return MAX_PER_SECTION;
}

/**
 * The servers running from the active session's folder, asked for each time
 * the palette opens: one `lsof` pair on demand, never while it is closed.
 * Nothing outside a session, and nothing until the answer arrives.
 */
function useLocalServers(open: boolean, sessionId: string | undefined): LocalServer[] {
  const [servers, setServers] = useState<LocalServer[]>(NO_SERVERS);
  useEffect(() => {
    if (!open || !sessionId) {
      setServers(NO_SERVERS);
      return;
    }
    let cancelled = false;
    browserBridge.localServers(sessionId).then(
      (found) => {
        if (!cancelled) setServers(found ?? NO_SERVERS);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);
  return servers;
}

const NO_SERVERS: LocalServer[] = [];

/**
 * The apps a session's folder can be opened in, and the favourite's id: what
 * main last listed, asked again each time the palette opens with a session
 * active, as the info panel's menu asks when it opens.
 */
function useOpenInTargets(
  open: boolean,
  sessionId: string | undefined,
): { targets: readonly OpenInTarget[]; favouriteId: string | undefined } {
  const targets = useOpenInStore((state) => state.targets) ?? NO_TARGETS;
  const favourite = useOpenInFavourite();
  useEffect(() => {
    if (open && sessionId) void loadOpenInTargets();
  }, [open, sessionId]);
  return { targets, favouriteId: favourite?.id };
}

const NO_TARGETS: OpenInTarget[] = [];

/** Live snapshot of everything the palette can act on. */
export function usePaletteContext(open: boolean): PaletteContext {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const attention = useAttentionStore((state) => state.records);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const isOverlayOpen = useNavigationStore((state) => state.overlay !== null);
  const terminals = useTerminalStore((state) => state.terminals);
  const statuses = useAttentionStore((state) => state.attention);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const gitStatusRootPath = useGitStatusStore((state) => state.rootPath);
  const commitMessage = useGitReviewStore((state) => state.commitMessage);
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const isSidePanelVisible = useSidePanelStore((state) => state.layout.visible);
  const isInfoPanelVisible = useInfoPanelShown();
  const { openSettings } = useSettings();
  const localServers = useLocalServers(open, activeSessionId ?? undefined);
  const { targets: openInTargets, favouriteId: openInFavouriteId } = useOpenInTargets(
    open,
    activeSessionId ?? undefined,
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const activeSession = useMemo(
    () => activeWorkspace?.sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeWorkspace, activeSessionId],
  );

  // The tab kinds as the side panel would offer them for the active session,
  // none while an overlay hides the side panel.
  const activeCheckout = useCheckout(
    activeWorkspace && activeSession
      ? checkoutPathForSession(activeWorkspace, activeSession)
      : null,
  );
  // Subscribed, so a lookup that lands while the palette is open refreshes its rows.
  const activeFound = useFoundPullRequest(
    activeWorkspace ?? undefined,
    activeSession ?? undefined,
    activeCheckout,
  );
  const tabKinds = useMemo(() => {
    if (!activeWorkspace || !activeSession || isOverlayOpen) return [];
    const facts = tabFactsFor(activeWorkspace, activeSession, activeCheckout, activeFound);
    return TAB_KINDS.map((kind) => ({
      id: kind.id,
      title: kind.title(facts),
      available: kind.availability(facts).available,
    }));
  }, [activeWorkspace, activeSession, activeCheckout, activeFound, isOverlayOpen]);

  // A session with no name yet is still being created; the sidebar hides those
  // too, and a blank row would be unselectable anyway.
  const allSessions = useMemo(() => {
    const entries = workspaces.flatMap((workspace) =>
      workspace.sessions
        .filter((session) => session.name.length > 0)
        .map((session) => ({ session, workspace })),
    );
    return entries.sort(
      (a, b) =>
        activityOf(b.session, attention[b.session.id]) -
        activityOf(a.session, attention[a.session.id]),
    );
  }, [workspaces, attention]);

  const exitedSessions = useMemo(
    () => allSessions.filter(({ session }) => terminals[session.instanceId]?.hasExited),
    [allSessions, terminals],
  );

  const stagedCount = useMemo(() => {
    let count = 0;
    fileStatuses.forEach((status) => {
      if (status === 'staged') count++;
    });
    return count;
  }, [fileStatuses]);

  const selectableHarnesses = useMemo(() => harnesses.filter(isSelectableHarness), [harnesses]);

  // Memoised as a whole, not just field by field: this object is a dependency
  // of the result memo, so a fresh identity every render would rebuild and
  // re-score every candidate on each keystroke and each row hover.
  return useMemo(
    () => ({
      workspaces,
      activeWorkspace,
      activeSession,
      selectableHarnesses,
      allSessions,
      exitedSessions,
      statuses,
      fileStatuses,
      gitStatusRootPath,
      stagedCount,
      commitMessage,
      tabKinds,
      isSidePanelVisible,
      isInfoPanelVisible,
      isOverlayOpen,
      terminalFontSize,
      localServers,
      openInTargets,
      openInFavouriteId,
      openSettings,
    }),
    [
      workspaces,
      activeWorkspace,
      activeSession,
      selectableHarnesses,
      allSessions,
      exitedSessions,
      statuses,
      fileStatuses,
      gitStatusRootPath,
      stagedCount,
      commitMessage,
      tabKinds,
      isSidePanelVisible,
      isInfoPanelVisible,
      isOverlayOpen,
      terminalFontSize,
      localServers,
      openInTargets,
      openInFavouriteId,
      openSettings,
    ],
  );
}

const EMPTY_RESULTS: PaletteResults = { groups: [], flat: [] };

/**
 * Candidates for a mode, before the query narrows them.
 *
 * A scope skips the other builders rather than filtering their output: the
 * expensive part is building and scoring candidates nobody will see.
 */
function collectCandidates(
  mode: PaletteMode,
  ctx: PaletteContext,
  scope: PaletteScope | null,
): PaletteItem[] {
  if (mode.kind === 'root') {
    switch (scope) {
      case 'actions':
        return buildActionItems(ctx);
      case 'sessions':
        return buildSessionItems(ctx.allSessions);
      case 'workspaces':
        return buildWorkspaceItems(ctx.workspaces, ctx.statuses);
      case 'files':
        return buildFileItems(ctx);
      default:
        return [
          ...buildActionItems(ctx),
          ...buildSessionItems(ctx.allSessions),
          ...buildWorkspaceItems(ctx.workspaces, ctx.statuses),
          ...buildFileItems(ctx),
        ];
    }
  }
  if (mode.kind === 'rename-session') return [];
  return buildPickerItems(mode, ctx);
}

/**
 * Rank, cap, and group the candidates for the current mode.
 *
 * Ranking runs across every section at once so scores stay comparable, and
 * grouping happens afterwards — a section with one excellent match should not
 * bury a section with three good ones.
 */
export function usePaletteResults(
  open: boolean,
  mode: PaletteMode,
  scope: PaletteScope | null,
  query: string,
  ctx: PaletteContext,
): PaletteResults {
  return useMemo(() => {
    // The dialog stays mounted so it can hand focus back on close, so this
    // hook still runs on every store tick. Building and scoring every
    // candidate for a palette nobody can see is the part worth skipping.
    if (!open) return EMPTY_RESULTS;

    const candidates = collectCandidates(mode, ctx, scope);
    const trimmed = query.trim();

    const scored: Array<{ item: PaletteItem; score: number }> = [];
    for (const item of candidates) {
      const match = rankItem(trimmed, item.label, item.context);
      if (match) scored.push({ item, score: match.score });
    }

    // With no query the natural order of each builder is already meaningful
    // (actions in priority order, sessions by recency), so leave it alone.
    if (trimmed.length > 0) {
      scored.sort((a, b) => b.score - a.score);
    }

    const bySection = new Map<PaletteItem['section'], PaletteItem[]>();
    for (const { item } of scored) {
      const bucket = bySection.get(item.section) ?? [];
      if (bucket.length < sectionLimit(item.section, scope)) bucket.push(item);
      bySection.set(item.section, bucket);
    }

    const groups: PaletteGroup[] = [];
    const flat: PaletteItem[] = [];
    for (const section of SECTION_ORDER) {
      const items = bySection.get(section);
      if (!items || items.length === 0) continue;
      groups.push({ section, items });
      flat.push(...items);
    }

    return { groups, flat };
  }, [open, mode, scope, query, ctx]);
}
