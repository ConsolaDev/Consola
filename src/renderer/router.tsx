import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomeView, WorkspaceView, SettingsView } from './components/Views';
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
export const router = createHashRouter([
  {
    path: '/',
    element: <LayoutWithProviders />,
    children: [
      { index: true, element: <HomeView /> },
      { path: 'workspace/:workspaceId', element: <WorkspaceView /> },
      { path: 'settings', element: <SettingsView /> },
    ],
  },
]);
