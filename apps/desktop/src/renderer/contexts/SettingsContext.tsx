import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { windowBridge } from '../services/windowBridge';
import { SettingsModal, type SettingsSection } from '../components/Dialogs/SettingsModal';

interface SettingsContextType {
  openSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');

  const openSettings = () => setModalOpen(true);

  useEffect(() => windowBridge.onOpenSettings(section => {
    if (section) setActiveSection(section);
    setModalOpen(true);
  }), []);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal open={modalOpen} onOpenChange={setModalOpen} activeSection={activeSection} onSectionChange={setActiveSection} />
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
