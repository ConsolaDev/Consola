import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound } from 'lucide-react';
import type { SecretsList } from '../../../shared/secrets';
import { secretsBridge } from '../../services/secretsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import type { Workspace } from '../../stores/workspaceStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { BindSecretDialog } from './BindSecretDialog';
import { MASKING_NOTE, SECRETS_INTRO, secretRows } from './secretsWords';

/**
 * Settings › Secrets: every name this workspace's automations use or this Mac
 * has bound, where each is bound and used, and Bind…, Change… and Unbind.
 * Opening it starts nothing and reads no value: main's list holds names,
 * labels and times only. It loads again after every bind and unbind, and
 * whenever the workspace's automations change (a file that names a new
 * secret, a binding another window made).
 */
export function SecretsPanel({ workspace }: { workspace: Workspace }) {
  const [list, setList] = useState<SecretsList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [binding, setBinding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ name: string; text: string } | null>(null);
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);

  const load = useCallback(() => {
    let live = true;
    secretsBridge.list(workspace.id).then(
      (next) => {
        if (!live) return;
        setList(next);
        setLoadError(null);
      },
      (failure: unknown) => {
        if (live) setLoadError(ipcErrorMessage(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [workspace.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot is the cue to read the list again.
  useEffect(() => load(), [load, snapshot]);

  const unbind = async (name: string) => {
    setError(null);
    setBusy(name);
    try {
      await secretsBridge.unbind(workspace.id, name);
      load();
    } catch (failure) {
      setError({ name, text: ipcErrorMessage(failure) });
    } finally {
      setBusy(null);
    }
  };

  const rows = list ? secretRows(list, {}) : [];
  const blocked = Boolean(list?.problem);

  return (
    <section className="ws-panel" aria-label="Secrets">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">
          <KeyRound size={14} aria-hidden="true" />
          Secrets
        </h3>
      </div>
      <p className="ws-panel-hint">{SECRETS_INTRO}</p>
      {loadError && (
        <p className="dialog-error" role="alert">
          {loadError}
        </p>
      )}
      {list?.problem && (
        <p className="ws-secret-problem" role="alert">
          <AlertTriangle size={12} aria-hidden="true" />
          {list.problem}
        </p>
      )}
      {list && rows.length === 0 && (
        <p className="ws-panel-hint">No automation in this workspace names a secret yet.</p>
      )}
      {rows.length > 0 && (
        <ul className="ws-row-list" aria-label="Secret names">
          {rows.map((row) => (
            <li key={row.name} className="ws-secret-row" aria-label={row.name}>
              <div className="ws-secret-head">
                <code className="ws-secret-name">{row.name}</code>
                <span className="ws-secret-binding">
                  {row.binding}
                  {row.changed && ` · ${row.changed}`}
                </span>
                <span className="ws-secret-actions">
                  <button
                    type="button"
                    className="dialog-button-secondary ws-panel-action"
                    disabled={blocked || busy !== null}
                    onClick={() => setBinding(row.name)}
                  >
                    {row.action}
                  </button>
                  {row.action === 'Change…' && (
                    <button
                      type="button"
                      className="dialog-button-secondary ws-panel-action"
                      disabled={blocked || busy !== null}
                      onClick={() => void unbind(row.name)}
                    >
                      {busy === row.name ? 'Unbinding…' : 'Unbind'}
                    </button>
                  )}
                </span>
              </div>
              {row.program && <p className="ws-secret-line">{row.program}</p>}
              <ul className="ws-secret-uses" aria-label={`Where ${row.name} is used`}>
                {row.uses.map((use) => (
                  <li key={use}>{use}</li>
                ))}
              </ul>
              {row.sameAs && <p className="ws-secret-line ws-secret-same">{row.sameAs}</p>}
              {row.note && <p className="ws-panel-hint">{row.note}</p>}
              {error?.name === row.name && (
                <p className="dialog-error" role="alert">
                  {error.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="ws-panel-hint">{MASKING_NOTE}</p>
      {binding && (
        <BindSecretDialog
          workspaceId={workspace.id}
          name={binding}
          onClose={() => setBinding(null)}
          onBound={load}
        />
      )}
    </section>
  );
}
