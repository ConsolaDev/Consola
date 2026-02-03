import { createContext, useContext, useState, type ReactNode } from 'react';
import { CreateWorkspaceDialog } from '../components/Dialogs/CreateWorkspaceDialog';

interface CreateWorkspaceContextType {
  openDialog: () => void;
}

const CreateWorkspaceContext = createContext<CreateWorkspaceContextType | null>(null);

export function CreateWorkspaceProvider({ children }: { children: ReactNode }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = () => setDialogOpen(true);

  return (
    <CreateWorkspaceContext.Provider value={{ openDialog }}>
      {children}
      <CreateWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </CreateWorkspaceContext.Provider>
  );
}

export function useCreateWorkspace() {
  const context = useContext(CreateWorkspaceContext);
  if (!context) {
    throw new Error('useCreateWorkspace must be used within a CreateWorkspaceProvider');
  }
  return context;
}
