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

function StartupError({ error }: { error: unknown }) {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Consola could not start</h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        Your conversations are safe — they live in the CLI&rsquo;s own configuration directory.
      </p>
      <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{String(error)}</pre>
    </div>
  );
}

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  try {
    // Records live in the main process now, so they have to arrive before the
    // first render — an empty list on screen is indistinguishable from having
    // no workspaces at all.
    await hydrateWorkspaceStore();
  } catch (error) {
    // A blank window is the one outcome worse than an error message: it looks
    // like the app started and the data is gone.
    root.render(<StartupError error={error} />);
    return;
  }

  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void bootstrap();
