import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SettingsView } from './components/Views';
import { CreateWorkspaceProvider } from './contexts/CreateWorkspaceContext';

// Wrap Layout with providers that need router context
function LayoutWithProviders() {
  return (
    <CreateWorkspaceProvider>
      <Layout />
    </CreateWorkspaceProvider>
  );
}

// Use HashRouter for Electron compatibility
// Tab-based navigation handles home, workspace, and project views
// Only settings uses traditional routing
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [
      { index: true, element: null },
      { path: 'settings', element: <SettingsView /> },
    ],
  },
]);
