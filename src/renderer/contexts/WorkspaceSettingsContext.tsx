import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { WorkspaceSettingsModal } from '../components/WorkspaceSettings';
import { useNavigationStore } from '../stores/navigationStore';

interface WorkspaceSettingsContextType {
  /**
   * Opens for one workspace, or the window's active workspace when omitted.
   * A no-op if neither resolves to a workspace — there is nothing to edit.
   */
  openWorkspaceSettings: (workspaceId?: string) => void;
  closeWorkspaceSettings: () => void;
}

const WorkspaceSettingsContext = createContext<WorkspaceSettingsContextType | null>(null);

/**
 * A sibling to SettingsProvider, not an extension of it: the two modals are
 * opened from different places for different things, and only the global
 * one's pointer row ever needs to reach across.
 *
 * State is the workspace id or null rather than a boolean plus an id, so
 * "open" and "for whom" cannot disagree.
 */
export function WorkspaceSettingsProvider({ children }: { children: ReactNode }) {
  const [openForWorkspaceId, setOpenForWorkspaceId] = useState<string | null>(null);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);

  const openWorkspaceSettings = useCallback((workspaceId?: string) => {
    const target = workspaceId ?? useNavigationStore.getState().activeWorkspaceId;
    if (!target) return;
    setOpenForWorkspaceId(target);
  }, []);

  const closeWorkspaceSettings = useCallback(() => setOpenForWorkspaceId(null), []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeWorkspaceSettings();
    },
    [closeWorkspaceSettings]
  );

  // A session activating while the modal is open — an OS notification click
  // landing on this window, or the new-session chord reaching the layout
  // underneath — must not leave the dialog obscuring what the window just
  // switched to. The Inbox closes on the same cue.
  useEffect(() => {
    setOpenForWorkspaceId(null);
  }, [activeSessionId]);

  // Memoised so consumers that put the openers in dependency lists (the
  // palette's context snapshot) do not rebuild on every render here.
  const value = useMemo(
    () => ({ openWorkspaceSettings, closeWorkspaceSettings }),
    [openWorkspaceSettings, closeWorkspaceSettings]
  );

  return (
    <WorkspaceSettingsContext.Provider value={value}>
      {children}
      <WorkspaceSettingsModal workspaceId={openForWorkspaceId} onOpenChange={handleOpenChange} />
    </WorkspaceSettingsContext.Provider>
  );
}

export function useWorkspaceSettings() {
  const context = useContext(WorkspaceSettingsContext);
  if (!context) {
    throw new Error('useWorkspaceSettings must be used within a WorkspaceSettingsProvider');
  }
  return context;
}
