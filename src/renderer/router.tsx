import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CreateWorkspaceProvider } from './contexts/CreateWorkspaceContext';
import { SettingsProvider } from './contexts/SettingsContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <SettingsProvider>
      <CreateWorkspaceProvider>
        <Layout />
      </CreateWorkspaceProvider>
    </SettingsProvider>
  );
}

// Use HashRouter for Electron compatibility
// Tab-based navigation handles home, workspace, and project views
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [{ index: true, element: null }],
  },
]);
