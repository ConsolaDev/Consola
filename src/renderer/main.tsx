import React from 'react';
import ReactDOM from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import App from './App';
import { useSettingsStore } from './stores/settingsStore';
import { hydrateWorkspaceStore } from './stores/workspaceStore';
import '@fontsource-variable/jetbrains-mono';
import '@radix-ui/themes/styles.css';
import './styles/themes/index.css';
import './styles/global.css';

function Root() {
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);

  return (
    <Theme appearance={resolvedTheme} accentColor="cyan" grayColor="slate">
      <App />
    </Theme>
  );
}

async function bootstrap() {
  // Records live in the main process now, so they have to arrive before the
  // first render — an empty list on screen is indistinguishable from having no
  // workspaces at all.
  await hydrateWorkspaceStore();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void bootstrap();
