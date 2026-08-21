import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { workspaceBridge } from '../../services/workspaceBridge';
import type { ScopeRepo } from '../../../shared/types';
import './styles.css';

interface FanOutDialogProps {
  workspaceId: string;
  onClose: () => void;
}

/**
 * Fan-out: pick a scope, pick target repos inside it, write one prompt.
 *
 * A creation gesture, not an entity: submitting mints one group and N
 * ordinary sessions in the main process, then this dialog walks away.
 */
export function FanOutDialog({ workspaceId, onClose }: FanOutDialogProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const scopes = workspace?.scopes ?? [];

  const [scopeId, setScopeId] = useState<string | undefined>(scopes[0]?.id);
  const [repos, setRepos] = useState<ScopeRepo[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState<Array<{ path: string; error: string }>>([]);

  const scope = scopes.find((candidate) => candidate.id === scopeId);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void workspaceBridge
      .listScopeRepos(workspaceId, scope.id)
      .then((found) => {
        if (cancelled) return;
        setRepos(found);
        setSelected(new Set());
      })
      .catch(() => {
        // An unreadable scope folder leaves the previous scope's repos on
        // screen otherwise, which would fan out into the wrong targets. The
        // empty list renders as "No git repositories inside this scope."
        if (!cancelled) setRepos([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, scope?.id]);

  useEffect(() => {
    if (scope && !nameTouched) setGroupName(`Fan-out — ${scope.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, nameTouched]);

  const toggle = (repoPath: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  };

  const canSubmit =
    !!scope &&
    selected.size > 0 &&
    prompt.trim().length > 0 &&
    groupName.trim().length > 0 &&
    !submitting;

  const submit = async () => {
    if (!canSubmit || !scope) return;
    setSubmitting(true);
    try {
      try {
        const result = await workspaceBridge.fanOut({
          workspaceId,
          scopeId: scope.id,
          targetPaths: [...selected],
          prompt: prompt.trim(),
          groupName: groupName.trim(),
        });
        if (result.failed.length > 0) {
          // Partial success: the group and the launched sessions exist. Show
          // what did not launch, and let the user close after reading it.
          setFailed(result.failed);
        } else {
          onClose();
        }
      } catch (error) {
        // The bridge call itself rejected (e.g. an unknown workspace) — no
        // group and no sessions exist. Reuse the failures block to say so
        // rather than a native alert.
        const message = error instanceof Error ? error.message : String(error);
        setFailed([{ path: 'all targets', error: message }]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content fan-out-dialog">
          <Dialog.Title className="dialog-title">Fan-out</Dialog.Title>
          <Dialog.Description className="dialog-description">
            One prompt, one session per target repo, all in a fresh group.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-scope">
                Scope
              </label>
              <select
                id="fan-out-scope"
                className="dialog-input"
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
              >
                {scopes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">Targets · {selected.size} selected</span>
              <div className="fan-out-targets">
                {repos.map((repo) => (
                  <label key={repo.path} className="fan-out-target">
                    <input
                      type="checkbox"
                      checked={selected.has(repo.path)}
                      onChange={() => toggle(repo.path)}
                    />
                    <span>{repo.name}</span>
                  </label>
                ))}
                {repos.length === 0 && (
                  <span className="fan-out-empty">No git repositories inside this scope.</span>
                )}
              </div>
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-group-name">
                Group name
              </label>
              <input
                id="fan-out-group-name"
                className="dialog-input"
                value={groupName}
                onChange={(event) => {
                  setNameTouched(true);
                  setGroupName(event.target.value);
                }}
              />
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="fan-out-prompt">
                Prompt — runs in each target
              </label>
              <textarea
                id="fan-out-prompt"
                className="dialog-input fan-out-prompt"
                rows={4}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Bump lodash to v5. Fix breaking changes, run the tests, open a PR."
              />
            </div>

            {failed.length > 0 && (
              <div className="fan-out-failures">
                <span>These targets did not launch — the rest did:</span>
                <ul>
                  {failed.map((failure) => (
                    <li key={failure.path}>
                      {failure.path}: {failure.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              {failed.length > 0 ? 'Close' : 'Cancel'}
            </button>
            {failed.length === 0 && (
              <button
                className="dialog-button-primary"
                onClick={() => void submit()}
                disabled={!canSubmit}
              >
                Create group · {selected.size} session{selected.size === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
