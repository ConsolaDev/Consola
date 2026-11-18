import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  /** With a section, opens there. Without one, where this window last left it. */
  openSettings: (section?: SettingsSection) => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>(DEFAULT_SECTION);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    activeWorkspaceId
      ? (state.workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null)
      : null,
  );

  // Stable on purpose: the palette's context snapshot names it in a
  // dependency list. The section argument is resolved at open time against
  // the stores through getState(), so a stored Workspace section always
  // had a workspace when it opened; with no argument, where the window
  // last left it resolves the same way.
  const openSettings = useCallback((openSection?: SettingsSection) => {
    const hasWorkspace = useNavigationStore.getState().activeWorkspaceId !== null;
    setModalOpen(true);
    if (openSection !== undefined) {
      setSection(resolveSection(openSection, hasWorkspace));
      return;
    }
    setSection((current) => resolveSection(current, hasWorkspace));
  }, []);

  // The close rule reads the section as it is now, not as it was when the
  // ids last changed, so this effect reacts to id changes only — a section
  // change alone never closes anything.
  const sectionRef = useRef(section);
  sectionRef.current = section;

  // A Workspace section never outlives its workspace. A session activating
  // while the dialog is open — an OS notification click landing on this
  // window, or the new-session chord reaching the layout underneath — must
  // not leave the dialog obscuring what the window just switched to.
  // activeWorkspaceId is watched too: switching workspaces sets the session
  // to null, a no-op against a dependency list of activeSessionId alone.
  // An App section or Updates stays open across the same changes: the
  // menu's Check for Updates opens Settings in a window that may still be
  // restoring its remembered view, and that restore is a session change.
  useEffect(() => {
    if (isWorkspaceSection(sectionRef.current)) setModalOpen(false);
  }, [activeSessionId, activeWorkspaceId]);

  // The workspace record can vanish under an open dialog — deleted from its
  // own danger zone here, or from another window — before the ids move.
  useEffect(() => {
    if (workspace === null && isWorkspaceSection(section)) setModalOpen(false);
  }, [workspace, section]);

  useEffect(
    () => windowBridge.onOpenSettings((bridgeSection) => openSettings(bridgeSection)),
    [openSettings],
  );

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        section={section}
        onSectionChange={setSection}
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
