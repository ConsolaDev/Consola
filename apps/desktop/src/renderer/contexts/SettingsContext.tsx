import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { windowBridge } from '../services/windowBridge';
import { SettingsModal } from '../components/Dialogs/SettingsModal';
import {
  DEFAULT_SECTION,
  isWorkspaceSection,
  resolveSection,
  type SettingsSection,
} from '../components/Dialogs/settingsSections';
import { useNavigationStore } from '../stores/navigationStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

interface SettingsContextType {
  /**
   * Opens the Settings dialog. With a section it opens there; without one,
   * where this window last left it. A workspace section asked for with no
   * workspace open lands on the default instead: there is nothing to edit.
   */
  openSettings: (section?: SettingsSection) => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

interface SettingsState {
  open: boolean;
  section: SettingsSection;
}

const closed = (state: SettingsState): SettingsState =>
  state.open ? { ...state, open: false } : state;

/** Closes the dialog only while it shows a section of the workspace. */
const closedIfOnWorkspace = (state: SettingsState): SettingsState =>
  isWorkspaceSection(state.section) ? closed(state) : state;

function hasActiveWorkspace(): boolean {
  const id = useNavigationStore.getState().activeWorkspaceId;
  return (
    id !== null && useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === id)
  );
}

/**
 * Owns the one Settings dialog: whether it is open and on which section.
 * The workspace it edits is never state here. It is always the one this
 * window is on, so "open" and "for whom" cannot disagree.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SettingsState>({ open: false, section: DEFAULT_SECTION });
  const activeSessionId = useNavigationStore((nav) => nav.activeSessionId);
  const activeWorkspaceId = useNavigationStore((nav) => nav.activeWorkspaceId);
  const workspace = useWorkspaceStore((store) =>
    activeWorkspaceId
      ? (store.workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null)
      : null,
  );

  const openSettings = useCallback((section?: SettingsSection) => {
    // Resolved here rather than on render, so a workspace section held in
    // state always had a workspace when it opened. That is what lets the
    // rules below read "its workspace is gone" as a reason to close.
    const hasWorkspace = hasActiveWorkspace();
    setState((current) => ({
      open: true,
      section: resolveSection(section ?? current.section, hasWorkspace),
    }));
  }, []);

  useEffect(() => windowBridge.onOpenSettings((section) => openSettings(section)), [openSettings]);

  // A session activating while a workspace section shows — an OS notification
  // click landing on this window, the new-session chord reaching the layout
  // underneath — must not leave the dialog over what the window just switched
  // to, nor editing a workspace the window has left. activeWorkspaceId is
  // watched too: switching workspaces with the Inbox showing leaves
  // activeSessionId null both before and after.
  //
  // App sections stay open on purpose. "Check for Updates…" in the app menu
  // can open the dialog in a window still restoring its remembered view, and
  // that restore is a session change: closing on it would dismiss the dialog
  // the menu item just opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids are the cue; the body reads state through the updater.
  useEffect(() => {
    setState(closedIfOnWorkspace);
  }, [activeSessionId, activeWorkspaceId]);

  // The workspace can vanish under an open workspace section: deleted from
  // its own Danger zone, or from another window. `open` follows the record,
  // so the dialog is gone the same render; the effect only drops the state,
  // so it does not reappear when a workspace is next opened.
  const workspaceGone = workspace === null && isWorkspaceSection(state.section);
  useEffect(() => {
    if (workspaceGone) setState(closed);
  }, [workspaceGone]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setState(closed);
  }, []);

  const handleSectionChange = useCallback((section: SettingsSection) => {
    setState((current) => ({ ...current, section }));
  }, []);

  // Memoised so consumers that put the opener in dependency lists (the
  // palette's context snapshot) do not rebuild on every render here.
  const value = useMemo(() => ({ openSettings }), [openSettings]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        open={state.open && !workspaceGone}
        onOpenChange={handleOpenChange}
        section={state.section}
        onSectionChange={handleSectionChange}
        workspace={workspace}
      />
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
