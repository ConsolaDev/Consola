import { createHashRouter } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomeView, WorkspaceView, SettingsView } from './components/Views';

// Use HashRouter for Electron compatibility
export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomeView /> },
      { path: 'workspace/:workspaceId', element: <WorkspaceView /> },
      { path: 'settings', element: <SettingsView /> },
    ],
  },
]);
