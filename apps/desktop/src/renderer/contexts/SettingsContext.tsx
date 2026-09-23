import { createContext, useContext, useState, type ReactNode } from 'react';
import { SettingsModal } from '../components/Dialogs/SettingsModal';

interface SettingsContextType {
  openSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [modalOpen, setModalOpen] = useState(false);

  const openSettings = () => setModalOpen(true);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal open={modalOpen} onOpenChange={setModalOpen} />
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
