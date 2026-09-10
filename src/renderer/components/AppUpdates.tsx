import { useEffect, useState } from 'react';
import type { AppUpdateState } from '../../shared/appUpdates';
import './appUpdates.css';

function useAppUpdates() {
  const [state, setState] = useState<AppUpdateState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const api = window.appUpdateAPI;
    if (!api) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = api.onChanged(next => {
      receivedEvent = true;
      setState(next);
      setError(undefined);
    });
    void api.getState().then(next => {
      if (active && !receivedEvent) setState(next);
    }).catch(() => { if (active) setError('Unable to read update status.'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const run = (action: 'check' | 'install') => {
    setError(undefined);
    void window.appUpdateAPI?.[action]().catch(() => setError('Unable to update. Please try again.'));
  };
  return { state, error, run };
}

function statusText(state: AppUpdateState): string {
  switch (state.status) {
    case 'disabled': return state.message ?? 'Updates are unavailable in this build.';
    case 'checking': return 'Checking for updates…';
    case 'downloading': return `Downloading Consola ${state.version}… ${state.progress ?? 0}%`;
    case 'ready': return `Consola ${state.version} is ready to install.`;
    case 'error': return 'Update failed. Check your connection and try again.';
    case 'idle': return state.checkedAt ? 'You’re up to date.' : 'Automatically checks for new versions every four hours.';
  }
}

export function AppUpdateNotice() {
  const { state, error, run } = useAppUpdates();
  if (!state || !['downloading', 'ready', 'error'].includes(state.status)) return null;
  return (
    <div className="app-update-notice" role="status">
      <span>{error ?? statusText(state)}</span>
      {state.status === 'ready' && <button onClick={() => run('install')}>Restart and install</button>}
      {state.status === 'error' && <button onClick={() => run('check')}>Retry update</button>}
    </div>
  );
}

export function AppUpdatesSection() {
  const { state, error, run } = useAppUpdates();
  return (
    <div className="settings-modal-section app-updates-section">
      <h2 className="settings-modal-section-title">Updates</h2>
      <p>Consola {state?.currentVersion ?? ''}</p>
      <p role="status">{error ?? (state ? statusText(state) : 'Update status is unavailable.')}</p>
      {state && state.status !== 'disabled' && <>
        <p>New versions download automatically. You choose when to restart and install.</p>
        <button disabled={state.status === 'checking' || state.status === 'downloading'}
          onClick={() => run(state.status === 'ready' ? 'install' : 'check')}>
          {state.status === 'ready' ? 'Restart and install' : 'Check for updates'}
        </button>
        {state.checkedAt && <p>Last checked: {new Date(state.checkedAt).toLocaleString()}</p>}
      </>}
    </div>
  );
}
