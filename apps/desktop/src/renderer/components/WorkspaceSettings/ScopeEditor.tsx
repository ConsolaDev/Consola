import { useId, useState } from 'react';
import type { Scope } from '../../../shared/workspace';
import { dialogBridge } from '../../services/dialogBridge';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export function ScopeEditor({ workspaceId, scope, onClose }: {
  workspaceId: string;
  scope: Scope;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(scope.name);
  const [location, setLocation] = useState(scope.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const folder = await dialogBridge.selectFolder();
      if (folder) setLocation(folder.path);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || !name.trim() || !location.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updates: Partial<Pick<Scope, 'name' | 'path'>> = {};
      if (name.trim() !== scope.name) updates.name = name.trim();
      // A rename must still work when the original folder has gone missing.
      if (location !== scope.path) updates.path = location;
      if (Object.keys(updates).length) {
        await useWorkspaceStore.getState().updateScope(workspaceId, scope.id, updates);
      }
      onClose();
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ws-scope-editor dialog-form" aria-label={`Edit scope ${scope.name}`}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        }
      }}>
      <div className="dialog-field">
        <label className="dialog-label" htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} className="dialog-input" autoFocus value={name}
          disabled={busy} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="dialog-field">
        <label className="dialog-label" htmlFor={`${id}-location`}>Folder location</label>
        <div className="ws-scope-location">
          <input id={`${id}-location`} className="dialog-input" value={location}
            disabled={busy} onChange={(event) => setLocation(event.target.value)}
            aria-describedby={`${id}-hint`} />
          <button type="button" className="dialog-button-secondary" disabled={busy}
            onClick={() => void chooseFolder()}>Choose folder…</button>
        </div>
        <p id={`${id}-hint`} className="ws-scope-hint">
          Moved this project? Choose its new folder to keep your sessions. Running terminals use the new location when restarted.
        </p>
      </div>
      {error && <span className="dialog-error" role="alert">{error}</span>}
      <div className="ws-scope-editor-actions">
        <button type="button" className="dialog-button-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="dialog-button-primary" disabled={busy || !name.trim() || !location.trim()}>
          Save changes
        </button>
      </div>
    </form>
  );
}
